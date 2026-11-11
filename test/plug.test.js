'use strict';

// Smart Plug and Smart Socket (sg_plug): which products it adds, on and off,
// and the countdown Homey counts itself. The formats are assumed: no plug
// has been tried with Homey yet. Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fake = require('./helpers/fake-homey');

fake.install();

const { decryptPayload, deriveNetworkKey } = require('../lib/csrmesh');
const {
  CSR_PRODUCTS, DIN_ONOFF_PREFIXES, PLUG_PREFIXES, RECALLED_PREFIXES, csrDriverFor, csrProductForName,
} = require('../lib/sgProducts');
const { foundNote, withStates, laterFindings } = require('../lib/csrPairing');
const SGPlugDriver = require('../drivers/sg_plug/driver');
const SGPlugDevice = require('../drivers/sg_plug/device');

const ROOT = path.join(__dirname, '..');
const KEY = deriveNetworkKey('test-only-pass');
const LOC = 0x5a3c;
const MESH_ID = 0x0124;
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const plainOf = (packet) => decryptPayload(KEY, packet.subarray(0, 3), packet.subarray(3, 5), packet.subarray(5, packet.length - 9));
const node = (meshId, name) => ({ meshId, name, product: csrProductForName(name), location: LOC });

// ---- the products

test('sg_plug adds Smart Plug (Gen2 to Gen4), Smart Socket and Smart DIN 3600, as sockets with on and off, each with its icon', () => {
  assert.deepEqual(PLUG_PREFIXES, ['@MP', '@SP', '@GP', '@GB']);
  assert.deepEqual(DIN_ONOFF_PREFIXES, ['@GM']);
  for (const prefix of Object.keys(CSR_PRODUCTS)) {
    const product = csrProductForName(`${prefix}1A2B`);
    assert.equal(csrDriverFor(product) === 'sg_plug', PLUG_PREFIXES.includes(prefix) || DIN_ONOFF_PREFIXES.includes(prefix), prefix);
  }
  assert.deepEqual(PLUG_PREFIXES.map((prefix) => {
    const p = csrProductForName(`${prefix}1A2B`);
    return [p.name, p.kind, p.icon];
  }), [['Smart Plug', 'onoff', 'plug'], ['Smart Plug', 'onoff', 'plug'], ['Smart Plug', 'onoff', 'plug'], ['Smart Socket', 'onoff', 'socket']]);
  const din3600 = csrProductForName('@GM1A2B');
  assert.deepEqual([din3600.name, din3600.kind, din3600.icon, csrDriverFor(din3600)], ['Smart DIN 3600', 'onoff', 'din', 'sg_plug']);
  const compose = JSON.parse(read('drivers/sg_plug/driver.compose.json'));
  assert.equal(compose.class, 'socket');
  assert.deepEqual(compose.capabilities, ['onoff']);
  assert.deepEqual(compose.pair, JSON.parse(read('drivers/sg_pill/driver.compose.json')).pair, 'the same pairing as sg_pill');
  assert.deepEqual(JSON.parse(read('drivers/sg_plug/driver.settings.compose.json')), [{ $extends: 'network' }]);
  for (const file of ['icon.svg', 'icons/plug.svg', 'icons/socket.svg', 'icons/din.svg', 'guide/guide.png', 'images/small.png', 'images/large.png',
    'images/xlarge.png']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'drivers', 'sg_plug', 'assets', file)), file);
  }
});

// ---- pairing

const SOCKET = node(MESH_ID, '@GB3C4D');
const PLUG = node(0x0125, '@GP7A8B');
const PILL = node(0x0126, '@SC1A2B');
const DIMMER = node(0x0127, '@GD5E6F');
const SWITCH = node(0x0128, '@SX9C0D');

function pairDriver(nodes, devices = []) {
  const app = { logs: [], errors: [], log() {}, error() {} };
  app.csr = fake.fakeCsr(nodes);
  const homey = fake.listenAtOnce(fake.fakeHomey(app, { ble: { discover: async () => [] } }));
  homey.__ = (key, tokens) => (tokens ? `${key} ${JSON.stringify(tokens)}` : key);
  const driver = new SGPlugDriver({ homey });
  driver.getDevices = () => devices.map((id) => ({ getData: () => ({ id }) }));
  return driver;
}

