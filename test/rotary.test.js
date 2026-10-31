'use strict';

// LEDDim Smart, the rotary dimmer, in one driver (sg_mesh, 2.5.0): the first
// generation (@ND, the mesh id in the name) as before, and the later
// generations as a trial, which need an FF11 answer for their mesh id.
// onMapDeviceClass gives each device its class from data.id. A home with
// first generation dimmers only gets no FF10 from the search. It pairs as
// sg_pill does: the guide, Homey's loading view, the list. Made-up ids and
// location ids. Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fake = require('./helpers/fake-homey');

fake.install();

const {
  CSR_PRODUCTS, PILL_PREFIXES, ROTARY_PREFIXES, csrDriverFor, csrProductForName,
} = require('../lib/sgProducts');
const SGMeshDevice = require('../lib/SGDeviceBase');
const SGCsrDevice = require('../lib/SGCsrDevice');
const SGMeshDriver = require('../drivers/sg_mesh/driver');
const SGPillDriver = require('../drivers/sg_pill/driver');
const { FF10_WITHIN_MS } = require('../lib/csrPairing');
const { SEARCH_LISTEN_MS } = require('../lib/CsrNetwork');
const SGSmartApp = require('../app');

const LOC = 0x5a3c;
// Translations show their key, and their tokens when they have any.
const __ = (key, tokens) => (tokens ? `${key} ${JSON.stringify(tokens)}` : key);

const node = (meshId, name) => ({ meshId, name, product: csrProductForName(name), location: LOC });
const adv = (uuid, localName, rssi = -60) => ({ uuid, localName, rssi, connectable: true });

// sg_mesh with this scan and these FF11 answers (lib/csrPairing.js,
// laterNodes, as in sg_pill); the name requests are counted in names.
function meshDriver(advertisements, nodes = [], added = []) {
  const app = { csr: fake.fakeCsr(nodes) };
  Object.defineProperty(app, 'names', { get: () => app.csr.sent });
  const homey = fake.listenAtOnce(fake.fakeHomey(app, { ble: { discover: async () => advertisements } }));
  const driver = new SGMeshDriver({ homey });
  driver.homey.__ = __;
  driver.getDevices = () => added.map((id) => ({ getData: () => ({ id }) }));
  return { app, driver };
}

// A pair session as far as onPair uses it: handlers, and the step to the next view.
function pairSession() {
  const session = { handlers: {}, views: [] };
  session.setHandler = (name, handler) => { session.handlers[name] = handler; };
  session.showView = async (view) => { session.views.push(view); };
  return session;
}

// The list after Homey's loading view, as the user gets it: the devices, or
// the one text it throws.
async function pairList(driver) {
  const session = pairSession();
  await driver.onPair(session);
  await session.handlers.showView('loading');
  return session.handlers.list_devices();
}

test('rotary dimmers: 12 prefixes, Gen2 to Gen4, all dimmable, none a Pill; sg_mesh adds them', () => {
  assert.equal(ROTARY_PREFIXES.length, 12);
  assert.equal(new Set(ROTARY_PREFIXES).size, 12);
  for (const prefix of ROTARY_PREFIXES) {
    const product = csrProductForName(`${prefix}0000`);
    assert.equal(product.kind, 'dimmable', prefix);
    assert.equal(product.form, 'rotary', prefix);
    assert.match(product.name, /^(TW )?LEDDim Smart( Master| 400 2-pole)?$/, prefix);
    assert.ok(!PILL_PREFIXES.includes(prefix), prefix);
    assert.equal(csrDriverFor(product), 'sg_mesh', prefix);
  }
  for (const prefix of Object.keys(CSR_PRODUCTS)) {
    const expected = ROTARY_PREFIXES.includes(prefix) ? 'sg_mesh' : (PILL_PREFIXES.includes(prefix) ? 'sg_pill' : null);
    assert.equal(csrDriverFor(csrProductForName(`${prefix}0000`)), expected, prefix);
  }
});

