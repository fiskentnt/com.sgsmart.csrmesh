'use strict';

// The first generation runs as before when SG Smart 3.0 is not set up: app.js
// and the sg3_dimmer driver load nothing from lib/sg3 or lib/sigmesh, and a
// 3.0 device has none of the methods app.js calls on every device. Run with
// a fake 'homey' module and a stand-in for lib/MeshBridge, so no Bluetooth is
// touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
// What app.js calls on devices of every driver (see drivers/sg3_dimmer/device.js).
const GEN1_DEVICE_METHODS = ['getMeshId', 'applyMeshStatus', 'setSignal', 'setConnection', 'getNetworkKey'];

class FakeApp {
  log() {}
  error() {}
}
class FakeDriver {}
class FakeDevice {
  constructor() {
    this.capabilityListeners = [];
  }

  getStore() { return { unicast: 3 }; }

  async setUnavailable(message) { this.unavailable = message; }

  registerMultipleCapabilityListener(...args) { this.capabilityListeners.push(args); }

  error() {}
}

const bridgeCalls = [];
class FakeMeshBridge {
  constructor() { bridgeCalls.push('new'); }

  startStatus() { bridgeCalls.push('startStatus'); }

  applyMode() { bridgeCalls.push('applyMode'); }

  async shutdown() { bridgeCalls.push('shutdown'); }
}

function fakeHomey(settings = {}) {
  const store = new Map(Object.entries(settings));
  const intervals = [];
  return {
    store,
    settings: {
      get: (key) => (store.has(key) ? store.get(key) : null),
      set: (key, value) => store.set(key, value),
      unset: (key) => store.delete(key),
      on: () => {},
    },
    manifest: { version: 'test' },
    setInterval: (fn, ms) => { intervals.push(ms); return intervals.length; },
    clearInterval: () => {},
    setTimeout,
    clearTimeout,
    drivers: { getDrivers: () => ({}), getDriver: () => ({ getDevices: () => [] }) },
    ble: { discover: async () => { throw new Error('no Bluetooth in this test'); } },
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

test('app.js without a 3.0 network: gen 1 starts and stops as before, lib/sg3 is never loaded', async () => {
  freshModules();
  bridgeCalls.length = 0;
  const App = load(path.join(ROOT, 'app.js'));
  const app = new App();
  app.homey = fakeHomey();
  await app.onInit();
  assert.deepEqual(bridgeCalls, ['new', 'startStatus']);
  assert.equal(app.homey.store.get('debugLogging'), false);
  // Number(null) is 0, a valid counter, so gen 1 leaves seqCounter unset here.
  assert.equal(app._seq, 0);
  assert.equal(app.homey.store.has('seqCounter'), false);
  assert.equal(app.sg3({ create: false }), null);
  await app.onUninit();
  assert.deepEqual(bridgeCalls, ['new', 'startStatus', 'shutdown']);
  assert.deepEqual(sg3Loaded(), []);
});

test('the sg3_dimmer driver and device files load nothing from lib/sg3', () => {
  freshModules();
  load(path.join(ROOT, 'drivers', 'sg3_dimmer', 'driver.js'));
  load(path.join(ROOT, 'drivers', 'sg3_dimmer', 'device.js'));
  load(path.join(ROOT, 'api.js'));
  assert.deepEqual(sg3Loaded(), []);
});

test('a 3.0 device has none of the methods app.js calls on gen 1 devices', () => {
  freshModules();
  const Device = load(path.join(ROOT, 'drivers', 'sg3_dimmer', 'device.js'));
  for (const name of GEN1_DEVICE_METHODS) {
    assert.equal(typeof Device.prototype[name], 'undefined', name);
  }
});

test('a 3.0 device without a network is unavailable, and still loads no 3.0 code', async () => {
  freshModules();
  const App = load(path.join(ROOT, 'app.js'));
  const Device = load(path.join(ROOT, 'drivers', 'sg3_dimmer', 'device.js'));
  const app = new App();
  app.homey = fakeHomey();
  const device = new Device();
  device.homey = { ...app.homey, app };
  await device.onInit();
  assert.equal(device.unavailable, 'sg3.device.notConfigured');
  assert.deepEqual(sg3Loaded(), []);
});

test('the status API answers without loading 3.0 code when nothing is set up', async () => {
  freshModules();
  const App = load(path.join(ROOT, 'app.js'));
  const api = load(path.join(ROOT, 'api.js'));
  const app = new App();
  app.homey = fakeHomey();
  assert.deepEqual(await api.getSg3Status({ homey: { ...app.homey, app } }), { configured: false });
  assert.deepEqual(sg3Loaded(), []);
});

test('with a network imported, the same device does load the controller (it is lazy, not missing)', async () => {
  freshModules();
  const App = load(path.join(ROOT, 'app.js'));
  const Device = load(path.join(ROOT, 'drivers', 'sg3_dimmer', 'device.js'));
  const app = new App();
  app.homey = fakeHomey({
    sg3Network: JSON.stringify({ netKeys: [{ key: '7dd7364cd842ad18c17c2b820c84c3d6' }], appKeys: [{ key: '63964771734fbd76e3b40519d1d94a48' }], nodes: [] }),
  });
  const device = new Device();
  device.homey = { ...app.homey, app };
  await device.onInit();
  assert.equal(device.unavailable, undefined);
  assert.equal(device.capabilityListeners.length, 1);
  assert.ok(sg3Loaded().length > 0);
  await app._sg3.stop();
});
