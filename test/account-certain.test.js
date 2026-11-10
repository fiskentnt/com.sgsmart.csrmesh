'use strict';

// Uncertain devices in the SG account (2.7.0, lib/account.js): a device whose
// id does not say which device it is, because the account module says so
// (certain false) or because another device of its home has the same id. It
// is kept and counted in its home's devices, but nothing goes by its id: no
// passphrase, name or type, no FF04, not in "X of Y answer" or in the lists
// of devices that did not answer. Two first generation dimmers, each with
// its own id, are both checked by it. Made-up ids, names and passwords.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const fake = require('./helpers/fake-homey');

fake.install();

const { deriveNetworkKey } = require('../lib/csrmesh');
const { SETTING, SgAccount } = require('../lib/account');
const { FIRST_GENERATION_TYPE } = require('../lib/sgProducts');
const { named, quietInAccount } = require('../lib/csrPairing');
const SGSmartApp = require('../app');
const SGMeshDevice = require('../lib/SGDeviceBase');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

const EMAIL = 'tester@example.invalid';
const PASSWORD = 'made-up pass 7';
const ISOLATED = 'c0ffee12';
const PILL = 1004;
const PLUG = 2002;

const tick = () => new Promise((resolve) => setImmediate(resolve));

// An app as SgAccount needs it: the first generation dimmers heard lately
// (heard), the later devices that answer an FF04 (answering), the devices
// added here, settings with unset, and what was kept before (kept). It
// records each FF04 (sent) and each mesh id it was asked whether it heard
// lately (asked).
function certainApp({ heard = [], answering = [], devices = [], kept } = {}) {
  const app = {
    logs: [],
    errors: [],
    sent: [],
    asked: [],
    log(...args) { app.logs.push(args.join(' ')); },
    error(...args) { app.errors.push(args.join(' ')); },
    _devices: () => devices,
    recentlyHeard: (meshId) => {
      app.asked.push(meshId);
      return heard.includes(meshId);
    },
    knownLocations: () => [],
  };
  app.csr = {
    nodes: new Map(),
    queueStatusAll: fake.queueAtOnce(async (meshId, location) => {
      app.sent.push([meshId, location]);
      if (answering.includes(meshId)) app.account.heard(meshId);
    }),
  };
  const values = new Map(kept ? [[SETTING, kept]] : []);
  const settings = { values, get: (k) => (values.has(k) ? values.get(k) : null), set: (k, v) => values.set(k, v), unset: (k) => values.delete(k) };
  app.homey = fake.fakeHomey(app, { settings, __: (key, tokens) => `${key}${tokens ? ` ${JSON.stringify(tokens)}` : ''}` });
  return app;
}

// A home as the account module gives it.
const home = (devices, { passphrase = null, locationId = 0x4242 } = {}) => ({ passphrase, netKey: null, appKey: null, locationId, devices });

// Logged in with homes, and the check after it run to its end.
async function loggedIn(app, homes) {
  app.account = new SgAccount(app, { fetch: async () => ({ homes, loggedOut: true }) });
  await app.account.login(EMAIL, PASSWORD);
  for (let i = 0; i < 20; i += 1) {
    await tick();
    if (app.homey.pending.size) app.homey.runAll();
  }
  return app.account;
}

const driverOf = (app) => ({ homey: { app, __: app.homey.__ }, logs: [], log(line) { this.logs.push(line); }, error() {} });
const checkLine = (app) => app.logs.find((line) => line.startsWith('[SG account] check:'));

