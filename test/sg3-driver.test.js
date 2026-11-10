'use strict';

// LEDDim Smart 3.0 (drivers/sg3_dimmer): the SG Smart 3.0 dimmers, listed
// from the SG account and from a scan for those it does not have (with the
// links let go meanwhile); an error in the list says why there is nothing to
// add. Every pairing scans before it looks at the account (2.9.0), and logs
// one line about the 3.0 nodes in the scan (lib/makerData.js); a node of a
// type not known here is never listed. Its guide says to
// log in while no account is fetched, and to fetch again after new dimmers
// once one is. No settings. Texts as Trond worded them (2026-11-06).
// Made-up home key, names and advertisements; the specification's sample
// network key.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const fake = require('./helpers/fake-homey');

fake.install();

const SG3Driver = require('../drivers/sg3_dimmer/driver');
const SG3Device = require('../lib/SG3Device');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const no = JSON.parse(read('locales/no.json'));
const en = JSON.parse(read('locales/en.json'));
const HOME_KEY = '0a1b2c3d4e5f';
const NET_KEY = '7dd7364cd842ad18c17c2b820c84c3d6';
const { NETWORK_ID } = require('./sg3/fake-homey');

// An advertisement of a 3.0 node: the proxy service with a Network ID, and
// made-up manufacturer data with the address at 8 (low byte first) and the
// type byte at 18.
function nodeAdvert(address, { typeByte = 0xa5, networkId = NETWORK_ID } = {}) {
  const data = Buffer.alloc(29, 0x5a);
  data.writeUInt16LE(0x0ee8, 0);
  data.writeUInt16LE(address, 8);
  data[18] = typeByte;
  return {
    uuid: `made-up-${address}`,
    serviceData: [{ uuid: '00001828-0000-1000-8000-00805f9b34fb', data: Buffer.concat([Buffer.from([0x00]), Buffer.from(networkId, 'hex')]) }],
    manufacturerData: data,
  };
}

// An account: fetched or not, with these 3.0 dimmers in its network (none:
// no 3.0 network).
function accountWith({ fetched = true, dimmers = null, fetchAgain = false } = {}) {
  return {
    fetched: () => fetched,
    sg3Network: () => (dimmers ? { homeKey: HOME_KEY, netKey: NET_KEY, devices: dimmers } : null),
    sg3FetchAgain: () => fetchAgain,
  };
}

// The driver with that account and these devices added, a scan that finds
// adverts (or throws it, an Error), and what a pairing touched: scans,
// pauses begun and ended.
async function pairing(account, addedIds = [], adverts = []) {
  const touched = { discover: 0, pauses: 0, ended: 0 };
  const app = {
    account,
    bridge: { pauseForScan: async () => { touched.pauses += 1; return () => { touched.ended += 1; }; } },
    sg3PauseForScan: async () => { touched.pauses += 1; return () => { touched.ended += 1; }; },
  };
  const discover = async () => {
    touched.discover += 1;
    if (adverts instanceof Error) throw adverts;
    return adverts;
  };
  const homey = fake.fakeHomey(app, { ble: { discover } });
  const driver = new SG3Driver({ homey });
  driver.getDevices = () => addedIds.map((id) => ({ getData: () => ({ id }) }));
  const session = { handlers: {}, setHandler(name, handler) { this.handlers[name] = handler; } };
  await driver.onPair(session);
  return { driver, session, touched };
}

const DIMMERS = [{ meshId: 0x0003, type: 3080, name: 'Made-up stue' }, { meshId: 0x0004, type: 3081, name: null }];

