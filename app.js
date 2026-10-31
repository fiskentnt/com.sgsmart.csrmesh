'use strict';

const Homey = require('homey');
const MeshBridge = require('./lib/MeshBridge');
const { deriveNetworkKey, DEFAULT_PASSPHRASE, meshIdFromName } = require('./lib/csrmesh');
const { learnLocation } = require('./lib/location');
const { FileLog, maskLog } = require('./lib/FileLog');
const { CsrNetwork } = require('./lib/CsrNetwork');

// App settings and their defaults. keepConnected ("Keep dimmers connected")
// has no stored default: unset, it follows the number of dimmers; see
// MeshBridge._keepConnected().
const DEFAULTS = {
  debugLogging: false,     // verbose BLE/GATT tracing, for troubleshooting only
};

// No status from a dimmer for this long: show a warning on it. A held link
// usually hears every dimmer about every 1.5 s, but the bridge itself has gone
// quiet for up to about 2 min; without it, a status poll runs every five
// minutes and can miss a round or two.
const NOT_HEARD_HELD_MS = 5 * 60 * 1000;
const NOT_HEARD_POLL_MS = 30 * 60 * 1000;
const NOT_HEARD_CHECK_MS = 60 * 1000;
// "Show log" on the settings page shows this many of the latest lines.
const LOG_VIEW_LINES = 500;

class SGSmartApp extends Homey.App {
  async onInit() {
    // A copy of the app's log in /userdata, always on, for "Show log".
    this.fileLog = new FileLog(this.homey);
    this.fileLog.install();

    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (this.homey.settings.get(key) === null) this.homey.settings.set(key, value);
    }

    this._startNotHeardCheck();
    // Location id per mesh id, from every status heard, learned as a dimmer
    // learns its own (see lib/location.js).
    this._locations = new Map();
    // Set when no status could be read at all (MeshBridge._startKeyCheck).
    this._statusUnreadable = false;
    // The timeline notification for that goes out at most once per start.
    this._passwordNotified = false;
    this.bridge = new MeshBridge(this);
    this.bridge.startStatus((idHex, level, location) => this._dispatchStatus(idHex, level, location));
    // SG's later CSRmesh products (lib/SGCsrDevice.js, a trial in 2.5.0).
    this.csr = new CsrNetwork(this);
    this.bridge.onFrame((frame) => this.csr.handleFrame(frame));
    this.csr.start();

    // "Keep dimmers connected" takes effect at once, without a restart.
    this.homey.settings.on('set', (key) => {
      if (key === 'keepConnected') this.bridge.applyMode();
    });

    let seq = Number(this.homey.settings.get('seqCounter'));
    if (!Number.isInteger(seq) || seq < 0 || seq > 0xFFFFFF) {
      seq = 0x800000;
      this.homey.settings.set('seqCounter', seq);
    }
    this._seq = seq;

