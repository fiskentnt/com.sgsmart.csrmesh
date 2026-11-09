'use strict';

const { DEFAULT_PASSPHRASE, deriveNetworkKey } = require('../csrmesh');
const { CsrNetwork } = require('../CsrNetwork');
const {
  laterDevice, laterFindings, thermostatDevice, withStates,
} = require('../csrPairing');
const { FAKE_ID_PREFIX, isFakeDevice } = require('../fakeDevices');
const { ANSWER_MS, FakeBridge } = require('./bridge');
const { FakeLight, FakeThermostat } = require('./nodes');

// Fake devices, for development: loaded by lib/fakeDevices.js only in a run
// with `homey app run` (DEBUG=1), from a copy of the app made by
// dev/run-with-fakes.sh. .homeyignore leaves this folder out of every build
// made from the app folder; --skip-build, which packs the folder without
// .homeyignore, is never used (lib/fakeDevices.js).
//
// They are found and added as usual, in the list of the driver that adds
// the product, named "FAKE ...", with the id "fake:<name>". They have a
// network of their own: this one, with its own CsrNetwork and a fake radio
// (lib/fake/bridge.js) in place of MeshBridge, so what they send and what
// the app asks of them never reaches Homey's Bluetooth, and nothing of the
// real network reaches them (app._devices() leaves them out). Their answers
// come ANSWER_MS after a command, through the same reading as a real
// device's.
//
// As a device in a real home is assumed to, a fake device answers only with
// its home's location id (lib/fake/nodes.js). A search finds them once the
// fake network has heard one of them, which gives it that location id: give
// one an order first (below), "7F01 status" for instance.
//
// Orders, for what a device does by itself: the app setting fakeOrder, set
// with dev/fake-order.sh, as "<device> <order> [value]", where the device is
// its name (@SC3B91) or mesh id (7F01). Every device knows "silent" (answers
// nothing), "answer" (answers again), "name" (sends FF11) and "status" (sends
// its status as it is); the lights,
// plug and socket "on" and "off", those with dimming "level <1..100>" and
// those with white "white <1..255>"; the thermostats theirs (lib/fake/nodes.js,
// FakeThermostat: set, preset, room, floor, pause, heating, error). The
// setting is cleared after each order, so the same can be given again.

const ORDER_SETTING = 'fakeOrder';
// The fake home's location id, and its devices: Pill, Pill ON-OFF, a rotary
// dimmer, a tunable white one, Smart Plug, Smart Socket and two HeatReg
// Smart, one of them with a high mesh id, as devices set up later can have.
// Each with a made-up Bluetooth address, whose last four characters end its
// name (lib/fake/nodes.js).
const LOCATION = 0x7f00;
const DEVICES = [
  ['@SC', 0x7f01, '02f4ce0a3b91'], ['@SE', 0x7f02, '02f4ce0a52c4'], ['@SD', 0x7f03, '02f4ce0a6d17'],
  ['@SW', 0x7f04, '02f4ce0a8e2a'], ['@GP', 0x7f05, '02f4ce0a9f5d'], ['@GB', 0x7f06, '02f4ce0ab460'],
  ['@MT', 0x7f07, '02f4ce0ac7a3'], ['@ST', 0x8123, '02f4ce0ad8e6'],
];
// The drivers that list each device with its own icon (laterDevice).
const ICON_DRIVERS = ['sg_pill', 'sg_plug'];

class FakeNetwork {
  constructor(app) {
    this.app = app;
    this.homey = app.homey;
    this.nodes = DEVICES.map(([prefix, meshId, address]) => {
      const Node = ['@MT', '@ST'].includes(prefix) ? FakeThermostat : FakeLight;
      return new Node({
        prefix, meshId, location: LOCATION, address,
      });
    });
    this.bridge = new FakeBridge(this);
    this.csr = new CsrNetwork(this);
    this._seq = 0;
    this._timers = new Set();
    this._onSetting = (key) => {
      if (key === ORDER_SETTING) this.order(this.homey.settings.get(ORDER_SETTING));
    };
  }

