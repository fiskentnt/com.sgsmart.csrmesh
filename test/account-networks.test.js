'use strict';

// An SG account with homes on different network passwords: the app speaks
// one network at a time (app.getNetworkKey), so a search counts, asks and
// listens for the devices of the homes on that network only, and the
// pairing text says how many devices are in a home on another password.
// With one home, or homes that share one password, nothing changes.
// Made-up values: the names, location ids, mesh ids and passwords. Run with:
// node --test test/*.test.js

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const fake = require('./helpers/fake-homey');

fake.install();

const { decryptPayload, deriveNetworkKey } = require('../lib/csrmesh');
const { CsrNetwork } = require('../lib/CsrNetwork');
const { SgAccount } = require('../lib/account');
const { accountHomesLine, otherNetworkCount, otherNetworkText } = require('../lib/csrPairing');
const SGSmartApp = require('../app');
const SGPillDriver = require('../drivers/sg_pill/driver');

const MC = 4; // a Pill's type in the SG account
const ST = 1021; // a thermostat's
const LOC_A = 0x5a3c;
const LOC_B = 0x2b1d;
const PASS_B = 'made-up-other';
const KEY_A = deriveNetworkKey('1234');
const KEY_B = deriveNetworkKey(PASS_B);

const tick = () => new Promise((resolve) => setImmediate(resolve));

const home = (locationId, passphrase, meshIds, type = MC) => ({
  homeKey: null,
  passphrase,
  netKey: null,
  appKey: null,
  locationId,
  devices: meshIds.map((meshId) => ({
    meshId, type, name: null, certain: true,
  })),
});
const kept = (homes) => ({ fetchedAt: '2026-11-08T12:00:00.000Z', check: null, homes });

const texts = Object.fromEntries(['en', 'no'].map((lang) => [lang, JSON.parse(fs.readFileSync(path.join(__dirname, `../locales/${lang}.json`), 'utf8'))]));
const translator = (lang) => (key, vars = {}) => {
  let s = key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), texts[lang]);
  if (typeof s !== 'string') return key;
  for (const [k, v] of Object.entries(vars)) s = s.split(`__${k}__`).join(String(v));
  return s;
};

// The app with this account, the devices already in Homey (each with the
// key of its home), its CsrNetwork and a Pill driver; every packet sent is
// kept with the key it went out with.
function makeApp({
  homes, paired = [], lang = 'no', keyOf = () => KEY_A,
} = {}) {
  const app = new SGSmartApp();
  const settings = new Map([['sgAccount', kept(homes)]]);
  const devices = paired.map((meshId) => ({
    getData: () => ({ id: `made-up-${meshId}` }), getCsrMeshId: () => meshId, getCsrLocationId: () => null,
    getName: () => `made-up-${meshId}`, getNetworkKey: () => keyOf(meshId),
  }));
  const homey = fake.listenAtOnce(fake.fakeHomey(app, {
    __: translator(lang),
    settings: { get: (key) => (settings.has(key) ? settings.get(key) : null), set: (key, value) => settings.set(key, value), unset: (key) => settings.delete(key) },
    drivers: { getDrivers: () => ({ sg_pill: { getDevices: () => devices } }) },
    ble: { discover: async () => [] },
  }));
  app.homey = homey;
  app.logs = [];
  app.log = (...args) => app.logs.push(args.join(' '));
  app.error = (...args) => app.logs.push(args.join(' '));
  app._devices = () => devices;
  let seq = 0x800000;
  app.nextSeq = () => { seq += 1; return seq; };
  app.sent = [];
  app.bridge = {
    send: async (packet, meta) => {
      const key = app.getNetworkKey();
      const plain = decryptPayload(key, packet.subarray(0, 3), packet.subarray(3, 5), packet.subarray(5, packet.length - 9));
      app.sent.push({
        key: key.equals(KEY_A) ? 'A' : key.equals(KEY_B) ? 'B' : '?', data: plain.toString('hex'), meta,
      });
      return { ok: true };
    },
  };
  app.account = new SgAccount(app, { fetch: async () => { throw new Error('made-up: no fetch here'); } });
  app.csr = new CsrNetwork(app);
  app._csrHeardAt = new Map();
  const driver = new SGPillDriver({ homey });
  driver.getDevices = () => devices;
  return { app, driver };
}

