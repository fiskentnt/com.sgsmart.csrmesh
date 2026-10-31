'use strict';

const Homey = require('homey');
const { makePacket, meshIdFromName, resolveKey } = require('./csrmesh');
const { gen1LevelData } = require('./sgProtocol');
const { CHANGE_AFTER, learnLocation } = require('./location');

// The data-model command a first generation dimmer acts on:
//   [dstLo dstHi] [73] [A0 ctr] [locHi locLo] [idHi idLo] [00 00] [01] [level]
// dst = 0x8001 written little-endian (01 80) = the channel every first
// generation dimmer listens on; the dimmer itself is selected by the 2-byte
// device id inside the payload. loc is the home's location id: the dimmer
// ignores a command with another one, so it is learned from the dimmer's own
// status before anything is sent (or, after LOCATION_BORROW_MS without one,
// taken from the other dimmers).
// level is 0..100 decimal, not the CSRmesh -128..-1 lightbulb encoding.
// Homey sets onoff and dim in the same breath when the slider is dragged on a
// dark lamp. Long enough to catch both, short enough not to feel laggy.
const DIM_DEBOUNCE_MS = 250;
// Siri (through HomeKit) sends "on" and the level as two changes, mostly about
// 0.3 s apart but up to 0.84 s (measured 15.10.2026), too far apart for the
// debounce above. "On" without a level to a dimmer that is off waits this long
// for one, so the lamp does not first go back to its previous level; to a
// dimmer that is on, it sends nothing. Off and levels are not held.
const ON_WAIT_MS = 800;
// What _sendOnce returns for a level kept until the location id is known:
// neither delivered (true) nor a failed send (false).
const SEND_KEPT = 'kept';
// A kept level waits this long for the dimmer's own status. Then it goes out
// with the location id the other dimmers report, when they all report the
// same one, and the dimmer uses that from then on until it reports its own.
const LOCATION_BORROW_MS = 10000;
// The longest a level is kept. A level that still cannot go out is dropped
// rather than reaching the lamp long after the tap.
const KEPT_LEVEL_MS = 30000;
// After a command the dimmer fades (from 30 % when it was off) and reports
// the levels on the way. Those reports are ignored until it is within this
// much of the target, for at most STATUS_SETTLE_MS.
const STATUS_SAME_PCT = 2;
const STATUS_SETTLE_MS = 5000;
// A room slider in the Homey app sets the group and each dimmer at once, so
// one dimmer can be asked for the same level twice. A level that is being
// sent, or was delivered less than this long ago, is not sent again unless
// the dimmer has reported another level since.
const SAME_LEVEL_MS = 2000;
// Signal strength tile: median of this many readings, a move of at least this
// many dB, at most this often.
const SIGNAL_MEDIAN_OF = 5;
const SIGNAL_STEP_DB = 3;
const SIGNAL_EVERY_MS = 3600000;
// Only the dimmer Homey connects to directly needs a good signal: the others
// are reached through it. Weaker than this, its connection says so.
// Weak below WEAK_BELOW_DB, good again only above GOOD_ABOVE_DB, so a signal
// near the limit does not make the status flip back and forth.
const WEAK_BELOW_DB = -85;
const GOOD_ABOVE_DB = -82;
// The name shown on dimmers paired before the signal had it.
const SIGNAL_TITLE = { en: 'Signal to Homey', no: 'Signal til Homey' };
// Test builds had these; 2.2.0 shows the connection as text instead.
// sg_role first: while a dimmer still has it, Homey refuses other changes
// ("Invalid Capability: sg_role").
const OLD_CAPABILITIES = ['sg_role', 'alarm_generic'];

class SGMeshDevice extends Homey.Device {
  _infoLog(...args) {
    super.log(...args);
  }

