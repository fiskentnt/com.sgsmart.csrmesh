'use strict';

// "Keep SG Smart 3.0 connected" (app.js, sg3Held), as "Keep dimmers
// connected" for the first generation: the user's choice, or by default on
// with two or more 3.0 devices in Homey that can carry the link, off with
// one. Which 3.0 types can (lib/sgProducts.js, bridge), and that a pairing
// search lets a held 3.0 link go with the first generation's
// (lib/csrPairing.js, pauseForScan). Made-up home key.

const test = require('node:test');
const assert = require('node:assert/strict');

const fake = require('./helpers/fake-homey');

fake.install();

const SGSmartApp = require('../app');
const SGMeshDriver = require('../drivers/sg_mesh/driver');
const { SG3_PRODUCTS, sg3CanBeBridge } = require('../lib/sgProducts');

const HOME_KEY = '0a1b2c3d4e5f';

// A 3.0 device in Homey as app.js sees it.
const sg3Device = (address, { bridge = true, deleted = false } = {}) => ({
  getData: () => ({ id: `sig:${HOME_KEY}:${address.toString(16).padStart(4, '0')}` }),
  getSg3Address: () => (deleted ? null : address),
  getSg3HomeKey: () => HOME_KEY,
  canBeSg3Bridge: () => bridge,
});

function appWith(devices, choice) {
  const app = Object.create(SGSmartApp.prototype);
  app.homey = fake.fakeHomey(app, { drivers: { getDrivers: () => ({ sg_mesh: { getDevices: () => devices } }) } });
  app.log = () => {};
  app.error = () => {};
  app._sg3Home = HOME_KEY;
  if (choice !== undefined) app.homey.settings.set('sg3KeepConnected', choice);
  return app;
}

test('every 3.0 type this build adds says whether it can be a bridge; the dimmers can, a type not known here cannot', () => {
  for (const [type, product] of Object.entries(SG3_PRODUCTS)) assert.equal(typeof product.bridge, 'boolean', type);
  assert.equal(sg3CanBeBridge(3080), true);
  assert.equal(sg3CanBeBridge(3081), true);
  for (const type of [3018, 3100, 101, undefined, null]) assert.equal(sg3CanBeBridge(type), false, String(type));
});

test('by default: off with one 3.0 device in Homey that can be a bridge, on with two; one that cannot is not counted', () => {
  assert.deepEqual(appWith([sg3Device(3)]).sg3Held(), { held: false, why: 'by default with 1 3.0 device(s) in Homey that can be a bridge' });
  assert.deepEqual(appWith([sg3Device(3), sg3Device(4)]).sg3Held(),
    { held: true, why: 'by default with 2 3.0 device(s) in Homey that can be a bridge' });
  assert.equal(appWith([sg3Device(3), sg3Device(9, { bridge: false })]).sg3Held().held, false);
  assert.equal(appWith([sg3Device(3), sg3Device(4, { deleted: true })]).sg3Held().held, false, 'a deleted one is not counted');
});

test('the choice wins both ways; with no 3.0 device in Homey nothing is held, whatever the choice', () => {
  assert.deepEqual(appWith([sg3Device(3)], true).sg3Held(), { held: true, why: 'chosen on' });
  assert.deepEqual(appWith([sg3Device(3), sg3Device(4)], false).sg3Held(), { held: false, why: 'chosen off' });
  assert.equal(appWith([], true).sg3Held().held, false);
});

test('when the 3.0 devices change, the default is kept for the settings page and the link follows', () => {
  const devices = [sg3Device(3)];
  const app = appWith(devices);
  let applied = 0;
  app._sg3 = { applyMode: () => { applied += 1; } };
  app.sg3DevicesChanged();
  app.sg3DevicesChanged();
  app.homey.runMs(2000);
  assert.equal(app.homey.settings.get('sg3KeepConnectedDefault'), false);
  assert.equal(applied, 1, 'once for both');
  devices.push(sg3Device(4));
  app.sg3DevicesChanged();
  app.homey.runMs(2000);
  assert.equal(app.homey.settings.get('sg3KeepConnectedDefault'), true);
  assert.equal(app.homey.settings.get('keepConnectedDefault'), null, 'the first generation default is not touched');
});

