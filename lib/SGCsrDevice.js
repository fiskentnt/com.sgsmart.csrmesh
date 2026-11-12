'use strict';

const Homey = require('homey');
const { makePacket, resolveKey } = require('./csrmesh');
const { LOG_PER_SENDER, LOG_WINDOW_MS, NAME_LISTEN_MS } = require('./CsrNetwork');
const { csrLevelData, isDeviceMeshId } = require('./sgProtocol');
const { CSR_PRODUCTS, RECALLED_PREFIXES, TYPE_PREFIXES } = require('./sgProducts');
const { CHANGE_AFTER, learnLocation, otherLocationLine } = require('./location');
const { CommandTimer } = require('./commandTiming');

// One of SG's CSRmesh products after the first generation (Gen2 to Gen4), a
// trial in 2.5.0: a Pill (sg_pill) or a rotary dimmer (sg_mesh, which picks
// this class in onMapDeviceClass), with onoff and dim, or onoff alone for an
// ON-OFF Pill. Commands are FF03 to its mesh id, status is FF05 or FF50
// (lib/CsrNetwork.js hands them over). The formats are assumed: none of these
// products has been tested with Homey yet, and the SG phone app is the
// reference for level and status.
//
// Its methods are named getCsrMeshId and getCsrLocationId, not getMeshId and
// getLocationId, so the first generation bookkeeping in app.js and the group
// leave it out.

// onoff and dim come in the same breath when a slider is dragged on a dark lamp.
const DIM_DEBOUNCE_MS = 250;
// The tid in FF03: one up per command, and 1 again only when more than this
// many whole seconds have passed both since the last command and since the
// last request this app sent the device (an FF04 read-back or poll, or any
// other: lib/CsrNetwork.js, noteAsked), so from 11 s after both. A device is
// assumed to keep the last tid it took for a while after a command and after
// a request, and to drop a command whose tid is not newer meanwhile (not
// tried); counting on is never older, so it is the safe side.
const TID_RESET_S = 10;
// A Gen3 or Gen4 device is assumed to send the same FF05 more than once (not
// tried). An exact copy of the last status taken (the same bytes, or the same
// fields when the bytes are not known) less than COPY_MS after it is dropped;
// anything else is taken. The number in byte 4 is not used to order statuses:
// it is assumed not to follow from one command to the next, so a lower one
// can be the newer status (not tried). Gen2 is not checked.
const COPY_MS = 2000;
// After a command from here to a dimmer, its status (FF05 and FF50) is not
// taken for this long: it may be from before the command, or from the way
// to the new level (assumed, not tried).
const QUIET_MS = 8000;
// One FF04 this long after the last command to a device, to read it back: a
// dimmer, and a device without dimming, so the log shows whether on and off
// reached it.
const READ_BACK_MS = 9000;
// A dimmer turned on without a level: FF03 pwr 01 with level 00, and the
// dimmer is assumed to come on at the level it keeps itself (not tried).
const ON = 'on';
// Siri (through HomeKit) and Matter send "on" and the level as two changes,
// mostly about 0.3 s apart, as to the first generation (lib/SGDeviceBase.js,
// the same wait). "On" without a level to a dimmer not known to be on waits
// this long for a level, so the lamp does not first go to the level it keeps;
// to one known to be on, nothing is sent. Off and levels are not held. A
// device without dimming is not held either.
const ON_WAIT_MS = 800;
// Status is asked for this long after start, and then this often.
const FIRST_STATUS_MS = 15000;
const STATUS_EVERY_MS = 10 * 60 * 1000;
// A level asked for before the location id is known waits at most this long.
const KEPT_LEVEL_MS = 30000;

const hex4 = (value) => `0x${value.toString(16).padStart(4, '0')}`;

