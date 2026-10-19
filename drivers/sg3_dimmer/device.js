'use strict';

// One SG Smart 3.0 dimmer. app.js calls getMeshId, applyMeshStatus,
// setSignal, setConnection and getNetworkKey on every device of every driver;
// those belong to the first generation, so none of them exists here. That is
// what keeps a 3.0 dimmer out of the first generation's dimmer count, status
// warnings and signal.

const Homey = require('homey');

// SG levels: 0 off, 1-100 percent, 101 on at the level it had.
const LEVEL_OFF = 0;
const LEVEL_LAST = 101;

class Sg3DimmerDevice extends Homey.Device {
  async onInit() {
    this.unicast = this.getStore().unicast;
    this.sg3 = this.homey.app.sg3({ create: Boolean(this.homey.settings.get('sg3Network')) });
    if (!this.sg3 || !this.sg3.configured) {
      await this.setUnavailable(this.homey.__('sg3.device.notConfigured'));
      return;
    }
    this.onStatus = (status) => {
      if (status.node === this.unicast) this.showStatus(status).catch((err) => this.error(err));
    };
    this.sg3.on('status', this.onStatus);
    // Homey sends onoff and dim together when a light is dimmed up from off.
    this.registerMultipleCapabilityListener(['onoff', 'dim'], (values) => this.onCapabilities(values), 300);
    this.sg3.start();
  }

  async onCapabilities(values) {
    let level;
    if (values.dim !== undefined) level = values.dim > 0 ? Math.max(1, Math.round(values.dim * 100)) : LEVEL_OFF;
    else level = values.onoff ? LEVEL_LAST : LEVEL_OFF;
    await this.sg3.setLevel(this.unicast, level);
  }

  // The node keeps its level while off, so dim is only moved by a level above 0.
  async showStatus({ on, level }) {
    await this.setCapabilityValue('onoff', on);
    if (level > 0) await this.setCapabilityValue('dim', level / 100);
  }

  async onUninit() {
    if (this.sg3 && this.onStatus) this.sg3.off('status', this.onStatus);
  }

  async onDeleted() {
    await this.onUninit();
  }
}

module.exports = Sg3DimmerDevice;