  async onInit() {
    // A dimmer that is off reports dim 0, so the stored value cannot seed the
    // level to restore on the next "on": Math.max(1, 0) would command 1%, well
    // under the dimmer's own 10% floor, and the light would look dead.
    const storedDim = this.getCapabilityValue('dim');
    this._lastDim = (typeof storedDim === 'number' && storedDim > 0) ? storedDim : 1;

    this._target = null;        // latest requested percent (coalesced)
    this._busy = false;
    this._lastAppliedLevel = null;
    this._sentLevel = null;     // last level delivered, until the dimmer reports another
    this._sentAt = 0;
    this._inFlight = null;      // the send under way: { level, delivered, kept, changed }
    this._pendingLevel = null;  // asked for before the location id was known
    this._keptTimer = null;     // LOCATION_BORROW_MS, then KEPT_LEVEL_MS, for _pendingLevel
    this._borrowLocation = false; // waited LOCATION_BORROW_MS once: may use the other dimmers'

    // Dimmers paired before signal strength was added get it as well, with
    // the connection, under the same names as new ones.
    for (const capability of OLD_CAPABILITIES) {
      if (!this.hasCapability(capability)) continue;
      await this.removeCapability(capability)
        .catch((err) => this.error(`removing ${capability} failed: ${err.message || err}`));
    }
    for (const capability of ['measure_signal_strength', 'sg_connection']) {
      if (this.hasCapability(capability)) continue;
      await this.addCapability(capability)
        .catch((err) => this.error(`adding ${capability} failed: ${err.message || err}`));
    }
    if (this.hasCapability('measure_signal_strength')) {
      let current = null;
      try {
        current = (this.getCapabilityOptions('measure_signal_strength') || {}).title;
      } catch (err) { /* no options yet */ }
      if (!current || current.en !== SIGNAL_TITLE.en || current.no !== SIGNAL_TITLE.no) {
        await this.setCapabilityOptions('measure_signal_strength', { title: SIGNAL_TITLE })
          .catch((err) => this.error(`naming the signal failed: ${err.message || err}`));
      }
    }

    // The location id may have been heard before this dimmer was added (the
    // status of a dimmer not yet in Homey, or during pairing).
    if (this.getLocationId() === null) {
      this._learnLocation(this.homey.app.locationFor ? this.homey.app.locationFor(this.getMeshId()) : null);
    }
    await this.updateAvailability();
    if (this.getLocationId() === null) {
      this._infoLog('location id not learned yet: commands wait for the dimmer\'s first status');
      if (this.homey.app.requestStatus) this.homey.app.requestStatus();
    }

    // onoff and dim must be coupled and debounced, as the SDK's light guidance
    // requires: dragging the slider on a dark lamp makes Homey set both at once,
    // and two separate listeners would race to send conflicting levels for the
    // same gesture. One listener turns each gesture into exactly one level.
    // Returns to Homey immediately; the BLE burst runs in the background so the
    // 10 s capability timeout can never fire on a slow mesh.
    this.registerMultipleCapabilityListener(['onoff', 'dim'], async (values) => {
      this._onCapabilities(values);
    }, DIM_DEBOUNCE_MS);

    // The last known bridge, also after a restart and before any link.
    const bridgeId = this.homey.app.bridgeMeshId ? this.homey.app.bridgeMeshId() : null;
    if (bridgeId !== null) this.setConnection(this.getMeshId() === bridgeId);

    this._infoLog(`dimmer ready (mesh id 0x${this.getMeshId().toString(16).padStart(4, '0')})`);
    this.homey.app.dimmersChanged();
  }

  // Just paired: the app asks for its first status (app.dimmerAdded).
  async onAdded() {
    if (this.homey.app.dimmerAdded) this.homey.app.dimmerAdded();
    else this.homey.app.dimmersChanged();
  }

  async onDeleted() {
    if (this._onWaitTimer) this.homey.clearTimeout(this._onWaitTimer);
    this._clearKept();
    this.homey.app.dimmersChanged();
  }

