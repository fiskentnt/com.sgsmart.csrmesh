'use strict';

// Pointing to the SG account's login when the network password may be wrong
// (2.7.0). Only while the account module is in this build and no account is
// fetched; with an account fetched, or without the module, as before. The
// pairing list: devices of the driver seen in the scan that did not answer
// FF10, and nothing to add (lib/csrPairing.js, loginHint). The dimmers'
// warning and the timeline: the same check as before (MeshBridge), another
// text (app.js). Made-up names.

const test = require('node:test');
const assert = require('node:assert/strict');

const fake = require('./helpers/fake-homey');

fake.install();

const SGSmartApp = require('../app');
const { SgAccount } = require('../lib/account');
const { csrProductForName } = require('../lib/sgProducts');
const SGMeshDriver = require('../drivers/sg_mesh/driver');
const SGPillDriver = require('../drivers/sg_pill/driver');
const SGPlugDriver = require('../drivers/sg_plug/driver');
const SGThermostatDriver = require('../drivers/sg_thermostat/driver');

const __ = (key, tokens) => `${key}${tokens ? ` ${JSON.stringify(tokens)}` : ''}`;

// The account as the app has it: the module in this build or not, and an
// account fetched or not. undefined: no account at all.
const ACCOUNTS = {
  'no account fetched': { available: () => true, fetched: () => false, devices: () => [], typeFor: () => null, nameFor: () => null },
  'an account fetched': { available: () => true, fetched: () => true, devices: () => [], typeFor: () => null, nameFor: () => null },
  'no module': { available: () => false, fetched: () => false, devices: () => [], typeFor: () => null, nameFor: () => null },
  'no account object': undefined,
};

const adv = (uuid, localName) => ({ uuid, localName, rssi: -60, connectable: true });

// Driver with this scan, these FF11 answers, these added and this account.
function pairingDriver(Driver, advertisements, { nodes = [], added = [], account } = {}) {
  const app = { csr: fake.fakeCsr(nodes), _devices: () => [], account };
  const homey = fake.listenAtOnce(fake.fakeHomey(app, { ble: { discover: async () => advertisements } }));
  const driver = new Driver({ homey });
  driver.homey.__ = __;
  driver.getDevices = () => added.map((id) => ({ getData: () => ({ id }) }));
  return driver;
}

// The list after Homey's loading view: the devices, or the one text thrown.
async function pairList(driver) {
  const session = { handlers: {}, views: [] };
  session.setHandler = (name, handler) => { session.handlers[name] = handler; };
  session.showView = async (view) => { session.views.push(view); };
  await driver.onPair(session);
  await session.handlers.showView('loading');
  try {
    return await session.handlers.list_devices();
  } catch (err) {
    return `text: ${err.message}`;
  }
}

const LOGIN = 'text: pair.csr.noAnswerLogin';

for (const [Driver, id, seen] of [
  [SGPillDriver, 'sg_pill', '@SC1A2B'], [SGPlugDriver, 'sg_plug', '@GB3C4D'], [SGThermostatDriver, 'sg_thermostat', '@MT5E6F'],
]) {
  test(`${id}: a device seen without an answer and nothing to add: the login text without an account fetched, else an empty list`, async () => {
    for (const [what, account] of Object.entries(ACCOUNTS)) {
      const listed = await pairList(pairingDriver(Driver, [adv('a', seen)], { account }));
      assert.deepEqual(listed, what === 'no account fetched' ? LOGIN : [], what);
    }
    // Nothing seen: an empty list, Homey's own text, also without an account.
    assert.deepEqual(await pairList(pairingDriver(Driver, [], { account: ACCOUNTS['no account fetched'] })), []);
  });
}

test('sg_pill: one Pill answered and one did not: the one that answered is listed, without the login text', async () => {
  const node = { meshId: 0x0123, name: '@SC1A2B', product: csrProductForName('@SC1A2B'), location: 0x4242 };
  const listed = await pairList(pairingDriver(SGPillDriver, [adv('a', '@SC1A2B'), adv('b', '@SC3C4D')],
    { nodes: [node], account: ACCOUNTS['no account fetched'] }));
  assert.ok(Array.isArray(listed), String(listed));
  assert.deepEqual(listed.map((device) => device.data.id), ['@SC1A2B']);
});

test('sg_pill: the log says why the list has the login text', async () => {
  const driver = pairingDriver(SGPillDriver, [adv('a', '@SC1A2B')], { account: ACCOUNTS['no account fetched'] });
  await pairList(driver);
  assert.ok(driver.logs.includes('pair: list_devices: error no answer from a Pill seen, no SG account'));
});