test('pairing: a plug and a socket with a mesh id are listed with their icons, on and off alone', async () => {
  const driver = pairDriver([SOCKET, PLUG, PILL]);
  const { devices, found } = await driver._search();
  assert.deepEqual(found.map((f) => [f.name, f.state]).sort(),
    [['@GB3C4D', 'add'], ['@GP7A8B', 'add'], ['@SC1A2B', 'elsewhere']]);
  assert.deepEqual(devices.map((d) => [d.name, d.data.id, d.icon, d.capabilities.join('+'), d.store.kind, d.store.meshId]), [
    ['Smart Socket 3C4D', '@GB3C4D', '/icons/socket.svg', 'onoff', 'onoff', MESH_ID],
    ['Smart Plug 7A8B', '@GP7A8B', '/icons/plug.svg', 'onoff', 'onoff', 0x0125],
  ]);
  const again = await pairDriver([SOCKET], ['@GB3C4D'])._search();
  assert.deepEqual(again.found.map((f) => f.state), ['added']);
  assert.deepEqual(again.devices, []);
});

test('no plug found: the list names where the others go, one sentence for each driver, then what cannot be added yet', () => {
  const __ = (key, tokens) => (tokens ? `${key} ${JSON.stringify(tokens)}` : key);
  const found = withStates(laterFindings([], [PILL, DIMMER, SWITCH]), 'sg_plug', new Set());
  assert.equal(foundNote(found, __, 'sg_plug'), 'pair.found.noPlug pair.found.goToPill {"products":"LEDDim Smart Pill"} '
    + 'pair.found.goToDimmer {"products":"LEDDim Smart"} pair.found.notYet {"products":"Smart Switch"}');
  // A Pill search that finds a plug says where it goes; one that finds only
  // rotary dimmers says it as before, in one sentence.
  assert.equal(foundNote(withStates(laterFindings([], [SOCKET]), 'sg_pill', new Set()), __, 'sg_pill'),
    'pair.found.noPill pair.found.goToPlug {"products":"Smart Socket"}');
  assert.equal(foundNote(withStates(laterFindings([], [DIMMER]), 'sg_pill', new Set()), __, 'sg_pill'),
    'pair.found.noPillButDimmer {"products":"LEDDim Smart"}');
  assert.equal(foundNote(withStates(laterFindings([], [DIMMER, SOCKET]), 'sg_pill', new Set()), __, 'sg_pill'),
    'pair.found.noPill pair.found.goToDimmer {"products":"LEDDim Smart"} pair.found.goToPlug {"products":"Smart Socket"}');
});

test('pairing in sg_plug with no plug: the list fails with that note', async () => {
  const driver = pairDriver([PILL]);
  const session = { handlers: {}, views: [], setHandler(name, handler) { session.handlers[name] = handler; }, showView: async (v) => { session.views.push(v); } };
  await driver.onPair(session);
  await session.handlers.showView('loading');
  await assert.rejects(session.handlers.list_devices(),
    { message: 'pair.found.noPlug pair.found.goToPill {"products":"LEDDim Smart Pill"}' });
});

// ---- recalled: Smart Plug @MP and @SP

const RECALLED = [node(0x0129, '@MP1A2C'), node(0x012a, '@SP3C4E')];
const RECALL_PAGE = 'https://www.sg-as.com/no/no/support/tilbakekalling-av-sg-smart-plug';

