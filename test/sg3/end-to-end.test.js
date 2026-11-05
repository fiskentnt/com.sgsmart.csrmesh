'use strict';

// SG Smart 3.0 from the login to the light, against a simulated LEDDim Smart
// 3.0 (simulated-node.js) behind Homey's Bluetooth: the SG account gives the
// network (made-up keys, home key and name), sg_mesh lists the dimmer from
// the account, the device is added, on, a level and off reach the dimmer as
// one command each, and its status comes back to onoff and dim. Every line
// logged on the way is checked for keys, the home's key and the name.

const test = require('node:test');
const assert = require('node:assert/strict');

const fake = require('../helpers/fake-homey');

fake.install();

const { SgAccount } = require('../../lib/account');
const SGSmartApp = require('../../app');
const SGMeshDriver = require('../../drivers/sg_mesh/driver');
const SG3Device = require('../../lib/SG3Device');
const { STATUS_BLOCK_MS } = require('../../lib/sg3/controller');
const { SimulatedSgNode } = require('./simulated-node');
const { advert } = require('./fake-homey');

const hex = (s) => Buffer.from(s, 'hex');
const NET_KEY = '7dd7364cd842ad18c17c2b820c84c3d6';
const APP_KEY = '63964771734fbd76e3b40519d1d94a48';
const HOME_KEY = '0a1b2c3d4e5f';
const NAME = 'Made-up stue';
const PERIPHERAL = 'a1b2c3d4e5f6deadbeef';

// The home as the account module gives it (interface 4).
const HOME = {
  homeKey: HOME_KEY, passphrase: null, netKey: NET_KEY.toUpperCase(), appKey: APP_KEY, locationId: null,
  devices: [{ meshId: 0x0003, type: 3080, name: NAME, certain: true }, { meshId: 0x8001, type: 101, name: null, certain: false }],
};

const until = async (what, done) => {
  for (let i = 0; i < 200; i += 1) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`never: ${what}`);
};

// The app as far as 3.0 needs it, with real timers, a Bluetooth whose one
// advertisement is the simulated dimmer (with nodeOptions), and sg_mesh's
// devices.
function world(nodeOptions = {}) {
  const node = new SimulatedSgNode({
    netKey: hex(NET_KEY), appKey: hex(APP_KEY), address: 0x0003, level: 40, on: false, statusGroup: 0xffff, ...nodeOptions,
  });
  const calls = { connect: [], order: [], peripherals: [] };
  const logs = [];
  const values = new Map();
  const devices = [];
  const app = Object.create(SGSmartApp.prototype);
  app.log = (...args) => logs.push(args.join(' '));
  app.error = (...args) => logs.push(args.join(' '));
  app.homey = {
    app,
    settings: { get: (k) => (values.has(k) ? values.get(k) : null), set: (k, v) => values.set(k, v), unset: (k) => values.delete(k) },
    __: (key) => key,
    manifest: { version: '2.8.0' },
    setTimeout,
    clearTimeout,
    setInterval: (fn, ms) => setInterval(fn, ms).unref(),
    clearInterval,
    ble: { discover: async () => [advert(node, { uuid: PERIPHERAL, calls })] },
    drivers: { getDrivers: () => ({ sg_mesh: { getDevices: () => devices } }) },
    clock: { getTimezone: () => 'Europe/Oslo' },
  };
  app.csr = fake.fakeCsr([]);
  app.account = new SgAccount(app, { fetch: async () => ({ homes: [HOME], loggedOut: true }) });
  return { app, node, logs, devices, values };
}

// The list after Homey's loading view, as test/password-login.test.js has it.
async function pairList(driver) {
  const session = { handlers: {}, views: [] };
  session.setHandler = (name, handler) => { session.handlers[name] = handler; };
  session.showView = async (view) => { session.views.push(view); };
  await driver.onPair(session);
  await session.handlers.showView('loading');
  return session.handlers.list_devices();
}

// A device as Homey makes it from a listed one, with its capability listener.
async function added(app, devices, listed) {
  const device = new SG3Device({ homey: app.homey, ...listed });
  device.registerMultipleCapabilityListener = (capabilities, listener) => { device.listener = listener; };
  devices.push(device);
  await device.onInit();
  await device.onAdded();
  return device;
}