test('sg_mesh: a later dimmer seen without an answer: the login text instead of the general advice, without an account fetched', async () => {
  for (const [what, account] of Object.entries(ACCOUNTS)) {
    const listed = await pairList(pairingDriver(SGMeshDriver, [adv('b', '@GD3C4D')], { account }));
    assert.equal(listed, what === 'no account fetched' ? LOGIN : 'text: pair.noDimmersFound', what);
  }
  // Nothing seen, or only a first generation dimmer: as before.
  assert.equal(await pairList(pairingDriver(SGMeshDriver, [], { account: ACCOUNTS['no account fetched'] })), 'text: pair.noDimmersFound');
  const gen1 = await pairList(pairingDriver(SGMeshDriver, [adv('a', '@ND1A2B')], { account: ACCOUNTS['no account fetched'] }));
  assert.deepEqual(gen1.map((device) => device.data.id), ['@ND1A2B']);
});

test('sg_mesh: the first generation dimmers all added and a later one without an answer: the login text instead of the empty list', async () => {
  for (const [what, account] of Object.entries(ACCOUNTS)) {
    const listed = await pairList(pairingDriver(SGMeshDriver, [adv('a', '@ND1A2B'), adv('b', '@GD3C4D')], { added: ['@ND1A2B'], account }));
    assert.deepEqual(listed, what === 'no account fetched' ? LOGIN : [], what);
  }
});

// The app as far as the password warning goes: its devices, its account and
// what the timeline got.
function warningApp(account, devices = []) {
  const app = Object.create(SGSmartApp.prototype);
  app.logs = [];
  app.log = (...args) => app.logs.push(args.join(' '));
  app.error = (...args) => app.logs.push(args.join(' '));
  app.account = account;
  app._statusUnreadable = false;
  app._devices = () => devices;
  app.sent = [];
  app.homey = fake.fakeHomey(app, { notifications: { createNotification: async (notification) => { app.sent.push(notification); } } });
  return app;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('the warning and the timeline point to the login only with the module and no account fetched; else as before', async () => {
  for (const [what, account] of Object.entries(ACCOUNTS)) {
    const app = warningApp(account);
    assert.equal(app.statusUnreadableText(), null, `${what}: no warning while status can be read`);
    app.statusUnreadable();
    await tick();
    const login = what === 'no account fetched';
    assert.equal(app.statusUnreadableText(), login ? 'device.passwordWrongLogin' : 'device.passwordWrong', what);
    assert.deepEqual(app.sent, [{ excerpt: login ? 'notification.passwordWrongLogin' : 'notification.passwordWrong' }], what);
  }
});

test('after a fetch or "Forget SG account" every device says its warning again: the password warning and the one for a device without a location id depend on the account', () => {
  const asked = [];
  const devices = [{ updateAvailability: () => { asked.push('dimmer'); } }];
  const app = warningApp(ACCOUNTS['no account fetched'], devices);
  app.accountChanged();
  assert.deepEqual(asked, ['dimmer'], 'also while status can be read');
  app._statusUnreadable = true;
  app.accountChanged();
  assert.deepEqual(asked, ['dimmer', 'dimmer']);
});

test('lib/account.js tells the app after a fetch and after "Forget SG account", not after a failed fetch', async () => {
  const told = [];
  const app = {
    logs: [],
    log() {},
    error() {},
    accountChanged: () => told.push('changed'),
    _devices: () => [],
    knownLocations: () => [],
    csr: { nodes: new Map(), queueStatusAll: fake.queueAtOnce() },
  };
  const values = new Map();
  app.homey = fake.fakeHomey(app, { settings: { get: (k) => (values.has(k) ? values.get(k) : null), set: (k, v) => values.set(k, v), unset: (k) => values.delete(k) } });
  let fail = true;
  const account = new SgAccount(app, {
    fetch: async () => {
      if (fail) throw Object.assign(new Error('SG cloud login: made-up refusal'), { code: 'SG_CLOUD_LOGIN' });
      return { homes: [{ passphrase: null, netKey: null, appKey: null, locationId: null, devices: [] }], loggedOut: true };
    },
  });
  await account.login('tester@example.invalid', 'made-up pass 7');
  assert.deepEqual(told, [], 'a failed fetch changes nothing');
  fail = false;
  await account.login('tester@example.invalid', 'made-up pass 7');
  assert.deepEqual(told, ['changed']);
  account.forget();
  assert.deepEqual(told, ['changed', 'changed']);
});
