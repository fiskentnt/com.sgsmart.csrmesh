'use strict';

const Homey = require('homey');
const { SG3_PRODUCTS } = require('./sgProducts');

// An SG Smart 3.0 dimmer (LEDDim Smart 3.0 and 2-pole 3.0, 2.8.0) in
// sg_mesh, which picks this class in onMapDeviceClass by its id,
// "sig:<home key>:<address>": the home's key from the SG account and the
// dimmer's address in its mesh, 4 hex digits. The id never changes after
// pairing. The network, its keys and the link are the app's (app.js, sg3,
// and lib/sg3/controller.js); this file loads nothing from lib/sg3, so
// without a 3.0 network none of it is loaded.
//
// On and off and the level go to the dimmer as one command per gesture: 0 is
// off, 1 to 100 the level, LEVEL_ON on at the level it had (assumed, not
// tried on a real dimmer). Status from the dimmer sets onoff and dim.
//
// Its methods are named getSg3Address and getSg3HomeKey, not getMeshId or
// getCsrMeshId, so the first generation and CSRmesh bookkeeping in app.js
// and lib/account.js leave it out. It has no network password: the settings
// for it stay empty, and a change to them is refused.

// onoff and dim come in the same breath when a slider is dragged on a dark lamp.
const DIM_DEBOUNCE_MS = 250;
const LEVEL_ON = 101;

const SG3_ID = /^sig:([0-9a-f]{12}):([0-9a-f]{4})$/;

const hex4 = (value) => `0x${value.toString(16).padStart(4, '0')}`;

// A 3.0 device's id from its home's key and its address.
function sg3Id(homeKey, address) {
  return `sig:${homeKey}:${address.toString(16).padStart(4, '0')}`;
}

// { homeKey, address } from a 3.0 device's id, or null for any other id.
function parseSg3Id(id) {
  const match = SG3_ID.exec(String(id || ''));
  return match ? { homeKey: match[1], address: parseInt(match[2], 16) } : null;
}

// The 3.0 dimmers of the SG account's 3.0 network (lib/account.js,
// sg3Network) as pairing lists them, the added ones left out: named as in
// the SG app, else "LEDDim Smart 3.0 0003", with onoff and dim, and empty
// network settings. addedIds are the ids of the devices added, in capitals.
// Never throws: a pairing of the other dimmers goes on without them.
function sg3PairingDevices(account, addedIds) {
  let network = null;
  try {
    network = account && typeof account.sg3Network === 'function' && account.fetched() ? account.sg3Network() : null;
  } catch (err) {
    network = null;
  }
  if (!network) return { devices: [], inAccount: 0, added: 0 };
  const all = network.devices.map((device) => {
    const product = SG3_PRODUCTS[device.type];
    return {
      name: device.name || `${product.name} ${device.meshId.toString(16).toUpperCase().padStart(4, '0')}`,
      data: { id: sg3Id(network.homeKey, device.meshId) },
      capabilities: ['onoff', 'dim'],
      store: { sg3Type: device.type },
      settings: { passphrase: '', netkey_hex: '' },
    };
  });
  const devices = all.filter((device) => !addedIds.has(device.data.id.toUpperCase()));
  return { devices, inAccount: all.length, added: all.length - devices.length };
}

class SG3Device extends Homey.Device {
  async onInit() {
    const parsed = parseSg3Id(this.getData().id);
    this._address = parsed.address;
    this._homeKey = parsed.homeKey;
    this._sg3 = null;
    this._shown = null;
    this._onStatus = (status) => {
      if (status.node === this._address) this.applyStatus(status);
    };
    this.registerMultipleCapabilityListener(['onoff', 'dim'], async (values) => {
      this._command(this._levelFor(values));
    }, DIM_DEBOUNCE_MS);
    await this.updateSg3();
    this.log(`SG Smart 3.0 dimmer ready (${this.getStoreValue('sg3Type')}, address ${hex4(this._address)})`);
  }