test('two first generation dimmers, each with its own id: both are checked by it, no FF04 goes to either, and both count', async () => {
  const app = certainApp({ heard: [0x1a2b, 0x3c4d] });
  const account = await loggedIn(app, [home([
    { meshId: 0x1a2b, type: FIRST_GENERATION_TYPE, name: 'Made-up dimmer', certain: true },
    { meshId: 0x3c4d, type: FIRST_GENERATION_TYPE, name: 'Made-up lamp', certain: true },
  ])]);
  assert.deepEqual([...app.asked].sort((a, b) => a - b), [0x1a2b, 0x3c4d]);
  assert.deepEqual(app.sent, [], 'a first generation dimmer gets no FF04');
  const [shown] = account.summary().homes;
  assert.deepEqual([shown.devices, shown.checked, shown.answering, shown.total, shown.quiet], [2, true, 2, 2, []]);
  assert.equal(checkLine(app), '[SG account] check: 2 of 2 answer, 0 asked, 0 skipped as heard, 0 unknown (no location id), 0 uncertain (not counted), 0 SG Smart 3.0 not asked');
  assert.equal(account.nameFor(0x1a2b), 'Made-up dimmer');
  assert.equal(account.nameFor(0x3c4d), 'Made-up lamp');
});

test('of two first generation dimmers with their own ids, the one not heard lately is the one that did not answer', async () => {
  const app = certainApp({ heard: [0x1a2b] });
  const account = await loggedIn(app, [home([
    { meshId: 0x1a2b, type: FIRST_GENERATION_TYPE, name: null, certain: true },
    { meshId: 0x3c4d, type: FIRST_GENERATION_TYPE, name: null, certain: true },
  ])]);
  const [shown] = account.summary().homes;
  assert.deepEqual([shown.answering, shown.total], [1, 2]);
  assert.deepEqual(shown.quiet, [{ product: 'LEDDim Smart', type: FIRST_GENERATION_TYPE, address: '3C4D' }]);
});

test('two first generation dimmers both at 0x8001 (a module before interface 3): both uncertain, no name, not counted, no "X of Y answer"', async () => {
  const app = certainApp({ heard: [0x8001, 0x1a2b] });
  const account = await loggedIn(app, [home([
    { meshId: 0x8001, type: FIRST_GENERATION_TYPE, name: 'Made-up dimmer' },
    { meshId: 0x8001, type: FIRST_GENERATION_TYPE, name: 'Made-up lamp' },
  ], { passphrase: ISOLATED })]);
  assert.deepEqual(app.homey.settings.values.get(SETTING).homes[0].devices.map((device) => device.certain), [false, false]);
  assert.deepEqual(app.asked, [], 'not checked by an id that is not theirs');
  assert.deepEqual(app.sent, []);
  const [shown] = account.summary().homes;
  assert.deepEqual([shown.devices, shown.checked, shown.answering, shown.total, shown.quiet, shown.unknown], [2, true, 0, 0, [], []]);
  assert.equal(account.nameFor(0x8001), null);
  assert.equal(account.typeFor(0x8001), null);
  assert.equal(account.passphraseFor(0x8001), null);
  assert.ok(app.logs.some((line) => /kept 1 home\(s\).*2 device\(s\), 2 with a name, 2 uncertain$/.test(line)));
  assert.equal(checkLine(app), '[SG account] check: 0 of 0 answer, 0 asked, 0 skipped as heard, 0 unknown (no location id), 2 uncertain (not counted), 0 SG Smart 3.0 not asked');
});

test('a device the module says is not certain is not counted or asked; a certain one beside it is', async () => {
  const app = certainApp({ heard: [0x8001], answering: [0x8005] });
  const account = await loggedIn(app, [home([
    { meshId: 0x8001, type: FIRST_GENERATION_TYPE, name: 'Made-up dimmer', certain: false },
    { meshId: 0x8005, type: PILL, name: 'Made-up pill', certain: true },
  ], { passphrase: ISOLATED })]);
  assert.deepEqual(app.sent, [[0x8005, 0x4242]]);
  assert.deepEqual(app.asked, []);
  const [shown] = account.summary().homes;
  assert.deepEqual([shown.devices, shown.answering, shown.total, shown.quiet], [2, 1, 1, []]);
  assert.equal(account.nameFor(0x8001), null);
  assert.equal(account.nameFor(0x8005), 'Made-up pill');
  assert.equal(account.passphraseFor(0x8005), ISOLATED);
  assert.equal(account.passphraseFor(0x8001), null);
});

