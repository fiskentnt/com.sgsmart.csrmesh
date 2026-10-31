'use strict';

const Homey = require('homey');
const { makePacket, resolveKey } = require('./csrmesh');
const { NAME_LISTEN_MS } = require('./CsrNetwork');
const { csrLevelData } = require('./sgProtocol');
const { CSR_PRODUCTS } = require('./sgProducts');
const { CHANGE_AFTER, learnLocation } = require('./location');

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
// The tid in FF03: one up per command, and 1 again when more than this many
// whole seconds have passed since the last one, so from 11 s. A device is
// assumed to drop a command whose tid is not newer than the last one it took
// within that time (not tried).
const TID_RESET_S = 10;
// A Gen3 or Gen4 device is assumed to number its FF05 in byte 4, and to send
// one again with the same number (not tried). Such an FF05, or one with an
// older number, is dropped while no more than this many whole seconds have
// passed since the last status taken (FF05 or FF50), so from 9 s on any is
// taken. Older is lower, unless the number has gone round: less than
// NUMBER_WRAP back over 255. Gen2 is not checked.
const STATUS_REPEAT_S = 8;
const NUMBER_WRAP = 20;
// Status is asked for this long after start, and then this often.
const FIRST_STATUS_MS = 15000;
const STATUS_EVERY_MS = 10 * 60 * 1000;
// A level asked for before the location id is known waits at most this long.
const KEPT_LEVEL_MS = 30000;

const hex4 = (value) => `0x${value.toString(16).padStart(4, '0')}`;

class SGCsrDevice extends Homey.Device {
  async onInit() {
    const storedDim = this.getCapabilityValue('dim');
    this._lastDim = typeof storedDim === 'number' && storedDim > 0 ? storedDim : 1;
    this._tid = 0;
    this._lastTxAt = 0;
    this._number = null;
    this._statusAt = 0;
    this._white = null;
    this._pendingLevel = null;
    this._keptTimer = null;

    const capabilities = this.hasCapability('dim') ? ['onoff', 'dim'] : ['onoff'];
    this.registerMultipleCapabilityListener(capabilities, async (values) => {
      this._request(this._levelFor(values));
    }, DIM_DEBOUNCE_MS);

    await this.updateAvailability();
    this._firstStatus = this.homey.setTimeout(() => this.requestStatus(), FIRST_STATUS_MS);
    this._statusTimer = this.homey.setInterval(() => this.requestStatus(), STATUS_EVERY_MS);
    const location = this.getCsrLocationId();
    this.log(`SG device ready (${this.getStoreValue('prefix')}, ${this.getStoreValue('kind')}, `
      + `mesh id ${hex4(this.getCsrMeshId())}, loc ${location === null ? 'not known yet' : hex4(location)})`);
  }

  async onDeleted() {
    this._stopTimers();
  }

  async onUninit() {
    this._stopTimers();
  }

  _stopTimers() {
    if (this._firstStatus) this.homey.clearTimeout(this._firstStatus);
    if (this._statusTimer) this.homey.clearInterval(this._statusTimer);
    if (this._keptTimer) this.homey.clearTimeout(this._keptTimer);
  }

  getCsrMeshId() {
    return Number(this.getStoreValue('meshId')) & 0xffff;
  }