test('onMapDeviceClass: @ND and anything else the first generation class, a later rotary dimmer the other, never an error', () => {
  const driver = new SGMeshDriver({ homey: fake.fakeHomey({}) });
  const classFor = (data) => driver.onMapDeviceClass({ getData: () => data });
  for (const id of ['@ND1A2B', '@ND1A2B3', '@nd1a2b', '@ND0000']) assert.equal(classFor({ id }), SGMeshDevice, id);
  for (const prefix of ROTARY_PREFIXES) assert.equal(classFor({ id: `${prefix}1A2B` }), SGCsrDevice, prefix);
  for (const data of [{ id: '@SC1A2B' }, { id: '@GY1A2B' }, { id: '' }, { id: 42 }, {}, null, undefined, { id: { a: 1 } }]) {
    assert.equal(classFor(data), SGMeshDevice, JSON.stringify(data));
  }
  assert.equal(driver.onMapDeviceClass({ getData: () => { throw new Error('gone'); } }), SGMeshDevice);
  assert.equal(driver.onMapDeviceClass(null), SGMeshDevice);
});

test('first generation dimmers only: no FF10, and the list as before, named "LEDDim Smart 1A2B"', async () => {
  const nameless = { uuid: 'z', localName: '', rssi: -70, connectable: true, serviceData: [{ uuid: '02fa', data: Buffer.from([0x10]) }] };
  const { app, driver } = meshDriver([adv('a', '@ND1A2B', -60), adv('b', '@ND3C4D', -50), nameless]);
  const { devices, reason, note } = await driver._search();
  assert.equal(app.names, 0, 'no FF10');
  assert.equal(reason, null);
  assert.equal(note, '');
  assert.deepEqual(devices, [
    { name: 'LEDDim Smart 3C4D', data: { id: '@ND3C4D' }, store: { peripheralUuid: 'b', address: '', localName: '@ND3C4D' } },
    { name: 'LEDDim Smart 1A2B', data: { id: '@ND1A2B' }, store: { peripheralUuid: 'a', address: '', localName: '@ND1A2B' } },
  ]);
  assert.ok(!driver.logs.some((line) => line.includes('after Gen1')));
  assert.equal(driver.homey.pending.size, 0);

  const none = meshDriver([nameless]);
  assert.deepEqual(await none.driver._search(), { devices: [], reason: 'none', note: '' });
  assert.equal(none.app.names, 0);
  const added = meshDriver([adv('a', '@ND1A2B')], [], ['@ND1A2B']);
  assert.equal((await added.driver._search()).reason, 'allAdded');
  assert.equal(added.app.names, 0);
});

test('a later rotary dimmer in the scan: one FF10, and one that answered is listed next to the first generation', async () => {
  const { app, driver } = meshDriver(
    [adv('a', '@ND1A2B'), adv('b', '@GD3C4D'), adv('c', '@SW5E6F'), adv('d', '@SC7A8B'), adv('e', '@GR9C0D')],
    [node(0x0124, '@GD3C4D'), node(0x0126, '@SC7A8B'), node(0x0127, '@GR9C0D')],
  );
  const { devices, reason, note } = await driver._search();
  assert.equal(app.names, 1);
  assert.equal(reason, null);
  assert.deepEqual(devices.map((d) => d.data.id), ['@ND1A2B', '@GD3C4D']);
  assert.deepEqual(devices[1], {
    name: 'LEDDim Smart 3C4D',
    data: { id: '@GD3C4D' },
    capabilities: ['onoff', 'dim'],
    store: { meshId: 0x0124, prefix: '@GD', kind: 'dimmable', tunableWhite: false, locationId: LOC },
  });
  assert.equal(note, '', 'with a dimmer found, the other products are in the log only');
  assert.ok(driver.logs.some((line) => line === 'pair: 3 FF11 answer(s), 4 SG device(s) after Gen1: '
    + '@GD Gen4 dimmable add; @SW Gen3 dimmable noAnswer; @SC Gen3 dimmable elsewhere; @GR Gen4 dimmable notYet'));
  assert.ok(!driver.logs.some((line) => /1A2B|3C4D|5E6F|7A8B|9C0D/.test(line.replace(/02FA [0-9a-f]+/g, ''))));
  assert.equal(driver.homey.pending.size, 0, 'the time limit is cleared');
});