test('recalled Smart Plug @MP and @SP: never offered when adding, also next to a plug and a socket that are; @GP and @GB as before', async () => {
  assert.deepEqual(RECALLED_PREFIXES, ['@MP', '@SP']);
  const driver = pairDriver([...RECALLED, PLUG, SOCKET]);
  const { devices, found } = await driver._search();
  assert.deepEqual(found.map((f) => [f.name, f.state]).sort(),
    [['@GB3C4D', 'add'], ['@GP7A8B', 'add'], ['@MP1A2C', 'recalled'], ['@SP3C4E', 'recalled']]);
  assert.deepEqual(devices.map((d) => d.data.id).sort(), ['@GB3C4D', '@GP7A8B']);
  assert.ok(driver.logs.some((line) => line.includes('@MP Gen2 onoff recalled') && line.includes('@SP Gen3 onoff recalled')));
  // Added before, or found by another driver: still recalled, never offered.
  assert.deepEqual((await pairDriver(RECALLED, ['@MP1A2C'])._search()).found.map((f) => f.state), ['recalled', 'recalled']);
  for (const driverId of ['sg_mesh', 'sg_pill', 'sg_thermostat']) {
    assert.deepEqual(withStates(laterFindings([], RECALLED), driverId, new Set()).map((f) => f.state), ['recalled', 'recalled']);
  }
});

test('a search that finds only recalled plugs shows the recall text instead of a list, in every driver; "none found" only where they would have been added', async () => {
  const __ = (key, tokens) => (tokens ? `${key} ${JSON.stringify(tokens)}` : key);
  const note = (nodes, driverId) => foundNote(withStates(laterFindings([], nodes), driverId, new Set()), __, driverId);
  assert.equal(note(RECALLED, 'sg_plug'), 'pair.found.recalled');
  assert.equal(note(RECALLED, 'sg_pill'), 'pair.found.noPill pair.found.recalled');
  assert.equal(note(RECALLED, 'sg_mesh'), 'pair.found.noDimmer pair.found.recalled');
  assert.equal(note(RECALLED, 'sg_thermostat'), 'pair.found.noThermostat pair.found.recalled');
  assert.equal(note([RECALLED[0], PILL], 'sg_plug'), 'pair.found.goToPill {"products":"LEDDim Smart Pill"} pair.found.recalled');
  // Next to a plug that can be added, Homey's list has that one only.
  assert.equal(note([RECALLED[0], PLUG], 'sg_plug'), '');
  const driver = pairDriver(RECALLED);
  const session = { handlers: {}, views: [], setHandler(name, handler) { session.handlers[name] = handler; }, showView: async (v) => { session.views.push(v); } };
  await driver.onPair(session);
  await session.handlers.showView('loading');
  await assert.rejects(session.handlers.list_devices(), { message: 'pair.found.recalled' });
});

test('the recall texts in Norwegian and English: the long one with the recall page when adding, a short warning on the device; a line in the 2.6.0 and 2.6.1 changelogs', () => {
  const [no, en] = ['no', 'en'].map((language) => JSON.parse(read(`locales/${language}.json`)));
  assert.equal(no.pair.found.recalled, `Fant en Smart Plug som SG har tilbakekalt. Den kan ikke legges til. Les mer: ${RECALL_PAGE}`);
  assert.equal(en.pair.found.recalled, `Found a Smart Plug recalled by SG. It cannot be added. Read more: ${RECALL_PAGE}`);
  assert.equal(no.device.recalled, 'Tilbakekalt av SG. Se sg-as.com.');
  assert.equal(en.device.recalled, 'Recalled by SG. See sg-as.com.');
  for (const version of ['2.6.0', '2.6.1']) {
    const changelog = JSON.parse(read('.homeychangelog.json'))[version];
    assert.ok(changelog.no.includes(' Smart Plug som SG har tilbakekalt, kan ikke legges til. '), version);
    assert.ok(changelog.en.includes(' Smart Plugs recalled by SG cannot be added. '), version);
  }
});

// ---- the device: on, off and the countdown