class SGCsrDevice extends Homey.Device {
  async onInit() {
    // The time from a command to its first status, for the log.
    this._commandTimer = new CommandTimer(this);
    // A fake device (lib/fakeDevices.js) with no fake network in this run:
    // nothing is sent or asked, it is only shown as unavailable.
    if (!this._net()) {
      this.log('fake device, but no fake network in this run: nothing is sent');
      await this.setUnavailable(this.homey.__('device.fakeLeftOver')).catch(() => {});
      return;
    }
    this._tid = 0;
    this._lastTxAt = 0;
    this._lastTaken = null;
    this._quietUntil = 0;
    this._readBack = null;
    this._stopped = false;
    this._pendingLevel = null;
    this._keptTimer = null;
    this._onWaitTimer = null;
    // Whether the device is on as far as is known: from its status and from
    // what was asked here; null when not known (at start, and after a
    // command that did not get out).
    this._knownOn = null;
    this._asked = null; // the level asked for last

    const capabilities = this.hasCapability('dim') ? ['onoff', 'dim'] : ['onoff'];
    this.registerMultipleCapabilityListener(capabilities, async (values) => {
      this._onCapabilities(values);
    }, DIM_DEBOUNCE_MS);

    await this.updateAvailability();
    if (typeof this.homey.app.laterDevicesChanged === 'function') this.homey.app.laterDevicesChanged();
    this._firstStatus = this.homey.setTimeout(() => this.requestStatus(), FIRST_STATUS_MS);
    this._statusTimer = this.homey.setInterval(() => this.requestStatus(), STATUS_EVERY_MS);
    const location = this.getCsrLocationId();
    this.log(`SG device ready (${this.getStoreValue('prefix')}, ${this.getStoreValue('kind')}, `
      + `mesh id ${hex4(this.getCsrMeshId())}, loc ${location === null ? 'not known yet' : hex4(location)})`);
  }

  async onDeleted() {
    this._stopTimers();
    if (typeof this.homey.app.laterDevicesChanged === 'function') this.homey.app.laterDevicesChanged();
  }

  async onUninit() {
    this._stopTimers();
  }

  // Deleted or stopped: no read-back is set after this either, also not by a
  // command whose send ends later.
  _stopTimers() {
    this._stopped = true;
    if (this._commandTimer) this._commandTimer.stop();
    if (this._firstStatus) this.homey.clearTimeout(this._firstStatus);
    if (this._statusTimer) this.homey.clearInterval(this._statusTimer);
    if (this._keptTimer) this.homey.clearTimeout(this._keptTimer);
    if (this._readBack) this.homey.clearTimeout(this._readBack);
    this._readBack = null;
    this._cancelOnWait();
  }

  // One gesture from Homey, after the debounce: "on" alone to a dimmer waits
  // ON_WAIT_MS for a level (or sends nothing when it is known to be on);
  // everything else goes at once.
  _onCapabilities(values) {
    this._cancelOnWait();
    if (this.hasCapability('dim') && values.onoff === true && typeof values.dim !== 'number') {
      if (this._knownOn === true) {
        this.log('"on" while on: nothing sent');
        return;
      }
      this._onWaitTimer = this.homey.setTimeout(() => {
        this._onWaitTimer = null;
        this._userLevel(ON);
      }, ON_WAIT_MS);
      return;
    }
    this._userLevel(this._levelFor(values));
  }

  _cancelOnWait() {
    if (this._onWaitTimer) this.homey.clearTimeout(this._onWaitTimer);
    this._onWaitTimer = null;
  }

  // What this device sends and asks through: the app (its bridge, network,
  // seq and the rest), or for a fake device the fake network
  // (app.networkFor); null for a fake device without one.
  _net() {
    const { app } = this.homey;
    return typeof app.networkFor === 'function' ? app.networkFor(this) : app;
  }

  // _net() for what is to be done, or null with a line in the log: a fake
  // device without its network (onInit) sends and asks nothing.
  _netFor(what) {
    const net = this._net();
    if (!net) this.log(`${what}: nothing done, fake device without a fake network in this run`);
    return net;
  }

  getCsrMeshId() {
    return Number(this.getStoreValue('meshId')) & 0xffff;
  }

  // The device's own settings, or while they are the default the home's
  // passphrase from the SG account (lib/csrmesh.js, resolveKey).
  getNetworkKey() {
    const app = this.homey && this.homey.app;
    return resolveKey(this.getSettings(), app && typeof app.accountPassphrase === 'function' ? app.accountPassphrase(this) : null);
  }

  getCsrLocationId() {
    if (this._location && Number.isInteger(this._location.value)) return this._location.value;
    const stored = this.getStoreValue('locationId');
    return Number.isInteger(stored) ? stored : null;
  }

  // As the first generation (lib/location.js): the first is taken at once,
  // another only after CHANGE_AFTER in a row.
  _learnLocation(location) {
    const before = this.getCsrLocationId();
    const { state, outcome } = learnLocation(this._location || { value: before, other: null, count: 0 }, location);
    this._location = state;
    if (outcome === 'learned' || outcome === 'changed') {
      this.setStoreValue('locationId', state.value).catch((err) => this.error(`storing the location id failed: ${err.message || err}`));
      this.log(outcome === 'learned'
        ? `location id learned: ${hex4(state.value)}`
        : `location id changed: ${hex4(before)} to ${hex4(state.value)} (heard ${CHANGE_AFTER} times in a row)`);
      this.updateAvailability();
      this._sendKept();
    }
    return outcome;
  }

