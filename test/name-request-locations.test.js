'use strict';

// FF10, the name request, in a home without a first generation dimmer and
// without a device in Homey (lib/CsrNetwork.js, requestNames): after 00 00
// it goes to everyone with the home's location id, from the later products'
// statuses (FF05, FF50, a thermostat's FF3D and FF5C) or from the SG account,
// and a search then sends it to each device known by its mesh id, with that
// device's location id. The statuses are enough without an account. That
// generation 3 and 4 devices answer it is assumed. The app's own location ids
// (knownLocations, sharedLocation, locationFor) stay as they were, and the
// four drivers that search send the same. Made-up location ids, mesh ids and
// passphrase; the account is kept as lib/account.js keeps one, made up too.

const test = require('node:test');
const assert = require('node:assert/strict');

const fake = require('./helpers/fake-homey');

fake.install();

const { decryptPayload, deriveNetworkKey } = require('../lib/csrmesh');
const {
  CsrNetwork, DIRECT_MAX, NAME_ANSWER_WAIT_MS, NAME_DIRECT_GAP_MS, NAME_LISTEN_MS, NAME_REQUEST_MIN_MS, NAME_VARIANT_GAP_MS,
} = require('../lib/CsrNetwork');
const { SgAccount } = require('../lib/account');
const { FIRST_GENERATION_TYPE } = require('../lib/sgProducts');
const SGSmartApp = require('../app');
const SGMeshDriver = require('../drivers/sg_mesh/driver');
const SGPillDriver = require('../drivers/sg_pill/driver');
const SGPlugDriver = require('../drivers/sg_plug/driver');
const SGThermostatDriver = require('../drivers/sg_thermostat/driver');
const SGDinDriver = require('../drivers/sg_din/driver');

const KEY = deriveNetworkKey('test-only-pass');
const LOC = 0x5a3c;
const OTHER = 0x2b1d;
// Types in the SG account (lib/sgProducts.js): @GD, @ST and SG Smart 3.0.
const GD = 2080;
const MC = 4;
const ST = 1021;
const SG3 = 3080;

const tick = () => new Promise((resolve) => setImmediate(resolve));
const plainOf = (packet) => decryptPayload(KEY, packet.subarray(0, 3), packet.subarray(3, 5), packet.subarray(5, packet.length - 9));
const ext = (dst, opcode, bytes) => Buffer.from([dst & 0xff, dst >> 8, opcode >> 8, opcode & 0xff, ...bytes]);
const loc = (location) => [location >> 8, location & 0xff];
const nameBytes = (location, name) => [...loc(location), ...Buffer.from(name.slice(1), 'latin1'), 0];

// What the later products send, from mesh id src with this location id.
const status = (src, location) => ({ src, plain: ext(0x8000, 0xff05, [...loc(location), 1, 40, 7]) });
const fastStatus = (src, location) => ({ src, plain: ext(0x8000, 0xff50, [...loc(location), 1, 55, 7, 0]) });
const temperatures = (src, location) => ({ src, plain: ext(0x8000, 0xff3d, [...loc(location), 0, 215, 0, 230, 0, 0]) });
const settings = (src, location) => ({ src, plain: ext(0x8000, 0xff5c, [...loc(location), 0, 0, 0, 0, 0, 0, 0]) });

function fakeSettings(values = {}) {
  const kept = new Map(Object.entries(values));
  return {
    get: (key) => (kept.has(key) ? kept.get(key) : null),
    set: (key, value) => kept.set(key, value),
    unset: (key) => kept.delete(key),
  };
}

// An SG account as lib/account.js keeps it: one home with this location id
// and these devices ({ meshId, type }), all certain.
const keptAccount = (location, devices) => ({
  fetchedAt: '2026-11-08T12:00:00.000Z',
  check: null,
  homes: [{
    homeKey: null, passphrase: null, netKey: null, appKey: null, locationId: location,
    devices: devices.map((device) => ({ name: null, certain: true, ...device })),
  }],
});