  // One gesture from Homey, after the debounce. Logs how long after the
  // previous one it came, so the gap between Siri's "on" and level shows.
  _onCapabilities(values) {
    const now = Date.now();
    const gap = this._capabilitiesAt ? ` (+${now - this._capabilitiesAt}ms)` : '';
    this._capabilitiesAt = now;
    this._infoLog(`capability in: ${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(' ')}${gap}`);

    if (this._onWaitTimer) {
      this.homey.clearTimeout(this._onWaitTimer);
      this._onWaitTimer = null;
    }
    if (values.onoff === true && typeof values.dim !== 'number') {
      // Already on, as the group treats a lit dimmer: nothing to send. This
      // also covers the second half of a level and "on" from Siri.
      if (typeof this._lastAppliedLevel === 'number' && this._lastAppliedLevel > 0) {
        this._skipLog(this._lastAppliedLevel, '"on" while already on');
        return;
      }
      const pct = this._levelFor(values);
      // Shown now, as before: the Homey app reads the tile back when this
      // listener answers.
      this.setCapabilityValue('dim', pct / 100).catch(() => {});
      this._onWaitTimer = this.homey.setTimeout(() => {
        this._onWaitTimer = null;
        this._request(pct);
      }, ON_WAIT_MS);
      return;
    }
    this._request(this._levelFor(values));
  }

  // The mesh id is normally carried in the @NDxxxx advertisement name captured
  // during pairing; the setting is a manual fallback.
  getMeshId() {
    const fromName = meshIdFromName(this.getStoreValue('localName'));
    if (fromName !== null) return fromName;
    return Number(this.getSettings().object_id || 0) & 0xffff;
  }

  getNetworkKey() {
    return resolveKey(this.getSettings());
  }

  // The home's location id, learned from this dimmer's status; null until then.
  getLocationId() {
    if (this._location && Number.isInteger(this._location.value)) return this._location.value;
    const stored = this.getStoreValue('locationId');
    return Number.isInteger(stored) ? stored : null;
  }

  // Kept per dimmer, and replaced only as lib/location.js says (paired again
  // in another SG home). Returns what the status meant there: 'learned',
  // 'changed', 'same', 'other' (another one, not taken yet) or 'invalid'.
  _learnLocation(location) {
    const before = this.getLocationId();
    const { state, outcome } = learnLocation(this._location || { value: before, other: null, count: 0 }, location);
    this._location = state;
    const hex = (value) => `0x${value.toString(16).padStart(4, '0')}`;
    if (outcome === 'learned' || outcome === 'changed') {
      this._otherLogged = null;
      this.setStoreValue('locationId', state.value)
        .catch((err) => this.error(`storing the location id failed: ${err.message || err}`));
      this._infoLog(outcome === 'learned'
        ? `location id learned: ${hex(state.value)}`
        : `location id changed: ${hex(before)} to ${hex(state.value)} (heard ${CHANGE_AFTER} times in a row)`);
    } else if (outcome === 'other' && this._otherLogged !== location) {
      // Once per other value: one that keeps coming back is logged once.
      this._otherLogged = location;
      this._infoLog(`status with another location id, ${hex(location)} (learned ${hex(before)}): `
        + `ignored until it comes ${CHANGE_AFTER} times in a row`);
    }
    return outcome;
  }

  // Never unavailable, so a tap still reaches the dimmer. A warning says why
  // commands may not work: Homey cannot read the dimmers' status at all (most
  // likely a wrong network password), or this dimmer's location id is not
  // known yet and commands wait for it.
  async updateAvailability() {
    const unreadable = this.homey.app.statusUnreadableText ? this.homey.app.statusUnreadableText() : null;
    await this.setAvailable().catch(() => {});
    let warning = unreadable;
    let reason = 'suspected wrong password';
    if (!warning && this.getLocationId() === null) {
      warning = this.homey.__('device.waitingForStatus');
      reason = 'waiting for the first status';
    }
    if (warning === this._warningShown) return;
    // Logged, so a warning that comes and goes can be told apart afterwards.
    const shown = this._warningShown;
    this._warningShown = warning;
    if (warning) this._infoLog(`warning shown: ${reason}`);
    else if (shown) this._infoLog('warning cleared');
    if (warning) await this.setWarning(warning).catch(() => {});
    else await this.unsetWarning().catch(() => {});
  }

