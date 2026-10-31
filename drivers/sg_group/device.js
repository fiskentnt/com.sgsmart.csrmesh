'use strict';

const Homey = require('homey');

// A group is a set of dimmers paired in this app, driven from one tile. Which
// dimmers is chosen at pairing and can be changed under repair.
//
// It sends nothing itself. These dimmers do not act on a group-addressed
// message (tested 2026-09-18): a command to each dimmer is what does the work.
// So the group hands its level to each dimmer device, which sends it the usual
// way. Each dimmer keeps only its newest level, so when Homey commands the
// room and the group tile and the dimmer tiles all get the same value at once,
// still one packet goes out per dimmer.

// Homey sets onoff and dim in the same breath when the slider is dragged on a
// dark group. Long enough to catch both, short enough not to feel laggy.
const DIM_DEBOUNCE_MS = 250;
// Siri and the room slider send "on" and the level as two changes up to about
// 0.8 s apart. "On" without a level waits this long for one; see SGDeviceBase.
const ON_WAIT_MS = 800;
// When Homey commands a whole room, the dimmers' own listeners fire close to
// the group's. Whichever request for the same level comes second finds the
// first still being sent, and the dimmer skips it.
const FAN_OUT_DELAY_MS = 100;
const MEMBER_DRIVER = 'sg_mesh';

class SGGroupDevice extends Homey.Device {
  _infoLog(...args) {
    super.log(...args);
  }

  async onInit() {
    // A group that is off reports dim 0, so the stored value cannot seed the
    // level to restore on the next "on": Math.max(1, 0) would command 1%, well
    // under the dimmers' own 10% floor, and the lights would look dead.
    // So the level to come back to is kept in the store, across app restarts.
    const storedDim = this.getCapabilityValue('dim');
    const keptDim = Number(this.getStoreValue('lastDim'));
    if (typeof storedDim === 'number' && storedDim > 0) this._lastDim = storedDim;
    else this._lastDim = (keptDim > 0 && keptDim <= 1) ? keptDim : 1;

    // Last level each member reported, by mesh id.
    this._levels = new Map();

    await this.setAvailable().catch(() => {});

    // onoff and dim must be coupled and debounced, as the SDK's light guidance
    // requires: dragging the slider on a dark group makes Homey set both at
    // once, and two separate listeners would race to send conflicting levels
    // for the same gesture. One listener turns each gesture into one level.
    this.registerMultipleCapabilityListener(['onoff', 'dim'], async (values) => {
      const now = Date.now();
      const gap = this._capabilitiesAt ? ` (+${now - this._capabilitiesAt}ms)` : '';
      this._capabilitiesAt = now;
      this._infoLog(`capability in: ${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(' ')}${gap}`);

      // The power button alone means "back on, as it was": each dimmer returns
      // to its own level. Any gesture with a level sets that level on all.
      const restore = values.onoff === true && typeof values.dim !== 'number';
      const pct = this._levelFor(values);
      // Decided before the await below, so a level that comes in meanwhile
      // always replaces a held "on".
      if (this._onWaitTimer) {
        this.homey.clearTimeout(this._onWaitTimer);
        this._onWaitTimer = null;
      }
      if (restore) {
        // A level that follows within ON_WAIT_MS replaces this "on".
        this._onWaitTimer = this.homey.setTimeout(() => {
          this._onWaitTimer = null;
          this._restore = true;
          this._request(pct);
        }, ON_WAIT_MS);
      } else {
        this._restore = false;
        this._request(pct);
      }
      // The Homey app reads the tile back when this listener answers and then
      // ignores updates for a moment, so both values must be stored by then.
      await this._show(pct, true);
    }, DIM_DEBOUNCE_MS);

    this._infoLog('group ready');
  }

  // Turn one coupled onoff/dim change into a single 0..100 level.
  //   both set   — dragging the slider on a dark group: dim wins, unless the
  //                gesture explicitly asks for off.
  //   dim only   — slider on a lit group; 0 means off.
  //   onoff only — the power button: restore the last level the group was at.
  _levelFor(values) {
    const { onoff, dim } = values;
    let pct;

    if (typeof dim === 'number') {
      pct = Math.round(dim * 100);
      if (onoff === false) pct = 0;
    } else if (typeof onoff === 'boolean') {
      // On: show the brightest level the members will come back to.
      pct = onoff ? Math.max(1, ...this._members().map((member) => this._restoreLevel(member))) : 0;
    } else {
      return 0;
    }

    pct = Math.max(0, Math.min(100, pct));
    this._remember(pct);
    return pct;
  }