// Runs until done settles, firing the shortest pending timer each round (the
// gaps between the FF10s before the search's limits).
async function run(app, promise) {
  let done = false;
  const result = promise.then((value) => { done = true; return value; }, (err) => { done = true; throw err; });
  result.catch(() => {});
  for (let round = 0; round < 1000 && !done; round += 1) {
    // Enough ticks for the promise chains between two timers to settle.
    for (let i = 0; i < 25 && !done; i += 1) await tick();
    if (done) break;
    const [next] = [...app.homey.pending.entries()].sort(([, a], [, b]) => a.ms - b.ms);
    if (next) {
      app.homey.pending.delete(next[0]);
      next[1].fn();
    }
  }
  assert.ok(done, 'the search settled');
  return result;
}

const ff10 = (app) => app.sent.filter((s) => s.data.slice(4, 8) === 'ff10');
const directTo = (app) => ff10(app).filter((s) => s.data.slice(0, 4) !== '0000').map((s) => parseInt(s.data.slice(2, 4) + s.data.slice(0, 2), 16));
const everyoneLocs = (app) => ff10(app).filter((s) => s.data.slice(0, 4) === '0000').map((s) => parseInt(s.data.slice(8, 12), 16));

// The pairing as far as the list: the devices offered, or the text.
async function pairingOutcome(driver, app) {
  const session = { handlers: {}, views: [] };
  session.setHandler = (name, handler) => { session.handlers[name] = handler; };
  session.showView = async (view) => { session.views.push(view); };
  await driver.onPair(session);
  await session.handlers.showView('guide');
  await run(app, session.handlers.showView('loading'));
  try {
    return { devices: await run(app, session.handlers.list_devices()) };
  } catch (err) {
    return { text: err.message };
  } finally {
    await session.handlers.disconnect();
  }
}

const TWO_HOMES = [home(LOC_A, null, [0x9c01, 0x9c02, 0x9c03]), home(LOC_B, PASS_B, [0x9d01, 0x9d02, 0x9d03, 0x9d04])];

test('one home: every device is in the app\'s network, whatever key the app uses, and the lists are as before', () => {
  for (const paired of [[], [0x9c01]]) {
    for (const keyOf of [() => KEY_A, () => deriveNetworkKey('typed-in-by-the-user')]) {
      const { app, driver } = makeApp({ homes: [home(LOC_A, null, [0x9c01, 0x9c02, 0x9c03])], paired, keyOf });
      assert.equal(app.account.networkHomes().length, 1);
      assert.deepEqual(app.account.otherNetworkHomes(), []);
      assert.deepEqual(app.account.devicesInNetwork().map((d) => d.meshId), [0x9c01, 0x9c02, 0x9c03]);
      assert.deepEqual(app.account.devicesOutsideNetwork(), []);
      assert.deepEqual(app.account.locations(), [LOC_A]);
      assert.deepEqual([...app.account.deviceLocations().keys()], [0x9c01, 0x9c02, 0x9c03]);
      assert.equal(otherNetworkCount(driver, 'sg_pill'), 0);
      assert.equal(accountHomesLine(driver, 'sg_pill'), 'pair: SG account: 1 home(s), 1 in Homey\'s network, 0 device(s) of this driver in the other home(s)');
    }
  }
});