test('two devices with the same id in one home are both uncertain: no FF04, no name, no type; the same id in two homes is not', async () => {
  // A device added here with that id and its own location id: still no FF04
  // for the account's check.
  const added = { getData: () => ({ id: 'made-up' }), getName: () => 'Made-up added', getCsrMeshId: () => 0x8005, getCsrLocationId: () => 0x4242 };
  const app = certainApp({ answering: [0x8005, 0x8006], devices: [added] });
  const account = await loggedIn(app, [
    home([
      { meshId: 0x8005, type: PILL, name: 'Made-up pill', certain: true },
      { meshId: 0x8005, type: PLUG, name: 'Made-up plug', certain: true },
      { meshId: 0x8006, type: PILL, name: 'Made-up hall', certain: true },
    ]),
    home([{ meshId: 0x8006, type: PILL, name: 'Made-up hall', certain: true }], { locationId: 0x4242 }),
  ]);
  assert.deepEqual(app.sent, [[0x8006, 0x4242]], 'one FF04, to the id that is certain');
  const [first, second] = account.summary().homes;
  assert.deepEqual([first.devices, first.answering, first.total], [3, 1, 1]);
  assert.deepEqual([second.devices, second.answering, second.total], [1, 1, 1]);
  assert.equal(account.nameFor(0x8005), null);
  assert.equal(account.typeFor(0x8005), null);
  // In two homes: certain in each, but no name or type, as before.
  assert.equal(account.nameFor(0x8006), null);
  assert.equal(account.typeFor(0x8006), null);
  assert.ok(checkLine(app).includes('2 uncertain (not counted)'));
});

test('what was kept before certain existed is read with it: two at 0x8001 are uncertain after a restart, other ids certain', () => {
  const kept = {
    fetchedAt: '2026-11-03T20:00:00.000Z',
    check: null,
    homes: [
      home([{ meshId: 0x8001, type: FIRST_GENERATION_TYPE, name: 'Made-up dimmer' }, { meshId: 0x8001, type: FIRST_GENERATION_TYPE, name: 'Made-up lamp' }]),
      home([{ meshId: 0x8005, type: PILL, name: 'Made-up pill' }]),
    ],
  };
  const app = certainApp({ kept });
  app.account = new SgAccount(app, { fetch: async () => ({ homes: [], loggedOut: true }) });
  assert.equal(app.account.nameFor(0x8001), null);
  assert.equal(app.account.nameFor(0x8005), 'Made-up pill');
  assert.deepEqual(app.account.devices().map((device) => [device.meshId, device.certain]), [[0x8001, false], [0x8001, false], [0x8005, true]]);
  assert.deepEqual(kept.homes[0].devices.map((device) => device.certain), [undefined, undefined], 'what was kept is not changed by reading it');
});

test('pairing: an uncertain device gives no name and is not listed as not answering; a certain one is', async () => {
  const app = certainApp({ heard: [] });
  await loggedIn(app, [home([
    { meshId: 0x8001, type: FIRST_GENERATION_TYPE, name: 'Made-up dimmer', certain: false },
    { meshId: 0x8001, type: FIRST_GENERATION_TYPE, name: 'Made-up lamp', certain: false },
    { meshId: 0x1a2b, type: FIRST_GENERATION_TYPE, name: 'Made-up hall', certain: true },
  ])]);
  const driver = driverOf(app);
  const device = { name: 'SG Dimmer 8001', data: { id: 'made-up' } };
  assert.equal(named(driver, device, 0x8001), device, 'the default name');
  assert.equal(named(driver, { ...device }, 0x1a2b).name, 'Made-up hall');
  assert.deepEqual(quietInAccount(driver, 'sg_mesh', []), ['pair.account.device {"product":"LEDDim Smart","address":"1A2B"}']);
  assert.deepEqual(quietInAccount(driver, 'sg_mesh', [0x1a2b]), []);
});