test('the list: the account\'s 3.0 dimmers not yet added, with the signal and the link, and no settings', async () => {
  const { session, touched, driver } = await pairing(accountWith({ dimmers: DIMMERS }), [`sig:${HOME_KEY}:0004`]);
  assert.deepEqual(await session.handlers.list_devices(), [{
    name: 'Made-up stue',
    data: { id: `sig:${HOME_KEY}:0003` },
    capabilities: ['onoff', 'dim', 'measure_signal_strength', 'sg_connection'],
    capabilitiesOptions: { measure_signal_strength: { title: { en: 'Signal to Homey', no: 'Signal til Homey' } } },
    store: { sg3Type: 3080 },
  }]);
  assert.deepEqual(touched, { discover: 1, pauses: 2, ended: 2 }, 'one scan, both links let go and back');
  assert.ok(driver.logs.includes('pair: SG Smart 3.0: 2 dimmer(s) in the SG account, 0 more found in the scan, 1 already added'),
    driver.logs.join('\n'));
});

test('the list says why there is nothing: no account fetched, no LEDDim Smart 3.0 in it, or all added; every pairing scans first', async () => {
  // With or without an account and kept keys, the scan comes first (2.9.0).
  const cases = [
    [accountWith({ fetched: false, dimmers: DIMMERS }), [], 'pair.sg3.loginFirst'],
    [null, [], 'pair.sg3.loginFirst'],
    [accountWith({ dimmers: null }), [], 'pair.sg3.none'],
    [accountWith({ dimmers: [] }), [], 'pair.sg3.none'],
    [accountWith({ dimmers: DIMMERS }), [`sig:${HOME_KEY}:0003`, `sig:${HOME_KEY}:0004`], 'pair.sg3.allAdded'],
  ];
  for (const [account, added, key] of cases) {
    const { session, touched } = await pairing(account, added);
    await assert.rejects(session.handlers.list_devices(), { message: key });
    assert.deepEqual(touched, { discover: 1, pauses: 2, ended: 2 }, key);
  }
});

test('the scan comes before the account: without one, or without a 3.0 network, it still scans and logs the 3.0 nodes it saw, then says why', async () => {
  const adverts = [
    nodeAdvert(0x0005),
    nodeAdvert(0x0006, { typeByte: 0x42 }),
    nodeAdvert(0x0007, { networkId: '0011223344556677' }),
    { uuid: 'made-up-other', serviceData: [], manufacturerData: Buffer.from([0x4c, 0x00, 1, 2]) },
  ];
  const nodes = 'pair: SG Smart 3.0 nodes in the scan (whether they are in this home is not known): '
    + '2 with 29 bytes and byte 18 0xa5, 1 with 29 bytes and byte 18 0x42';
  const cases = [
    [null, 'pair.sg3.loginFirst'],
    [accountWith({ fetched: false, dimmers: DIMMERS }), 'pair.sg3.loginFirst'],
    [accountWith({ dimmers: null }), 'pair.sg3.none'],
    [accountWith({ dimmers: null, fetchAgain: true }), 'pair.sg3Guide.fetchAgain'],
  ];
  for (const [account, key] of cases) {
    const { session, touched, driver } = await pairing(account, [], adverts);
    let scanned = null;
    await assert.rejects(session.handlers.list_devices().finally(() => { scanned = touched.discover; }), { message: key });
    assert.equal(scanned, 1, `${key}: scanned before the error`);
    assert.deepEqual(touched, { discover: 1, pauses: 2, ended: 2 }, key);
    assert.ok(driver.logs.some((line) => /^pair: SG Smart 3\.0 scan \d+\.\d s: 4 advert\(s\), no 3\.0 network kept$/.test(line)),
      `${key}\n${driver.logs.join('\n')}`);
    assert.ok(driver.logs.includes(nodes), `${key}\n${driver.logs.join('\n')}`);
    for (const line of driver.logs) assert.doesNotMatch(line, /0x000[5-7]|made-up-/, 'no addresses or ids in the log');
  }
  // A scan that fails: no line about the nodes, and the account's answer as before.
  const failing = await pairing(null, [], new Error('made-up: Bluetooth busy'));
  await assert.rejects(failing.session.handlers.list_devices(), { message: 'pair.sg3.loginFirst' });
  assert.ok(failing.driver.logs.includes('pair: SG Smart 3.0 scan failed (made-up: Bluetooth busy)'), failing.driver.logs.join('\n'));
  assert.ok(!failing.driver.logs.some((line) => line.includes('nodes in the scan')), failing.driver.logs.join('\n'));
  // A scan that gives nothing at all.
  const empty = await pairing(null, [], []);
  empty.driver.homey.app.bleDiscover = async () => undefined;
  await assert.rejects(empty.session.handlers.list_devices(), { message: 'pair.sg3.loginFirst' });
  assert.ok(empty.driver.logs.includes('pair: SG Smart 3.0 nodes in the scan: none'), empty.driver.logs.join('\n'));
});