  // Signal strength in dB (RSSI), from a scan (see MeshBridge). RSSI swings a
  // few dB from one reading to the next, so the tile
  // shows the median of the last SIGNAL_MEDIAN_OF readings, and moves only
  // when that is SIGNAL_STEP_DB away, at most once per SIGNAL_EVERY_MS. A
  // dimmer that is not seen keeps its last value.
  setSignal(rssi) {
    const value = Math.round(Number(rssi));
    if (!Number.isFinite(value) || value >= 0 || value < -127) return;
    if (!this.hasCapability('measure_signal_strength')) return;
    this._signals = [...(this._signals || []), value].slice(-SIGNAL_MEDIAN_OF);
    const sorted = [...this._signals].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    const shown = this.getCapabilityValue('measure_signal_strength');
    if (typeof shown === 'number') {
      if (Math.abs(median - shown) < SIGNAL_STEP_DB) return;
      if (Date.now() - (Number(this.getStoreValue('signalSetAt')) || 0) < SIGNAL_EVERY_MS) return;
    }
    this.setStoreValue('signalSetAt', Date.now()).catch(() => {});
    this.setCapabilityValue('measure_signal_strength', median).catch(() => {});
    this._showConnection(median);
  }

  // Whether Homey connects to this dimmer directly (the bridge) or reaches it
  // indirectly, via other dimmers. Changes only when the bridge does.
  setConnection(isBridge) {
    this._isBridge = isBridge;
    this._showConnection(this.getCapabilityValue('measure_signal_strength'));
  }

  _showConnection(signal) {
    // Unknown until the bridge is: then the shown text stays as it was.
    if (typeof this._isBridge !== 'boolean' || !this.hasCapability('sg_connection')) return;
    let key = 'device.connection.indirect';
    if (!this._isBridge) {
      this._weak = undefined;
    } else {
      if (typeof signal === 'number' && signal < WEAK_BELOW_DB) this._weak = true;
      else if (typeof signal !== 'number' || signal > GOOD_ABOVE_DB) this._weak = false;
      // In between: as before, also after a restart (from the shown text).
      else if (typeof this._weak !== 'boolean') {
        this._weak = this.getCapabilityValue('sg_connection') === this.homey.__('device.connection.directWeak');
      }
      key = this._weak ? 'device.connection.directWeak' : 'device.connection.directGood';
    }
    const text = this.homey.__(key);
    if (this.getCapabilityValue('sg_connection') !== text) this.setCapabilityValue('sg_connection', text).catch(() => {});
  }

  applyMeshStatus(idHex, level, location) {
    if (parseInt(idHex, 16) !== this.getMeshId()) return;
    const outcome = this._learnLocation(location);
    // Another location id than the learned one, not taken yet: most likely
    // another home's dimmer with the same id, so not this dimmer's level.
    if (outcome === 'other') return;
    if (outcome === 'learned' || outcome === 'changed') {
      this.updateAvailability();
      // A level asked for before the location id was known goes out now;
      // the next status shows where the dimmer ends up.
      if (this._pendingLevel !== null) {
        const pending = this._pendingLevel;
        this._clearKept();
        this._infoLog(`location id known: sending the kept level ${pending}`);
        this._request(pending);
        return;
      }
    }
    const pct = Math.max(0, Math.min(100, Math.round(level)));
    // Another level than the one just delivered (the wall switch, or the fade
    // on its way): the same level again is a change, so it will be sent.
    if (this._sentLevel !== null && (Math.abs(pct - this._sentLevel) > STATUS_SAME_PCT
      || (pct > 0) !== (this._sentLevel > 0))) this._sentLevel = null;
    // Just after a command, the dimmer is still on its way to the target.
    if (this._commandedAt && Date.now() - this._commandedAt < STATUS_SETTLE_MS
      && Math.abs(pct - this._commandedLevel) > STATUS_SAME_PCT) return;
    // The dimmers round to their own steps (one reports 21 for 20); within
    // 2 % of what Homey shows, and still on or still off, it is the same level.
    const shown = this._lastAppliedLevel;
    if (typeof shown === 'number' && Math.abs(pct - shown) <= STATUS_SAME_PCT
      && (pct > 0) === (shown > 0)) return;
    this._applyLevel(pct);
  }

  _applyLevel(level) {
    const pct = Math.max(0, Math.min(100, Math.round(level)));
    if (pct === this._lastAppliedLevel) return;
    this._lastAppliedLevel = pct;
    if (pct > 0) this._lastDim = pct / 100;
    this.setCapabilityValue('onoff', pct > 0).catch(() => {});
    this.setCapabilityValue('dim', pct / 100).catch(() => {});
    this._infoLog(`status applied: on=${pct > 0} dim=${pct}%`);
  }