// A bridge pause that records itself in steps: its start, and each end with why.
const recordPause = (steps) => ({
  pauseForScan: async (label) => {
    steps.push(`pause ${label}`);
    return (why) => steps.push(`end ${why}`);
  },
});

// Enough turns for a search with its pause to get as far as it can.
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise(setImmediate);
};

test('sg_mesh: the held link and the status poll wait from before the scan until the list is answered, also when it fails', async () => {
  for (const fails of [false, true]) {
    const steps = [];
    const { app, driver } = meshDriver([]);
    driver.homey.ble.discover = async () => {
      steps.push('scan');
      if (fails) throw new Error('radio busy');
      return [{ uuid: 'a', localName: '@ND1A2B', rssi: -60, serviceUuids: ['fef1'] }];
    };
    app.bridge = recordPause(steps);
    const session = pairSession();
    await driver.onPair(session);
    await session.handlers.showView('loading');
    assert.deepEqual(steps, ['pause pairing scan', 'scan'], 'not over with the scan');
    if (fails) await assert.rejects(session.handlers.list_devices(), { message: 'pair.csr.failed' });
    else assert.deepEqual((await session.handlers.list_devices()).map((d) => d.data.id), ['@ND1A2B']);
    assert.deepEqual(steps, ['pause pairing scan', 'scan', 'end list answered']);
  }
});

test('sg_mesh: the loading view again, the newer search takes its pause before the older one ends', async () => {
  const steps = [];
  const { app, driver } = meshDriver([adv('a', '@ND1A2B')]);
  const discover = driver.homey.ble.discover;
  driver.homey.ble.discover = async () => { steps.push('scan'); return discover(); };
  app.bridge = recordPause(steps);
  const session = pairSession();
  await driver.onPair(session);
  await session.handlers.showView('loading');
  await session.handlers.showView('loading');
  assert.deepEqual(steps, ['pause pairing scan', 'scan', 'pause pairing scan', 'end a newer search', 'scan']);
  assert.equal((await session.handlers.list_devices()).length, 1);
  assert.deepEqual(steps.slice(-1), ['end list answered']);
});

test('sg_mesh: closed during the scan, the pause ends when the scan is over, not before', async () => {
  const steps = [];
  const { app, driver } = meshDriver([]);
  let scanDone;
  driver.homey.ble.discover = () => {
    steps.push('scan');
    return new Promise((resolve) => { scanDone = resolve; });
  };
  app.bridge = recordPause(steps);
  const session = pairSession();
  await driver.onPair(session);
  const loading = session.handlers.showView('loading');
  await settle();
  assert.deepEqual(steps, ['pause pairing scan', 'scan']);
  await session.handlers.disconnect();
  assert.ok(driver.logs.includes('pair: closed'));
  await settle();
  assert.deepEqual(steps, ['pause pairing scan', 'scan'], 'not while the scan runs');
  scanDone([adv('a', '@ND1A2B')]);
  await loading;
  await settle();
  assert.deepEqual(steps, ['pause pairing scan', 'scan', 'end pairing closed']);
});

