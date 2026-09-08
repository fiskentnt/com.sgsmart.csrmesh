'use strict';

const Homey = require('homey');
const MeshBridge = require('./lib/MeshBridge');
const { deriveNetworkKey, DEFAULT_PASSPHRASE } = require('./lib/csrmesh');

// App settings and their defaults.
const DEFAULTS = {
  loggingEnabled: true,    // normal informational logging
  debugLogging: false,     // verbose BLE/GATT tracing, for troubleshooting only
  statusPollMs: 300000,    // 5 min; 0 = no background status polling
};

class SGSmartApp extends Homey.App {
  async onInit() {
    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (this.homey.settings.get(key) === null) this.homey.settings.set(key, value);
    }

    this.bridge = new MeshBridge(this);
    this.bridge.startStatus((idHex, level) => this._dispatchStatus(idHex, level));

    // App settings can change while the app runs. Apply a new status interval
    // immediately instead of requiring a restart.
    this.homey.settings.on('set', (key) => {
      if (key === 'statusPollMs') this.bridge.refreshStatusPolling();
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
    if (this.bridge) {
      await this.bridge.shutdown().catch((err) => {
        this.error(`bridge shutdown failed: ${err.message || err}`);
      });
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

  _dispatchStatus(idHex, level) {
    for (const device of this._devices()) {
      if (typeof device.applyMeshStatus === 'function') {
        try {
          device.applyMeshStatus(idHex, level);
        } catch (err) {
          this.error(`applying status to ${device.getName()} failed: ${err.message || err}`);
        }
      }
    }
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