test('a 3.0 node of a type not known here is never listed: not with the keys kept, and not without them', async () => {
  const unknown = [nodeAdvert(0x0006, { typeByte: 0x42 }), nodeAdvert(0x0009, { typeByte: 0x00 })];
  const kept = await pairing(accountWith({ dimmers: [] }), [], unknown);
  await assert.rejects(kept.session.handlers.list_devices(), { message: 'pair.sg3.none' });
  assert.ok(kept.driver.logs.includes('pair: SG Smart 3.0: 0 dimmer(s) in the SG account, 0 more found in the scan, '
    + '2 of a type not known here left out, 0 already added'), kept.driver.logs.join('\n'));
  const withDimmers = await pairing(accountWith({ dimmers: DIMMERS }), [], unknown);
  assert.deepEqual((await withDimmers.session.handlers.list_devices()).map((device) => device.data.id),
    [`sig:${HOME_KEY}:0003`, `sig:${HOME_KEY}:0004`]);
  for (const account of [null, accountWith({ dimmers: null })]) {
    const without = await pairing(account, [], unknown);
    await assert.rejects(without.session.handlers.list_devices());
  }
});

test('the scan adds the dimmers the account does not have: one per address, the account\'s name wins, named "LEDDim Smart 3.0 0005" otherwise', async () => {
  const adverts = [
    nodeAdvert(0x0003), // in the account
    nodeAdvert(0x0006, { typeByte: 0xa6 }),
    nodeAdvert(0x0005),
    nodeAdvert(0x0005), // the same node twice
    nodeAdvert(0x0007, { typeByte: 0x42 }), // a type not known here
    nodeAdvert(0x0008, { networkId: '0011223344556677' }), // another network
    { uuid: 'made-up-other', serviceData: [], manufacturerData: Buffer.from([0x4c, 0x00, 1, 2]) },
  ];
  const { session, driver } = await pairing(accountWith({ dimmers: DIMMERS }), [], adverts);
  const listed = await session.handlers.list_devices();
  assert.deepEqual(listed.map((device) => [device.name, device.data.id, device.store.sg3Type]), [
    ['Made-up stue', `sig:${HOME_KEY}:0003`, 3080],
    ['LEDDim Smart 2-pole 3.0 0004', `sig:${HOME_KEY}:0004`, 3081],
    ['LEDDim Smart 3.0 0005', `sig:${HOME_KEY}:0005`, 3080],
    ['LEDDim Smart 2-pole 3.0 0006', `sig:${HOME_KEY}:0006`, 3081],
  ]);
  assert.deepEqual(listed[2].capabilities, ['onoff', 'dim', 'measure_signal_strength', 'sg_connection']);
  assert.ok(driver.logs.some((line) => /^pair: SG Smart 3\.0 scan \d+\.\d s: 7 advert\(s\), 5 of this network$/.test(line)), driver.logs.join('\n'));
  assert.ok(driver.logs.includes('pair: SG Smart 3.0: 2 dimmer(s) in the SG account, 2 more found in the scan, 1 of a type not known here left out, 0 already added'),
    driver.logs.join('\n'));
  // Every node with data for 0x0EE8 once, of this network or not: 0x0005 twice is one.
  assert.ok(driver.logs.includes('pair: SG Smart 3.0 nodes in the scan (whether they are in this home is not known): '
    + '3 with 29 bytes and byte 18 0xa5, 1 with 29 bytes and byte 18 0x42, 1 with 29 bytes and byte 18 0xa6'), driver.logs.join('\n'));
  for (const line of driver.logs) assert.doesNotMatch(line, /0x000[5-8]|made-up-/, 'no addresses or ids in the log');
  // One added from the scan is left out next time.
  const again = await pairing(accountWith({ dimmers: DIMMERS }), [`sig:${HOME_KEY}:0005`], adverts);
  assert.deepEqual((await again.session.handlers.list_devices()).map((device) => device.data.id),
    [`sig:${HOME_KEY}:0003`, `sig:${HOME_KEY}:0004`, `sig:${HOME_KEY}:0006`]);
});