  // Turn one coupled onoff/dim change into a single 0..100 level.
  //   both set   — dragging the slider on a dark lamp: dim wins, unless the
  //                gesture explicitly asks for off.
  //   dim only   — slider on a lit lamp; 0 means off.
  //   onoff only — the power button: restore the last level the lamp was at.
  _levelFor(values) {
    const { onoff, dim } = values;
    let pct;

    if (typeof dim === 'number') {
      pct = Math.round(dim * 100);
      if (onoff === false) pct = 0;
    } else if (typeof onoff === 'boolean') {
      pct = onoff ? Math.max(1, Math.round(this._lastDim * 100)) : 0;
    } else {
      return this._lastAppliedLevel ?? 0;
    }

    pct = Math.max(0, Math.min(100, pct));
    // Never remember 0 as the level to come back to; "on" would command 1%,
    // far under the dimmer's own 10% floor, and the lamp would look dead.
    if (pct > 0) this._lastDim = pct / 100;
    return pct;
  }

  // Coalesce: keep only the newest target. While a send is running, slider
  // moves just update the target; the drain loop sends the latest and skips
  // the intermediates.
  _request(pct) {
    // Any newer request, also one from the group, replaces a held "on".
    if (this._onWaitTimer) {
      this.homey.clearTimeout(this._onWaitTimer);
      this._onWaitTimer = null;
    }
    if (this._busy && this._target === pct) this._skipLog(pct, 'same level already waiting');
    // Another level asked for meanwhile (off and on again while a send keeps
    // failing): the level the user ends on is a new request, not a repeat.
    if (this._inFlight && pct !== this._inFlight.level) this._inFlight.changed = true;
    this._target = pct;
    this._commandedLevel = pct;
    this._commandedAt = Date.now();

    // Reflect the gesture in Homey now, not from inside the send. A send that
    // is still retrying keeps _drain() awaiting and _busy true, so every later
    // gesture would otherwise be swallowed here in silence: no log, no tile
    // update, until the mesh recovers minutes later. The newest request is the
    // truth the user is looking at; a status poll corrects it if the dimmer
    // ends up somewhere else.
    this._lastAppliedLevel = pct;
    this.setCapabilityValue('onoff', pct > 0).catch(() => {});
    this.setCapabilityValue('dim', pct / 100).catch(() => {});

    if (!this._busy) this._drain();
  }

  async _drain() {
    this._busy = true;
    try {
      // The send that has just finished; a target found after it came in
      // while that send was under way.
      let last = null;
      while (this._target !== null) {
        const pct = this._target;
        this._target = null;
        if (this._alreadySent(pct, last)) continue;
        last = { level: pct, delivered: false, kept: false, changed: false };
        this._inFlight = last;
        try {
          const outcome = await this._sendOnce(pct);
          last.delivered = outcome === true;
          last.kept = outcome === SEND_KEPT;
        } catch (err) {
          this.error(`send failed: ${err.message || err}`);
        }
      }
    } finally {
      this._busy = false;
      this._inFlight = null;
    }
  }

  // A request for the level that was being sent when it came in is skipped
  // whatever that send's outcome: a failed send has had its retries already.
  _alreadySent(pct, last) {
    if (last && pct === last.level && !last.changed) {
      const outcome = last.delivered ? 'delivered' : (last.kept ? 'kept until the location id is known' : 'not delivered');
      this._skipLog(pct, `same level was being sent (${outcome})`);
      return true;
    }
    const ago = Date.now() - this._sentAt;
    // A clock that stepped back must not stretch the window.
    if (pct !== this._sentLevel || ago < 0 || ago >= SAME_LEVEL_MS) return false;
    this._skipLog(pct, `same level delivered ${ago}ms ago`);
    return true;
  }

  _skipLog(pct, why) {
    this._infoLog(`command id=0x${this.getMeshId().toString(16).padStart(4, '0')} level=${pct} skipped: ${why}`);
  }

