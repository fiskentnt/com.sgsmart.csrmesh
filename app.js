'use strict';

const Homey = require('homey');
const MeshBridge = require('./lib/MeshBridge');
const { deriveNetworkKey, DEFAULT_PASSPHRASE, meshIdFromName } = require('./lib/csrmesh');

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

class SGSmartApp extends Homey.App {
  async onInit() {
    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (this.homey.settings.get(key) === null) this.homey.settings.set(key, value);
    }

    this._startNotHeardCheck();
    this.bridge = new MeshBridge(this);
    this.bridge.startStatus((idHex, level) => this._dispatchStatus(idHex, level));

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
    if (this._sg3) await this._sg3.stop().catch((err) => this.error(`SG Smart 3.0 stop failed: ${err.message || err}`));
    if (this._notHeardTimer) this.homey.clearInterval(this._notHeardTimer);
    if (this.bridge) {
      await this.bridge.shutdown().catch((err) => {
        this.error(`bridge shutdown failed: ${err.message || err}`);
      });
    }
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
    }, 2000);
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

  _dispatchStatus(idHex, level) {
    this._statusHeard(idHex);
    // Dimmers first: a group shows the level its dimmers have just decided on.
    const devices = this._devices()
      .sort((a, b) => (typeof b.getMeshId === 'function') - (typeof a.getMeshId === 'function'));
    for (const device of devices) {
      if (typeof device.applyMeshStatus === 'function') {
        try {
          device.applyMeshStatus(idHex, level);
        } catch (err) {
          this.error(`applying status to ${device.getName()} failed: ${err.message || err}`);
        }
      }
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

  // SG Smart 3.0 (lib/sg3). Created on first use: by an import from the
  // settings page, or by a 3.0 dimmer or pairing once a network exists.
  // Until then none of lib/sg3 is loaded and the first generation runs as
  // before.
  sg3({ create = true } = {}) {
    if (!this._sg3 && create) {
      const { Sg3Controller } = require('./lib/sg3/controller');
      this._sg3 = new Sg3Controller({ homey: this.homey, log: (line) => this.log(`[SG3] ${line}`) });
    }
    return this._sg3 || null;
  }
}

module.exports = SGSmartApp;
