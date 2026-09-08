'use strict';

const Homey = require('homey');
const MeshBridge = require('./lib/MeshBridge');

class SGSmartApp extends Homey.App {
  async onInit() {
    // v1.0.10: app-wide status polling and app-wide logging switch.
    if (this.homey.settings.get('loggingEnabled') === null) {
      this.homey.settings.set('loggingEnabled', true);
    }
    if (this.homey.settings.get('statusPollMs') === null) {
      let migrated = null;
      try {
        const drivers = this.homey.drivers.getDrivers();
        for (const driver of Object.values(drivers)) {
          for (const device of driver.getDevices()) {
            const v = Number(device.getSetting('statusPollMs'));
            if (Number.isFinite(v) && (v === 0 || v >= 5000)) { migrated = v; break; }
          }
          if (migrated !== null) break;
        }
      } catch (_) {}
      // v1.0.26 recovery strategy: no background status. Keep the radio free for
      // short connect→drain→disconnect command bursts only.
      this.homey.settings.set('statusPollMs', migrated === null ? 0 : migrated);
    }
    this.bridge = new MeshBridge(this);
    if (this.bridge.startStatus) {
      this.bridge.startStatus((idHex, level) => this._dispatchStatus(idHex, level));
    }

    // App settings can be changed while the app is running. ManagerSettings
    // emits the changed key; apply status interval changes immediately instead
    // of requiring an app restart.
    this.homey.settings.on('set', (key) => {
      if (key === 'statusPollMs' && this.bridge && this.bridge.refreshStatusPolling) {
        this.bridge.refreshStatusPolling();
      }
    });

    let seq = Number(this.homey.settings.get('seqCounter'));
    if (!Number.isInteger(seq) || seq < 0 || seq > 0xFFFFFF) {
      seq = 0x800000;
      this.homey.settings.set('seqCounter', seq);
    }
    this._seq = seq;

    if (this.homey.settings.get('loggingEnabled') !== false) {
      this.log(`SG LEDDim app initialized (v1.0.48, store prep: readme+contributors, faithful icon RSSI selection + v1.0.31 BLE/recovery logic, seq=0x${this._seq.toString(16).padStart(6, '0')})`);
    }
  }

  _dispatchStatus(idHex, level) {
    try {
      const drivers = this.homey.drivers.getDrivers();
      for (const driver of Object.values(drivers)) {
        for (const device of driver.getDevices()) {
          if (typeof device.applyMeshStatus === 'function') {
            device.applyMeshStatus(idHex, level);
          }
        }
      }
    } catch (err) {
      this.error(`dispatchStatus failed: ${err.message || err}`);
    }
  }

  getPairedMeshIds() {
    const ids = new Set();
    try {
      const drivers = this.homey.drivers.getDrivers();
      for (const driverId of ['sg_sofa', 'sg_spisebord']) {
        const driver = drivers[driverId];
        if (!driver) continue;
        for (const device of driver.getDevices()) {
          const name = String(device.getStoreValue('localName') || '');
          const m = name.match(/@ND([0-9A-Fa-f]{4})/);
          if (m) ids.add(m[1].toLowerCase());
        }
      }
    } catch (err) {
      this.error(`getPairedMeshIds failed: ${err.message || err}`);
    }
    return [...ids];
  }

  nextSeq() {
    this._seq = (this._seq + 1) & 0xFFFFFF;
    if (this._seq === 0) this._seq = 1;
    this.homey.settings.set('seqCounter', this._seq);
    return this._seq;
  }
}

module.exports = SGSmartApp;