test('from the login to the light: listed from the account, added, on, a level and off, and the wheel\'s status back', async () => {
  const { app, node, logs, devices } = world();
  await app.account.login('tester@example.invalid', 'made-up pass 7');
  assert.ok(logs.includes('[SG account] SG Smart 3.0: 1 device(s), 1 certain with an id from 0x0001 to 0x7f7f, '
    + '1 of a type this build adds; 1 home(s) with a 3.0 network, 1 home key(s)'), logs.join('\n'));
  assert.equal(app._sg3, undefined, 'no controller before a 3.0 device asks for it');

  // Pairing: the dimmer from the account, named as in the SG app; nothing
  // sent for it.
  const driver = new SGMeshDriver({ homey: app.homey });
  driver.getDevices = () => devices;
  const listed = await pairList(driver);
  assert.deepEqual(listed, [{
    name: NAME,
    data: { id: `sig:${HOME_KEY}:0003` },
    capabilities: ['onoff', 'dim'],
    store: { sg3Type: 3080 },
    settings: { passphrase: '', netkey_hex: '' },
  }]);
  assert.equal(driver.onMapDeviceClass({ getData: () => listed[0].data }), SG3Device);
  assert.deepEqual(node.events, [], 'nothing sent while pairing');

  // Added: the link comes up and the dimmer is asked for its status.
  const device = await added(app, devices, listed[0]);
  assert.equal(device.available, true);
  await until('the first status', () => device.getCapabilityValue('onoff') === false);
  assert.equal(device.getCapabilityValue('dim'), undefined, 'off: the level is not shown');

  // On, a level and off: one command each, to the dimmer.
  device.listener({ onoff: true });
  await until('on', () => node.on === true);
  device.listener({ dim: 0.25 });
  await until('level 25', () => node.level === 25);
  device.listener({ onoff: false });
  await until('off', () => node.on === false);
  assert.deepEqual(node.events.filter((event) => event.startsWith('level')), ['level 101', 'level 25', 'level 0']);
  assert.equal(device.warning, null);

  // The wheel, once the 4 s after the last command are over.
  app._sg3.now = () => Date.now() + STATUS_BLOCK_MS;
  node.localChange({ on: true, level: 60 });
  await until('the wheel\'s status', () => device.getCapabilityValue('dim') === 0.6);
  assert.equal(device.getCapabilityValue('onoff'), true);

  // A second pairing lists nothing new; deleting lets the link go.
  assert.deepEqual(await pairList(driver), []);
  await device.onDeleted();
  devices.length = 0;
  await until('the link let go', () => !app._sg3.bridge.link);
  await app._sg3.stop();
  app.account.stop();

  const lines = [...logs, ...device.logs, ...device.errors, ...driver.logs, ...driver.errors];
  assert.ok(lines.some((line) => line.startsWith('[SG3] filter ok via 0x0003, an empty reject list')), lines.join('\n'));
  assert.ok(lines.some((line) => /^\[SG3\] 0x0003 level 25 to 0x0003 on link #1: 2 segment\(s\), 4 write\(s\)/.test(line)), lines.join('\n'));
  for (const line of lines) {
    assert.doesNotMatch(line, /[0-9a-f]{32}/i, `a 32-digit hex string in: ${line}`);
    for (const secret of [NET_KEY, APP_KEY, HOME_KEY, NAME, PERIPHERAL, 'tester@example.invalid', 'made-up pass 7']) {
      assert.ok(!line.toLowerCase().includes(secret.toLowerCase()), `"${secret}" in: ${line}`);
    }
  }
});

test('the reserve, 0xFFFF: the same dimmer reached with the node in the payload', async () => {
  const { app, node, devices } = world();
  await app.account.login('tester@example.invalid', 'made-up pass 7');
  const device = await added(app, devices, {
    name: NAME, data: { id: `sig:${HOME_KEY}:0003` }, store: { sg3Type: 3080 }, settings: {},
  });
  await until('the first status', () => device.getCapabilityValue('onoff') === false);
  app._sg3.sendTo = 'all';
  device.listener({ dim: 0.5 });
  await until('level 50', () => node.level === 50);
  await app._sg3.stop();
  app.account.stop();
});

test('the dimmer as it answers, with its long status reply: added while on at 40 %, Homey shows on at 40 %, and the link stays', async () => {
  for (const notifyMax of [20, 244]) {
    const { app, node, devices, logs } = world({ longPdus: true, statusLength: 22, notifyMax, on: true, level: 40 });
    await app.account.login('tester@example.invalid', 'made-up pass 7');
    const device = await added(app, devices, {
      name: NAME, data: { id: `sig:${HOME_KEY}:0003` }, store: { sg3Type: 3080 }, settings: {},
    });
    await until('the first status', () => device.getCapabilityValue('onoff') === true);
    assert.equal(device.getCapabilityValue('dim'), 0.4);
    device.listener({ dim: 0.6 });
    await until('level 60', () => node.level === 60);
    await until('the ack in the log', () => logs.some((line) => /level 60 .*acked yes/.test(line)));
    assert.ok(!logs.some((line) => /dropped|message too long/.test(line)), logs.join('\n'));
    assert.equal(app._sg3.counts.links, 1);
    await app._sg3.stop();
    app.account.stop();
  }
});