test('two homes on the same password (both 1234, or both their own): all of it as before, both location ids in FF10', async () => {
  for (const [passA, passB] of [[null, null], [PASS_B, PASS_B]]) {
    const homes = [home(LOC_A, passA, [0x9c01, 0x9c02]), home(LOC_B, passB, [0x9d01, 0x9d02])];
    const { app, driver } = makeApp({ homes });
    assert.equal(app.account.networkHomes().length, 2);
    assert.deepEqual(app.account.devicesInNetwork().map((d) => d.meshId), [0x9c01, 0x9c02, 0x9d01, 0x9d02]);
    assert.deepEqual(app.account.locations(), [LOC_B, LOC_A].sort((a, b) => a - b));
    assert.equal(app.account.deviceLocations().size, 4);
    assert.equal(otherNetworkCount(driver, 'sg_pill'), 0);
    const outcome = await pairingOutcome(driver, app);
    assert.equal(outcome.text, '4 enheter fra SG-kontoen svarte ikke. Prøv igjen nærmere dem.', 'the text as before, nothing about another password');
    assert.deepEqual(everyoneLocs(app), [0, LOC_B, LOC_A]);
    assert.deepEqual(directTo(app), [0x9c01, 0x9c02, 0x9d01, 0x9d02]);
  }
});

test('two homes on different passwords, nothing paired: the app speaks the home with its own password; the other home\'s '
  + 'devices are not counted, not asked, and the text says how many are on another password', async () => {
  const { app, driver } = makeApp({ homes: TWO_HOMES });
  assert.deepEqual(app.account.networkHomes().map((h) => h.locationId), [LOC_B]);
  assert.deepEqual(app.account.devicesOutsideNetwork().map((d) => d.meshId), [0x9c01, 0x9c02, 0x9c03]);
  assert.deepEqual(app.account.locations(), [LOC_B], 'no FF10 with the other home\'s location id');
  assert.deepEqual([...app.account.deviceLocations().keys()], [0x9d01, 0x9d02, 0x9d03, 0x9d04]);
  assert.equal(otherNetworkCount(driver, 'sg_pill'), 3);
  const outcome = await pairingOutcome(driver, app);
  assert.equal(outcome.text, '4 enheter fra SG-kontoen svarte ikke. Prøv igjen nærmere dem. '
    + '3 enheter i SG-kontoen hører til et hjem med et annet nettverkspassord og kan ikke legges til nå.');
  assert.deepEqual([...new Set(ff10(app).map((s) => s.key))], ['B']);
  assert.deepEqual(everyoneLocs(app), [0, LOC_B]);
  assert.deepEqual(directTo(app), [0x9d01, 0x9d02, 0x9d03, 0x9d04], 'none to the home the app does not speak with');
  assert.ok(app.logs.includes('pair: SG account: 2 home(s), 1 in Homey\'s network, 3 device(s) of this driver in the other home(s)')
    || (driver.logs || []).includes('pair: SG account: 2 home(s), 1 in Homey\'s network, 3 device(s) of this driver in the other home(s)'), 'the line');
});

test('a device of the 1234 home paired: the app speaks that home; the four on the other password are the sentence, '
  + 'alone when nothing of this home is quiet', async () => {
  const { app, driver } = makeApp({ homes: TWO_HOMES, paired: [0x9c01, 0x9c02, 0x9c03] });
  assert.deepEqual(app.account.networkHomes().map((h) => h.locationId), [LOC_A]);
  assert.equal(otherNetworkCount(driver, 'sg_pill'), 4);
  const outcome = await pairingOutcome(driver, app);
  assert.equal(outcome.text, '4 enheter i SG-kontoen hører til et hjem med et annet nettverkspassord og kan ikke legges til nå.');
  assert.deepEqual([...new Set(ff10(app).map((s) => s.key))], ['A']);
  assert.deepEqual(directTo(app), [], 'the three are paired, the four cannot read it');
  const one = makeApp({ homes: [home(LOC_A, null, [0x9c01]), home(LOC_B, PASS_B, [0x9d01])], paired: [0x9c01] });
  assert.equal(otherNetworkText(one.driver, otherNetworkCount(one.driver, 'sg_pill')),
    '1 enhet i SG-kontoen hører til et hjem med et annet nettverkspassord og kan ikke legges til nå.');
  const en = makeApp({ homes: TWO_HOMES, paired: [0x9c01, 0x9c02, 0x9c03], lang: 'en' });
  assert.equal((await pairingOutcome(en.driver, en.app)).text,
    '4 devices in your SG account are in a home with a different network password and cannot be added now.');
  assert.equal(otherNetworkText(en.driver, 1), '1 device in your SG account is in a home with a different network password and cannot be added now.');
});