    this.log(`SG LEDDim v${this.homey.manifest.version} initialized`);
  }

  // Homey keeps BLE connections outside the app process: one left open here
  // survives an app restart and is only cleared by rebooting Homey. Release it.
  async onUninit() {
    if (this._notHeardTimer) this.homey.clearInterval(this._notHeardTimer);
    if (this.csr) this.csr.stop();
    if (this.bridge) {
      await this.bridge.shutdown().catch((err) => {
        this.error(`bridge shutdown failed: ${err.message || err}`);
      });
    }
    if (this.fileLog) await this.fileLog.flush().catch(() => {});
  }

  // "Show log" on the settings page (GET /log-view in api.js): a short summary
  // and the latest LOG_VIEW_LINES of the file log, with Bluetooth addresses,
  // UUIDs and device names hidden, for a tester to send privately to the
  // developer. It is not to be pasted in the forum.
  async logView() {
    const lines = await this.fileLog.tail(LOG_VIEW_LINES);
    const devices = this._devices();
    const dimmers = devices.filter((device) => typeof device.getMeshId === 'function').length;
    const csr = devices.filter((device) => typeof device.getCsrMeshId === 'function').length;
    const keep = this.bridge && typeof this.bridge._keepConnected === 'function'
      ? (this.bridge._keepConnected() ? 'on' : 'off') : 'unknown';
    const at = (line) => (line && /^\d{4}-\d\d-\d\dT[\d:.]+Z/.test(line) ? line.slice(0, 24) : null);
    const from = at(lines[0]);
    const to = at(lines[lines.length - 1]);
    const summary = [
      `SG LEDDim ${this.homey.manifest.version}, Homey ${this.homey.version || 'unknown'}, `
        + `keep connected: ${keep}, detailed logging: ${this.homey.settings.get('debugLogging') ? 'on' : 'off'}`,
      `Dimmers: ${dimmers}, later generations: ${csr}, groups: ${devices.length - dimmers - csr}`,
      `Log from ${from || 'unknown'} to ${to || 'unknown'}, ${lines.length} lines`,
    ];
    const names = devices.map((device) => device.getName());
    return { count: lines.length, from, to, text: maskLog([...summary, ...lines].join('\n'), names) };
  }

  // Dimmers (not groups) paired in this app.
  dimmerCount() {
    return this._devices().filter((device) => typeof device.getMeshId === 'function').length;
  }

  // A dimmer was initialised, added or deleted. The default of "Keep dimmers
  // connected" depends on how many there are, and the settings page shows it.
  dimmersChanged() {
    if (this._dimmersTimer) this.homey.clearTimeout(this._dimmersTimer);
    this._dimmersTimer = this.homey.setTimeout(() => {
      this._dimmersTimer = null;
      this.homey.settings.set('keepConnectedDefault', this.dimmerCount() >= 2);
      if (this.bridge) this.bridge.applyMode();
      if (this._dimmerAdded) this._firstStatus();
    }, 2000);
  }

  // A dimmer was paired: its first status now, not at the next change or the
  // next poll. Decided after applyMode, which may just have started holding
  // the link; several added at once give one request.
  dimmerAdded() {
    this._dimmerAdded = true;
    this.dimmersChanged();
  }

  // On a held link FFFF, once; otherwise a status poll soon, which listens.
  _firstStatus() {
    this._dimmerAdded = false;
    if (!this.bridge) return;
    if (this.bridge._held && this.csr) {
      this.csr.requestAllStatus().catch((err) => this.error(`[CSR] status request failed: ${err.message || err}`));
    } else {
      this.bridge.pollSoon();
    }
  }

  // Every paired device, across all drivers.
  _devices() {
    const devices = [];
    try {
      for (const driver of Object.values(this.homey.drivers.getDrivers())) {
        devices.push(...driver.getDevices());
      }
    } catch (err) {
      this.error(`enumerating devices failed: ${err.message || err}`);
    }
    return devices;
  }

  _dispatchStatus(idHex, level, location) {
    const meshId = parseInt(idHex, 16);
    this._locations.set(meshId, learnLocation(this._locations.get(meshId), location).state);
    if (this._statusUnreadable) this._statusReadable();
    this._statusHeard(idHex);
    // Dimmers first: a group shows the level its dimmers have just decided on.
    const devices = this._devices()
      .sort((a, b) => (typeof b.getMeshId === 'function') - (typeof a.getMeshId === 'function'));
    for (const device of devices) {
      if (typeof device.applyMeshStatus === 'function') {
        try {
          device.applyMeshStatus(idHex, level, location);
        } catch (err) {
          this.error(`applying status to ${device.getName()} failed: ${err.message || err}`);
        }
      }
    }
  }

  // The location id learned for a mesh id, or null.
  locationFor(meshId) {
    const state = this._locations ? this._locations.get(meshId) : undefined;
    return state && Number.isInteger(state.value) ? state.value : null;
  }

  // The location id every paired dimmer but this one has learned, when they
  // all have the same; null when none has one or they differ. For a dimmer
  // whose own status does not reach Homey (see SGDeviceBase._keptWaited).
  sharedLocation(exceptMeshId) {
    const seen = new Set();
    for (const device of this._devices()) {
      if (typeof device.getLocationId !== 'function' || device.getMeshId() === exceptMeshId) continue;
      const location = device.getLocationId();
      if (location !== null) seen.add(location);
    }
    return seen.size === 1 ? [...seen][0] : null;
  }

  // Every location id known here, for FF10 (lib/CsrNetwork.js): the first
  // generation dimmers' from their status, also those not added yet, and the
  // later products' added in Homey. Sorted, none twice, never 0.
  knownLocations() {
    const known = new Set();
    for (const state of (this._locations || new Map()).values()) {
      if (Number.isInteger(state.value) && state.value > 0) known.add(state.value);
    }
    for (const device of this._devices()) {
      let location = null;
      if (typeof device.getLocationId === 'function') location = device.getLocationId();
      else if (typeof device.getCsrLocationId === 'function') location = device.getCsrLocationId();
      if (Number.isInteger(location) && location > 0) known.add(location);
    }
    return [...known].sort((a, b) => a - b);
  }

  // A dimmer waits for its first status.
  requestStatus() {
    if (this.bridge) this.bridge.pollSoon();
  }

  // MeshBridge heard frames but could read no status: every dimmer shows why
  // as a warning, and stays available, until a status is read. The timeline
  // gets one notification as well, at most once per start.
  statusUnreadable() {
    if (this._statusUnreadable) return;
    this._statusUnreadable = true;
    this.log('no status could be read: the network password is probably wrong ("Network Isolation" in the SG app?)');
    this._updateAvailability();
    if (this._passwordNotified || !this.homey.notifications) return;
    this._passwordNotified = true;
    this.homey.notifications.createNotification({ excerpt: this.homey.__('notification.passwordWrong') })
      .then(() => this.log('timeline notification sent: suspected wrong password'))
      .catch((err) => this.error(`timeline notification failed: ${err.message || err}`));
  }

  statusUnreadableText() {
    return this._statusUnreadable ? this.homey.__('device.passwordWrong') : null;
  }

  _statusReadable() {
    this._statusUnreadable = false;
    this.log('status can be read again');
    this._updateAvailability();
  }

  _updateAvailability() {
    for (const device of this._devices()) {
      if (typeof device.updateAvailability === 'function') device.updateAvailability();
    }
  }

  // The status the app already gets is the only source: nothing is sent or
  // scanned for this. A dimmer's clock starts when the app first sees it, at
  // start or just after pairing. Homey is called only when the warning changes.
  _startNotHeardCheck() {
    this._heardAt = new Map(); // mesh id -> last status
    this._firstSeen = new WeakMap(); // device -> first check that saw it
    this._warned = new WeakMap(); // device -> true (set), false (cleared)
    this._notHeardTimer = this.homey.setInterval(() => this._checkNotHeard(), NOT_HEARD_CHECK_MS);
  }

  _statusHeard(idHex) {
    const id = parseInt(idHex, 16);
    const before = this._heardAt.get(id);
    const now = Date.now();
    this._heardAt.set(id, now);
    for (const device of this._devices()) {
      if (typeof device.getMeshId !== 'function' || device.getMeshId() !== id) continue;
      // Unknown after a start: clear a warning Homey may still show.
      if (this._warned.get(device) === false) continue;
      const wasSet = this._warned.get(device) === true;
      this._warned.set(device, false);
      device.unsetWarning().catch((err) => this.error(`clearing warning failed: ${err.message || err}`));
      if (wasSet) {
        const since = Math.max(before || 0, this._firstSeen.get(device) || 0);
        device.log(`warning cleared: status heard again after ${Math.round((now - since) / 60000)} min`);
      }
    }
  }

  _checkNotHeard() {
    // The dimmers already say why: no status can be read at all.
    if (this._statusUnreadable) return;
    const now = Date.now();
    // Read only: which mode MeshBridge is in right now.
    const held = !!(this.bridge && this.bridge._held);
    const limit = held ? NOT_HEARD_HELD_MS : NOT_HEARD_POLL_MS;
    for (const device of this._devices()) {
      if (typeof device.getMeshId !== 'function') continue;
      if (!this._firstSeen.has(device)) this._firstSeen.set(device, now);
      const last = Math.max(this._heardAt.get(device.getMeshId()) || 0, this._firstSeen.get(device));
      if (now - last < limit || this._warned.get(device) === true) continue;
      this._warned.set(device, true);
      device.setWarning(this.homey.__('device.notHeard'))
        .catch((err) => this.error(`setting warning failed: ${err.message || err}`));
      device.log(`warning set: no status for ${Math.round((now - last) / 60000)} min `
        + `(limit ${limit / 60000} min, ${held ? 'held link' : 'without held link'})`);
    }
  }

  // A node seen in a scan: its @NDxxxx name carries the dimmer's mesh id.
  reportSignal(nodeName, rssi) {
    const id = meshIdFromName(nodeName);
    if (id === null) return;
    for (const device of this._devices()) {
      if (typeof device.setSignal === 'function' && device.getMeshId() === id) device.setSignal(rssi);
    }
  }

  // The bridge was changed (MeshBridge stores it as bridgeUuid): Homey now
  // connects to that dimmer directly and reaches the others via it.
  bridgeChanged() {
    const id = this.bridgeMeshId();
    if (id === null) return;
    for (const device of this._devices()) {
      if (typeof device.setConnection === 'function') device.setConnection(device.getMeshId() === id);
    }
  }

  // Mesh id of the last known bridge, kept across restarts in bridgeUuid.
  bridgeMeshId() {
    const uuid = this.bridge && this.bridge._preferredUuid;
    if (!uuid) return null;
    return meshIdFromName(this.bridge._nodeNameFor({ uuid }));
  }

  // Mesh ids of every paired dimmer, so a status poll knows when it has heard
  // from all of them and can release the radio.
  getPairedMeshIds() {
    const ids = new Set();
    for (const device of this._devices()) {
      if (typeof device.getMeshId !== 'function') continue;
      const id = device.getMeshId();
      if (Number.isInteger(id) && id > 0) {
        ids.add(id.toString(16).padStart(4, '0').toLowerCase());
      }
    }
    return [...ids];
  }

  // All devices on one CSRmesh network share the same key, so inbound status
  // frames are decrypted with the key of any paired device.
  getNetworkKey() {
    for (const device of this._devices()) {
      if (typeof device.getNetworkKey === 'function') {
        try {
          return device.getNetworkKey();
        } catch (err) {
          this.error(`reading network key from ${device.getName()} failed: ${err.message || err}`);
        }
      }
    }
    return deriveNetworkKey(DEFAULT_PASSPHRASE);
  }

  nextSeq() {
    this._seq = (this._seq + 1) & 0xFFFFFF;
    if (this._seq === 0) this._seq = 1;
    this.homey.settings.set('seqCounter', this._seq);
    return this._seq;
  }
}

module.exports = SGSmartApp;