// The app with these devices in Homey (none by default), its CsrNetwork,
// and the SG account when one is kept; every packet sent is recorded as its
// plain data, and every gap between them.
function home({ account = null, devices = [] } = {}) {
  const app = new SGSmartApp();
  app.homey = fake.fakeHomey(app, {
    settings: fakeSettings(account ? { sgAccount: account } : {}),
    drivers: { getDrivers: () => ({ sg_pill: { getDevices: () => devices } }) },
  });
  app.logs = [];
  app.sent = [];
  app.gaps = [];
  app.log = (...args) => app.logs.push(args.join(' '));
  app.error = (...args) => app.logs.push(args.join(' '));
  app.getNetworkKey = () => KEY;
  let seq = 0x800000;
  app.nextSeq = () => { seq += 1; return seq; };
  app.bridge = {
    send: async (packet, meta) => {
      app.sent.push({ data: plainOf(packet).toString('hex'), meta });
      return { ok: true };
    },
  };
  const wait = app.homey.setTimeout;
  app.homey.setTimeout = (fn, ms) => { app.gaps.push(ms); return wait(fn, ms); };
  app.account = new SgAccount(app, { fetch: async () => { throw new Error('made-up: no fetch here'); } });
  app.csr = new CsrNetwork(app);
  return app;
}

// Runs until done, with the gaps between the FF10s run as they come.
async function run(app, promise) {
  let done = false;
  const result = promise.then((value) => { done = true; return value; });
  while (!done) {
    await tick();
    if (done) break;
    app.homey.runAll();
  }
  return result;
}

const names = (app) => run(app, app.csr.requestNames({ asked: true, listenMs: NAME_LISTEN_MS }));
const search = (app) => run(app, app.csr.requestNames({ asked: true, listenMs: NAME_LISTEN_MS, direct: true }));
const ff10 = (app) => app.sent.map((s) => s.data).filter((data) => data.slice(4, 8) === 'ff10');

test('without an account, a later product\'s status is enough: FF10 to everyone with its location id after 00 00', async () => {
  const app = home();
  app.csr.handleFrame(status(0x9a01, LOC));
  assert.equal(await names(app), true);
  assert.deepEqual(ff10(app), ['0000ff100000', '0000ff105a3c']);
  assert.deepEqual(app.logs.filter((line) => line.startsWith('[CSR] FF10')), [
    '[CSR] FF10 name request to everyone, loc=0x0000',
    '[CSR] FF10 name request to everyone, loc=0x5a3c',
  ]);
});

test('an FF50 and a thermostat\'s FF3D and FF5C count too; location id 0 counts not, and each one goes once', async () => {
  const app = home();
  app.csr.handleFrame(fastStatus(0x9a01, LOC));
  app.csr.handleFrame(temperatures(0x9a02, OTHER));
  app.csr.handleFrame(settings(0x9a03, OTHER));
  app.csr.handleFrame(status(0x9a04, 0));
  await names(app);
  assert.deepEqual(ff10(app), ['0000ff100000', '0000ff102b1d', '0000ff105a3c']);
});

test('with an SG account and nothing heard: FF10 to everyone with the home\'s location id', async () => {
  const app = home({ account: keptAccount(LOC, [{ meshId: 0x9b01, type: GD }]) });
  await names(app);
  assert.deepEqual(ff10(app), ['0000ff100000', '0000ff105a3c']);
});

test('a home in the SG account with SG Smart 3.0 devices only gives no FF10 of its own', async () => {
  const account = keptAccount(LOC, [{ meshId: 0x9b01, type: GD }]);
  account.homes.push({ ...keptAccount(OTHER, [{ meshId: 0x0005, type: SG3 }]).homes[0] });
  const app = home({ account });
  await names(app);
  assert.deepEqual(ff10(app), ['0000ff100000', '0000ff105a3c']);
});

test('with nothing known, 00 00 alone, as before', async () => {
  const app = home();
  await names(app);
  assert.deepEqual(ff10(app), ['0000ff100000']);
});

