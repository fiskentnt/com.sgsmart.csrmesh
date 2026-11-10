'use strict';

// The names from the SG account (2.7.0, lib/account.js and lib/csrPairing.js,
// named): the name the user gave a device in the SG app is the name pairing
// suggests, when it is text, not empty and not too long, and the device's
// mesh id is in exactly one home. Anything else, and any error, gives the
// name as without an account, and never stops a pairing. A name is never in
// the log or "Show log". Made-up names only. Run with:
// node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const fake = require('./helpers/fake-homey');

fake.install();

const { NAME_MAX, SETTING, SgAccount, cleanName } = require('../lib/account');
const { named } = require('../lib/csrPairing');
const { csrProductForName } = require('../lib/sgProducts');
const SGMeshDriver = require('../drivers/sg_mesh/driver');
const SGPillDriver = require('../drivers/sg_pill/driver');
const SGSmartApp = require('../app');

const EMAIL = 'tester@example.invalid';
const PASSWORD = 'made-up pass 7';
const LOC = 0x5a3c;
const LONG = 'L'.repeat(NAME_MAX + 1);

const tick = () => new Promise((resolve) => setImmediate(resolve));
const __ = (key, tokens) => (tokens ? `${key} ${JSON.stringify(tokens)}` : key);

// Every name a made-up account below has, to look for in logs.
const NAMES = ['Stue', 'Made-up hall', 'Kjøkken taklys', 'Gang', 'Made-up shared', LONG];

// The account as the module gives it: home 1 with names for each case, home
// 2 sharing one mesh id (0x8005) with home 1. A first generation dimmer has
// type 101, a Pill 1004.
const HOMES = () => [{
  passphrase: null, netKey: null, appKey: null, locationId: 0x4242,
  devices: [
    { meshId: 0x8001, type: 101, name: 'Stue' },
    { meshId: 0x8002, type: 101, name: '' },
    { meshId: 0x8003, type: 101, name: 42 },
    { meshId: 0x8004, type: 101, name: LONG },
    { meshId: 0x8005, type: 101, name: 'Made-up shared' },
    { meshId: 0x8006, type: 101 },
    { meshId: 0x8007, type: 101, name: '‮Kjøkken\ttaklys\n' },
    { meshId: 0x8008, type: 101, name: '   ' },
    { meshId: 0x8011, type: 1004, name: 'Made-up hall' },
  ],
}, {
  passphrase: null, netKey: null, appKey: null, locationId: 0x4343,
  devices: [{ meshId: 0x8005, type: 101, name: 'Gang' }],
}];

function fakeSettings() {
  const values = new Map();
  return {
    values,
    get: (key) => (values.has(key) ? values.get(key) : null),
    set: (key, value) => values.set(key, value),
    unset: (key) => values.delete(key),
  };
}

// An app with an SG account fetched from homes (the module's answer), the
// devices added here, and a CsrNetwork for pairing with these FF11 answers.
async function appWith({ homes = HOMES(), devices = [], nodes = [], fetched = true } = {}) {
  const app = {
    logs: [],
    errors: [],
    log(...args) { app.logs.push(args.join(' ')); },
    error(...args) { app.errors.push(args.join(' ')); },
    _devices: () => devices,
    recentlyHeard: () => false,
    heardSinceStart: () => false,
    csr: fake.fakeCsr(nodes),
  };
  app.csr.requestStatus = async () => true;
  app.homey = fake.fakeHomey(app, { settings: fakeSettings() });
  app.account = new SgAccount(app, { fetch: async () => ({ homes, loggedOut: true }) });
  if (fetched) {
    await app.account.login(EMAIL, PASSWORD);
    for (let i = 0; i < 20; i += 1) {
      await tick();
      if (app.homey.pending.size) app.homey.runAll();
    }
  }
  return app;
}

// A driver of DriverClass on app, with this scan.
function driverOn(DriverClass, app, advertisements) {
  const homey = fake.listenAtOnce(fake.fakeHomey(app, { ble: { discover: async () => advertisements } }));
  const driver = new DriverClass({ homey });
  driver.homey.__ = __;
  driver.getDevices = () => [];
  return driver;
}

// The list after Homey's loading view, as the user gets it.
async function pairList(driver) {
  const session = { handlers: {}, setHandler(name, fn) { this.handlers[name] = fn; }, showView: async () => {} };
  await driver.onPair(session);
  await session.handlers.showView('loading');
  return session.handlers.list_devices();
}

const adv = (localName) => ({ uuid: `uuid-${localName}`, localName, rssi: -60, connectable: true });
const gen1 = (meshId) => adv(`@ND${meshId.toString(16).toUpperCase()}`);

// ---- the name as it may be used