test('the scan alone, with the keys kept but the dimmer not in the account; a scan that fails leaves the account\'s', async () => {
  const only = await pairing(accountWith({ dimmers: [] }), [], [nodeAdvert(0x0005)]);
  assert.deepEqual((await only.session.handlers.list_devices()).map((device) => device.name), ['LEDDim Smart 3.0 0005']);
  const failing = await pairing(accountWith({ dimmers: DIMMERS }), [], new Error('made-up: Bluetooth busy'));
  assert.deepEqual((await failing.session.handlers.list_devices()).map((device) => device.name), ['Made-up stue', 'LEDDim Smart 2-pole 3.0 0004']);
  assert.ok(failing.driver.logs.includes("pair: SG Smart 3.0 scan failed (made-up: Bluetooth busy): the SG account's dimmers only"),
    failing.driver.logs.join('\n'));
  assert.deepEqual(failing.touched, { discover: 1, pauses: 2, ended: 2 }, 'the links come back also after a failed scan');
  assert.ok(!failing.driver.logs.some((line) => line.includes('nodes in the scan')), 'no line about the nodes without a scan');
  // Through the app's queue of scans when it has one, for the proxy service.
  const queued = await pairing(accountWith({ dimmers: [] }), [], []);
  const asked = [];
  queued.driver.homey.app.bleDiscover = async (...args) => { asked.push(args); return [nodeAdvert(0x0005)]; };
  assert.equal((await queued.session.handlers.list_devices()).length, 1);
  assert.deepEqual(asked, [[['1828']]]);
  assert.equal(queued.touched.discover, 0, 'not straight to Homey');
});

test('an account fetched before 2.8.0 (no home key): the list asks for "Fetch again", not "none found"', async () => {
  const { session, touched } = await pairing(accountWith({ dimmers: null, fetchAgain: true }));
  await assert.rejects(session.handlers.list_devices(), { message: 'pair.sg3Guide.fetchAgain' });
  assert.deepEqual(touched, { discover: 1, pauses: 2, ended: 2 }, 'scanned first');
  // As the account kept from 2.7.0 says it: its keys and a 3.0 dimmer, no home key.
  const { SETTING, SgAccount } = require('../lib/account');
  const kept = {
    fetchedAt: '2026-11-01T10:00:00.000Z',
    check: null,
    homes: [{
      passphrase: null, netKey: '0F1E2D3C4B5A69788796A5B4C3D2E1F0', appKey: 'f0e1d2c3b4a5968778695a4b3c2d1e0f', locationId: null,
      devices: [{ meshId: 0x0003, type: 3080, name: 'Made-up stue', certain: true }],
    }],
  };
  const app = { log() {}, error() {}, _devices: () => [], recentlyHeard: () => false, csr: { nodes: new Map(), queueStatusAll: fake.queueAtOnce() } };
  const values = new Map([[SETTING, kept]]);
  const settings = { get: (k) => (values.has(k) ? values.get(k) : null), set: (k, v) => values.set(k, v), unset: (k) => values.delete(k) };
  app.homey = fake.fakeHomey(app, { settings, __: (key) => key });
  const account = new SgAccount(app, { fetch: async () => { throw new Error('made-up: not used'); } });
  assert.equal(account.sg3Network(), null);
  assert.equal(account.sg3FetchAgain(), true);
  assert.equal(account.summary().homes[0].sg3State, 'fetchAgain', 'as the settings page says');
  const real = await pairing(account);
  await assert.rejects(real.session.handlers.list_devices(), { message: 'pair.sg3Guide.fetchAgain' });
  // Fetched with 2.8.0, or no 3.0 dimmer kept: no "Fetch again".
  kept.homes[0].devices = [{ meshId: 0x0003, type: 101, name: null, certain: true }];
  const withoutSg3 = new SgAccount(app, { fetch: async () => { throw new Error('made-up: not used'); } });
  assert.equal(withoutSg3.sg3FetchAgain(), false);
  const none = await pairing(withoutSg3);
  await assert.rejects(none.session.handlers.list_devices(), { message: 'pair.sg3.none' });
});

