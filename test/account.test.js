'use strict';

// The SG account in the app's settings (2.7.0, lib/account.js): what is
// kept, the passphrase each device takes, "X of Y answer" with one FF04 per
// later CSRmesh device, "Forget SG account", the type in the account for
// pairing, the settings page and its texts. The cloud itself is in
// test/sky.test.js. Made-up values only. Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const util = require('util');

const fake = require('./helpers/fake-homey');

fake.install();

const { deriveNetworkKey, resolveKey } = require('../lib/csrmesh');
const {
  INTERFACE_VERSIONS, SETTING, SgAccount, loadAccountModule,
} = require('../lib/account');
const {
  CSR_PRODUCTS, FIRST_GENERATION_TYPE, TYPE_PREFIXES, csrProductForType, driverForType, familyForType,
} = require('../lib/sgProducts');
const {
  accountFindings, laterFindings, pairInLoadingView, quietInAccount, typeDisagreements, withStates,
} = require('../lib/csrPairing');
const api = require('../api');
const SGSmartApp = require('../app');
const SGCsrDevice = require('../lib/SGCsrDevice');
const SGMeshDevice = require('../lib/SGDeviceBase');
const SGThermostatDevice = require('../lib/SGThermostatDevice');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const EMAIL = 'tester@example.invalid';
const PASSWORD = 'made-up pass 7';
const ISOLATED = 'c0ffee12';
const NET_KEY = 'a1'.repeat(16);
const APP_KEY = 'b2'.repeat(16);

// Two homes as the account module gives them: home 1 isolated, with its
// location id, two first generation dimmers, a Pill, a plug, a 3.0 device and
// one without a mesh id; home 2 at 1234, without a location id, with the same
// Pill's mesh id and a dimmer of its own.
const HOMES = () => [
  {
    passphrase: ISOLATED, netKey: NET_KEY, appKey: APP_KEY, locationId: 0x4242,
    devices: [
      { meshId: 0x8001, type: FIRST_GENERATION_TYPE }, { meshId: 0x8002, type: FIRST_GENERATION_TYPE },
      { meshId: 0x8003, type: 1004 }, { meshId: 0x8004, type: 2002 }, { meshId: 0x8005, type: 3005 },
      { meshId: null, type: 7 },
    ],
  },
  {
    passphrase: '1234', netKey: NET_KEY, appKey: APP_KEY, locationId: null,
    devices: [{ meshId: 0x8003, type: 1004 }, { meshId: 0x8006, type: 1 }],
  },
];

const tick = () => new Promise((resolve) => setImmediate(resolve));

// An error as the account module gives one: a code, and a message without
// values. Made-up messages.
const accountError = (code, message) => Object.assign(new Error(message), { code });

// Settings as Homey keeps them, with unset.
function fakeSettings() {
  const values = new Map();
  return {
    values,
    get: (key) => (values.has(key) ? values.get(key) : null),
    set: (key, value) => values.set(key, value),
    unset: (key) => values.delete(key),
  };
}

// An app as SgAccount needs it: the devices added, the first generation
// dimmers heard lately, and a CsrNetwork whose FF04s are recorded; a mesh id
// in answering answers its FF04 with a frame.
function accountApp({ devices = [], heard = [], answering = [], nodes = new Map(), known = [] } = {}) {
  const app = {
    logs: [],
    errors: [],
    sent: [],
    log(...args) { app.logs.push(args.join(' ')); },
    error(...args) { app.errors.push(args.join(' ')); },
    _devices: () => devices,
    recentlyHeard: (meshId) => heard.includes(meshId),
    knownLocations: () => known,
  };
  app.csr = {
    nodes,
    requestStatus: async (meshId, location) => {
      app.sent.push([meshId, location]);
      if (answering.includes(meshId)) app.account.heard(meshId);
      return true;
    },
  };
  app.homey = fake.fakeHomey(app, { settings: fakeSettings() });
  return app;
}

// SgAccount on app with a fetch that gives homes (or throws), and records
// what it got.
function withAccount(app, homes = HOMES()) {
  const fetched = [];
  const fetch = async (email, password, { log }) => {
    fetched.push([email, password]);
    if (homes instanceof Error) throw homes;
    log(`SG cloud: ${homes.length} home(s), logged out`);
    return { homes, loggedOut: true };
  };
  app.account = new SgAccount(app, { fetch });
  return fetched;
}

// The check after a login, to its end: FF04s, then the timer for the answers.
async function checked(app) {
  for (let i = 0; i < 20; i += 1) {
    await tick();
    if (app.homey.pending.size) app.homey.runAll();
  }
}

// A device added here: later CSRmesh (getCsrMeshId) or first generation
// (getMeshId), with its name and settings.
function added({ meshId, csr = true, name = 'Made-up device', settings = { passphrase: '1234' }, id = `@SC${meshId}`, location } = {}) {
  return {
    getData: () => ({ id }),
    getName: () => name,
    getSettings: () => settings,
    ...(csr ? { getCsrMeshId: () => meshId, getCsrLocationId: () => location } : { getMeshId: () => meshId }),
  };
}

const allText = (app) => [...app.logs, ...app.errors, JSON.stringify(app.account.summary())].join('\n');

// ---- what is kept

test('a login keeps per home the passphrase when it is not 1234, the 3.0 keys and the devices with a mesh id; never the e-mail or the password', async () => {
  const app = accountApp();
  const fetched = withAccount(app);
  const summary = await app.account.login(EMAIL, PASSWORD);
  await checked(app);
  assert.deepEqual(fetched, [[EMAIL, PASSWORD]]);
  assert.equal(summary.fetched, true);
  assert.deepEqual([...app.homey.settings.values.keys()], [SETTING], 'one setting');
  const kept = app.homey.settings.values.get(SETTING);
  assert.deepEqual(kept.homes, [
    { homeKey: null, passphrase: ISOLATED, netKey: NET_KEY, appKey: APP_KEY, locationId: 0x4242,
      devices: HOMES()[0].devices.slice(0, 5).map((device) => ({ ...device, name: null, certain: true })) },
    { homeKey: null, passphrase: null, netKey: NET_KEY, appKey: APP_KEY, locationId: null,
      devices: HOMES()[1].devices.map((device) => ({ ...device, name: null, certain: true })) },
  ]);
  const stored = JSON.stringify([...app.homey.settings.values]);
  for (const word of [EMAIL, PASSWORD]) assert.ok(!stored.includes(word), word);
  assert.ok(app.logs.some((line) => /kept 2 home\(s\): passphrase other than 1234 for 1, 3\.0 keys for 2, 7 device\(s\), 1 without a mesh id left out, 0 with a name, 0 uncertain$/.test(line)));
});