test('the count is for this driver\'s devices only, and never an uncertain or recalled one', () => {
  const homes = [home(LOC_A, null, [0x9c01]), { ...home(LOC_B, PASS_B, [0x9d01, 0x9d02], ST), devices: [{ meshId: 0x9d01, type: ST, name: null, certain: true }, { meshId: 0x9d02, type: MC, name: null, certain: false }, { meshId: 0x9d03, type: MC, name: null, certain: true }] }];
  const { driver } = makeApp({ homes, paired: [0x9c01] });
  assert.equal(otherNetworkCount(driver, 'sg_pill'), 1, 'the certain Pill; not the thermostat, not the uncertain one');
  assert.equal(otherNetworkCount(driver, 'sg_thermostat'), 1);
});

test('the app\'s key none of the homes\' (a password typed in a device): every home counts, as before', () => {
  const { app, driver } = makeApp({ homes: TWO_HOMES, paired: [0x9c01], keyOf: () => deriveNetworkKey('typed-in-by-the-user') });
  assert.equal(app.account.networkHomes().length, 2);
  assert.equal(otherNetworkCount(driver, 'sg_pill'), 0);
  assert.deepEqual(app.account.locations(), [LOC_B, LOC_A].sort((a, b) => a - b));
});

test('without an account, or with one not fetched: 0, \'\' and no line', () => {
  const { app, driver } = makeApp({ homes: TWO_HOMES });
  app.account = null;
  assert.equal(otherNetworkCount(driver, 'sg_pill'), 0);
  assert.equal(otherNetworkText(driver, 0), '');
  assert.equal(accountHomesLine(driver, 'sg_pill'), '');
});

test('the check asks only the homes on the app\'s network password; another home is not asked, not counted, and shown as on another network password, not asked', async () => {
  const { app } = makeApp({
    homes: [home(LOC_A, null, [0x8101, 0x8102]), home(LOC_B, PASS_B, [0x8201, 0x8202, 0x8203])], paired: [0x8101],
  });
  await run(app, app.account._check(app.account._run));
  const ff04 = app.sent.filter((s) => s.data.slice(4, 8) === 'ff04')
    .map((s) => [parseInt(s.data.slice(2, 4) + s.data.slice(0, 2), 16), parseInt(s.data.slice(8, 12), 16)]);
  assert.deepEqual(ff04.map(([meshId]) => meshId).sort(), [0x8101, 0x8102], 'only home 1 is asked');
  assert.ok(ff04.every(([, location]) => location === LOC_A));
  const [first, second] = app.account.summary().homes;
  assert.deepEqual([first.otherNetwork, first.total, first.quiet.length], [false, 2, 2]);
  assert.deepEqual([second.otherNetwork, second.answering, second.quiet, second.unknown], [true, 0, [], []]);
  const line = app.logs.find((l) => l.startsWith('[SG account] check:'));
  assert.ok(line.startsWith('[SG account] check: 0 of 2 answer, '), line);
  assert.ok(line.includes(', 0 uncertain (not counted), 3 in 1 home(s) on another network password, not asked, 0 SG Smart 3.0 not asked'), line);
  // The page's text for it, in both languages.
  assert.equal(translator('no')('settings.account.csrOtherNetwork', { devices: '3 enheter' }), 'SG Smart: 3 enheter, annet nettverkspassord, ikke spurt.');
  assert.equal(translator('en')('settings.account.csrOtherNetwork', { devices: '3 devices' }), 'SG Smart: 3 devices, another network password, not asked.');
  // Homes on one password: all asked, none marked, and the line as before.
  const same = makeApp({ homes: [home(LOC_A, null, [0x8101]), home(LOC_B, null, [0x8201])], paired: [0x8101] });
  await run(same.app, same.app.account._check(same.app.account._run));
  assert.deepEqual(same.app.account.summary().homes.map((h) => h.otherNetwork), [false, false]);
  assert.ok(!same.app.logs.find((l) => l.startsWith('[SG account] check:')).includes('another network password'));
});