// A plug device with an app that records what is sent and which countdown
// cards ran, its timers run by the test.
async function plug({ store = {}, onoff } = {}) {
  const sent = [];
  const triggered = [];
  const app = {
    logs: [], errors: [], log() {}, error() {}, seq: 0x800000,
    nextSeq() { app.seq += 1; return app.seq; },
    bridge: { send: async (packet) => { sent.push(plainOf(packet)); return { ok: true }; } },
    csr: { requestNames: async () => true, requestStatus: async () => true, isThermostat: () => false },
    sharedLocation: () => null,
    statusUnreadableText: () => null,
  };
  const flow = { getDeviceTriggerCard: (id) => ({ trigger: async (device) => { triggered.push([id, device]); } }) };
  const homey = fake.fakeHomey(app, { flow });
  const device = new SGPlugDevice({
    homey, store: { meshId: MESH_ID, prefix: '@GB', kind: 'onoff', tunableWhite: false, locationId: LOC, ...store },
    settings: { passphrase: 'test-only-pass' }, data: { id: '@GB3C4D' }, name: 'plug',
  });
  device.hasCapability = (capability) => capability === 'onoff';
  // What Homey runs when the tile, a Flow card or a voice assistant sets it.
  let listener = null;
  device.registerMultipleCapabilityListener = (capabilities, fn) => { listener = fn; };
  if (onoff !== undefined) await device.setCapabilityValue('onoff', onoff);
  await device.onInit();
  const setInHomey = (values) => listener(values);
  const countdownTimers = () => [...homey.pending.entries()].filter(([, { ms }]) => ms > 60000);
  const runCountdown = async () => {
    for (const [id, { fn }] of countdownTimers()) {
      homey.pending.delete(id);
      fn();
    }
    for (let i = 0; i < 5; i += 1) await tick();
  };
  return { device, homey, sent, triggered, countdownTimers, runCountdown, setInHomey };
}

const ff03 = (plain) => plain.subarray(0, 4).toString('hex');
const bytesOf = (plain) => [...plain.subarray(4)];

test('a recalled plug added before: the warning says it is recalled and stays, also over a password warning; on and off still go', async () => {
  for (const prefix of RECALLED_PREFIXES) {
    const { device, sent } = await plug({ store: { prefix } });
    assert.equal(device.warning, 'device.recalled', prefix);
    assert.ok(device.logs.includes('warning shown: recalled product'), prefix);
    device.homey.app.statusUnreadableText = () => 'device.passwordWrong';
    await device.updateAvailability();
    assert.equal(device.warning, 'device.recalled', prefix);
    assert.equal(device.available, true, prefix);
    device._request(100);
    device._request(0);
    await tick();
    assert.deepEqual(sent.map(bytesOf), [[0x5a, 0x3c, 1, 0, 1, 0, 0], [0x5a, 0x3c, 0, 0, 2, 0, 0]], prefix);
  }
  for (const prefix of ['@GP', '@GB']) {
    const { device } = await plug({ store: { prefix } });
    assert.equal(device.warning, null, prefix);
  }
});

test('on and off: one FF03 each, pwr 01 with level 0 for on, 00 00 for off', async () => {
  const { device, sent } = await plug();
  device._request(100);
  device._request(0);
  await tick();
  assert.deepEqual(sent.map(ff03), ['2401ff03', '2401ff03']);
  assert.deepEqual(sent.map(bytesOf), [[0x5a, 0x3c, 1, 0, 1, 0, 0], [0x5a, 0x3c, 0, 0, 2, 0, 0]]);
});

test('"Turn off in ... minutes": one FF03 off when the time is up, the card runs, and the countdown is gone', async () => {
  const { device, sent, triggered, countdownTimers, runCountdown } = await plug({ onoff: true });
  await device.offIn(30);
  assert.equal(device.countdownRunning(), true);
  const [[, { ms }]] = countdownTimers();
  assert.ok(ms > 29.9 * 60000 && ms <= 30 * 60000, `${ms}`);
  assert.equal(sent.length, 0);
  await runCountdown();
  assert.deepEqual(sent.map(bytesOf), [[0x5a, 0x3c, 0, 0, 1, 0, 0]]);
  assert.deepEqual(triggered.map(([id, d]) => [id, d === device]), [['plug_countdown_done', true]]);
  assert.equal(device.getStoreValue('countdown'), null);
  assert.equal(device.countdownRunning(), false);
  assert.ok(device.logs.includes('countdown done: off'));
});

test('a countdown sends off when it is up, whatever the last status said; the card runs', async () => {
  const { device, sent, triggered, runCountdown } = await plug({ onoff: false });
  await device.offIn(5);
  await runCountdown();
  assert.deepEqual(sent.map((p) => p[6]), [0], 'one FF03 off');
  assert.equal(triggered.length, 1);
  assert.ok(device.logs.includes('countdown done: off'));
});