test('a failed login keeps what was there, never the e-mail or the password, and says what kind of error it was', async () => {
  for (const [err, kind] of [
    [accountError('SG_CLOUD_LOGIN', 'made-up login refused'), 'login'],
    [accountError('SG_CLOUD_TIMEOUT', 'made-up timeout'), 'network'],
    [accountError('SG_CLOUD_NETWORK', 'made-up no connection'), 'network'],
    [accountError('SG_CLOUD_MISSING', 'made-up no e-mail'), 'missing'],
    [new TypeError(`made-up failure with ${EMAIL} and ${PASSWORD}`), 'other'],
  ]) {
    const app = accountApp();
    withAccount(app);
    await app.account.login('first@example.invalid', 'first pass');
    await checked(app);
    const before = JSON.stringify([...app.homey.settings.values]);
    withAccount(app, err);
    app.account._state = app.homey.settings.get(SETTING);
    const summary = await app.account.login(EMAIL, PASSWORD);
    assert.equal(summary.error, kind, err.message);
    assert.equal(summary.fetched, true, 'what was kept stays');
    assert.equal(JSON.stringify([...app.homey.settings.values]), before);
    for (const word of [EMAIL, PASSWORD, 'first@example.invalid', 'first pass']) assert.ok(!allText(app).includes(word), `${kind}: ${word}`);
  }
});

test('no key, passphrase, e-mail or password in the log, the errors or the summary for the page', async () => {
  const app = accountApp({ answering: [0x8003] });
  withAccount(app);
  await app.account.login(EMAIL, PASSWORD);
  await checked(app);
  const text = allText(app);
  for (const word of [EMAIL, PASSWORD, ISOLATED, NET_KEY, APP_KEY]) assert.ok(!text.includes(word), word);
  assert.equal(app.account.summary().homes[0].passphrase, true, 'only that one was fetched');
});

// ---- the passphrase

test('resolveKey: a raw key or an own passphrase other than 1234 wins; the fetched one counts while the own is 1234 or empty', () => {
  const raw = 'ab'.repeat(16);
  assert.deepEqual(resolveKey({ netkey_hex: raw, passphrase: 'own1' }, ISOLATED), Buffer.from(raw, 'hex'));
  assert.deepEqual(resolveKey({ passphrase: 'own1' }, ISOLATED), deriveNetworkKey('own1'));
  assert.deepEqual(resolveKey({ passphrase: ' own1 ' }, ISOLATED), deriveNetworkKey('own1'));
  for (const settings of [{ passphrase: '1234' }, { passphrase: '' }, { passphrase: ' 1234 ' }, {}]) {
    assert.deepEqual(resolveKey(settings, ISOLATED), deriveNetworkKey(ISOLATED), JSON.stringify(settings));
    assert.deepEqual(resolveKey(settings, null), deriveNetworkKey('1234'), JSON.stringify(settings));
    assert.deepEqual(resolveKey(settings), deriveNetworkKey('1234'), 'as before without the account');
  }
});

test('the passphrase for a mesh id: of the one home that has it; none for a mesh id in two homes, at 1234 or not in the account', async () => {
  const app = accountApp();
  withAccount(app);
  await app.account.login(EMAIL, PASSWORD);
  await checked(app);
  assert.equal(app.account.passphraseFor(0x8001), ISOLATED);
  assert.equal(app.account.passphraseFor(0x8003), null, 'in two homes');
  assert.equal(app.account.passphraseFor(0x8006), null, 'its home is at 1234');
  assert.equal(app.account.passphraseFor(0x9999), null);
  assert.equal(app.account.passphraseFor(null), null);
  assert.equal(app.account.onlyPassphrase(), ISOLATED);
  assert.equal(app.account.typeFor(0x8004), 2002);
  assert.equal(app.account.typeFor(0x8003), null, 'in two homes');
});

test('each kind of device takes the account\'s passphrase in getNetworkKey, unless it has its own', () => {
  for (const DeviceClass of [SGCsrDevice, SGMeshDevice, SGThermostatDevice]) {
    const asked = [];
    const device = {
      homey: { app: { accountPassphrase: (d) => { asked.push(d); return ISOLATED; } } },
      settings: { passphrase: '1234' },
      getSettings() { return this.settings; },
    };
    assert.deepEqual(DeviceClass.prototype.getNetworkKey.call(device), deriveNetworkKey(ISOLATED), DeviceClass.name);
    assert.deepEqual(asked, [device], 'asked for itself');
    device.settings = { passphrase: 'own1' };
    assert.deepEqual(DeviceClass.prototype.getNetworkKey.call(device), deriveNetworkKey('own1'), DeviceClass.name);
    const without = { homey: { app: {} }, getSettings: () => ({ passphrase: '1234' }) };
    assert.deepEqual(DeviceClass.prototype.getNetworkKey.call(without), deriveNetworkKey('1234'), `${DeviceClass.name}, no account`);
  }
});

// The app with these devices and an SG account on its settings.
function appWith(devices) {
  const app = new SGSmartApp();
  app.homey = fake.fakeHomey(app, {
    settings: fakeSettings(),
    drivers: { getDrivers: () => ({ one: { getDevices: () => devices } }) },
  });
  withAccount(app);
  return app;
}

