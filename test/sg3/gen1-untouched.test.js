'use strict';

// The first generation runs as before when SG Smart 3.0 is not set up: app.js,
// the sg_mesh driver and the 3.0 device class load nothing from lib/sg3 or
// lib/sigmesh, sg_mesh picks the classes it picked before for every other
// id, and a 3.0 device has none of the methods app.js and lib/account.js
// call on the first generation and CSRmesh devices. Run with a fake 'homey'
// module and a stand-in for lib/MeshBridge, so no Bluetooth is touched.
// Made-up keys and home key.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
// What app.js and lib/account.js call on devices of every driver, when the
// device has it.
const OTHER_DEVICE_METHODS = ['getMeshId', 'getLocationId', 'applyMeshStatus', 'setSignal', 'setConnection', 'getNetworkKey',
  'updateAvailability', 'getCsrMeshId', 'getCsrLocationId', 'applyCsrStatus', 'applyCsrName', 'applyThermostat',
  'applyThermostatCommand'];
const NET_KEY = '7dd7364cd842ad18c17c2b820c84c3d6';
const APP_KEY = '63964771734fbd76e3b40519d1d94a48';
const HOME_KEY = '0a1b2c3d4e5f';

class FakeApp {
  log() {}
  error() {}
}
class FakeDriver {}
class FakeDevice {
  constructor(id = `sig:${HOME_KEY}:0003`) {
    this.capabilityListeners = [];
    this.id = id;
  }

  getData() { return { id: this.id }; }

  getStoreValue() { return 3080; }

  getCapabilityValue() { return null; }

  async setUnavailable(message) { this.unavailable = message; }

  async setAvailable() { this.unavailable = null; }

  registerMultipleCapabilityListener(...args) { this.capabilityListeners.push(args); }

  log() {}

  error() {}
}

const bridgeCalls = [];
class FakeMeshBridge {
  constructor() { bridgeCalls.push('new'); }

  startStatus() { bridgeCalls.push('startStatus'); }

  onFrame() { bridgeCalls.push('onFrame'); }

  applyMode() { bridgeCalls.push('applyMode'); }

  async shutdown() { bridgeCalls.push('shutdown'); }
}

// The SG account as lib/account.js keeps it, with a 3.0 network or not.
const kept = (homes) => ({ fetchedAt: '2026-11-04T05:40:00.000Z', homes, check: null });
const SG3_HOME = {
  homeKey: HOME_KEY, passphrase: null, netKey: NET_KEY, appKey: APP_KEY, locationId: null,
  devices: [{ meshId: 3, type: 3080, name: null, certain: true }],
};

// The app's settings 'set' handlers, from the latest start.
const setHandlers = [];

function fakeHomey(settings = {}) {
  setHandlers.length = 0;
  const store = new Map(Object.entries(settings));
  const intervals = [];
  const scans = [];
  return {
    store,
    scans,
    settings: {
      get: (key) => (store.has(key) ? store.get(key) : null),
      set: (key, value) => store.set(key, value),
      unset: (key) => store.delete(key),
      on: (event, handler) => { if (event === 'set') setHandlers.push(handler); },
    },
    manifest: { version: 'test' },
    setInterval: (fn, ms) => { intervals.push(ms); return intervals.length; },
    clearInterval: () => {},
    setTimeout,
    clearTimeout,
    drivers: { getDrivers: () => ({}), getDriver: () => ({ getDevices: () => [] }) },
    ble: { discover: async () => { scans.push('discover'); throw new Error('no Bluetooth in this test'); } },
    clock: { getTimezone: () => 'Europe/Oslo' },
    __: (key) => key,
  };
}

// Load `file` fresh, with 'homey' and lib/MeshBridge replaced.
function load(file) {
  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'homey') return { App: FakeApp, Driver: FakeDriver, Device: FakeDevice };
    if (request === './lib/MeshBridge') return FakeMeshBridge;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(file);
  } finally {
    Module._load = originalLoad;
  }
}

function freshModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(ROOT) && !key.includes(`${path.sep}test${path.sep}`)) delete require.cache[key];
  }
}

function sg3Loaded() {
  return Object.keys(require.cache).filter((key) => (
    key.includes(`${path.sep}lib${path.sep}sg3${path.sep}`) || key.includes(`${path.sep}lib${path.sep}sigmesh${path.sep}`)
  ));
}

async function startedApp(settings) {
  const App = load(path.join(ROOT, 'app.js'));
  const app = new App();
  app.homey = fakeHomey(settings);
  await app.onInit();
  return app;
}

test('app.js without a 3.0 network: gen 1 starts and stops as before, lib/sg3 is never loaded', async () => {
  freshModules();
  bridgeCalls.length = 0;
  const app = await startedApp();
  assert.deepEqual(bridgeCalls, ['new', 'startStatus', 'onFrame']);
  assert.equal(app.homey.store.get('debugLogging'), false);
  // Number(null) is 0, a valid counter, so gen 1 leaves seqCounter unset here.
  assert.equal(app._seq, 0);
  assert.equal(app.homey.store.has('seqCounter'), false);
  assert.equal(app.sg3(), null);
  app.accountChanged();
  app.sg3DevicesChanged();
  // A scan goes straight to Homey, as before: no queue without 3.0.
  const first = app.bleDiscover();
  const second = app.bleDiscover();
  await assert.rejects(first);
  await assert.rejects(second);
  assert.deepEqual(app.homey.scans, ['discover', 'discover']);
  await app.onUninit();
  assert.deepEqual(bridgeCalls, ['new', 'startStatus', 'onFrame', 'shutdown']);
  assert.deepEqual(sg3Loaded(), []);
});