  // true when the dimmer got the level, false when the send failed, SEND_KEPT
  // when the level waits for the location id (sent with the first status).
  async _sendOnce(pct) {
    const key = this.getNetworkKey();
    const id = this.getMeshId();
    const level = Math.max(0, Math.min(100, Math.round(pct)));

    // The dimmer would ignore a command with the wrong location id. Without
    // its own, the newest level is kept (see _keep).
    let location = this.getLocationId();
    let borrowed = false;
    if (location === null && this._borrowLocation) {
      location = this._sharedLocation();
      borrowed = location !== null;
    }
    if (location === null) {
      this._keep(level);
      this._infoLog(`command id=0x${id.toString(16).padStart(4, '0')} level=${level} `
        + 'kept: location id not learned yet; it goes out with the dimmer\'s first status');
      if (this.homey.app.requestStatus) this.homey.app.requestStatus();
      return SEND_KEPT;
    }

    // Exactly one command per capability change. The Gen1 counter byte is a
    // local rolling value, seeded from the app-wide sequence on first use.
    if (!Number.isInteger(this._gen1Seq)) {
      this._gen1Seq = this.homey.app.nextSeq() & 0xff;
    } else {
      this._gen1Seq = (this._gen1Seq + 1) & 0xff;
    }
    const ctr = this._gen1Seq;

    const data = gen1LevelData({ location, id, level, tid: ctr });

    const seq = this.homey.app.nextSeq();
    const packet = makePacket(key, seq, data);

    this._infoLog(
      `command id=0x${id.toString(16).padStart(4, '0')} level=${level} ` +
      `loc=0x${location.toString(16).padStart(4, '0')}${borrowed ? ' (from the other dimmers)' : ''} ` +
      `seq=0x${seq.toString(16).padStart(6, '0')}`
    );

    // Homey already shows this level: _request() set it the moment the gesture
    // arrived, so the tile never waits on the mesh.
    this._sentLevel = null;
    const result = await this.homey.app.bridge.send(packet, { key: `device:${id.toString(16)}`, level });
    if (!result || !result.ok) return false;
    this._sentLevel = level;
    this._sentAt = Date.now();
    return true;
  }

  // A level kept for want of a location id goes out with the dimmer's first
  // status (applyMeshStatus). The first kept level starts the clock; a newer
  // one only replaces the level.
  _keep(level) {
    this._pendingLevel = level;
    if (this._keptTimer) return;
    this._keptTimer = this.homey.setTimeout(() => this._keptWaited(), LOCATION_BORROW_MS);
  }

  // No status from this dimmer in LOCATION_BORROW_MS: the other dimmers'
  // location id, when they all report the same, or wait until KEPT_LEVEL_MS.
  _keptWaited() {
    this._keptTimer = null;
    if (this._pendingLevel === null) return;
    this._borrowLocation = true;
    const level = this._pendingLevel;
    const shared = this._sharedLocation();
    const waited = `no status from this dimmer in ${LOCATION_BORROW_MS / 1000} s`;
    if (shared !== null) {
      this._pendingLevel = null;
      this._infoLog(`${waited}: sending the kept level ${level} with the other dimmers' location id `
        + `0x${shared.toString(16).padStart(4, '0')}`);
      this._request(level);
      return;
    }
    this._infoLog(`${waited}, and the other dimmers report no common location id: `
      + `the kept level ${level} waits at most ${(KEPT_LEVEL_MS - LOCATION_BORROW_MS) / 1000} s more`);
    this._keptTimer = this.homey.setTimeout(() => this._keptExpired(), KEPT_LEVEL_MS - LOCATION_BORROW_MS);
  }

  _keptExpired() {
    this._keptTimer = null;
    if (this._pendingLevel === null) return;
    this._infoLog(`kept level ${this._pendingLevel} dropped: no location id in ${KEPT_LEVEL_MS / 1000} s`);
    this._pendingLevel = null;
  }

  _clearKept() {
    if (this._keptTimer) this.homey.clearTimeout(this._keptTimer);
    this._keptTimer = null;
    this._pendingLevel = null;
  }

  // The location id every other paired dimmer has learned, when they agree.
  _sharedLocation() {
    return this.homey.app.sharedLocation ? this.homey.app.sharedLocation(this.getMeshId()) : null;
  }
}

module.exports = SGMeshDevice;