  // Never unavailable. A warning while no status can be read at all
  // (password), while the location id is not known, or while nothing has
  // been heard from it for a while (the app's notHeard); for a recalled
  // product (RECALLED_PREFIXES), that it is recalled, always, and on and off
  // still work. A device without dimming has texts of its own, which do not
  // say dimmer.
  async updateAvailability() {
    const net = this._netFor('availability');
    if (!net) return;
    const unreadable = net.statusUnreadableText ? net.statusUnreadableText() : null;
    await this.setAvailable().catch(() => {});
    const dimmer = this.hasCapability('dim');
    let warning = null;
    let reason = null;
    if (RECALLED_PREFIXES.includes(this.getStoreValue('prefix'))) {
      warning = this.homey.__('device.recalled');
      reason = 'recalled product';
    } else if (unreadable) {
      warning = unreadable;
      reason = 'suspected wrong password';
    } else if (this.getCsrLocationId() === null) {
      warning = this.homey.__(dimmer ? 'device.waitingForStatus' : 'device.waitingForStatusDevice');
      reason = 'waiting for the first status';
    } else if (typeof net.notHeard === 'function' && net.notHeard(this)) {
      warning = this.homey.__(dimmer ? 'device.notHeard' : 'device.notHeardDevice');
      reason = 'nothing heard from it';
    }
    if (warning === this._warningShown) return;
    const shown = this._warningShown;
    this._warningShown = warning;
    if (warning) this.log(`warning shown: ${reason}`);
    else if (shown) this.log('warning cleared');
    if (warning) await this.setWarning(warning).catch(() => {});
    else await this.unsetWarning().catch(() => {});
  }

  // One gesture: a level 0..100, or ON for a dimmer turned on without a
  // level. A device without dimming has only on (100 here) and off (0);
  // _send turns them into FF03 on and off.
  _levelFor({ onoff, dim }) {
    if (!this.hasCapability('dim')) return onoff === false ? 0 : 100;
    if (typeof dim !== 'number') return onoff ? ON : 0;
    return onoff === false ? 0 : Math.max(0, Math.min(100, Math.round(dim * 100)));
  }

  // The location id this command goes out with: its own, or the one the other
  // devices share (the first generation dimmers of the same home), or, in a
  // home without a first generation dimmer in Homey, its home's in the SG
  // account (_accountLocation). Without any, the command is kept (_keep).
  _locationForCommand() {
    const own = this.getCsrLocationId();
    if (own !== null) return { location: own, borrowed: false };
    const net = this._net();
    const shared = net && net.sharedLocation ? net.sharedLocation(null) : null;
    if (shared !== null) return { location: shared, borrowed: 'the other devices' };
    const location = this._accountLocation();
    return location === null ? null : { location, borrowed: 'the SG account' };
  }

  // Its home's location id in the SG account, or null. Only when the account
  // has this mesh id as one device in the homes the app speaks with, of this
  // product (TYPE_PREFIXES), with one location id (lib/account.js,
  // deviceLocations and typeInNetwork), and not when the device itself said
  // it is in no home (applyCsrName, _saidNoHome). Not with a first
  // generation dimmer in Homey.
  _accountLocation() {
    const { app } = this.homey;
    if (this._saidNoHome || !app || typeof app.dimmerCount !== 'function' || app.dimmerCount() !== 0) return null;
    const { account } = app;
    if (!account || typeof account.deviceLocations !== 'function' || typeof account.typeInNetwork !== 'function') return null;
    const meshId = this.getCsrMeshId();
    if (TYPE_PREFIXES[account.typeInNetwork(meshId)] !== this.getStoreValue('prefix')) return null;
    const location = account.deviceLocations().get(meshId);
    return Number.isInteger(location) ? location : null;
  }

  // A level chosen in Homey: the tile, a Flow card or a voice assistant.
  _userLevel(level) {
    this._request(level);
  }