test('an SG account without a 3.0 network, or kept before the home\'s key: still no lib/sg3', async () => {
  for (const home of [{ ...SG3_HOME, homeKey: null }, { ...SG3_HOME, devices: [{ meshId: 0x8001, type: 101, name: null, certain: true }] }]) {
    freshModules();
    const app = await startedApp({ sgAccount: kept([home]) });
    assert.equal(app.account.fetched(), true);
    assert.equal(app.sg3(), null);
    app.accountChanged();
    await app.onUninit();
    assert.deepEqual(sg3Loaded(), []);
  }
});

test('the sg_mesh driver, the 3.0 device class and api.js load nothing from lib/sg3', () => {
  freshModules();
  load(path.join(ROOT, 'drivers', 'sg_mesh', 'driver.js'));
  load(path.join(ROOT, 'lib', 'SG3Device.js'));
  load(path.join(ROOT, 'api.js'));
  assert.deepEqual(sg3Loaded(), []);
});

test('sg_mesh picks the classes it picked before, and the 3.0 class only for a "sig:" id', () => {
  freshModules();
  const Driver = load(path.join(ROOT, 'drivers', 'sg_mesh', 'driver.js'));
  const SGMeshDevice = load(path.join(ROOT, 'lib', 'SGDeviceBase.js'));
  const SGCsrDevice = load(path.join(ROOT, 'lib', 'SGCsrDevice.js'));
  const SG3Device = load(path.join(ROOT, 'lib', 'SG3Device.js'));
  const driver = new Driver();
  const classOf = (id) => driver.onMapDeviceClass({ getData: () => ({ id }) });
  assert.equal(classOf('@ND1A2B'), SGMeshDevice);
  assert.equal(classOf(''), SGMeshDevice);
  assert.equal(classOf('sig:not-a-key:0003'), SGMeshDevice);
  assert.equal(classOf(`sig:${HOME_KEY}:003`), SGMeshDevice);
  assert.equal(classOf(`SIG:${HOME_KEY.toUpperCase()}:0003`), SGMeshDevice);
  assert.equal(driver.onMapDeviceClass({ getData: () => { throw new Error('made-up'); } }), SGMeshDevice);
  assert.equal(classOf('@SD1A2B'), SGCsrDevice);
  assert.equal(classOf(`sig:${HOME_KEY}:0003`), SG3Device);
  assert.deepEqual(sg3Loaded(), []);
});

test('a 3.0 device has none of the methods app.js and the account call on the other devices', () => {
  freshModules();
  const Device = load(path.join(ROOT, 'lib', 'SG3Device.js'));
  for (const name of OTHER_DEVICE_METHODS) {
    assert.equal(typeof Device.prototype[name], 'undefined', name);
  }
});

test('a 3.0 device without a 3.0 network is unavailable, and still loads no 3.0 code', async () => {
  freshModules();
  const app = await startedApp();
  const Device = load(path.join(ROOT, 'lib', 'SG3Device.js'));
  const device = new Device();
  device.homey = { ...app.homey, app };
  await device.onInit();
  assert.equal(device.unavailable, 'device.sg3NoNetwork');
  await assert.rejects(device.onSettings({}), /device\.sg3SettingsFixed/);
  await app.onUninit();
  assert.deepEqual(sg3Loaded(), []);
});

test('with a 3.0 network in the account, the same device does load the controller (it is lazy, not missing)', async () => {
  freshModules();
  const app = await startedApp({ sgAccount: kept([SG3_HOME]) });
  assert.deepEqual(sg3Loaded(), [], 'not before a 3.0 device asks');
  const Device = load(path.join(ROOT, 'lib', 'SG3Device.js'));
  const device = new Device();
  device.homey = { ...app.homey, app };
  await device.onInit();
  assert.equal(device.unavailable, undefined);
  assert.equal(device.capabilityListeners.length, 1);
  assert.ok(sg3Loaded().length > 0);
  assert.equal(app.sg3HomeKey(), HOME_KEY);
  const other = new Device('sig:ffeeddccbbaa:0003');
  other.homey = device.homey;
  await other.onInit();
  app.homey.drivers = { getDrivers: () => ({ sg_mesh: { getDevices: () => [device, other] } }) };
  assert.equal(other.unavailable, 'device.sg3OtherHome');
  // "Forget SG account": the controller stops, and the device is unavailable.
  app.account.forget();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.sg3(), null);
  assert.equal(device.unavailable, 'device.sg3NoNetwork');
  await app.onUninit();
});

test('"Keep SG Smart 3.0 connected" takes effect at once: a change reaches the 3.0 link; "Keep dimmers connected" stays the first generation\'s', async () => {
  freshModules();
  bridgeCalls.length = 0;
  const app = await startedApp();
  let applied = 0;
  app._sg3 = { applyMode: () => { applied += 1; }, stop: async () => {} };
  for (const handler of setHandlers) handler('sg3KeepConnected');
  assert.equal(applied, 1);
  for (const handler of setHandlers) handler('keepConnected');
  assert.equal(applied, 1, 'not for the first generation setting');
  assert.deepEqual(bridgeCalls.filter((call) => call === 'applyMode'), ['applyMode']);
  app._sg3 = null;
  for (const handler of setHandlers) handler('sg3KeepConnected');
  await app.onUninit();
});