test('sg_mesh pairs as sg_pill does: the guide, Homey\'s loading view, which moves on by itself, and the list', async () => {
  const pair = (driver) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'drivers', driver, 'driver.compose.json'), 'utf8')).pair;
  const steps = (driver) => pair(driver).map(({ options, ...step }) => step);
  assert.deepEqual(steps('sg_mesh'), steps('sg_pill'));
  assert.equal(pair('sg_mesh')[0].options, undefined);
  assert.deepEqual(pair('sg_pill')[0].options, { duration: 'durationPill' }, 'only the Pill guide has its own duration');
  assert.deepEqual(pair('sg_mesh').map((step) => [step.id, step.template, step.navigation]), [
    ['guide', undefined, { next: 'loading' }],
    ['loading', 'loading', { next: 'list_devices' }],
    ['list_devices', 'list_devices', { prev: 'guide', next: 'add_devices' }],
    ['add_devices', 'add_devices', undefined],
  ]);
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'drivers', 'sg_mesh', 'pair', 'search.html')));

  const { app, driver } = meshDriver([adv('a', '@ND1A2B')]);
  const session = pairSession();
  await driver.onPair(session);
  assert.deepEqual(Object.keys(session.handlers).sort(), ['disconnect', 'list_devices', 'showView']);
  await session.handlers.showView('guide');
  await session.handlers.showView('loading');
  assert.deepEqual(session.views, ['list_devices'], 'the list by name, not nextView');
  assert.deepEqual((await session.handlers.list_devices()).map((d) => d.data.id), ['@ND1A2B']);
  assert.equal(app.names, 0, 'still no FF10 for the first generation only');
  assert.deepEqual(driver.logs.filter((line) => /^pair: (showView|to the list|list_devices)/.test(line)), [
    'pair: showView guide', 'pair: showView loading', 'pair: to the list', 'pair: to the list done',
    'pair: list_devices', 'pair: list_devices: 1 device(s)',
  ]);
  assert.equal(driver.homey.pending.size, 0, 'the time limit is cleared');
});

test('sg_mesh: a failed scan moves on too, and the list says "Search failed"', async () => {
  const app = { csr: { search: async () => [] } };
  const driver = new SGMeshDriver({
    homey: fake.fakeHomey(app, { ble: { discover: async () => { throw new Error('radio busy'); } } }),
  });
  driver.homey.__ = __;
  driver.getDevices = () => [];
  const session = pairSession();
  await driver.onPair(session);
  await session.handlers.showView('loading');
  assert.deepEqual(session.views, ['list_devices']);
  await assert.rejects(session.handlers.list_devices(), { message: 'pair.csr.failed' });
  assert.ok(driver.errors.some((line) => line.includes('pair: scan failed after')));
  assert.ok(driver.errors.some((line) => line.includes('pair: search failed: radio busy')));
  assert.ok(driver.logs.includes('pair: list_devices: error failed'));
});

test('no rotary dimmer, but a Pill and a DIN: the list says so instead of the general advice', async () => {
  const { driver } = meshDriver([adv('d', '@SC7A8B'), adv('e', '@GR9C0D')], [node(0x0126, '@SC7A8B')]);
  const note = 'pair.found.noDimmerButPill {"products":"LEDDim Smart Pill"} '
    + 'pair.found.notYet {"products":"LEDDim Smart DIN"}';
  await assert.rejects(pairList(driver), { message: note });
  assert.ok(driver.logs.includes('pair: list_devices: error none'));
});

test('no rotary dimmer, only a DIN: no rotary dimmers found, and the DIN cannot be added yet', async () => {
  const { driver } = meshDriver([adv('e', '@GR9C0D')], [node(0x0127, '@GR9C0D')]);
  await assert.rejects(pairList(driver),
    { message: 'pair.found.noDimmer pair.found.notYet {"products":"LEDDim Smart DIN"}' });
});