test('the settings page leaves "X of Y respond" out when a home has no certain device to count', () => {
  const page = read('settings/index.html');
  assert.ok(page.includes('const answering = home.checked && home.total > 0;'));
  assert.ok(page.includes("Homey.__(answering ? 'settings.account.csrAnswering' : 'settings.account.csr', { devices: countText(csr), answering: home.answering, total: home.total })"));
});

// A first generation dimmer added here, with its id and settings; it records
// any change to its settings.
function gen1Added(meshId, settings, app) {
  const device = Object.create(SGMeshDevice.prototype);
  device.homey = { app };
  device.settings = { ...settings };
  device.changed = [];
  device.getData = () => ({ id: `made-up-${meshId.toString(16)}` });
  device.getName = () => 'Made-up dimmer';
  device.getMeshId = () => meshId;
  device.getSettings = function getSettings() { return this.settings; };
  device.setSettings = async function setSettings(values) { this.changed.push(values); Object.assign(this.settings, values); };
  return device;
}

test('a first generation dimmer already added keeps its own key: the account\'s passphrase only where it has none (1234)', async () => {
  const RAW = 'ab'.repeat(16);
  // The app's own accountPassphrase, on an app with only what it needs.
  const app = certainApp();
  app.accountPassphrase = SGSmartApp.prototype.accountPassphrase;
  const own = gen1Added(0x1a2b, { passphrase: 'own-pass-1' }, app);
  const raw = gen1Added(0x3c4d, { passphrase: '1234', netkey_hex: RAW }, app);
  const plain = gen1Added(0x5e6f, { passphrase: '1234' }, app);
  const empty = gen1Added(0x6a7b, { passphrase: '' }, app);
  const elsewhere = gen1Added(0x0abc, { passphrase: '1234' }, app);
  const devices = [own, raw, plain, empty, elsewhere];
  const before = devices.map((device) => JSON.stringify(device.settings));
  const keys = () => devices.map((device) => device.getNetworkKey().toString('hex'));
  const expected = (fetched) => [deriveNetworkKey('own-pass-1'), Buffer.from(RAW, 'hex'), deriveNetworkKey(fetched),
    deriveNetworkKey(fetched), deriveNetworkKey('1234')].map((key) => key.toString('hex'));

  assert.deepEqual(keys(), expected('1234'), 'before a fetch');
  await loggedIn(app, [home(['own', 'raw', 'plain', 'empty'].map((name, i) => (
    { meshId: [0x1a2b, 0x3c4d, 0x5e6f, 0x6a7b][i], type: FIRST_GENERATION_TYPE, name: `Made-up ${name}`, certain: true })),
  { passphrase: ISOLATED })]);
  assert.equal(app.account.passphraseFor(0x1a2b), ISOLATED, 'the account has a passphrase for each of them');
  assert.deepEqual(keys(), expected(ISOLATED), 'after a fetch: only the ones at 1234 or empty take it');
  app.account.forget();
  assert.deepEqual(keys(), expected('1234'), 'after "Forget SG account"');
  assert.deepEqual(devices.map((device) => JSON.stringify(device.settings)), before, 'settings unchanged');
  assert.deepEqual(devices.flatMap((device) => device.changed), [], 'the account never writes a device\'s settings');
});

test('a first generation dimmer whose id is uncertain in the account takes no passphrase from it', async () => {
  const app = certainApp();
  app.accountPassphrase = SGSmartApp.prototype.accountPassphrase;
  const dimmer = gen1Added(0x8001, { passphrase: '1234' }, app);
  await loggedIn(app, [home([
    { meshId: 0x8001, type: FIRST_GENERATION_TYPE, name: 'Made-up dimmer' },
    { meshId: 0x8001, type: FIRST_GENERATION_TYPE, name: 'Made-up lamp' },
  ], { passphrase: ISOLATED })]);
  assert.deepEqual(dimmer.getNetworkKey(), deriveNetworkKey('1234'));
});