test('"Turn on for" with the plug off and no status since: on now, and off when the time is up', async () => {
  const { device, sent, runCountdown } = await plug({ onoff: false });
  await device.onFor(10);
  await tick();
  assert.equal(device.getCapabilityValue('onoff'), false, 'no status has come');
  await runCountdown();
  assert.deepEqual(sent.map((p) => p[6]), [1, 0], 'on, then off');
});

test('off chosen in Homey cancels the countdown; on does not', async () => {
  const { device, sent, countdownTimers, runCountdown, setInHomey } = await plug({ onoff: true });
  await device.offIn(30);
  await setInHomey({ onoff: true });
  assert.equal(device.countdownRunning(), true, 'on keeps it');
  await setInHomey({ onoff: false });
  await tick();
  assert.equal(device.countdownRunning(), false);
  assert.equal(countdownTimers().length, 0);
  assert.equal(device.getStoreValue('countdown'), null);
  assert.ok(device.logs.includes('countdown cancelled: turned off in Homey'));
  await runCountdown();
  assert.deepEqual(sent.map((p) => p[6]), [1, 0], 'the on and the off chosen, nothing at the end');
  const cards = JSON.parse(read('drivers/sg_plug/driver.flow.compose.json')).actions;
  for (const id of ['plug_off_in', 'plug_on_for']) {
    const { hint } = cards.find((c) => c.id === id);
    assert.match(hint.en, /off in Homey cancels/, id);
    assert.match(hint.no, /av i Homey, avbrytes nedtellingen/, id);
  }
});

test('"Turn on for ... minutes": on now, off when the time is up', async () => {
  const { device, sent, runCountdown } = await plug({ onoff: true });
  await device.onFor(15);
  await tick();
  assert.deepEqual(sent.map(bytesOf), [[0x5a, 0x3c, 1, 0, 1, 0, 0]]);
  await runCountdown();
  assert.deepEqual(sent.map((p) => p[6]), [1, 0], 'on, then off');
});

test('a new countdown replaces the running one; cancelling sends nothing and stops it', async () => {
  const { device, sent, countdownTimers, runCountdown } = await plug({ onoff: true });
  await device.offIn(10);
  await device.offIn(20);
  assert.equal(countdownTimers().length, 1);
  assert.equal(device.getStoreValue('countdown').minutes, 20);
  await device.cancelCountdown();
  assert.equal(countdownTimers().length, 0);
  assert.equal(device.countdownRunning(), false);
  await runCountdown();
  assert.deepEqual(sent, []);
  assert.ok(device.logs.includes('countdown cancelled'));
  await device.cancelCountdown();
  assert.ok(device.logs.includes('countdown cancel: none was running'));
});

test('minutes outside 1 to 1440 are taken as the nearest end', async () => {
  const { device } = await plug();
  await device.offIn(0);
  assert.equal(device.getStoreValue('countdown').minutes, 1);
  await device.offIn(5000);
  assert.equal(device.getStoreValue('countdown').minutes, 1440);
});

test('after a restart a countdown goes on, never longer than 1440 min; one that ran out meanwhile is only logged, and nothing is sent', async () => {
  const going = await plug({ onoff: true, store: { countdown: { at: Date.now() + 10 * 60000, minutes: 15 } } });
  assert.equal(going.countdownTimers().length, 1);
  assert.equal(going.device.countdownRunning(), true);
  assert.ok(going.device.logs.some((line) => /^countdown goes on: off at \d\d:\d\d UTC, 10 min left$/.test(line)));
  await going.runCountdown();
  assert.equal(going.sent.length, 1);

  // A clock that was behind: never more than 1440 min from now.
  const far = await plug({ onoff: true, store: { countdown: { at: Date.now() + 5000 * 60000, minutes: 30 } } });
  const [[, { ms }]] = far.countdownTimers();
  assert.ok(ms <= 1440 * 60000 && ms > 1439 * 60000, `${ms}`);
  assert.ok(far.device.getStoreValue('countdown').at <= Date.now() + 1440 * 60000);
  assert.ok(far.device.logs.some((line) => /^countdown goes on: off at \d\d:\d\d UTC, 1440 min left, cut to 1440 min$/.test(line)));

  const out = await plug({ onoff: true, store: { countdown: { at: Date.now() - 7 * 60000, minutes: 15 } } });
  assert.equal(out.countdownTimers().length, 0);
  assert.equal(out.device.getStoreValue('countdown'), null);
  assert.ok(out.device.logs.includes('countdown ran out 7 min ago while the app was not running: nothing sent'));
  await tick();
  assert.deepEqual(out.sent, []);
  assert.deepEqual(out.triggered, []);
});

