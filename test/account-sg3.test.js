'use strict';

// The SG Smart 3.0 network from the SG account (2.8.0, lib/account.js,
// sg3Network): the first home with its key (interface 4), both 3.0 keys and
// a certain device of a type this build adds (3080 or 3081) with an id in
// the node range. Made-up keys, ids and names.

const test = require('node:test');
const assert = require('node:assert/strict');

const fake = require('./helpers/fake-homey');

fake.install();

const { SETTING, SgAccount } = require('../lib/account');
const { SG3_PRODUCTS } = require('../lib/sgProducts');

const EMAIL = 'tester@example.invalid';
const PASSWORD = 'made-up pass 7';
const NET_KEY = '0F1E2D3C4B5A69788796A5B4C3D2E1F0';
const APP_KEY = 'f0e1d2c3b4a5968778695a4b3c2d1e0f';
const HOME_KEY = '0a1b2c3d4e5f';
const OTHER_HOME_KEY = 'ffeeddccbbaa';

function sg3App({ kept } = {}) {
  const app = {
    logs: [],
    errors: [],
    log(...args) { app.logs.push(args.join(' ')); },
    error(...args) { app.errors.push(args.join(' ')); },
    _devices: () => [],
    recentlyHeard: () => false,
    knownLocations: () => [],
  };
  app.csr = { nodes: new Map(), requestStatus: async () => true };
  const values = new Map(kept ? [[SETTING, kept]] : []);
  const settings = { values, get: (k) => (values.has(k) ? values.get(k) : null), set: (k, v) => values.set(k, v), unset: (k) => values.delete(k) };
  app.homey = fake.fakeHomey(app, { settings, __: (key) => key });
  return app;
}

const home = (extra = {}) => ({
  homeKey: HOME_KEY,
  passphrase: null,
  netKey: NET_KEY,
  appKey: APP_KEY,
  locationId: null,
  devices: [
    { meshId: 0x0003, type: 3080, name: 'Made-up stue', certain: true },
    { meshId: 0x0004, type: 3081, name: null, certain: true },
    { meshId: 0x0005, type: 3026, name: 'Made-up pill', certain: true },     // a 3.0 Pill: later
    { meshId: 0x8001, type: 3080, name: null, certain: false },              // no id of its own
    { meshId: 0x8006, type: 3080, name: null, certain: true },               // outside the node range
    { meshId: 0x0007, type: 3080, name: null, certain: true },
    { meshId: 0x0007, type: 3081, name: null, certain: true },               // the same id twice
    { meshId: 0x8010, type: 101, name: null, certain: true },
  ],
  ...extra,
});

async function fetchedApp(homes) {
  const app = sg3App();
  app.account = new SgAccount(app, { fetch: async () => ({ homes, loggedOut: true }) });
  await app.account.login(EMAIL, PASSWORD);
  return app;
}

test('the 3.0 types this build adds: the two dimmers, in sg_mesh', () => {
  assert.deepEqual(Object.keys(SG3_PRODUCTS), ['3080', '3081']);
  assert.deepEqual(Object.values(SG3_PRODUCTS).map((product) => product.driver), ['sg_mesh', 'sg_mesh']);
});

test('the network: the home\'s key, both keys in small letters, and only its certain dimmers with an id from 0x0001 to 0x7F7F', async () => {
  const app = await fetchedApp([home()]);
  assert.deepEqual(app.account.sg3Network(), {
    homeKey: HOME_KEY,
    netKey: NET_KEY.toLowerCase(),
    appKey: APP_KEY,
    devices: [{ meshId: 0x0003, type: 3080, name: 'Made-up stue' }, { meshId: 0x0004, type: 3081, name: null }],
    addresses: [0x0003, 0x0004, 0x0005, 0x0007, 0x8001, 0x8006],
    // The dimmers may carry the link; the Pill (3026) is not a type this
    // build knows, and the uncertain ones say nothing.
    bridges: [0x0003, 0x0004],
  });
  assert.ok(app.logs.includes('[SG account] SG Smart 3.0: 7 device(s), 3 certain with an id from 0x0001 to 0x7f7f, '
    + '2 of a type this build adds; 1 home(s) with a 3.0 network, 1 home key(s)'), app.logs.join('\n'));
  // The certain dimmer outside the node range is left out, and the log says
  // so; the uncertain ones, the 3.0 Pill and the type 101 device are not
  // named.
  assert.deepEqual(app.logs.filter((line) => line.includes('left out')),
    ['[SG account] SG Smart 3.0: type 3080 with 0x8006 left out: not from 0x0001 to 0x7f7f']);
});

test('at most five lines for 3.0 dimmers left out for their id, then one with how many more', async () => {
  const outside = Array.from({ length: 7 }, (_, i) => ({ meshId: 0x8100 + i, type: 3080, name: null, certain: true }));
  const app = await fetchedApp([home({ devices: [...home().devices, ...outside] })]);
  const lines = app.logs.filter((line) => line.includes('left out'));
  assert.equal(lines.length, 6);
  assert.equal(lines[5], '[SG account] SG Smart 3.0: and 3 more left out for the id');
});

test('no network without the home\'s key (interface 3), a key that is not 32 hex digits, or a dimmer that would do', async () => {
  for (const extra of [
    { homeKey: undefined },
    { homeKey: 'not-a-key' },
    { homeKey: HOME_KEY.toUpperCase() },
    { netKey: null },
    { appKey: '' },
    { netKey: NET_KEY.slice(2) },
    { appKey: `${APP_KEY.slice(2)}zz` },
    { devices: home().devices.filter((device) => ![0x0003, 0x0004].includes(device.meshId)) },
  ]) {
    const app = await fetchedApp([home(extra)]);
    assert.equal(app.account.sg3Network(), null, JSON.stringify(Object.keys(extra)));
  }
});

test('two homes with a network: the first is used, and the log says so', async () => {
  const app = await fetchedApp([home({ devices: [{ meshId: 0x8010, type: 101, name: null, certain: true }] }),
    home({ homeKey: OTHER_HOME_KEY }), home()]);
  assert.equal(app.account.sg3Network().homeKey, OTHER_HOME_KEY);
  assert.ok(app.logs.some((line) => line.endsWith('2 home(s) with a 3.0 network, only the first is used, 3 home key(s)')), app.logs.join('\n'));
});

test('kept before the home\'s key: no network, and the log says to fetch again; "Forget SG account" leaves none', async () => {
  const { homeKey, ...old } = home();
  const app = sg3App({ kept: { fetchedAt: '2026-11-04T05:40:00.000Z', homes: [old], check: null } });
  app.account = new SgAccount(app, { fetch: async () => ({ homes: [home()], loggedOut: true }) });
  assert.equal(app.account.sg3Network(), null);
  assert.ok(app.logs.includes('[SG account] kept without the home\'s key: fetch again to use SG Smart 3.0'));
  await app.account.login(EMAIL, PASSWORD);
  assert.equal(app.account.sg3Network().homeKey, HOME_KEY);
  app.account.forget();
  assert.equal(app.account.sg3Network(), null);
});

test('no key, home key or name is in the log', async () => {
  const app = await fetchedApp([home(), home({ homeKey: OTHER_HOME_KEY })]);
  app.account.sg3Network();
  const logged = [...app.logs, ...app.errors].join('\n').toLowerCase();
  for (const word of [NET_KEY, APP_KEY, HOME_KEY, OTHER_HOME_KEY, 'made-up stue', 'made-up pill']) {
    assert.ok(!logged.includes(word.toLowerCase()), word);
  }
});