test('Smart Switches in homes on two network passwords: those in the app\'s home are not asked and are said in the line and on the page; '
  + 'those in the other home are in its "not asked" and not said again', async () => {
  const mine = home(LOC_A, null, [0x8101, 0x8102]);
  mine.devices[1].type = 19; // a Gen2 Smart Switch
  const other = home(LOC_B, PASS_B, [0x8201, 0x8202]);
  other.devices[1].type = 1019; // a Gen3 one
  const { app } = makeApp({ homes: [mine, other], paired: [0x8101] });
  await run(app, app.account._check(app.account._run));
  const ff04 = app.sent.filter((s) => s.data.slice(4, 8) === 'ff04').map((s) => parseInt(s.data.slice(2, 4) + s.data.slice(0, 2), 16));
  assert.deepEqual(ff04, [0x8101], 'only the Pill of the app\'s home');
  const [first, second] = app.account.summary().homes;
  assert.deepEqual([first.otherNetwork, first.total, first.switches, first.quiet.length], [false, 1, 1, 1]);
  assert.deepEqual([second.otherNetwork, second.total, second.switches, second.quiet], [true, 1, 0, []], 'a switch is never in the total');
  const line = app.logs.find((l) => l.startsWith('[SG account] check:'));
  assert.ok(line.startsWith('[SG account] check: 0 of 1 answer, 1 asked, '), line);
  assert.ok(line.includes(', 0 uncertain (not counted), 1 switch(es) not asked, 2 in 1 home(s) on another network password, not asked, 0 SG Smart 3.0 not asked'), line);
  assert.equal(translator('no')('settings.account.switches', { count: 1 }), 'Brytere: 1, ikke spurt.');
  assert.equal(translator('en')('settings.account.switches', { count: 1 }), 'Switches: 1, not asked.');
});

test('FF04 and the Gen4 bytes by the account: only the homes on the app\'s network password count, also with the same mesh id and location id in another home of another type', async () => {
  const ff04 = (app) => app.sent.filter((s) => s.data.slice(4, 8) === 'ff04').map((s) => [parseInt(s.data.slice(2, 4) + s.data.slice(0, 2), 16), s.data.slice(8)]);
  // The same mesh id and location id in both homes: a Gen3 Pill (1004) in the
  // one on 1234, a Gen4 one (2013) in the one on another password. And a mesh
  // id only in the other home, as Gen4.
  const homes = () => [home(LOC_A, null, [0x8301, 0x8101], 1004), home(LOC_A, PASS_B, [0x8301, 0x8302, 0x8201], 2013)];
  // The app on 1234 (a device of the first home added): 0x8301 is the Pill,
  // and 0x8302 is not in a home it speaks with.
  const one = makeApp({ homes: homes(), paired: [0x8101] });
  await one.app.csr.requestStatus(0x8301, LOC_A);
  await one.app.csr.requestStatus(0x8302, LOC_A);
  assert.deepEqual(ff04(one.app), [[0x8301, '5a3c'], [0x8302, '5a3c']]);
  // The app on the other password: 0x8301 is the Gen4 device there.
  const other = makeApp({ homes: homes(), paired: [0x8201], keyOf: () => KEY_B });
  await other.app.csr.requestStatus(0x8301, LOC_A);
  assert.deepEqual(ff04(other.app), [[0x8301, '5a3c0000']]);
  one.app.csr.stop();
  other.app.csr.stop();
});