  _request(level) {
    if (!this._netFor(`command level=${level}`)) return;
    this._asked = level;
    this._knownOn = level === ON || level > 0;
    const target = this._locationForCommand();
    if (!target) {
      this._keep(level);
      return;
    }
    // Not sent, and nothing newer asked meanwhile: the state is not known.
    const unknownIfNotSent = (sent) => {
      if (!sent && this._asked === level) this._knownOn = null;
    };
    this._send(level, target).then(unknownIfNotSent, (err) => {
      this.error(`send failed: ${err.message || err}`);
      unknownIfNotSent(false);
    });
  }

  // No location id yet: the newest level waits, a name request asks for it
  // (FF11 carries it), and it goes when the location id comes, or is dropped
  // after KEPT_LEVEL_MS.
  _keep(level) {
    const net = this._netFor(`command level=${level}`);
    if (!net) return;
    this._pendingLevel = level;
    this.log(`command level=${level} kept: location id not known yet`);
    net.csr.requestNames({ asked: true, listenMs: NAME_LISTEN_MS }).catch(() => {});
    if (this._keptTimer) return;
    this._keptTimer = this.homey.setTimeout(() => {
      this._keptTimer = null;
      if (this._pendingLevel === null) return;
      this.log(`kept level ${this._pendingLevel} dropped: no location id in ${KEPT_LEVEL_MS / 1000} s`);
      this._pendingLevel = null;
    }, KEPT_LEVEL_MS);
  }

  _sendKept() {
    if (this._pendingLevel === null) return;
    const level = this._pendingLevel;
    this._pendingLevel = null;
    if (this._keptTimer) this.homey.clearTimeout(this._keptTimer);
    this._keptTimer = null;
    this.log(`location id known: sending the kept level ${level}`);
    this._request(level);
  }

  // FF03, once, with white 0 for every product: this app never sets the
  // colour temperature, and 0 is assumed to leave it as it is (not tried). A
  // device without dimming is set with pwr 01 and level 00 for on, and 00 00
  // for off; a dimmer turned on without a level (ON) gets pwr 01 and level 00
  // as well (assumed: not tried with a device). After a command to a dimmer,
  // its status is not taken for QUIET_MS. To any device, one FF04 goes
  // READ_BACK_MS after the last command.
  async _send(level, { location, borrowed }) {
    const net = this._netFor(`command FF03 level=${level}`);
    if (!net) return false;
    // Never to 0, a group or this app's own address: only to one device.
    if (!isDeviceMeshId(this.getCsrMeshId())) {
      this.log(`command FF03 level=${level} not sent: mesh id ${hex4(this.getCsrMeshId())} is not one device's`);
      return false;
    }
    // Never to a mesh id that the network now knows as a thermostat's.
    if (net.csr && net.csr.isThermostat(this.getCsrMeshId())) {
      this.log(`command FF03 id=${hex4(this.getCsrMeshId())} level=${level} not sent: that mesh id is a thermostat's now`);
      return false;
    }
    const now = Date.now();
    const meshId = this.getCsrMeshId();
    const askedAt = net.csr && typeof net.csr.lastAskedAt === 'function' ? net.csr.lastAskedAt(meshId) : 0;
    const quietSince = (at) => Math.floor((now - at) / 1000) > TID_RESET_S;
    this._tid = quietSince(this._lastTxAt) && quietSince(askedAt) ? 1 : (this._tid % 0xffff) + 1;
    this._lastTxAt = now;
    const dimmable = this.hasCapability('dim');
    // A level of its own, not only on or off.
    const own = dimmable && level !== ON;
    const on = level === ON || level > 0;
    const data = own ? csrLevelData({ meshId, location, level, tid: this._tid })
      : csrLevelData({ meshId, location, level: 0, on, tid: this._tid });
    const seq = net.nextSeq();
    const shown = own ? `level=${level}` : `${on ? 'on' : 'off'} level=0`;
    this.log(`command FF03 id=${hex4(meshId)} ${shown} loc=${hex4(location)}${borrowed ? ` (from ${borrowed})` : ''} `
      + `tid=${this._tid} seq=0x${seq.toString(16).padStart(6, '0')}`);
    if (dimmable) this._quiet();
    // Its status after the command counts as asked (lib/CsrNetwork.js).
    const asked = () => {
      if (net.csr && typeof net.csr.noteAsked === 'function') net.csr.noteAsked(meshId);
    };
    asked();
    const result = await net.bridge.send(makePacket(this.getNetworkKey(), seq, data), { key: `csr:${meshId}`, level });
    if (result && result.ok) asked();
    if (this._commandTimer) this._commandTimer.sent(result);
    // Counted again from when it went out, which a slow link may delay.
    if (dimmable) this._quiet();
    this._readBackSoon(net);
    return !!(result && result.ok);
  }