  start() {
    this.csr.start();
    if (this.homey.settings && typeof this.homey.settings.on === 'function') this.homey.settings.on('set', this._onSetting);
    this.log(`fake devices on: ${this.nodes.join(', ')}; answers after ${ANSWER_MS / 1000} s; orders in the app setting `
      + `${ORDER_SETTING}`);
    return this;
  }

  stop() {
    this.csr.stop();
    for (const timer of this._timers) this.homey.clearTimeout(timer);
    this._timers.clear();
    if (this.homey.settings && typeof this.homey.settings.removeListener === 'function') {
      this.homey.settings.removeListener('set', this._onSetting);
    }
  }

  // What CsrNetwork (lib/CsrNetwork.js) and a device (lib/SGCsrDevice.js)
  // use of the app, for the fake network.
  log(...args) {
    this.app.log('[FAKE]', ...args);
  }

  error(...args) {
    this.app.error('[FAKE]', ...args);
  }

  _devices() {
    const devices = [];
    for (const driver of Object.values(this.homey.drivers.getDrivers())) devices.push(...driver.getDevices());
    return devices.filter(isFakeDevice);
  }

  getNetworkKey() {
    const device = this._devices().find((d) => typeof d.getNetworkKey === 'function');
    return device ? device.getNetworkKey() : deriveNetworkKey(DEFAULT_PASSPHRASE);
  }

  nextSeq() {
    this._seq = (this._seq % 0xffffff) + 1;
    return this._seq;
  }

  knownLocations() {
    const known = this._devices().map((d) => (typeof d.getCsrLocationId === 'function' ? d.getCsrLocationId() : null))
      .filter((location) => Number.isInteger(location) && location > 0);
    return [...new Set(known)].sort((a, b) => a - b);
  }

  sharedLocation() {
    return null;
  }

  statusUnreadableText() {
    return null;
  }

  later(run, ms) {
    const timer = this.homey.setTimeout(() => {
      this._timers.delete(timer);
      run();
    }, ms);
    this._timers.add(timer);
  }

  // The fake devices a pairing search of this driver lists: found with FF10
  // on the fake radio, as the real ones are, those the driver has not added.
  async search(driver) {
    const nodes = await this.csr.search();
    const advertisements = this.nodes.map((node) => ({
      uuid: node.address, localName: node.name, rssi: -50, connectable: true,
    }));
    const added = new Set(driver.getDevices().filter(isFakeDevice)
      .map((device) => String(device.getData().id).slice(FAKE_ID_PREFIX.length)));
    const found = withStates(laterFindings(advertisements, nodes), driver.id, added);
    const devices = found.filter((f) => f.state === 'add').map((f) => {
      const device = driver.id === 'sg_thermostat' ? thermostatDevice(f) : laterDevice(f, { icons: ICON_DRIVERS.includes(driver.id) });
      return {
        ...device,
        name: `FAKE ${device.name}`,
        data: { id: `${FAKE_ID_PREFIX}${device.data.id}` },
        store: { ...device.store, fake: true },
      };
    });
    this.log(`pair: ${devices.length} fake device(s) for ${driver.id}, ${added.size} added before`);
    return devices;
  }

  // "<device> <order> [value]" (see above), from the app setting.
  order(text) {
    const [who, event, value] = String(text || '').trim().split(/\s+/);
    if (!who) return;
    const wanted = who.toUpperCase().replace(/^0X/, '');
    const node = this.nodes.find((n) => n.name === (wanted.startsWith('@') ? wanted : `@${wanted}`)
      || n.meshId.toString(16).toUpperCase().padStart(4, '0') === wanted);
    const messages = node ? node.order(event, value) : null;
    if (!messages) {
      this.log(`fake order not understood: "${text}"`);
    } else {
      this.log(`fake order: ${node} ${event}${value === undefined ? '' : ` ${value}`}, ${messages.length} message(s) sent`);
      for (const message of messages) this.bridge.deliver(node, message);
    }
    if (typeof this.homey.settings.unset === 'function') this.homey.settings.unset(ORDER_SETTING);
  }
}

function start(app) {
  return new FakeNetwork(app).start();
}

module.exports = {
  ANSWER_MS, DEVICES, FakeNetwork, LOCATION, ORDER_SETTING, start,
};