test('a search then asks each device heard by its mesh id, with its location id, also without an account', async () => {
  const app = home();
  app.csr.handleFrame(status(0x9a01, LOC));
  app.csr.handleFrame(temperatures(0x9a02, LOC));
  await search(app);
  assert.deepEqual(ff10(app), ['0000ff100000', '0000ff105a3c', '019aff105a3c', '029aff105a3c']);
  assert.deepEqual(app.sent.slice(2).map((s) => s.meta), [
    { key: `csr:names:${LOC}:${0x9a01}`, listenMs: NAME_LISTEN_MS },
    { key: `csr:names:${LOC}:${0x9a02}`, listenMs: NAME_LISTEN_MS },
  ], 'each on a link that listens');
  assert.deepEqual(app.gaps, [NAME_VARIANT_GAP_MS, NAME_ANSWER_WAIT_MS, NAME_DIRECT_GAP_MS, NAME_DIRECT_GAP_MS]);
  assert.deepEqual(app.logs.filter((line) => line.startsWith('[CSR] FF10 name request to 0x')), [
    '[CSR] FF10 name request to 0x9a01, loc=0x5a3c',
    '[CSR] FF10 name request to 0x9a02, loc=0x5a3c',
  ]);
  // The FF10 at start and every 10 min goes to everyone only.
  const quiet = home();
  quiet.csr.handleFrame(status(0x9a01, LOC));
  await run(quiet, quiet.csr.requestNames({ listenMs: NAME_LISTEN_MS }));
  assert.deepEqual(ff10(quiet), ['0000ff100000', '0000ff105a3c']);
});

test('with an SG account, its later devices are asked too, with their home\'s location id; one heard wins; '
  + 'not the first generation, 3.0, one that answered FF11 or one added', async () => {
  const added = { getCsrMeshId: () => 0x9b05, getCsrLocationId: () => null, applyCsrStatus() {} };
  const app = home({
    account: keptAccount(LOC, [
      { meshId: 0x9b01, type: GD },
      { meshId: 0x9b02, type: ST },
      { meshId: 0x9b03, type: GD },
      { meshId: 0x8001, type: FIRST_GENERATION_TYPE },
      { meshId: 0x0005, type: SG3 },
      { meshId: 0x9b05, type: GD },
    ]),
    devices: [added],
  });
  app.csr.handleFrame(status(0x9b02, OTHER));
  app.csr.handleFrame({ src: 0x9b03, plain: ext(0x8000, 0xff11, nameBytes(LOC, '@GD3C4D')) });
  await search(app);
  assert.deepEqual(ff10(app), ['0000ff100000', '0000ff102b1d', '0000ff105a3c', '019bff105a3c', '029bff102b1d']);
});

// The mesh ids a search sent FF10 to one by one, in the order sent.
const directTo = (app) => app.sent.map((s) => s.meta.key).filter((key) => /^csr:names:\d+:\d+$/.test(key))
  .map((key) => Number(key.split(':')[3]));
const pillSearch = (app) => run(app, app.csr.requestNames({
  asked: true, listenMs: NAME_LISTEN_MS, direct: true, forDriver: 'sg_pill',
}));