  _quiet() {
    this._quietUntil = Date.now() + QUIET_MS;
  }

  // One FF04 READ_BACK_MS after the last command to a device, on a link that
  // listens for the FF05 (lib/CsrNetwork.js). For a dimmer it ends the quiet
  // time, which is over by then: its answer is the status after the command.
  // A read-back that fails gets a line in the log.
  _readBackSoon(net) {
    if (this._stopped) return;
    if (this._readBack) this.homey.clearTimeout(this._readBack);
    this._readBack = this.homey.setTimeout(() => {
      this._readBack = null;
      const failed = (err) => this.error(`read-back failed: ${err.message || err}`);
      try {
        this._quietUntil = 0;
        const location = this.getCsrLocationId();
        if (location !== null) net.csr.requestStatus(this.getCsrMeshId(), location).catch(failed);
      } catch (err) {
        failed(err);
      }
    }, READ_BACK_MS);
  }

  requestStatus() {
    const net = this._netFor('status request');
    if (!net) return;
    const location = this.getCsrLocationId();
    const { csr } = net;
    if (location === null) {
      csr.requestNames({ asked: true, listenMs: NAME_LISTEN_MS }).catch(() => {});
      return;
    }
    // Through the poll queue (lib/CsrNetwork.js, queueStatus), so the devices
    // whose timers coincide are asked one at a time.
    if (typeof csr.queueStatus === 'function') csr.queueStatus(this.getCsrMeshId(), location);
    else csr.requestStatus(this.getCsrMeshId(), location).catch(() => {});
  }

  // FF11 from this device (lib/CsrNetwork.js). One with location id 0 says
  // the device is in no home (assumed: not tried with a device), kept in
  // memory until an FF11 with another one: the SG account's location id is
  // not used for it then (_accountLocation).
  applyCsrName(name) {
    this._saidNoHome = name.location === 0;
    if (name.location) this._learnLocation(name.location);
  }

  // Whether an exact copy of the last status taken is dropped: for Gen3 and
  // Gen4, not for Gen2.
  _dropsCopies() {
    const product = CSR_PRODUCTS[this.getStoreValue('prefix')];
    return !!product && product.generation !== 'Gen2';
  }

  // FF05 or FF50 from this device (lib/CsrNetwork.js): true when it was
  // taken. Not within QUIET_MS of a command from here to a dimmer. The white
  // value is only logged, for a product with tunable white.
  applyCsrStatus(status, kind, bytes = null) {
    if (status.location && this._learnLocation(status.location) === 'other') {
      if (!this._otherLines) this._otherLines = new Map();
      const line = otherLocationLine(this._otherLines, this._location, `status ${kind}`, Date.now(),
        { windowMs: LOG_WINDOW_MS, perWindow: LOG_PER_SENDER });
      if (line) this.log(line);
      return false;
    }
    if (this._commandTimer) this._commandTimer.status();
    const now = Date.now();
    if (now < this._quietUntil) {
      this.log(`status ${kind} not taken: within ${QUIET_MS / 1000} s of a command from here`);
      return false;
    }
    const print = `${kind} ${bytes ? Buffer.from(bytes).toString('hex') : JSON.stringify([status.location, status.on,
      status.level, status.number, status.firmware, status.white, status.flags])}`;
    if (kind === 'FF05' && this._dropsCopies() && this._lastTaken && this._lastTaken.print === print
      && now - this._lastTaken.at < COPY_MS) {
      return false; // an exact copy of the last status taken
    }
    this._lastTaken = { print, at: now };
    this._knownOn = status.on;
    const white = this.getStoreValue('tunableWhite') && Number.isInteger(status.white) ? status.white : null;
    const changes = [this.setCapabilityValue('onoff', status.on)];
    if (this.hasCapability('dim') && status.level !== null && status.level > 0) {
      changes.push(this.setCapabilityValue('dim', status.level / 100));
    }
    Promise.all(changes).catch(() => {});
    const line = `status ${kind} applied: on=${status.on} level=${status.level === null ? '-' : status.level}`
      + `${white !== null ? ` white=${white}` : ''}`;
    if (typeof this.homey.app.logStatus === 'function') this.homey.app.logStatus(this, line);
    else this.log(line);
    return true;
  }
}

module.exports = SGCsrDevice;