test('all dimmers added and a Pill found: an empty list, so Homey says itself that none is new; a later dimmer added is not listed', async () => {
  const { driver } = meshDriver([adv('a', '@ND1A2B'), adv('b', '@GD3C4D'), adv('d', '@SC7A8B')],
    [node(0x0124, '@GD3C4D'), node(0x0126, '@SC7A8B')], ['@ND1A2B', '@GD3C4D']);
  const result = await driver._search();
  assert.equal(result.reason, 'allAdded');
  assert.deepEqual(result.devices.map((d) => d.data.id), ['@ND1A2B']);
  assert.equal(result.note, '');
  assert.deepEqual(await pairList(driver), []);
  assert.ok(driver.logs.includes('pair: list_devices: 0 device(s), all added'));
});

test('a later dimmer seen but without an answer is not a dimmer to add; the general advice stays, also with a Pill', async () => {
  const { driver } = meshDriver([adv('b', '@GD3C4D')]);
  assert.deepEqual(await driver._search(), { devices: [], reason: 'none', note: '' });
  await assert.rejects(pairList(driver), { message: 'pair.noDimmersFound' });
  const withPill = meshDriver([adv('b', '@GD3C4D'), adv('d', '@SC7A8B')], [node(0x0126, '@SC7A8B')]);
  await assert.rejects(pairList(withPill.driver), { message: 'pair.noDimmersFound' });
  const nothing = meshDriver([]);
  await assert.rejects(pairList(nothing.driver), { message: 'pair.noDimmersFound' });
});

test('FF10 as in sg_pill (laterNodes): one that fails, or is not out in FF10_WITHIN_MS, still lists the first generation dimmers', async () => {
  const failing = meshDriver([adv('a', '@ND1A2B'), adv('b', '@GD3C4D')], () => { throw new Error('radio busy'); });
  const first = await failing.driver._search();
  assert.deepEqual(first.devices.map((d) => d.data.id), ['@ND1A2B']);
  assert.ok(failing.driver.errors.some((line) => line.includes('pair: FF10 failed: radio busy')));
  assert.ok(failing.driver.errors.some((line) => /^pair: FF10 not delivered after \d+\.\d s, no listening$/.test(line)));

  const hanging = meshDriver([adv('a', '@ND1A2B'), adv('b', '@GD3C4D')], () => new Promise(() => {}));
  const searching = hanging.driver._search();
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.deepEqual([...hanging.driver.homey.pending.values()].map((t) => t.ms), [FF10_WITHIN_MS], 'the same deadline, not 25 s');
  hanging.driver.homey.runMs(FF10_WITHIN_MS);
  assert.deepEqual((await searching).devices.map((d) => d.data.id), ['@ND1A2B']);
  assert.ok(hanging.driver.errors.includes(`pair: FF10 not out in ${FF10_WITHIN_MS / 1000} s, no listening`));
  assert.equal(hanging.driver.homey.pending.size, 0, 'no listening after a late FF10');
});

test('a later rotary dimmer that answered before: listed when FF10 does not get out now', async () => {
  const { driver } = meshDriver([adv('b', '@GD3C4D')], () => { throw new Error('radio busy'); });
  driver.homey.app.csr.nodes.set(0x0124, { ...node(0x0124, '@GD3C4D'), seenAt: 1 });
  const { devices, reason } = await driver._search();
  assert.equal(reason, null);
  assert.deepEqual(devices.map((d) => d.data.id), ['@GD3C4D']);
});

test('FF10 out, then the listening, before a later rotary dimmer is listed; the first generation alone sends none', async () => {
  const app = { csr: fake.fakeCsr([node(0x0124, '@GD3C4D')]) };
  const driver = new SGMeshDriver({ homey: fake.fakeHomey(app, { ble: { discover: async () => [adv('b', '@GD3C4D')] } }) });
  driver.homey.__ = __;
  driver.getDevices = () => [];
  const searching = driver._search();
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.deepEqual([...driver.homey.pending.values()].map((t) => t.ms), [SEARCH_LISTEN_MS]);
  assert.ok(driver.logs.some((line) => /^pair: FF10 out after \d+\.\d s$/.test(line)));
  driver.homey.runMs(SEARCH_LISTEN_MS);
  assert.deepEqual((await searching).devices.map((d) => d.data.id), ['@GD3C4D']);

  const gen1 = meshDriver([adv('a', '@ND1A2B'), adv('c', '@ND3C4D')]);
  await gen1.driver._search();
  assert.equal(gen1.app.names, 0);
  assert.ok(!gen1.driver.logs.some((line) => line.includes('FF10')));
});