test('a search for a driver sends FF10 directly to at most DIRECT_MAX of its devices in the SG account and the '
  + 'devices heard, those asked longest ago first, with NAME_DIRECT_GAP_MS between them', async () => {
  const pills = Array.from({ length: 12 }, (_, i) => ({ meshId: 0x9c01 + i, type: MC }));
  const app = home({ account: keptAccount(LOC, [...pills, { meshId: 0x9d01, type: ST }, { meshId: 0x9d02, type: ST }]) });
  let now = 1000000;
  app.csr = new CsrNetwork(app, { now: () => now });
  app.csr.handleFrame(status(0x9e01, LOC)); // heard, not in the account
  await pillSearch(app);
  assert.equal(DIRECT_MAX, 10);
  assert.deepEqual(directTo(app), pills.slice(0, 10).map((p) => p.meshId), 'not the thermostats: another driver adds them');
  assert.equal(app.gaps.filter((ms) => ms === NAME_DIRECT_GAP_MS).length, 10);
  assert.ok(app.logs.includes('[CSR] FF10 direct to 10 of 13 device(s) that have not answered (at most 10, those asked longest ago first)'));
  // The next search: the three not asked yet, then the seven asked longest ago.
  app.sent = [];
  now += NAME_REQUEST_MIN_MS + 1000;
  await pillSearch(app);
  assert.deepEqual(directTo(app), [...pills.slice(0, 7).map((p) => p.meshId), 0x9c0b, 0x9c0c, 0x9e01]);
});

test('without an SG account, the devices heard get FF10 directly, at most DIRECT_MAX, the rest at the next search', async () => {
  const app = home();
  let now = 1000000;
  app.csr = new CsrNetwork(app, { now: () => now });
  const heard = Array.from({ length: 12 }, (_, i) => 0x9a01 + i);
  for (const meshId of heard) app.csr.handleFrame(status(meshId, LOC));
  await pillSearch(app);
  assert.deepEqual(directTo(app), heard.slice(0, 10));
  app.sent = [];
  now += NAME_REQUEST_MIN_MS + 1000;
  await pillSearch(app);
  assert.deepEqual(directTo(app), [...heard.slice(0, 8), ...heard.slice(10)]);
});

test('a device that answers the FF10 to everyone within NAME_ANSWER_WAIT_MS gets no FF10 of its own: the targets are '
  + 'chosen after that wait, so the places go to the devices that have not answered', async () => {
  const pills = Array.from({ length: 12 }, (_, i) => ({ meshId: 0x9c01 + i, type: MC }));
  const app = home({ account: keptAccount(LOC, pills) });
  // The three lowest mesh ids answer the FF10 to everyone with the home's
  // location id, as the wait runs.
  const wait = app.homey.setTimeout;
  app.homey.setTimeout = (fn, ms) => {
    if (ms === NAME_ANSWER_WAIT_MS) {
      for (const meshId of [0x9c01, 0x9c02, 0x9c03]) {
        app.csr.handleFrame({ src: meshId, plain: ext(0x8000, 0xff11, nameBytes(LOC, `@MC${meshId.toString(16).toUpperCase()}`)) });
      }
    }
    return wait(fn, ms);
  };
  await pillSearch(app);
  assert.deepEqual(directTo(app), pills.slice(3).map((p) => p.meshId).slice(0, 9), 'the nine that did not answer, none of the three');
  assert.ok(app.logs.includes('[CSR] FF10 direct to 9 of 9 device(s) that have not answered (at most 10, those asked longest ago first)'));
  assert.equal(app.gaps.filter((ms) => ms === NAME_ANSWER_WAIT_MS).length, 1, 'one wait, after the last FF10 to everyone');
  // Without anything out, there is no wait: nothing is coming.
  const down = home({ account: keptAccount(LOC, pills) });
  down.bridge.send = async () => ({ ok: false });
  await pillSearch(down);
  assert.equal(down.gaps.filter((ms) => ms === NAME_ANSWER_WAIT_MS).length, 0);
});

test('the pairing in sg_pill tells the list how many of its devices in the SG account that did not answer are heard in the mesh', async () => {
  const app = home({ account: keptAccount(LOC, [{ meshId: 0x9c01, type: MC }, { meshId: 0x9c02, type: MC }, { meshId: 0x9c03, type: ST }]) });
  app._csrHeardAt = new Map();
  app._csrHeardAt.set(0x9c02, Date.now()); // a frame heard from one of the Pills
  const homey = fake.listenAtOnce(fake.fakeHomey(app, { ble: { discover: async () => [] } }));
  const driver = new SGPillDriver({ homey });
  driver.getDevices = () => [];
  const result = await run(app, driver._search());
  assert.equal(result.quiet.length, 2, 'the two Pills, not the thermostat');
  assert.equal(result.quietHeard, 1);
});