test('cleanName: text, cleaned; null when missing, empty, not text, or longer than NAME_MAX', () => {
  for (const [value, expected] of [
    ['Stue', 'Stue'], ['  Stue  ', 'Stue'], ['Kjøkken\ttaklys\n', 'Kjøkken taklys'], ['a\u0000b', 'a b'],
    ['‮Stue', 'Stue'], ['﻿Stue', 'Stue'], ['Stue 😀', 'Stue 😀'], ['👨‍👩‍👧', '👨‍👩‍👧'],
    ['L'.repeat(NAME_MAX), 'L'.repeat(NAME_MAX)], ['😀'.repeat(NAME_MAX), '😀'.repeat(NAME_MAX)],
    [undefined, null], [null, null], ['', null], ['   ', null], ['​', null], ['\n\t', null],
    [42, null], [true, null], [{ name: 'Stue' }, null], [['Stue'], null],
    [LONG, null], ['😀'.repeat(NAME_MAX + 1), null], ['x'.repeat(100000), null],
  ]) {
    assert.equal(cleanName(value), expected, String(JSON.stringify(value)).slice(0, 40));
  }
  assert.equal(NAME_MAX, 64);
});

test('the names are kept with the device list, cleaned, and a name the app cannot use is kept as none', async () => {
  const app = await appWith();
  const kept = app.homey.settings.get(SETTING).homes[0].devices;
  assert.deepEqual(kept.map((device) => device.name),
    ['Stue', null, null, null, 'Made-up shared', null, 'Kjøkken taklys', null, 'Made-up hall']);
  assert.ok(app.logs.some((line) => /kept 2 home\(s\).*10 device\(s\), 5 with a name, 0 uncertain$/.test(line)));
});

test('nameFor: the name of a mesh id in exactly one home; none in two homes, none unknown, none without an account', async () => {
  const app = await appWith();
  assert.equal(app.account.nameFor(0x8001), 'Stue');
  assert.equal(app.account.nameFor(0x8005), null, 'in two homes: as today');
  assert.equal(app.account.nameFor(0x9999), null);
  assert.equal(app.account.nameFor(null), null);
  const none = await appWith({ fetched: false });
  assert.equal(none.account.nameFor(0x8001), null);
});

// ---- pairing

test('pairing a first generation dimmer: each case, and the name as without an account when it cannot be used', async () => {
  const ids = [0x8001, 0x8002, 0x8003, 0x8004, 0x8005, 0x8006, 0x8007, 0x8008, 0x8009];
  const today = (meshId) => `LEDDim Smart ${meshId.toString(16).toUpperCase()}`;
  const expected = {
    [0x8001]: 'Stue', // a name
    [0x8002]: today(0x8002), // empty
    [0x8003]: today(0x8003), // not text
    [0x8004]: today(0x8004), // too long
    [0x8005]: today(0x8005), // the mesh id is in two homes
    [0x8006]: today(0x8006), // missing
    [0x8007]: 'Kjøkken taklys', // odd characters, cleaned
    [0x8008]: today(0x8008), // only spaces
    [0x8009]: today(0x8009), // not in the account
  };
  const app = await appWith();
  const driver = driverOn(SGMeshDriver, app, ids.map(gen1));
  const listed = await pairList(driver);
  assert.deepEqual(Object.fromEntries(listed.map((device) => [Number.parseInt(device.data.id.slice(3), 16), device.name])), expected);
  for (const device of listed) assert.equal(device.data.id, `@ND${device.data.id.slice(3)}`, 'the id is as without an account');
  assert.deepEqual(driver.logs.filter((line) => / named as in the SG account$/.test(line)),
    ['pair: 0x8001 named as in the SG account', 'pair: 0x8007 named as in the SG account']);
});

test('pairing a later device takes its name the same way, by its FF11 mesh id', async () => {
  const product = csrProductForName('@SC0001');
  const app = await appWith({ nodes: [{ meshId: 0x8011, name: '@SC0001', product, location: LOC }] });
  const listed = await pairList(driverOn(SGPillDriver, app, [adv('@SC0001')]));
  assert.deepEqual(listed.map((device) => [device.data.id, device.name, device.store.meshId]), [['@SC0001', 'Made-up hall', 0x8011]]);
});

test('without an account, or with a module of interface 1 (no names), pairing names as before', async () => {
  const ids = [0x8001, 0x8007];
  const before = ['LEDDim Smart 8001', 'LEDDim Smart 8007'];
  const noAccount = await appWith({ fetched: false });
  assert.deepEqual((await pairList(driverOn(SGMeshDriver, noAccount, ids.map(gen1)))).map((d) => d.name), before);
  const v1 = HOMES().map((home) => ({ ...home, devices: home.devices.map(({ name, ...device }) => device) }));
  const oldModule = await appWith({ homes: v1 });
  assert.deepEqual(oldModule.homey.settings.get(SETTING).homes[0].devices.map((device) => device.name), Array(9).fill(null));
  assert.deepEqual((await pairList(driverOn(SGMeshDriver, oldModule, ids.map(gen1)))).map((d) => d.name), before);
});