test('the app: a device\'s passphrase by its mesh id, none for a fake device; with no device the one fetched passphrase, after "Forget" 1234', async () => {
  const csr = added({ meshId: 0x8004 });
  const gen1 = added({ meshId: 0x8001, csr: false });
  const fakeOne = added({ meshId: 0x8004, id: 'fake:@SC8004' });
  const app = appWith([csr, gen1, fakeOne]);
  app.csr = { nodes: new Map(), requestStatus: async () => true };
  await app.account.login(EMAIL, PASSWORD);
  for (let i = 0; i < 20; i += 1) {
    await tick();
    if (app.homey.pending.size) app.homey.runAll();
  }
  assert.equal(app.accountPassphrase(csr), ISOLATED);
  assert.equal(app.accountPassphrase(gen1), ISOLATED);
  assert.equal(app.accountPassphrase(fakeOne), null);
  const empty = appWith([]);
  await empty.account.login(EMAIL, PASSWORD);
  assert.deepEqual(empty.getNetworkKey(), deriveNetworkKey(ISOLATED));
  empty.account.forget();
  assert.deepEqual(empty.getNetworkKey(), deriveNetworkKey('1234'));
});

// ---- X of Y answer

test('the check: one FF04 to each later CSRmesh device with a location id, none twice and none to a first generation dimmer or 3.0; X of Y, who does not answer, and who is unknown', async () => {
  const devices = [added({ meshId: 0x8002, csr: false, name: 'Made-up hall' }), added({ meshId: 0x8003, location: 0x4343 })];
  const app = accountApp({ devices, heard: [0x8001], answering: [0x8003] });
  withAccount(app);
  const first = await app.account.login(EMAIL, PASSWORD);
  assert.equal(first.checking, true);
  assert.equal((await app.account.login(EMAIL, PASSWORD)).error, 'busy', 'no second fetch while the devices are asked');
  await checked(app);
  assert.deepEqual(app.sent, [[0x8003, 0x4343], [0x8004, 0x4242]],
    'one FF04 each, the Pill once though it is in both homes, with its own location id; the plug with its home\'s; the dimmer of home 2 has none');
  const summary = app.account.summary();
  assert.equal(summary.checking, false);
  assert.deepEqual(summary.homes, [
    {
      number: 1, devices: 5, passphrase: true, sg3: 1, sg3State: 'fetchAgain', checked: true, answering: 2, total: 4,
      quiet: [{ name: 'Made-up hall' }, { product: 'Smart Plug', type: 2002, address: '8004' }], unknown: [],
    },
    {
      number: 2, devices: 2, passphrase: false, sg3: 0, sg3State: 'later', checked: true, answering: 1, total: 1,
      quiet: [], unknown: [{ product: 'LEDDim Smart', type: 1, address: '8006' }],
    },
  ]);
  assert.ok(app.logs.includes('[SG account] check: 3 of 5 answer, 2 FF04 sent, 1 unknown (no location id), 0 uncertain (not counted), 1 SG Smart 3.0 not asked'));
  // The check is kept, and the next login asks again, once each.
  assert.ok(app.homey.settings.get(SETTING).check);
  await app.account.login(EMAIL, PASSWORD);
  await checked(app);
  assert.equal(app.sent.length, 4);
});

test('the FF04\'s location id: the device\'s own, then its FF11\'s, then its home\'s from the account; with none the device is not asked', async () => {
  const nodes = new Map([[0x8004, { meshId: 0x8004, location: 0x5151 }]]);
  for (const [home2, sent, unknown] of [
    [0x7171, [[0x8003, 0x4343], [0x8004, 0x5151], [0x8006, 0x7171]], []],
    [null, [[0x8003, 0x4343], [0x8004, 0x5151]], [0x8006]],
  ]) {
    const app = accountApp({ devices: [added({ meshId: 0x8003, location: 0x4343 })], nodes });
    const homes = HOMES();
    homes[1].locationId = home2;
    withAccount(app, homes);
    await app.account.login(EMAIL, PASSWORD);
    await checked(app);
    assert.deepEqual(app.sent, sent, String(home2));
    assert.deepEqual(app.homey.settings.get(SETTING).check.unknown, unknown);
  }
  // A Pill in two homes with different location ids, and none of its own: unknown.
  const app = accountApp();
  const homes = HOMES();
  homes[1].locationId = 0x7171;
  withAccount(app, homes);
  await app.account.login(EMAIL, PASSWORD);
  await checked(app);
  assert.ok(!app.sent.some(([meshId]) => meshId === 0x8003));
  assert.deepEqual(app.homey.settings.get(SETTING).check.unknown, [0x8003]);
});

// ---- Forget SG account

test('"Forget SG account" removes all that was kept, a check under way keeps nothing, and the devices fall back to their own passphrase or 1234', async () => {
  const app = accountApp();
  withAccount(app);
  await app.account.login(EMAIL, PASSWORD);
  const summary = app.account.forget();
  await checked(app);
  assert.deepEqual(summary, { available: true, fetched: false, checking: false, homes: [] });
  assert.deepEqual([...app.homey.settings.values.keys()], []);
  assert.equal(app.account.passphraseFor(0x8001), null);
  assert.equal(app.account.onlyPassphrase(), null);
  assert.ok(app.logs.includes('[SG account] forgotten: the devices use their own passphrase or 1234'));
  assert.ok(!app.logs.some((line) => line.startsWith('[SG account] check:')), 'the check stopped');
  // Read again after a restart: nothing.
  assert.equal(new SgAccount(app).fetched(), false);
});

// ---- the API and the page

test('api.js hands the e-mail and password on, gives the summary, and an error only by its kind', async () => {
  const got = [];
  const account = {
    login: async (email, password) => { got.push([email, password]); return { fetched: true }; },
    summary: () => ({ fetched: true }),
    forget: () => ({ fetched: false }),
  };
  const homey = { app: { account } };
  assert.deepEqual(await api.loginAccount({ homey, body: { email: EMAIL, password: PASSWORD } }), { fetched: true });
  assert.deepEqual(got, [[EMAIL, PASSWORD]]);
  assert.deepEqual(await api.getAccount({ homey }), { fetched: true });
  assert.deepEqual(await api.forgetAccount({ homey }), { fetched: false });
  const broken = { app: { account: { login: async () => { throw new Error(`failed for ${EMAIL}`); } } } };
  assert.deepEqual(await api.loginAccount({ homey: broken, body: {} }), { error: 'other' });
  const manifest = JSON.parse(read('app.json'));
  assert.deepEqual(manifest.api, {
    getLogView: { method: 'GET', path: '/log-view' },
    getAccount: { method: 'GET', path: '/account' },
    loginAccount: { method: 'POST', path: '/account/login' },
    forgetAccount: { method: 'POST', path: '/account/forget' },
  });
  // The account's API came with 2.7.0.
  const [major, minor] = manifest.version.split('.').map(Number);
  assert.ok(major > 2 || (major === 2 && minor >= 7), manifest.version);
});