test('the Flow cards: the driver hands them to the device, and they are in the manifest with their texts', async () => {
  const listeners = {};
  const card = (id) => ({ registerRunListener: (fn) => { listeners[id] = fn; } });
  const flow = { getActionCard: card, getConditionCard: card };
  const driver = new SGPlugDriver({ homey: fake.fakeHomey(null, { flow }) });
  await driver.onInit();
  const calls = [];
  const device = {
    offIn: async (m) => calls.push(['offIn', m]), onFor: async (m) => calls.push(['onFor', m]),
    cancelCountdown: async () => calls.push(['cancel']), countdownRunning: () => true,
  };
  await listeners.plug_off_in({ device, minutes: 30 });
  await listeners.plug_on_for({ device, minutes: 5 });
  await listeners.plug_countdown_cancel({ device });
  assert.equal(await listeners.plug_countdown_running({ device }), true);
  assert.deepEqual(calls, [['offIn', 30], ['onFor', 5], ['cancel']]);
  const cards = JSON.parse(read('drivers/sg_plug/driver.flow.compose.json'));
  assert.deepEqual(Object.fromEntries(Object.entries(cards).map(([kind, list]) => [kind, list.map((c) => c.id)])), {
    triggers: ['plug_countdown_done'],
    conditions: ['plug_countdown_running'],
    actions: ['plug_off_in', 'plug_on_for', 'plug_countdown_cancel'],
  });
  for (const c of Object.values(cards).flat()) {
    for (const field of ['title', 'titleFormatted', 'hint']) {
      if (c[field]) assert.deepEqual(Object.keys(c[field]).sort(), ['en', 'no'], `${c.id} ${field}`);
    }
    for (const arg of c.args || []) assert.deepEqual([arg.type, arg.min, arg.max, arg.step], ['number', 1, 1440, 1], c.id);
  }
});

test('nothing in the app builds the plug\'s own countdown, its mode or a removal (FF12, FF52, FF39, FF28)', () => {
  const files = ['app.js', ...['lib', 'drivers/sg_mesh', 'drivers/sg_pill', 'drivers/sg_plug', 'drivers/sg_group']
    .flatMap((dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.js')).map((f) => `${dir}/${f}`))];
  for (const file of files) assert.doesNotMatch(read(file), /0xff,\s*0x(?:12|52|39|28)\]/i, file);
});

test('FF05 from a plug: bytes 7 and 8 are logged as its own countdown when they change, never taken as white', async () => {
  const { device, sent } = await plug();
  const status = (b7, b8, number) => ({
    location: LOC, on: true, level: null, number, firmware: 0x0102, white: b7, flags: b8,
  });
  assert.equal(device.applyCsrStatus(status(30, 1, 1), 'FF05'), true);
  assert.equal(device.applyCsrStatus(status(30, 1, 2), 'FF05'), true);
  assert.equal(device.applyCsrStatus(status(0, 0, 3), 'FF05'), true);
  assert.equal(device.applyCsrStatus(status(0, 0, 3), 'FF05'), false, 'an exact copy of the last one is dropped, and not logged');
  assert.deepEqual(device.logs.filter((line) => line.startsWith('the plug\'s own countdown')), [
    'the plug\'s own countdown in FF05: 30 min, running (assumed meaning)',
    'the plug\'s own countdown in FF05: 0 min, not running (assumed meaning)',
  ]);
  assert.ok(!device.logs.some((line) => /^status FF05 applied: .*white=/.test(line)));
  assert.equal(device.getCapabilityValue('onoff'), true);
  device._request(0);
  await tick();
  assert.equal(sent[0][10], 0, 'FF03 white stays 0');
});
