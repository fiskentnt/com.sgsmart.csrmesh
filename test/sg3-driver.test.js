'use strict';

// LEDDim Smart 3.0 (drivers/sg3_dimmer): the SG Smart 3.0 dimmers, listed
// from the SG account alone. No scan and no pause of a link while pairing;
// an error in the list says why there is nothing to add. Its guide says to
// log in while no account is fetched, and to fetch again after new dimmers
// once one is. No settings. Texts as Trond worded them (2026-11-06).
// Made-up home key and names.

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

// An account: fetched or not, with these 3.0 dimmers in its network (none:
// no 3.0 network).
function accountWith({ fetched = true, dimmers = null, fetchAgain = false } = {}) {
  return {
    fetched: () => fetched,
    sg3Network: () => (dimmers ? { homeKey: HOME_KEY, devices: dimmers } : null),
    sg3FetchAgain: () => fetchAgain,
  };
}

// The driver with that account and these devices added, and what a pairing
// touched.
async function pairing(account, addedIds = []) {
  const touched = { discover: 0, pauses: 0 };
  const app = {
    account,
    bridge: { pauseForScan: async () => { touched.pauses += 1; return () => {}; } },
    sg3PauseForScan: async () => { touched.pauses += 1; return () => {}; },
  };
  const homey = fake.fakeHomey(app, { ble: { discover: async () => { touched.discover += 1; return []; } } });
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
  assert.deepEqual(touched, { discover: 0, pauses: 0 }, 'no scan and no pause');
  assert.ok(driver.logs.includes('pair: SG Smart 3.0: 2 dimmer(s) in the SG account, 1 already added'), driver.logs.join('\n'));
});

test('the list says why there is nothing: no account fetched, no LEDDim Smart 3.0 in it, or all added', async () => {
  const cases = [
    [accountWith({ fetched: false, dimmers: DIMMERS }), [], 'pair.sg3.loginFirst'],
    [null, [], 'pair.sg3.loginFirst'],
    [accountWith({ dimmers: null }), [], 'pair.sg3.none'],
    [accountWith({ dimmers: DIMMERS }), [`sig:${HOME_KEY}:0003`, `sig:${HOME_KEY}:0004`], 'pair.sg3.allAdded'],
  ];
  for (const [account, added, key] of cases) {
    const { session, touched } = await pairing(account, added);
    await assert.rejects(session.handlers.list_devices(), { message: key });
    assert.deepEqual(touched, { discover: 0, pauses: 0 });
  }
});

test('an account fetched before 2.8.0 (no home key): the list asks for "Fetch again", not "none found"', async () => {
  const { session, touched } = await pairing(accountWith({ dimmers: null, fetchAgain: true }));
  await assert.rejects(session.handlers.list_devices(), { message: 'pair.sg3Guide.fetchAgain' });
  assert.deepEqual(touched, { discover: 0, pauses: 0 });
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
  const app = { log() {}, error() {}, _devices: () => [], recentlyHeard: () => false, csr: { nodes: new Map(), requestStatus: async () => true } };
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

test('the guide is told whether an SG account is fetched', async () => {
  assert.deepEqual(await (await pairing(accountWith())).session.handlers.account(), { fetched: true });
  assert.deepEqual(await (await pairing(accountWith({ fetched: false }))).session.handlers.account(), { fetched: false });
  assert.deepEqual(await (await pairing(null)).session.handlers.account(), { fetched: false });
  const throwing = { fetched: () => { throw new Error('made-up'); } };
  assert.deepEqual(await (await pairing(throwing)).session.handlers.account(), { fetched: false });
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

test('the texts, as Trond worded them (2026-11-06)', () => {
  assert.deepEqual(no.pair.sg3Guide, {
    title: 'LEDDim Smart 3.0',
    addFirst: 'Legg til nye dimmere i SG-appen først.',
    loginFirst: 'Trykk "Logg inn og hent" i innstillingene til SG LEDDim.',
    fetchAgain: 'Trykk "Hent på nytt" i innstillingene til SG LEDDim.',
    closeApp: 'Lukk SG-appen på telefonen.',
  });
  assert.deepEqual(en.pair.sg3Guide, {
    title: 'LEDDim Smart 3.0',
    addFirst: 'Add new dimmers in the SG app first.',
    loginFirst: 'Tap "Log in and fetch" in the SG LEDDim settings.',
    fetchAgain: 'Tap "Fetch again" in the SG LEDDim settings.',
    closeApp: 'Close the SG app on your phone.',
  });
  // Point 2 names the buttons as the settings page has them, in both languages.
  for (const locale of [no, en]) {
    assert.ok(locale.pair.sg3Guide.loginFirst.includes(`"${locale.settings.account.fetch}"`), locale.settings.account.fetch);
    assert.ok(locale.pair.sg3Guide.fetchAgain.includes(`"${locale.settings.account.refetch}"`), locale.settings.account.refetch);
  }
  assert.deepEqual(no.pair.sg3, {
    loginFirst: 'Logg inn med SG-kontoen i innstillingene til SG LEDDim først.',
    none: 'Fant ingen LEDDim Smart 3.0 i SG-kontoen.',
    allAdded: 'Alle LEDDim Smart 3.0 i SG-kontoen er allerede lagt til.',
  });
  assert.deepEqual(en.pair.sg3, {
    loginFirst: 'Log in with your SG account in the SG LEDDim settings first.',
    none: 'No LEDDim Smart 3.0 devices found in your SG account.',
    allAdded: 'All LEDDim Smart 3.0 devices in your SG account have already been added.',
  });
  assert.equal(no.settings.account.sg3Ready, 'SG Smart 3.0: __devices__. Legges til under LEDDim Smart 3.0.');
  assert.equal(en.settings.account.sg3Ready, 'SG Smart 3.0: __devices__. Added under LEDDim Smart 3.0.');
  // Gone with the CSRmesh settings and the 3.0 point in the shared guide.
  assert.equal(no.device.sg3SettingsFixed, undefined);
  assert.equal(en.device.sg3SettingsFixed, undefined);
  assert.equal(no.pair.guide.loginFirst, undefined);
  assert.equal(en.pair.guide.loginFirst, undefined);
});

test('the guide: point 1 says to add new dimmers in the SG app first; point 2 names "Log in and fetch" until the account is known to be fetched, then "Fetch again"; point 3 to close the SG app', () => {
  const guide = read('drivers/sg3_dimmer/pair/guide.html');
  assert.match(guide, /data-step="addFirst"[\s\S]*data-step="account"[\s\S]*data-step="closeApp"/);
  assert.ok(guide.includes("Homey.__('pair.sg3Guide.addFirst')"));
  assert.ok(guide.includes("account.textContent = Homey.__('pair.sg3Guide.loginFirst');"));
  assert.ok(guide.includes("if (answer && answer.fetched === true) account.textContent = Homey.__('pair.sg3Guide.fetchAgain');"));
  assert.ok(guide.includes("Homey.__('pair.sg3Guide.closeApp')"));
  assert.ok(guide.includes("Homey.setTitle(Homey.__('pair.sg3Guide.title'))"));
  assert.doesNotMatch(guide, /pair\.guide\./, 'none of the shared guide\'s texts');
});