test('the guide is told whether an SG account is fetched, and whether its 3.0 keys are kept', async () => {
  assert.deepEqual(await (await pairing(accountWith({ dimmers: DIMMERS }))).session.handlers.account(), { fetched: true, keys: true });
  assert.deepEqual(await (await pairing(accountWith({ dimmers: [] }))).session.handlers.account(), { fetched: true, keys: true });
  assert.deepEqual(await (await pairing(accountWith())).session.handlers.account(), { fetched: true, keys: false });
  assert.deepEqual(await (await pairing(accountWith({ fetched: false, dimmers: DIMMERS }))).session.handlers.account(), { fetched: false, keys: false });
  assert.deepEqual(await (await pairing(null)).session.handlers.account(), { fetched: false, keys: false });
  const throwing = { fetched: () => { throw new Error('made-up'); } };
  assert.deepEqual(await (await pairing(throwing)).session.handlers.account(), { fetched: false, keys: false });
});

test('the manifest: LEDDim Smart 3.0, a light with the signal and the link, the guide and the list, no settings, its own assets', () => {
  const manifest = JSON.parse(read('drivers/sg3_dimmer/driver.compose.json'));
  assert.deepEqual(manifest.name, { en: 'LEDDim Smart 3.0', no: 'LEDDim Smart 3.0' });
  assert.equal(manifest.class, 'light');
  assert.deepEqual(manifest.capabilities, ['onoff', 'dim', 'measure_signal_strength', 'sg_connection']);
  assert.deepEqual(manifest.pair.map((view) => view.id), ['guide', 'list_devices', 'add_devices']);
  assert.equal(manifest.settings, undefined);
  assert.ok(!fs.existsSync(path.join(ROOT, 'drivers/sg3_dimmer/driver.settings.compose.json')));
  for (const file of ['assets/icon.svg', 'assets/images/small.png', 'assets/images/large.png', 'assets/images/xlarge.png', 'assets/guide/guide.png']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'drivers/sg3_dimmer', file)), file);
  }
  assert.equal(require('../drivers/sg3_dimmer/device'), SG3Device);
  // The device has no onSettings of its own: nothing to refuse.
  assert.equal(Object.prototype.hasOwnProperty.call(SG3Device.prototype, 'onSettings'), false);
  const app = JSON.parse(read('app.json'));
  const built = app.drivers.find((driver) => driver.id === 'sg3_dimmer');
  assert.ok(built, 'in app.json');
  assert.equal(built.settings, undefined);
});