test('sg_pill: no Pill, but rotary dimmers: the list says to go back and choose "LEDDim Smart"', async () => {
  const app = { csr: fake.fakeCsr([node(0x0124, '@GD3C4D'), node(0x0125, '@MB5E6F')]) };
  const driver = new SGPillDriver({ homey: fake.listenAtOnce(fake.fakeHomey(app, { ble: { discover: async () => [] } })) });
  driver.homey.__ = __;
  driver.getDevices = () => [];
  const handlers = {};
  await driver.onPair({ setHandler: (name, fn) => { handlers[name] = fn; }, showView: async () => {} });
  await assert.rejects(handlers.list_devices(),
    { message: 'pair.found.noPillButDimmer {"products":"LEDDim Smart, LEDDim Smart Master"}' });
  assert.ok(driver.logs.some((line) => line.includes('@GD Gen4 dimmable elsewhere; @MB Gen2 dimmable elsewhere')));
});

test('a later rotary dimmer added: the first generation bookkeeping in the app leaves it out', async () => {
  const app = new SGSmartApp();
  const homeyFor = () => fake.fakeHomey(app);
  const gen1 = new SGMeshDevice({ homey: homeyFor(), store: { localName: '@ND1A2B', locationId: 0x1234 }, name: 'gen1' });
  const later = new SGCsrDevice({
    homey: homeyFor(), store: { meshId: 0x0124, prefix: '@GD', kind: 'dimmable', locationId: LOC }, name: 'later',
  });
  app.homey = fake.fakeHomey(app, { drivers: { getDrivers: () => ({ sg_mesh: { getDevices: () => [gen1, later] } }) } });
  app.dimmersChanged = () => {};
  app.statusUnreadableText = () => null;
  await gen1.onInit();
  await later.onInit();
  assert.equal(app.dimmerCount(), 1);
  assert.deepEqual(app.getPairedMeshIds(), ['1a2b']);
  assert.equal(app.sharedLocation(null), 0x1234);
  assert.equal(later.getCsrMeshId(), 0x0124);
  assert.equal(typeof later.getMeshId, 'undefined');
});

test('the location ids FF10 asks with: the first generation dimmers\', also from status only, and a later device\'s', async () => {
  const app = new SGSmartApp();
  const homeyFor = () => fake.fakeHomey(app);
  const gen1 = new SGMeshDevice({ homey: homeyFor(), store: { localName: '@ND1A2B', locationId: 0x1234 }, name: 'gen1' });
  const later = new SGCsrDevice({
    homey: homeyFor(), store: { meshId: 0x0124, prefix: '@GD', kind: 'dimmable', locationId: LOC }, name: 'later',
  });
  const unknown = new SGCsrDevice({ homey: homeyFor(), store: { meshId: 0x0125, prefix: '@SC', kind: 'dimmable' }, name: 'unknown' });
  app.homey = fake.fakeHomey(app, { drivers: { getDrivers: () => ({ sg_mesh: { getDevices: () => [gen1, later, unknown] } }) } });
  assert.deepEqual(app.knownLocations(), [0x1234, LOC].sort((a, b) => a - b));
  // A dimmer heard but not added, and one with the same location id as an added one.
  app._locations = new Map([[0x3c4d, { value: 0x0042 }], [0x1a2b, { value: 0x1234 }], [0x5e6f, { value: null }]]);
  assert.deepEqual(app.knownLocations(), [0x0042, 0x1234, LOC].sort((a, b) => a - b));
});