  getNetworkKey() {
    return resolveKey(this.getSettings());
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

  // Never unavailable. A warning while no status can be read at all (password)
  // or while the location id is not known.
  async updateAvailability() {
    const unreadable = this.homey.app.statusUnreadableText ? this.homey.app.statusUnreadableText() : null;
    await this.setAvailable().catch(() => {});
    let warning = unreadable;
    if (!warning && this.getCsrLocationId() === null) warning = this.homey.__('device.waitingForStatus');
    if (warning === this._warningShown) return;
    const shown = this._warningShown;
    this._warningShown = warning;
    if (warning) this.log(`warning shown: ${unreadable ? 'suspected wrong password' : 'waiting for the first status'}`);
    else if (shown) this.log('warning cleared');
    if (warning) await this.setWarning(warning).catch(() => {});
    else await this.unsetWarning().catch(() => {});
  }

  // One gesture: a level 0..100. A device without dimming has only on (100
  // here) and off (0); _send turns them into FF03 on and off.
  _levelFor({ onoff, dim }) {
    if (!this.hasCapability('dim')) return onoff === false ? 0 : 100;
    let pct;
    if (typeof dim === 'number') pct = onoff === false ? 0 : Math.round(dim * 100);
    else pct = onoff ? Math.max(1, Math.round(this._lastDim * 100)) : 0;
    pct = Math.max(0, Math.min(100, pct));
    if (pct > 0) this._lastDim = pct / 100;
    return pct;
  }

  // The location id this command goes out with: its own, or the one the other
  // devices share (the first generation dimmers of the same home).
  _locationForCommand() {
    const own = this.getCsrLocationId();
    if (own !== null) return { location: own, borrowed: false };
    const shared = this.homey.app.sharedLocation ? this.homey.app.sharedLocation(null) : null;
    return shared === null ? null : { location: shared, borrowed: true };
  }

  _request(level) {
    const target = this._locationForCommand();
    if (!target) {
      this._keep(level);
      return;
    }
    this._send(level, target).catch((err) => this.error(`send failed: ${err.message || err}`));
  }

  // No location id yet: the newest level waits, a name request asks for it
  // (FF11 carries it), and it goes when the location id comes, or is dropped
  // after KEPT_LEVEL_MS.
  _keep(level) {
    this._pendingLevel = level;
    this.log(`command level=${level} kept: location id not known yet`);
    this.homey.app.csr.requestNames({ asked: true, listenMs: NAME_LISTEN_MS }).catch(() => {});
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

  // FF03, once. The white value is the last one the device reported, so a tap
  // does not change the colour temperature of a tunable white product. A
  // device without dimming is set with pwr 01 and level 00 for on, and 00 00
  // for off (assumed: not tried with a device).
  async _send(level, { location, borrowed }) {
    const now = Date.now();
    this._tid = Math.floor((now - this._lastTxAt) / 1000) > TID_RESET_S ? 1 : (this._tid % 0xffff) + 1;
    this._lastTxAt = now;
    const white = this.getStoreValue('tunableWhite') && Number.isInteger(this._white) ? this._white : 0;
    const meshId = this.getCsrMeshId();
    const dimmable = this.hasCapability('dim');
    const data = dimmable ? csrLevelData({ meshId, location, level, tid: this._tid, white })
      : csrLevelData({ meshId, location, level: 0, on: level > 0, tid: this._tid, white });
    const seq = this.homey.app.nextSeq();
    const shown = dimmable ? `level=${level}` : `${level > 0 ? 'on' : 'off'} level=0`;
    this.log(`command FF03 id=${hex4(meshId)} ${shown} loc=${hex4(location)}${borrowed ? ' (from the other devices)' : ''} `
      + `tid=${this._tid} white=${white} seq=0x${seq.toString(16).padStart(6, '0')}`);
    const result = await this.homey.app.bridge.send(makePacket(this.getNetworkKey(), seq, data), { key: `csr:${meshId}`, level });
    return !!(result && result.ok);
  }

  requestStatus() {
    const location = this.getCsrLocationId();
    if (location === null) {
      this.homey.app.csr.requestNames({ asked: true, listenMs: NAME_LISTEN_MS }).catch(() => {});
      return;
    }
    this.homey.app.csr.requestStatus(this.getCsrMeshId(), location).catch(() => {});
  }

  // FF11 from this device (lib/CsrNetwork.js).
  applyCsrName(name) {
    if (name.location) this._learnLocation(name.location);
  }

  // Whether the number in FF05 is checked: for Gen3 and Gen4, not for Gen2.
  _checksNumber() {
    const product = CSR_PRODUCTS[this.getStoreValue('prefix')];
    return !!product && product.generation !== 'Gen2';
  }

  _newerNumber(number) {
    if (number > this._number) return true;
    if (number === this._number) return false;
    return number + 255 - this._number < NUMBER_WRAP;
  }

  // FF05 or FF50 from this device (lib/CsrNetwork.js).
  applyCsrStatus(status, kind) {
    if (status.location && this._learnLocation(status.location) === 'other') return;
    const now = Date.now();
    if (kind === 'FF05' && this._checksNumber()) {
      // A status without byte 4 counts as 256: higher than any byte, the
      // first is taken and the next within the time is the same.
      const number = status.number === null ? 256 : status.number;
      if (this._number !== null && this._statusAt
        && Math.floor((now - this._statusAt) / 1000) <= STATUS_REPEAT_S && !this._newerNumber(number)) {
        return; // the same or an older number
      }
      this._number = number;
    }
    this._statusAt = now;
    if (Number.isInteger(status.white)) this._white = status.white;
    const changes = [this.setCapabilityValue('onoff', status.on)];
    if (this.hasCapability('dim') && status.level !== null && status.level > 0) {
      this._lastDim = status.level / 100;
      changes.push(this.setCapabilityValue('dim', status.level / 100));
    }
    Promise.all(changes).catch(() => {});
    this.log(`status ${kind} applied: on=${status.on} level=${status.level === null ? '-' : status.level}`
      + `${Number.isInteger(status.white) ? ` white=${status.white}` : ''}`);
  }
}

module.exports = SGCsrDevice;