  // null once deleted: Homey may still list the device while onDeleted runs.
  getSg3Address() {
    return this._deleted ? null : this._address;
  }

  getSg3HomeKey() {
    return this._homeKey;
  }

  // Takes the app's 3.0 controller as it is now (app.js, sg3): at start,
  // and when the SG account was fetched or forgotten. Unavailable while the
  // account has no 3.0 network, or one of another home.
  async updateSg3() {
    const app = this.homey.app;
    const sg3 = app && typeof app.sg3 === 'function' ? app.sg3() : null;
    const ours = sg3 && app.sg3HomeKey() === this._homeKey ? sg3 : null;
    if (ours !== this._sg3) {
      if (this._sg3) this._sg3.off('status', this._onStatus);
      this._sg3 = ours;
      if (ours) {
        ours.on('status', this._onStatus);
        ours.start();
      }
    }
    const why = ours ? null : sg3 ? 'device.sg3OtherHome' : 'device.sg3NoNetwork';
    if (why === this._shown) return;
    this._shown = why;
    if (why) {
      this.log(`unavailable: ${sg3 ? 'the account\'s 3.0 network is another home\'s' : 'no 3.0 network in the SG account'}`);
      await this.setUnavailable(this.homey.__(why)).catch(() => {});
    } else {
      await this.setAvailable().catch(() => {});
    }
  }

  // One gesture: 0 off, 1 to 100 the level, LEVEL_ON for "on" alone.
  _levelFor({ onoff, dim }) {
    if (typeof dim === 'number') return onoff === false ? 0 : Math.max(0, Math.min(100, Math.round(dim * 100)));
    return onoff ? LEVEL_ON : 0;
  }

  // Sent in the background, so the capability listener answers Homey at
  // once also while the link is being set up. A command that does not get
  // out leaves a warning, until the next one gets out.
  _command(level) {
    const sg3 = this._sg3;
    if (!sg3) return;
    if (level === 0) this.setCapabilityValue('onoff', false).catch(() => {});
    else if (level !== LEVEL_ON) this.setCapabilityValue('onoff', true).catch(() => {});
    sg3.setLevel(this._address, level).then(() => {
      if (this._failed) {
        this._failed = false;
        this.unsetWarning().catch(() => {});
      }
    }, (err) => {
      this.error(`level ${level} not sent: ${err.message || err}`);
      this._failed = true;
      this.setWarning(this.homey.__('device.sg3NotSent')).catch(() => {});
    });
  }

  // A status from the dimmer (lib/sg3/controller.js, 'status').
  applyStatus({ on, level }) {
    const changes = [this.setCapabilityValue('onoff', on)];
    if (on && level > 0) changes.push(this.setCapabilityValue('dim', level / 100));
    Promise.all(changes).catch(() => {});
    this.log(`status applied: on=${on} level=${level}`);
  }

  // The network settings are for the CSRmesh dimmers; a 3.0 dimmer's keys
  // come from the SG account.
  async onSettings() {
    throw new Error(this.homey.__('device.sg3SettingsFixed'));
  }

  async onAdded() {
    const app = this.homey.app;
    if (app && typeof app.sg3DevicesChanged === 'function') app.sg3DevicesChanged();
  }

  async onDeleted() {
    this._deleted = true;
    this._detach();
    const app = this.homey.app;
    if (app && typeof app.sg3DevicesChanged === 'function') app.sg3DevicesChanged();
  }

  async onUninit() {
    this._detach();
  }

  _detach() {
    if (this._sg3) this._sg3.off('status', this._onStatus);
    this._sg3 = null;
  }
}

module.exports = SG3Device;
module.exports.LEVEL_ON = LEVEL_ON;
module.exports.parseSg3Id = parseSg3Id;
module.exports.sg3Id = sg3Id;
module.exports.sg3PairingDevices = sg3PairingDevices;