test('an FF11 after an FF10 to the device itself says so in the log', async () => {
  const app = home();
  app.csr.handleFrame(status(0x9a01, LOC));
  await search(app);
  app.csr.handleFrame({ src: 0x9a01, plain: ext(0x8000, 0xff11, nameBytes(LOC, '@GD3C4D')) });
  const line = app.logs.find((l) => l.includes('op=FF11'));
  assert.match(line, / after FF10 loc=0x5a3c to this device \(\+\d+\.\d s\)$/);
});

test('the app\'s own location ids are as before: knownLocations, sharedLocation and locationFor take neither the '
  + 'statuses nor the account', async () => {
  const app = home({ account: keptAccount(LOC, [{ meshId: 0x9b01, type: GD }]) });
  app.csr.handleFrame(status(0x9a01, OTHER));
  app.csr.handleFrame(temperatures(0x9a02, OTHER));
  assert.deepEqual(app.knownLocations(), []);
  assert.equal(app.sharedLocation(null), null);
  assert.equal(app.locationFor(0x9a01), null);
  assert.deepEqual(app.account.locations(), [LOC]);
});

// A pair session as far as onPair uses it.
const pairSession = () => {
  const session = { handlers: {}, views: [] };
  session.setHandler = (name, handler) => { session.handlers[name] = handler; };
  session.showView = async (view) => { session.views.push(view); };
  session.show = (view) => session.handlers.showView(view);
  return session;
};

// sg_mesh searches only when the scan saw a later product's name (a home
// with first generation dimmers only gets nothing new on the radio); the
// other three always do.
const LATER_NAME = [{ localName: '@GD1A2B', rssi: -60, uuid: 'made-up-uuid' }];
for (const [Driver, driverId, advertisements] of [
  [SGMeshDriver, 'sg_mesh', LATER_NAME], [SGPillDriver, 'sg_pill', []], [SGPlugDriver, 'sg_plug', []],
  [SGThermostatDriver, 'sg_thermostat', []], [SGDinDriver, 'sg_din', []],
]) {
  test(`the pairing in ${driverId} sends FF10 with the home's location id to everyone and to each device heard, `
    + 'without an account', async () => {
    const app = home();
    app.csr.handleFrame(status(0x9a01, LOC));
    app.csr.handleFrame(temperatures(0x9a02, LOC));
    const homey = fake.listenAtOnce(fake.fakeHomey(app, { ble: { discover: async () => advertisements } }));
    const driver = new Driver({ homey });
    driver.getDevices = () => [];
    const session = pairSession();
    await driver.onPair(session);
    await session.show('guide');
    await run(app, session.show('loading'));
    assert.deepEqual(ff10(app), ['0000ff100000', '0000ff105a3c', '019aff105a3c', '029aff105a3c']);
    assert.deepEqual(session.views, ['list_devices']);
  });

  test(`the pairing in ${driverId} sends FF10 directly only to its own devices in the SG account, and to those heard`, async () => {
    const app = home({
      account: keptAccount(LOC, [{ meshId: 0x9b01, type: GD }, { meshId: 0x9b02, type: MC }, { meshId: 0x9b03, type: ST }]),
    });
    app.csr.handleFrame(status(0x9a01, LOC)); // heard, not in the account
    const homey = fake.listenAtOnce(fake.fakeHomey(app, { ble: { discover: async () => advertisements } }));
    const driver = new Driver({ homey });
    driver.getDevices = () => [];
    const session = pairSession();
    await driver.onPair(session);
    await session.show('guide');
    await run(app, session.show('loading'));
    const own = { sg_mesh: [0x9b01], sg_pill: [0x9b02], sg_thermostat: [0x9b03] }[driverId] || [];
    assert.deepEqual(directTo(app), [0x9a01, ...own].sort((a, b) => a - b));
  });
}