test('an error anywhere in the name gives the name as before, and the pairing goes on', async () => {
  const device = { name: 'LEDDim Smart 8001', data: { id: '@ND8001' } };
  const driverWith = (app) => ({ homey: { app }, logs: [], errors: [], log(line) { this.logs.push(line); }, error(line) { this.errors.push(line); } });
  for (const account of [
    { fetched: () => true, nameFor: () => { throw new TypeError('made-up failure'); } },
    { fetched: () => { throw new Error('made-up failure'); } },
    { fetched: () => true, nameFor: () => ({ toString() { throw new Error('made-up'); } }) },
    { fetched: () => true, nameFor: () => 'Stue', get bad() { throw new Error('never read'); } },
  ]) {
    const driver = driverWith({ account });
    const result = named(driver, device, 0x8001);
    assert.ok(result === device || result.name === 'Stue');
    for (const line of [...driver.logs, ...driver.errors]) assert.ok(!line.includes('Stue'), line);
  }
  const broken = driverWith({ account: { fetched: () => true, nameFor: () => { throw new TypeError('made-up failure'); } } });
  assert.equal(named(broken, device, 0x8001), device);
  assert.deepEqual(broken.errors, ['pair: no name from the SG account (TypeError)']);
  // A driver whose log throws still gets its device back.
  const loud = { homey: { app: { account: { fetched: () => true, nameFor: () => 'Stue' } } }, log() { throw new Error('x'); }, error() { throw new Error('x'); } };
  assert.equal(named(loud, device, 0x8001), device);
  assert.equal(named({ homey: {} }, device, 0x8001), device);
  assert.equal(named({ homey: { app: { account: { fetched: () => true, nameFor: () => 'Stue' } } }, log() {} }, device, null), device);
  // And a whole pairing with an account that fails still lists the dimmers.
  const app = await appWith();
  app.account.nameFor = () => { throw new TypeError('made-up failure'); };
  assert.deepEqual((await pairList(driverOn(SGMeshDriver, app, [gen1(0x8001)]))).map((d) => d.name), ['LEDDim Smart 8001']);
});

// ---- the log and "Show log"

test('no name is in the log or in "Show log", from the fetch, the check, the pairing or "Forget SG account"', async () => {
  const app = new SGSmartApp();
  const devices = [];
  app.homey = fake.fakeHomey(app, {
    settings: fakeSettings(),
    drivers: { getDrivers: () => ({ one: { getDevices: () => devices } }) },
    manifest: { version: '2.7.0' },
  });
  app.csr = fake.fakeCsr([{ meshId: 0x8011, name: '@SC0001', product: csrProductForName('@SC0001'), location: LOC }]);
  app.csr.requestStatus = async () => true;
  app.account = new SgAccount(app, { fetch: async (email, password, { log }) => { log('SG cloud: 2 home(s), 10 device(s), logged out'); return { homes: HOMES(), loggedOut: true }; } });
  await app.account.login(EMAIL, PASSWORD);
  for (let i = 0; i < 20; i += 1) {
    await tick();
    if (app.homey.pending.size) app.homey.runAll();
  }
  const mesh = driverOn(SGMeshDriver, app, [gen1(0x8001), gen1(0x8007)]);
  const pill = driverOn(SGPillDriver, app, [adv('@SC0001')]);
  assert.deepEqual((await pairList(mesh)).map((d) => d.name), ['Stue', 'Kjøkken taklys']);
  assert.deepEqual((await pairList(pill)).map((d) => d.name), ['Made-up hall']);
  app.account.forget();
  const lines = [...(app.logs || []), ...(app.errors || []), ...mesh.logs, ...mesh.errors, ...pill.logs, ...pill.errors];
  assert.ok(lines.length > 10);
  app.fileLog = { tail: async () => lines };
  app.bridge = { _keepConnected: () => false };
  const { text } = await app.logView();
  for (const name of [...NAMES, 'Kjøkken']) {
    for (const line of lines) assert.ok(!line.includes(name), `"${name}" in: ${line}`);
    assert.ok(!text.includes(name), `"${name}" in "Show log"`);
  }
});

// ---- Forget SG account

test('"Forget SG account" removes the names with the list, and never touches a device already added in Homey', async () => {
  const renamed = [];
  const devices = [{ getData: () => ({ id: '@ND8001' }), getName: () => 'Stue', getMeshId: () => 0x8001, setName: async (name) => renamed.push(name) }];
  const app = await appWith({ devices });
  assert.equal(app.account.nameFor(0x8001), 'Stue');
  app.account.forget();
  assert.deepEqual([...app.homey.settings.values.keys()], []);
  assert.equal(app.account.nameFor(0x8001), null);
  assert.deepEqual(renamed, [], 'no device is renamed');
  assert.equal(devices[0].getName(), 'Stue', 'the device keeps the name it was added with');
  assert.deepEqual((await pairList(driverOn(SGMeshDriver, app, [gen1(0x8002)]))).map((d) => d.name), ['LEDDim Smart 8002']);
});