test('the settings page sends the e-mail and password with Homey.api, never Homey.set, empties both fields, and uses every account text', () => {
  const page = read('settings/index.html');
  assert.ok(page.includes("api('POST', '/account/login', body)"));
  assert.ok(page.includes("api('POST', '/account/forget', null)"));
  assert.ok(page.includes("api('GET', '/account', null)"));
  assert.doesNotMatch(page, /set\(\s*['"]account|Homey\.set\(\s*['"]account|Homey\.get\(\s*['"]sgAccount/);
  assert.ok(page.includes("accountEmail.value = '';") && page.includes("accountPassword.value = '';"));
  assert.match(page, /<input class="homey-form-input" id="account-password" type="password"/);
  const en = JSON.parse(read('locales/en.json'));
  const keys = Object.keys(en.settings.account).filter((key) => key !== 'error');
  for (const key of keys) assert.ok(page.includes(`settings.account.${key}`), `settings.account.${key} is not used`);
  assert.ok(page.includes('settings.account.error.${summary.error}'));
  assert.ok(page.includes("'settings.account.error.other'"));
  const kinds = ['login', 'missing', 'network', 'busy', 'noHomes', 'other'];
  assert.deepEqual(Object.keys(en.settings.account.error).sort(), [...kinds].sort());
});

// The account summary on the settings page, as Trond set it out (2026-11-06):
// "Home N", then a point per type, the devices that do not respond and those
// not checked under SG Smart. The page's own functions, run with its texts.
function summaryLines(language) {
  const page = read('settings/index.html');
  const start = page.indexOf('      const shownDevice = ');
  const end = page.indexOf('      const showAccount = ');
  assert.ok(start > 0 && end > start, 'shownDevice to showAccount');
  const texts = JSON.parse(read(`locales/${language}.json`));
  const Homey = {
    __: (key, tokens = {}) => {
      const text = key.split('.').reduce((at, part) => (at ? at[part] : undefined), texts);
      assert.equal(typeof text, 'string', key);
      return text.replace(/__([a-zA-Z]+)__/g, (whole, name) => (name in tokens ? String(tokens[name]) : whole));
    },
  };
  // eslint-disable-next-line no-new-func
  const homeLines = new Function('Homey', `${page.slice(start, end)}\nreturn homeLines;`)(Homey);
  return (home) => {
    const { title, items } = homeLines({ quiet: [], unknown: [], sg3: 0, checked: false, total: 0, answering: 0, ...home });
    return [title, ...items.map((lines) => lines.map((line, i) => (i === 0 ? `• ${line}` : `  ${line}`)).join('\n'))].join('\n');
  };
}

test('the account summary: a line per type under each home, "enhet" or "enheter" after the number, "No response" and "Not checked" under SG Smart', () => {
  const home = { number: 1, devices: 3, sg3: 1, sg3State: 'ready', passphrase: false, checked: true, answering: 2, total: 2 };
  assert.equal(summaryLines('no')(home), [
    'Hjem 1',
    '• SG Smart: 2 enheter, 2 av 2 svarer. Nettverkspassord: 1234.',
    '• SG Smart 3.0: 1 enhet. Legges til under LEDDim Smart 3.0.',
  ].join('\n'));
  assert.equal(summaryLines('en')(home), [
    'Home 1',
    '• SG Smart: 2 devices, 2 of 2 respond. Network password: 1234.',
    '• SG Smart 3.0: 1 device. Added under LEDDim Smart 3.0.',
  ].join('\n'));
  const quiet = {
    number: 2, devices: 4, passphrase: true, checked: true, answering: 1, total: 3,
    quiet: [{ name: 'Made-up hall' }], unknown: [{ name: null, product: 'LEDDim Smart', address: '1A2B' }],
  };
  assert.equal(summaryLines('no')(quiet), [
    'Hjem 2',
    '• SG Smart: 4 enheter, 1 av 3 svarer. Nettverkspassord: hentet.',
    '  Svarer ikke: Made-up hall.',
    '  Ikke sjekket: LEDDim Smart 1A2B.',
  ].join('\n'));
  assert.equal(summaryLines('en')(quiet), [
    'Home 2',
    '• SG Smart: 4 devices, 1 of 3 respond. Network password: fetched.',
    '  No response: Made-up hall.',
    '  Not checked: LEDDim Smart 1A2B.',
  ].join('\n'));
  // One device; not checked yet, or nothing certain to count: no "X of Y".
  assert.equal(summaryLines('no')({ number: 1, devices: 1, passphrase: false }), 'Hjem 1\n• SG Smart: 1 enhet. Nettverkspassord: 1234.');
  assert.equal(summaryLines('en')({ number: 1, devices: 1, passphrase: false, checked: true, total: 0 }), 'Home 1\n• SG Smart: 1 device. Network password: 1234.');
  // Only 3.0 devices: no SG Smart line; the 3.0 line says what to do.
  assert.equal(summaryLines('no')({ number: 1, devices: 2, sg3: 2, sg3State: 'fetchAgain' }), 'Hjem 1\n• SG Smart 3.0: 2 enheter. Trykk "Hent på nytt".');
  // "Tap", as in the LEDDim Smart 3.0 guide.
  assert.equal(summaryLines('en')({ number: 1, devices: 2, sg3: 2, sg3State: 'fetchAgain' }), 'Home 1\n• SG Smart 3.0: 2 devices. Tap "Fetch again".');
  assert.equal(summaryLines('en')({ number: 1, devices: 1, sg3: 1, sg3State: 'later' }), 'Home 1\n• SG Smart 3.0: 1 device. Not supported yet.');
  // A home with no devices still says so.
  assert.equal(summaryLines('no')({ number: 3, devices: 0, passphrase: false }), 'Hjem 3\n• SG Smart: 0 enheter. Nettverkspassord: 1234.');
});

test('the texts: the SG password is not stored, the passphrase hint and the store texts name the login, the guide too when no account is fetched', () => {
  const [en, no] = ['en', 'no'].map((language) => JSON.parse(read(`locales/${language}.json`)));
  assert.equal(en.settings.account.intro, 'Required for SG Smart 3.0, otherwise optional. Fetch the network password and device names. Your SG password is not stored.');
  assert.equal(no.settings.account.intro, 'Kreves for SG Smart 3.0, ellers valgfritt. Hent nettverkspassord og enhetsnavn. SG-passordet lagres ikke.');
  const hint = JSON.parse(read('.homeycompose/drivers/settings/network.json')).children.find((s) => s.id === 'passphrase').hint;
  assert.match(hint.en, /Log in with your SG account in the SG LEDDim settings to fetch the network password\.$/);
  assert.match(hint.no, /Logg inn med SG-kontoen i innstillingene til SG LEDDim for å hente nettverkspassordet\.$/);
  // The store texts as Trond worded them for 2.8.0 (2026-11-08).
  assert.ok(read('README.txt').includes('Set up the devices in the SG app first. Then add them to Homey. Log in with your SG account in the SG LEDDim settings to fetch the network password and device names. LEDDim Smart 3.0 requires login. Your SG password is not stored.'));
  assert.ok(read('README.no.txt').includes('Sett opp enhetene i SG-appen først. Legg dem så til i Homey. Logg inn med SG-kontoen i innstillingene til SG LEDDim for å hente nettverkspassord og enhetsnavn. LEDDim Smart 3.0 krever innlogging. SG-passordet lagres ikke.'));
  assert.equal(en.pair.guide.passwordAccount, "If Homey can't find the devices or they don't respond, log in with your SG account in the SG LEDDim settings.");
  assert.equal(no.pair.guide.passwordAccount, 'Finner ikke Homey enhetene, eller svarer de ikke? Logg inn med SG-kontoen i innstillingene til SG LEDDim.');
  // "enhet" after 1, "enheter" after any other number (the account summary,
  // Trond 2026-11-06).
  assert.equal(en.settings.account.home, 'Home __number__');
  assert.equal(no.settings.account.home, 'Hjem __number__');
  assert.equal(en.settings.account.sg3, 'SG Smart 3.0: __devices__. Not supported yet.');
  assert.equal(no.settings.account.sg3, 'SG Smart 3.0: __devices__. Støttes ikke ennå.');
  assert.equal(en.settings.account.asking, 'Checking devices.');
  assert.equal(no.settings.account.asking, 'Sjekker enhetene.');
  // "app settings", never "app's settings", in what the user reads.
  for (const text of [read('locales/en.json'), JSON.stringify(hint), read('README.txt'), read('.homeychangelog.json'), read('settings/index.html')]) {
    assert.doesNotMatch(text, /app's settings/);
  }
  const guides = ['sg_mesh', 'sg_pill', 'sg_din', 'sg_plug', 'sg_thermostat'].map((driver) => read(`drivers/${driver}/pair/guide.html`));
  for (const guide of guides) assert.equal(guide, guides[0], 'one guide for all five');
  assert.ok(guides[0].includes("Homey.emit('account')") && guides[0].includes("Homey.__('pair.guide.passwordAccount')"));
  // 2.6.1 is Live, and 2.6.2 is not published on its own: the 2.7.0
  // changelog is Trond's short text alone, with the dimmer fixes of 2.6.2 in
  // "Dimmer fixes", and nothing from 2.6.1.
  const changelogs = JSON.parse(read('.homeychangelog.json'));
  assert.equal(changelogs['2.6.2'], undefined);
  assert.deepEqual(changelogs['2.7.0'], {
    en: 'New, optional login with your SG account in the app settings. It fetches the network password and the device names. '
      + 'Dimmer fixes.',
    no: 'Ny, valgfri innlogging med SG-kontoen i appens innstillinger. Den henter nettverkspassordet og navnene på enhetene. '
      + 'Rettinger for dimmere.',
  });
  for (const language of ['en', 'no']) {
    const live = changelogs['2.6.1'][language].split(/(?<=\.) /);
    assert.deepEqual(live.filter((sentence) => changelogs['2.7.0'][language].includes(sentence)), [], `${language}: nothing from 2.6.1`);
  }
  // 2.8.0 as Trond worded it (2026-11-08), after the old entries, which stay.
  assert.deepEqual(changelogs['2.8.0'], {
    en: 'Support for LEDDim Smart 3.0 with SG account login. Optional login for other devices. Several bug fixes.',
    no: 'Støtte for LEDDim Smart 3.0 med innlogging på SG-kontoen. Valgfri innlogging for andre enheter. Flere feilrettinger.',
  });
  // 2.8.1 as Trond worded it (2026-11-08); 2.8.0 never went Live.
  assert.deepEqual(changelogs['2.8.1'], {
    en: 'Support for LEDDim Smart 3.0 with SG account login. Optional login for other devices. '
      + 'Better search for generation 3 and 4 devices. Several bug fixes.',
    no: 'Støtte for LEDDim Smart 3.0 med innlogging på SG-kontoen. Valgfri innlogging for andre enheter. '
      + 'Bedre søk etter enheter av generasjon 3 og 4. Flere feilrettinger.',
  });
  // 2.8.2 (2026-11-09), the test build from sg3; 2.8.1 never went Live.
  assert.deepEqual(changelogs['2.8.2'], {
    en: 'Support for LEDDim Smart 3.0 with SG account login. Optional login for other devices. '
      + 'Better search for generation 3 and 4 devices, and a warning when a device stops answering. Several bug fixes.',
    no: 'Støtte for LEDDim Smart 3.0 med innlogging på SG-kontoen. Valgfri innlogging for andre enheter. '
      + 'Bedre søk etter enheter av generasjon 3 og 4, og varsel når en enhet slutter å svare. Flere feilrettinger.',
  });
  assert.deepEqual(Object.keys(changelogs).slice(-5), ['2.6.1', '2.7.0', '2.8.0', '2.8.1', '2.8.2']);
});

// ---- the type in the account

test('the type in the account: 101 is the first generation, 3000 to 3999 SG Smart 3.0, every other known one a product of ours', () => {
  assert.equal(familyForType(FIRST_GENERATION_TYPE), 'gen1');
  assert.equal(driverForType(FIRST_GENERATION_TYPE), 'sg_mesh');
  for (const type of [3000, 3005, 3999]) assert.equal(familyForType(type), 'sg3');
  assert.equal(driverForType(3005), null);
  for (const [type, prefix] of Object.entries(TYPE_PREFIXES)) {
    assert.ok(CSR_PRODUCTS[prefix], `${type}: ${prefix}`);
    assert.equal(familyForType(Number(type)), 'csr');
  }
  assert.equal(csrProductForType(1004).name, 'LEDDim Smart Pill');
  assert.deepEqual([1004, 2002, 1021, 2080, 6, 999].map(driverForType), ['sg_pill', 'sg_plug', 'sg_thermostat', 'sg_mesh', null, null]);
  assert.equal(csrProductForType(999), null);
});

// ---- pairing

// A driver as lib/csrPairing.js needs it, with the app's account.
function pairDriver(app) {
  const driver = {
    logs: [],
    errors: [],
    homey: { app, __: (key, tokens) => `${key}${tokens ? ` ${JSON.stringify(tokens)}` : ''}`, ...fake.fakeTimers() },
  };
  driver.log = (...args) => driver.logs.push(args.join(' '));
  driver.error = (...args) => driver.errors.push(args.join(' '));
  return driver;
}

async function loggedIn(options) {
  const app = accountApp(options);
  withAccount(app);
  await app.account.login(EMAIL, PASSWORD);
  await checked(app);
  return app;
}

test('pairing: the name\'s prefix decides; a type that disagrees is logged; the type decides only when the prefix is not known here', async () => {
  const app = await loggedIn();
  const driver = pairDriver(app);
  const nodes = [
    { meshId: 0x8004, name: '@SC0001', product: CSR_PRODUCTS['@SC'] && { prefix: '@SC', ...CSR_PRODUCTS['@SC'] } },
    { meshId: 0x8006, name: '@ZZ0002', product: null },
    { meshId: 0x9999, name: '@ZZ0003', product: null },
  ];
  const found = accountFindings(driver, [], nodes);
  assert.deepEqual(found.map((f) => [f.name, f.product.prefix, !!f.byType]), [['@SC0001', '@SC', false], ['@ZZ0002', '@MD', true]]);
  assert.deepEqual(driver.logs, ['pair: 0x8004 @SC is LEDDim Smart Pill Gen3 by its name, type 2002 (Smart Plug Gen4) in the SG account; the name decides']);
  assert.deepEqual(withStates(found, 'sg_pill', new Set()).map((f) => [f.name, f.driver]), [['@SC0001', 'sg_pill'], ['@ZZ0002', 'sg_mesh']]);
  // Without an account, as before.
  assert.deepEqual(laterFindings([], nodes).map((f) => f.name), ['@SC0001']);
  assert.deepEqual(typeDisagreements(nodes, () => null), []);
});

test('pairing: the account\'s devices for a driver that did not answer are named, not offered; heard, added and recalled ones are not', async () => {
  const app = await loggedIn({ devices: [added({ meshId: 0x8003 })], nodes: new Map([[0x8006, { meshId: 0x8006 }]]) });
  app.account._state.homes[0].devices.push({ meshId: 0x8007, type: 1002 }, { meshId: 0x8008, type: 2004 });
  const driver = pairDriver(app);
  assert.deepEqual(quietInAccount(driver, 'sg_pill'), ['pair.account.device {"product":"LEDDim Smart Pill","address":"8008"}']);
  assert.deepEqual(quietInAccount(driver, 'sg_plug'), ['pair.account.device {"product":"Smart Plug","address":"8004"}'], 'the recalled plug is left out');
  assert.deepEqual(quietInAccount(driver, 'sg_mesh', [0x8001]), ['pair.account.device {"product":"LEDDim Smart","address":"8002"}'],
    'the first generation dimmer the scan saw, and the rotary dimmer that answered, are not named');
  assert.deepEqual(quietInAccount(pairDriver(accountApp()), 'sg_pill'), [], 'no account, none');
});

test('pairing: with nothing to add, the list says which of the account\'s devices did not answer; with devices to add, only the log does', async () => {
  const app = await loggedIn();
  for (const [listed, expected] of [
    [{ devices: [], why: 'none found' }, 'pair.account.quiet {"devices":"A, B"}'],
    [{ error: 'none', text: 'No Pill found.' }, 'No Pill found. pair.account.quiet {"devices":"A, B"}'],
  ]) {
    const driver = pairDriver(app);
    const session = { handlers: {}, setHandler(name, fn) { this.handlers[name] = fn; }, showView: async () => {} };
    pairInLoadingView(driver, session, { search: async () => ({ quiet: ['A', 'B'] }), list: () => listed });
    await assert.rejects(session.handlers.list_devices(), (err) => err.message === expected);
    assert.ok(driver.logs.includes('pair: 2 device(s) in the SG account did not answer'));
  }
  const driver = pairDriver(app);
  const session = { handlers: {}, setHandler(name, fn) { this.handlers[name] = fn; }, showView: async () => {} };
  pairInLoadingView(driver, session, { search: async () => ({ quiet: ['A'] }), list: () => ({ devices: [{ data: { id: '@SC0001' } }] }) });
  assert.deepEqual((await session.handlers.list_devices()).map((d) => d.data.id), ['@SC0001']);
  assert.deepEqual(await session.handlers.account(), { fetched: true, password: 'fetchAgain' });
  assert.deepEqual(await (() => {
    const other = { handlers: {}, setHandler(name, fn) { this.handlers[name] = fn; }, showView: async () => {} };
    pairInLoadingView(pairDriver(accountApp()), other, { search: async () => ({}), list: () => ({ devices: [] }) });
    return other.handlers.account();
  })(), { fetched: false, password: 'passwordAccount' });
});

test('the guide\'s point 4, the same in the five drivers that search: fetch again with an account fetched; without one, where the password can come from; without the module as before', () => {
  const { guidePoint } = require('../lib/csrPairing');
  const driverWith = (account) => ({ homey: { app: { account } } });
  const account = (fetched, available = true) => ({ fetched: () => fetched, available: () => available });
  assert.deepEqual(guidePoint(driverWith(account(true))), { fetched: true, password: 'fetchAgain' });
  assert.deepEqual(guidePoint(driverWith(account(false))), { fetched: false, password: 'passwordAccount' });
  // Without the module: as before.
  assert.deepEqual(guidePoint(driverWith(account(false, false))), { fetched: false, password: 'passwordAccount' });
  assert.deepEqual(guidePoint(driverWith(account(true, false))), { fetched: true, password: 'password' });
  assert.deepEqual(guidePoint(driverWith(undefined)), { fetched: false, password: 'passwordAccount' });
  for (const driver of ['sg_mesh', 'sg_pill', 'sg_din', 'sg_plug', 'sg_thermostat']) {
    assert.doesNotMatch(read(`drivers/${driver}/driver.js`), /sg3Guide|sg3PairingDevices|SG3Device/, driver);
  }
});

test('the account\'s values are never in util.inspect of an error from it', async () => {
  const app = accountApp();
  withAccount(app, accountError('SG_CLOUD_LOGIN', 'made-up login refused'));
  await app.account.login(EMAIL, PASSWORD);
  const text = [...app.errors, util.inspect(app.account.summary())].join('\n');
  assert.ok(!text.includes(EMAIL) && !text.includes(PASSWORD));
  assert.deepEqual(app.errors, ['[SG account] made-up login refused']);
});

// ---- without the account module (a clone of the public repository)

// What load throws when lib/sky/ is not there.
const missingModule = () => {
  throw Object.assign(new Error("Cannot find module './sky'\nRequire stack:\n- lib/account.js"), { code: 'MODULE_NOT_FOUND' });
};

test('without lib/sky/ the account is not available: no login, no fetch, nothing kept, and the rest as without an account', async () => {
  const app = accountApp();
  app.account = new SgAccount(app, { load: missingModule });
  assert.equal(app.account.available(), false);
  assert.deepEqual(app.account.summary(), { available: false, fetched: false, checking: false, homes: [] });
  const summary = await app.account.login(EMAIL, PASSWORD);
  assert.equal(summary.error, 'unavailable');
  assert.deepEqual([...app.homey.settings.values.keys()], []);
  assert.deepEqual(app.sent, []);
  assert.equal(app.account.passphraseFor(0x8001), null);
  assert.ok(app.logs.includes('[SG account] the account module not in this build: no SG account in this build'));
  assert.ok(!allText(app).includes(EMAIL) && !allText(app).includes(PASSWORD));
});

test('a module that does not load, or has another interface version, counts as missing, and the app still starts', () => {
  const broken = () => { throw new TypeError('made-up failure inside the module'); };
  const missingInside = () => {
    throw Object.assign(new Error("Cannot find module './request'"), { code: 'MODULE_NOT_FOUND' });
  };
  for (const [load, why] of [
    [broken, 'did not load (TypeError)'],
    [missingInside, 'did not load (Error)'],
    [() => ({ interfaceVersion: 99, fetchHomes: async () => ({}) }), 'has interface 99 where 1 or 2 or 3 or 4 is needed'],
    [() => ({ interfaceVersion: 5, fetchHomes: async () => ({}) }), 'has interface 5 where 1 or 2 or 3 or 4 is needed'],
    [() => ({ interfaceVersion: 2 }), 'has no fetchHomes'],
    [() => null, 'has interface null where 1 or 2 or 3 or 4 is needed'],
  ]) {
    const found = loadAccountModule(load);
    assert.equal(found.fetch, null, why);
    assert.equal(found.why, why);
  }
  const fetchHomes = async () => ({ homes: [], loggedOut: true });
  assert.deepEqual(INTERFACE_VERSIONS, [1, 2, 3, 4]);
  for (const interfaceVersion of INTERFACE_VERSIONS) {
    assert.equal(loadAccountModule(() => ({ interfaceVersion, fetchHomes })).fetch, fetchHomes, `interface ${interfaceVersion}`);
  }
  // The app starts with no module: it is only noted in the log.
  const app = appWith([]);
  app.account = new SgAccount(app, { load: missingModule });
  assert.deepEqual(app.getNetworkKey(), deriveNetworkKey('1234'));
});

test('what was kept before stays usable without the module, and "Forget SG account" still removes it', async () => {
  const app = accountApp();
  withAccount(app);
  await app.account.login(EMAIL, PASSWORD);
  await checked(app);
  const later = new SgAccount(app, { load: missingModule });
  assert.equal(later.passphraseFor(0x8001), ISOLATED);
  assert.equal(later.summary().available, false);
  assert.equal(later.summary().fetched, true);
  later.forget();
  assert.deepEqual([...app.homey.settings.values.keys()], []);
});

test('the page says when the account module is not in this build, and hides the login', () => {
  const page = read('settings/index.html');
  assert.ok(page.includes('<p id="account-unavailable" hidden data-i18n="settings.account.unavailable">'));
  assert.ok(page.includes("document.getElementById('account-login').hidden = !available;"));
  const [en, no] = ['en', 'no'].map((language) => JSON.parse(read(`locales/${language}.json`)));
  assert.equal(en.settings.account.unavailable, 'SG account login is not included in this build.');
  assert.equal(no.settings.account.unavailable, 'Denne utgaven har ikke innlogging med SG-konto.');
});

test('lib/sky/ is not in git, its code goes in a build, its tests and README do not', () => {
  assert.match(read('.gitignore'), /^lib\/sky\/$/m);
  const homeyignore = read('.homeyignore').split('\n');
  assert.ok(!homeyignore.some((line) => /^\/?lib\/sky\/?$/.test(line.trim())), 'the module is not left out of a build');
  assert.ok(homeyignore.includes('lib/sky/test/') && homeyignore.includes('lib/sky/README.md'));
});

// The SG account is a service (Trond 2026-11-08): what was fetched is only
// removed by "Forget SG account", never by a fetch that comes back empty.
test('a fetch with no homes keeps what was fetched before, and the page says the account has no homes', async () => {
  const app = await loggedIn();
  const before = JSON.stringify(app.homey.settings.get(SETTING));
  assert.equal(app.account.passphraseFor(0x8001), ISOLATED);
  for (const answer of [{ homes: [], loggedOut: true }, { loggedOut: true }, { homes: null, loggedOut: true }]) {
    app.account._fetch = async () => answer;
    const summary = await app.account.login(EMAIL, PASSWORD);
    assert.equal(summary.error, 'noHomes', JSON.stringify(answer));
    assert.equal(summary.fetched, true);
    assert.equal(summary.homes.length, 2, 'the two homes from before');
    assert.equal(JSON.stringify(app.homey.settings.get(SETTING)), before, 'the kept setting unchanged');
    assert.equal(app.account.passphraseFor(0x8001), ISOLATED, 'the passphrase from before');
  }
  assert.ok(app.logs.includes('[SG account] the account has no homes: what was fetched before is kept'), app.logs.join('\n'));
  // Never fetched: nothing kept, and the same text.
  const first = accountApp();
  withAccount(first, []);
  const summary = await first.account.login(EMAIL, PASSWORD);
  assert.equal(summary.error, 'noHomes');
  assert.equal(summary.fetched, false);
  assert.equal(first.homey.settings.get(SETTING), null);
  assert.ok(first.logs.includes('[SG account] the account has no homes: nothing kept'), first.logs.join('\n'));
  const [en, no] = ['en', 'no'].map((language) => JSON.parse(read(`locales/${language}.json`)));
  assert.equal(no.settings.account.error.noHomes, 'SG-kontoen har ingen hjem. Ingenting er endret.');
  assert.equal(en.settings.account.error.noHomes, 'The SG account has no homes. Nothing was changed.');
});

// ---- a fetch with empty fields keeps what was fetched before

// Made-up home keys and a fetch that gives each list in turn.
const HOME_A = 'a1b2c3d4e5f6';
const HOME_B = '0f1e2d3c4b5a';
const homeA = (fields = {}) => ({
  homeKey: HOME_A,
  passphrase: ISOLATED,
  netKey: NET_KEY,
  appKey: APP_KEY,
  locationId: 0x4242,
  devices: [{ meshId: 0x8003, type: 1004 }, { meshId: 0x8004, type: 2002 }],
  ...fields,
});
const homeB = (fields = {}) => ({
  homeKey: HOME_B,
  passphrase: '1234',
  netKey: null,
  appKey: null,
  locationId: 0x3131,
  devices: [{ meshId: 0x8006, type: 1 }],
  ...fields,
});

function fetchingInTurn(app, ...lists) {
  const fetch = async () => ({ homes: lists.shift(), loggedOut: true });
  app.account = new SgAccount(app, { fetch });
}

const keptHomes = (app) => app.homey.settings.get('sgAccount').homes;

test('a home that comes back with an empty passphrase, empty 3.0 keys and no location id keeps those fetched before', async () => {
  const app = accountApp();
  const emptied = {
    passphrase: '', netKey: '', appKey: null, locationId: null,
  };
  fetchingInTurn(app, [homeA()], [homeA(emptied)]);
  await app.account.login(EMAIL, PASSWORD);
  await checked(app);
  await app.account.login(EMAIL, PASSWORD);
  await checked(app);
  const [home] = keptHomes(app);
  assert.equal(home.passphrase, ISOLATED);
  assert.equal(home.netKey, NET_KEY);
  assert.equal(home.appKey, APP_KEY);
  assert.equal(home.locationId, 0x4242);
  assert.equal(app.account.passphraseFor(0x8003), ISOLATED);
  assert.deepEqual(app.account.locations(), [0x4242]);
  assert.ok(app.logs.includes('[SG account] empty in this fetch, kept from before: 4 field(s) in 1 home(s)'), app.logs.join('\n'));
  assert.ok(!app.logs.some((line) => line.includes(ISOLATED) || line.includes(NET_KEY)), 'no value in the log');
});

test('"1234" in a new fetch replaces a passphrase fetched before: Network Isolation was turned off', async () => {
  const app = accountApp();
  fetchingInTurn(app, [homeA()], [homeA({ passphrase: '1234' })]);
  await app.account.login(EMAIL, PASSWORD);
  await checked(app);
  await app.account.login(EMAIL, PASSWORD);
  await checked(app);
  assert.equal(keptHomes(app)[0].passphrase, null);
  assert.equal(app.account.passphraseFor(0x8003), null);
  assert.equal(app.account.onlyPassphrase(), null);
});

test('a home is matched by its key, else by its location id; one that matches neither keeps nothing of another', async () => {
  const app = accountApp();
  // Kept before the home's key; then fetched with it and an empty passphrase.
  fetchingInTurn(app, [homeA({ homeKey: null })], [homeA({ passphrase: null }), homeB({ homeKey: null, locationId: 0x5555, passphrase: null })]);
  await app.account.login(EMAIL, PASSWORD);
  await checked(app);
  await app.account.login(EMAIL, PASSWORD);
  await checked(app);
  const [a, b] = keptHomes(app);
  assert.equal(a.homeKey, HOME_A);
  assert.equal(a.passphrase, ISOLATED, 'the same home by its location id');
  assert.equal(b.passphrase, null, 'another home takes nothing');
});

test('a home not in a new fetch is kept with its keys and marked; back in a fetch it is not marked; "Forget SG account" removes it', async () => {
  const app = accountApp();
  fetchingInTurn(app, [homeA(), homeB()], [homeB()], [homeB(), homeA()]);
  await app.account.login(EMAIL, PASSWORD);
  await checked(app);
  await app.account.login(EMAIL, PASSWORD);
  await checked(app);
  let homes = keptHomes(app);
  assert.deepEqual(homes.map((home) => [home.homeKey, !!home.missing]), [[HOME_B, false], [HOME_A, true]]);
  assert.equal(app.account.passphraseFor(0x8003), ISOLATED, 'the keys of the home not fetched still count');
  assert.ok(app.logs.includes('[SG account] not in this fetch, kept from before with its keys: 1 home(s)'), app.logs.join('\n'));
  await app.account.login(EMAIL, PASSWORD);
  await checked(app);
  homes = keptHomes(app);
  assert.deepEqual(homes.map((home) => [home.homeKey, !!home.missing]), [[HOME_B, false], [HOME_A, false]]);
  app.account.forget();
  assert.equal(app.homey.settings.get('sgAccount'), null);
  assert.equal(app.account.passphraseFor(0x8003), null);
});