test('the texts, as Trond worded them (2026-11-06; the scan\'s 2026-11-08)', () => {
  assert.deepEqual(no.pair.sg3Guide, {
    title: 'LEDDim Smart 3.0',
    addFirst: 'Legg til nye dimmere i SG-appen først.',
    loginFirst: 'Trykk "Logg inn og hent" i innstillingene til SG LEDDim.',
    fetchAgain: 'Trykk "Hent på nytt" i innstillingene til SG LEDDim.',
    closeApp: 'Lukk SG-appen på telefonen.',
    near: 'Ha Homey nær dimmerne. Søket tar rundt 10 sekunder.',
    names: 'Vil du ha navnene fra SG-appen? Trykk "Hent på nytt" i innstillingene til SG LEDDim først.',
  });
  assert.deepEqual(en.pair.sg3Guide, {
    title: 'LEDDim Smart 3.0',
    addFirst: 'Add new dimmers in the SG app first.',
    loginFirst: 'Tap "Log in and fetch" in the SG LEDDim settings.',
    fetchAgain: 'Tap "Fetch again" in the SG LEDDim settings.',
    closeApp: 'Close the SG app on your phone.',
    near: 'Keep Homey close to the dimmers. The search takes about 10 seconds.',
    names: 'Want the names from the SG app? Tap "Fetch again" in the SG LEDDim settings first.',
  });
  // Point 2 names the buttons as the settings page has them, in both languages.
  for (const locale of [no, en]) {
    assert.ok(locale.pair.sg3Guide.loginFirst.includes(`"${locale.settings.account.fetch}"`), locale.settings.account.fetch);
    assert.ok(locale.pair.sg3Guide.fetchAgain.includes(`"${locale.settings.account.refetch}"`), locale.settings.account.refetch);
    assert.ok(locale.pair.sg3Guide.names.includes(`"${locale.settings.account.refetch}"`), locale.settings.account.refetch);
  }
  assert.deepEqual(no.pair.sg3, {
    loginFirst: 'Logg inn med SG-kontoen i innstillingene til SG LEDDim først.',
    none: 'Fant ingen LEDDim Smart 3.0. Lukk SG-appen på telefonen. Prøv igjen nærmere en dimmer.',
    allAdded: 'Alle LEDDim Smart 3.0 som ble funnet, er allerede lagt til.',
  });
  assert.deepEqual(en.pair.sg3, {
    loginFirst: 'Log in with your SG account in the SG LEDDim settings first.',
    none: 'No LEDDim Smart 3.0 found. Close the SG app on your phone. Try again closer to a dimmer.',
    allAdded: 'All LEDDim Smart 3.0 devices found have already been added.',
  });
  assert.equal(no.settings.account.sg3Ready, 'SG Smart 3.0: __devices__. Legges til under LEDDim Smart 3.0.');
  assert.equal(en.settings.account.sg3Ready, 'SG Smart 3.0: __devices__. Added under LEDDim Smart 3.0.');
  // Gone with the CSRmesh settings and the 3.0 point in the shared guide.
  assert.equal(no.device.sg3SettingsFixed, undefined);
  assert.equal(en.device.sg3SettingsFixed, undefined);
  assert.equal(no.pair.guide.loginFirst, undefined);
  assert.equal(en.pair.guide.loginFirst, undefined);
});

test('the guide: with the keys kept, add first, close the SG app, Homey close (10 s), and the names; otherwise "Log in and fetch" or "Fetch again" as point 2', () => {
  const guide = read('drivers/sg3_dimmer/pair/guide.html');
  assert.match(guide, /data-step="addFirst"[\s\S]*data-step="account"[\s\S]*data-step="closeApp"[\s\S]*data-step="near" hidden[\s\S]*data-step="names" hidden/);
  assert.ok(guide.includes('.sg-steps li[hidden] { display: none; }'), 'a hidden point takes no number');
  assert.ok(guide.includes("Homey.__('pair.sg3Guide.addFirst')"));
  assert.ok(guide.includes("account.textContent = Homey.__('pair.sg3Guide.loginFirst');"));
  assert.ok(guide.includes("near.textContent = Homey.__('pair.sg3Guide.near');"));
  assert.ok(guide.includes("names.textContent = Homey.__('pair.sg3Guide.names');"));
  assert.match(guide, /if \(answer && answer\.keys === true\) \{\s*account\.hidden = true;\s*near\.hidden = false;\s*names\.hidden = false;/);
  assert.match(guide, /\} else if \(answer && answer\.fetched === true\) \{\s*account\.textContent = Homey\.__\('pair\.sg3Guide\.fetchAgain'\);/);
  assert.ok(guide.includes("Homey.__('pair.sg3Guide.closeApp')"));
  assert.ok(guide.includes("Homey.setTitle(Homey.__('pair.sg3Guide.title'))"));
  assert.doesNotMatch(guide, /pair\.guide\./, 'none of the shared guide\'s texts');
});