test('a pairing search pauses the first generation link and the 3.0 link, and ends both pauses', async () => {
  const calls = [];
  const app = {
    csr: fake.fakeCsr([]),
    _devices: () => [],
    bridge: { pauseForScan: async (label) => { calls.push(`gen1 ${label}`); return (why) => calls.push(`gen1 end ${why}`); } },
    sg3PauseForScan: async (label) => { calls.push(`3.0 ${label}`); return (why) => calls.push(`3.0 end ${why}`); },
  };
  const homey = fake.listenAtOnce(fake.fakeHomey(app, { ble: { discover: async () => [] } }));
  const driver = new SGMeshDriver({ homey });
  driver.getDevices = () => [];
  const session = { handlers: {}, setHandler(name, handler) { this.handlers[name] = handler; }, showView: async () => {} };
  await driver.onPair(session);
  await session.handlers.showView('loading');
  await session.handlers.list_devices().catch(() => {});
  assert.deepEqual(calls, ['gen1 pairing scan', '3.0 pairing scan', 'gen1 end list answered', '3.0 end list answered']);
});

test('the app hands a pairing pause to the 3.0 controller, and gives none without it', async () => {
  const app = appWith([]);
  assert.equal(await app.sg3PauseForScan('pairing scan'), null);
  app._sg3 = { pauseForScan: async (label) => `ended ${label}` };
  assert.equal(await app.sg3PauseForScan('pairing scan'), 'ended pairing scan');
});

test('the settings page is told which box to show: the first generation box with a dimmer, the 3.0 box with a 3.0 device', () => {
  const gen1 = { getData: () => ({ id: '@ND1A2B' }), getMeshId: () => 0x1a2b };
  const devices = [];
  const app = appWith(devices);
  app.bridge = { applyMode: () => {} };
  app.dimmersChanged();
  app.sg3DevicesChanged();
  app.homey.runMs(2000);
  assert.equal(app.homey.settings.get('keepConnectedShown'), false);
  assert.equal(app.homey.settings.get('sg3KeepConnectedShown'), false);
  devices.push(gen1);
  app.dimmersChanged();
  app.homey.runMs(2000);
  assert.equal(app.homey.settings.get('keepConnectedShown'), true);
  assert.equal(app.homey.settings.get('sg3KeepConnectedShown'), false);
  devices.push(sg3Device(3, { bridge: false }));
  app.sg3DevicesChanged();
  app.homey.runMs(2000);
  assert.equal(app.homey.settings.get('sg3KeepConnectedShown'), true, 'any 3.0 device, also one that cannot be a bridge');
  assert.equal(app.homey.settings.get('sg3KeepConnectedDefault'), false);
});

test('an error about one device is that device\'s own line, without its name; Homey names the device in front', () => {
  const lines = { device: [], app: [] };
  const named = (name, fail) => ({
    getData: () => ({ id: '@ND1A2B' }), getName: () => name, getMeshId: () => 0x1a2b,
    applyMeshStatus() { throw new Error(fail); },
    getNetworkKey() { throw new Error(fail); },
    error: (line) => lines.device.push(line),
  });
  const app = appWith([named('Made-up Kitchen Spot', 'made-up failure')]);
  app.error = (line) => lines.app.push(line);
  // Only the step that applies the status to each device.
  app._locations = new Map();
  app._statusHeard = () => {};
  app._dispatchStatus('1a2b', 50, null);
  app.getNetworkKey();
  assert.deepEqual(lines.device, ['applying status failed: made-up failure', 'reading the network key failed: made-up failure']);
  assert.deepEqual(lines.app, []);
});