  // Never remember 0 as the level to come back to.
  _remember(pct) {
    if (pct <= 0 || pct / 100 === this._lastDim) return;
    this._lastDim = pct / 100;
    this.setStoreValue('lastDim', this._lastDim).catch(() => {});
  }

  // Ids of the member dimmers, as chosen at pairing. A group paired before
  // members could be chosen has none stored, and drives every dimmer.
  getMemberIds() {
    const stored = this.getStoreValue('members');
    return Array.isArray(stored) ? stored : null;
  }

  async setMemberIds(members) {
    await this.setStoreValue('members', members);
    // Forget levels of dimmers that may no longer belong.
    this._levels.clear();
    this._infoLog(`group members: ${members.join(', ')}`);
  }

  // The level a dimmer returns to when it is switched on again.
  _restoreLevel(member) {
    const last = Number(member._lastDim);
    return Math.max(1, Math.min(100, Math.round((last > 0 ? last : this._lastDim) * 100)));
  }

  // First generation dimmers only (they have getMeshId), also for a group
  // with no stored members: later generations in the same driver are not
  // group members in 2.5.0.
  _members() {
    try {
      const ids = this.getMemberIds();
      const dimmers = this.homey.drivers.getDriver(MEMBER_DRIVER).getDevices()
        .filter((device) => typeof device.getMeshId === 'function');
      return ids ? dimmers.filter((dimmer) => ids.includes(dimmer.getData().id)) : dimmers;
    } catch (err) {
      this.error(`listing dimmers failed: ${err.message || err}`);
      return [];
    }
  }

  _show(pct, force = false) {
    if (pct === this._shown && !force) return undefined;
    this._shown = pct;
    return Promise.all([
      this.setCapabilityValue('onoff', pct > 0).catch(() => {}),
      this.setCapabilityValue('dim', pct / 100).catch(() => {}),
    ]);
  }

  _request(pct) {
    // Only the newest gesture is fanned out.
    this._pending = pct;
    this._pendingRestore = this._restore === true;
    if (this._fanOutTimer) return;
    this._fanOutTimer = this.homey.setTimeout(() => {
      this._fanOutTimer = null;
      this._fanOut(this._pending, this._pendingRestore);
    }, FAN_OUT_DELAY_MS);
  }

  _fanOut(pct, restore = false) {
    const members = this._members();
    let sent = 0;

    for (const member of members) {
      // Each dimmer is commanded with its own location id; one that has not
      // reported it yet keeps the level (see SGDeviceBase._keep).
      if (typeof member.getLocationId === 'function' && member.getLocationId() === null) {
        this._infoLog(`group: dimmer 0x${member.getMeshId().toString(16).padStart(4, '0')} waits: location id not learned yet, `
          + 'the level goes out with its first status, or after 10 s with the other dimmers\' location id');
      }
      // Switched on as a room, a dimmer has just restored its own level, and
      // one that is already lit is left where it is.
      if (restore && member._lastAppliedLevel > 0) {
        this._levels.set(member.getMeshId(), member._lastAppliedLevel);
        continue;
      }
      const level = restore ? this._restoreLevel(member) : pct;
      this._levels.set(member.getMeshId(), level);
      // A level the dimmer is already sending, or has just delivered, is
      // skipped (and logged) by the dimmer itself.
      // A level set from the group is the level the dimmer comes back to.
      if (!restore && level > 0) member._lastDim = level / 100;
      member._request(level);
      sent += 1;
    }

    const what = restore ? 'on, each at its own level' : `level=${pct}`;
    this._infoLog(`group ${what}: passed to ${sent} of ${members.length} dimmer(s)`);
  }

  async onDeleted() {
    if (this._fanOutTimer) this.homey.clearTimeout(this._fanOutTimer);
    if (this._onWaitTimer) this.homey.clearTimeout(this._onWaitTimer);
  }

  // Called by the app for every status frame heard on the mesh. The group is
  // on while any member is, and shows the brightest member's level.
  applyMeshStatus(idHex, level) {
    const id = parseInt(idHex, 16);
    const member = this._members().find((dimmer) => dimmer.getMeshId() === id);
    if (!member) return;

    // The dimmer has already decided what it shows (fade and rounding
    // ignored); the group follows that.
    const shown = typeof member._lastAppliedLevel === 'number' ? member._lastAppliedLevel : level;
    this._levels.set(id, Math.max(0, Math.min(100, Math.round(shown))));
    // A gesture is still on its way to the dimmers; the tile already shows it.
    if (this._onWaitTimer || this._fanOutTimer) return;
    const pct = Math.max(0, ...this._levels.values());
    this._remember(pct);
    this._show(pct);
  }
}

module.exports = SGGroupDevice;
