'use strict';

// The fake devices (lib/fake/, lib/fakeDevices.js): never in a build made
// from the app folder, never loaded without DEBUG=1, and never anything on
// the real radio. Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fake = require('./helpers/fake-homey');

fake.install();

const { decryptPayload, deriveNetworkKey } = require('../lib/csrmesh');
const { csrProductForName } = require('../lib/sgProducts');
const { CsrNetwork } = require('../lib/CsrNetwork');
const MeshBridge = require('../lib/MeshBridge');
const SGCsrDevice = require('../lib/SGCsrDevice');
const SGMeshDriver = require('../drivers/sg_mesh/driver');
const SGPillDriver = require('../drivers/sg_pill/driver');
const SGPlugDriver = require('../drivers/sg_plug/driver');
const SGPlugDevice = require('../drivers/sg_plug/device');
const SGThermostatDriver = require('../drivers/sg_thermostat/driver');
const SGThermostatDevice = require('../lib/SGThermostatDevice');
const SGSmartApp = require('../app');
const { FAKE_ID_PREFIX, isFakeDevice, loadFakes } = require('../lib/fakeDevices');
const { buildFiles } = require('./helpers/build-files');

const ROOT = path.join(__dirname, '..');
const tick = () => new Promise((resolve) => setImmediate(resolve));

// ---- never in a build

test('.homeyignore leaves lib/fake/ and dev/ out', () => {
  const lines = fs.readFileSync(path.join(ROOT, '.homeyignore'), 'utf8').split(/\r?\n/);
  assert.ok(lines.includes('lib/fake/'));
  assert.ok(lines.includes('dev/'));
});

test('an editor workspace file in the app folder is not in a build', async () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'drivers', 'sg_group', 'com.sgsmart.csrmesh.code-workspace')));
  assert.deepEqual((await buildFiles()).filter((file) => file.endsWith('.code-workspace')), []);
});

test('a build from the app folder has no fake device and no dev script, but has what loads them', async () => {
  const files = await buildFiles();
  assert.ok(files.includes('app.js') && files.includes('lib/SGCsrDevice.js') && files.includes('lib/fakeDevices.js'));
  assert.deepEqual(files.filter((file) => file.startsWith('lib/fake/') || file.startsWith('dev/')), []);
  assert.ok(fs.existsSync(path.join(ROOT, 'lib', 'fake', 'index.js')), 'the folder is there, the build leaves it out');
});

test('in a build, only lib/fakeDevices.js names lib/fake/, and nothing requires it', async () => {
  const files = (await buildFiles()).filter((file) => file.endsWith('.js'));
  for (const file of files) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(text, /require\(\s*['"][^'"]*\/fake(?:\/[^'"]*)?['"]\s*\)/, file);
    if (file !== 'lib/fakeDevices.js') assert.doesNotMatch(text, /path\.join\([^)]*'fake'/, file);
  }
});

test('no fake devices without DEBUG=1, and none when the build has no lib/fake/', () => {
  const app = { logs: [], log(...args) { app.logs.push(args.join(' ')); } };
  for (const env of [{}, { DEBUG: '0' }, { DEBUG: 'true' }, { DEBUG: '' }]) assert.equal(loadFakes(app, { env }), null);
  assert.deepEqual(app.logs, []);
  assert.equal(loadFakes(app, { env: { DEBUG: '1' }, dir: path.join(ROOT, 'lib', 'no-such-folder') }), null);
  assert.deepEqual(app.logs, ['fake devices: none in this build']);
});

// The files of a build (buildFiles), copied to a folder of their own, and
// lib/fake/ with them when withFakes.
async function buildCopy({ withFakes = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-leddim-build-'));
  const files = await buildFiles();
  if (withFakes) files.push(...fs.readdirSync(path.join(ROOT, 'lib', 'fake')).map((file) => `lib/fake/${file}`));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
  }
  return dir;
}

// The app of the copy in dir, started as Homey starts it (onInit), with
// process.env.DEBUG as debug gives it, and stopped again (onUninit): its
// log and fakes.
async function startApp(dir, debug) {
  const before = process.env.DEBUG;
  if (debug === undefined) delete process.env.DEBUG;
  else process.env.DEBUG = debug;
  try {
    const App = require(path.join(dir, 'app.js'));
    const app = new App();
    const settings = new Map();
    app.homey = fake.fakeHomey(app, {
      settings: { get: (key) => (settings.has(key) ? settings.get(key) : null), set: (key, value) => settings.set(key, value), on() {} },
      manifest: { version: '9.9.9' },
      drivers: { getDrivers: () => ({}) },
    });
    await app.onInit();
    const fakes = app.fakes;
    app.fileLog.file = path.join(dir, 'app.log');
    await app.onUninit();
    return { logs: app.logs || [], errors: app.errors || [], fakes };
  } finally {
    if (before === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the app as the published build has it, without lib/fake/: it starts, and fakes is null, also with DEBUG=1', async () => {
  for (const debug of [undefined, '1']) {
    const dir = await buildCopy();
    assert.ok(!fs.existsSync(path.join(dir, 'lib', 'fake')) && fs.existsSync(path.join(dir, 'lib', 'fakeDevices.js')));
    const { logs, errors, fakes } = await startApp(dir, debug);
    assert.equal(fakes, null, `DEBUG=${debug}`);
    assert.ok(logs.includes('SG LEDDim v9.9.9 initialized'), `DEBUG=${debug}`);
    assert.deepEqual(errors, [], `DEBUG=${debug}`);
    assert.deepEqual(logs.filter((line) => /fake/i.test(line)), debug === '1' ? ['fake devices: none in this build'] : []);
  }
  // The same copy with lib/fake/ in it, as dev/run-with-fakes.sh makes it,
  // has them with DEBUG=1 only: the test above would see them.
  assert.equal((await startApp(await buildCopy({ withFakes: true }), undefined)).fakes, null);
  const run = await startApp(await buildCopy({ withFakes: true }), '1');
  assert.notEqual(run.fakes, null);
  assert.ok(run.logs.some((line) => line.startsWith('[FAKE] fake devices on: @SC3B91 (0x7f01)')));
});

// ---- a fake device left without its network

test('a fake device in a run without fake devices: unavailable, no timers, nothing sent', async () => {
  const sent = [];
  const app = {
    fakes: null,
    networkFor: SGSmartApp.prototype.networkFor,
    bridge: { send: async (packet) => { sent.push(packet); return { ok: true }; } },
  };
  const homey = fake.fakeHomey(app);
  const device = new SGCsrDevice({
    homey, store: { meshId: 0x7f01, prefix: '@SC', kind: 'dimmable', locationId: 0x7f00, fake: true },
    settings: { passphrase: '1234' }, data: { id: `${FAKE_ID_PREFIX}@SC7F01` }, name: 'FAKE LEDDim Smart Pill 7F01',
  });
  await device.onInit();
  assert.equal(device.available, false);
  assert.equal(device.unavailableReason, 'device.fakeLeftOver');
  assert.equal(homey.pending.size, 0);
  assert.deepEqual(sent, []);
  assert.ok(device.logs.includes('fake device, but no fake network in this run: nothing is sent'));
});

test('the app leaves fake devices out of everything it reads and sends for (_devices), and gives them their own network', () => {
  const real = new fake.FakeDevice({ data: { id: '@SC1A2B' } });
  const fakeOne = new fake.FakeDevice({ data: { id: `${FAKE_ID_PREFIX}@SC7F01` } });
  const app = Object.create(SGSmartApp.prototype);
  app.homey = { drivers: { getDrivers: () => ({ sg_pill: { getDevices: () => [real, fakeOne] } }) } };
  app.error = () => {};
  assert.deepEqual(app._devices(), [real]);
  assert.equal(app.networkFor(real), app);
  assert.equal(app.networkFor(fakeOne), null);
  app.fakes = { name: 'the fake network' };
  assert.equal(app.networkFor(fakeOne), app.fakes);
  assert.equal(isFakeDevice(fakeOne), true);
  assert.equal(isFakeDevice(real), false);
  assert.equal(isFakeDevice({}), false);
});

test('sg_mesh gives a fake device the later class, never the first generation one', () => {
  const driver = new SGMeshDriver({ homey: fake.fakeHomey(null) });
  for (const id of ['@SD7F03', '@SW7F04', '@ND1A2B', '@SC7F01', 'anything']) {
    assert.equal(driver.onMapDeviceClass({ getData: () => ({ id: `${FAKE_ID_PREFIX}${id}` }) }), SGCsrDevice, id);
  }
});

// ---- the fake network: never the real radio

// An app as far as pairing and the devices use it: the real app methods, a
// real MeshBridge whose send and Bluetooth only count, a real CsrNetwork,
// and the fake network loaded as with DEBUG=1.
function fakeRun() {
  const realSends = [];
  const bluetooth = [];
  const app = Object.create(SGSmartApp.prototype);
  app.logs = [];
  app.errors = [];
  app.log = (...args) => app.logs.push(args.join(' '));
  app.error = (...args) => app.errors.push(args.join(' '));
  const drivers = {};
  const ble = new Proxy({}, { get: (target, name) => (...args) => { bluetooth.push(String(name)); return Promise.reject(new Error('no radio here')); } });
  app.homey = fake.fakeHomey(app, { ble, drivers: { getDrivers: () => drivers, getDriver: (id) => drivers[id] } });
  app._seq = 0x800000;
  app.bridge = new MeshBridge(app);
  app.bridge.send = async (packet, meta) => { realSends.push({ packet, meta }); return { ok: true }; };
  app.csr = new CsrNetwork(app);
  app.fakes = loadFakes(app, { env: { DEBUG: '1' } });
  for (const [id, Driver] of [['sg_pill', SGPillDriver], ['sg_mesh', SGMeshDriver], ['sg_plug', SGPlugDriver],
    ['sg_thermostat', SGThermostatDriver]]) {
    const driver = new Driver({ homey: app.homey });
    driver.id = id;
    driver.devices = [];
    driver.getDevices = () => driver.devices;
    drivers[id] = driver;
  }
  return { app, drivers, realSends, bluetooth };
}

// Runs the timers for these times, in turn, with the promises between.
async function runTimers(homey, ...times) {
  for (const ms of times) {
    for (let i = 0; i < 5; i += 1) await tick();
    homey.runMs(ms);
    for (let i = 0; i < 5; i += 1) await tick();
  }
}

// The status a fake dimmer sends 2 s after a command is not taken (the quiet
// time in lib/SGCsrDevice.js); the read-back 9 s after it is, 2 s later.
const READ_BACK = [9000, 2000];

// The fake home is heard once: one of its devices sends its status, as when
// someone else in the home asked for it, so the fake network has the home's
// location id that its devices answer FF10 with (lib/fake/nodes.js).
async function hearHome(run) {
  run.app.fakes.order('7F01 status');
  await runTimers(run.app.homey, 0);
}

// A pairing of driver as Homey runs it, with what the real search gives
// (nothing found, unless real or search says otherwise): the list it gives.
// The fake home is heard first, unless heard is false.
async function pair(run, driverId, { real = { devices: [], found: [], out: true }, search, heard = true } = {}) {
  if (heard) await hearHome(run);
  const driver = run.drivers[driverId];
  driver._search = search || (async () => real);
  const session = { handlers: {}, setHandler(name, handler) { session.handlers[name] = handler; }, showView: async () => {} };
  await driver.onPair(session);
  const listed = session.handlers.list_devices();
  listed.catch(() => {}); // a list that fails is the test's to check
  await runTimers(run.app.homey, 2000, 2000, 8000, 2000);
  return listed;
}

// A device made from a list entry, as Homey makes it, and started.
async function add(run, driverId, entry, { settings = { passphrase: '1234' } } = {}) {
  const driver = run.drivers[driverId];
  const classes = {
    sg_mesh: () => driver.onMapDeviceClass({ getData: () => entry.data }), sg_plug: () => SGPlugDevice, sg_thermostat: () => SGThermostatDevice,
  };
  const Class = classes[driverId] ? classes[driverId]() : SGCsrDevice;
  const device = new Class({
    homey: run.app.homey, store: entry.store, settings, data: entry.data, name: entry.name,
  });
  device.hasCapability = (capability) => driverId === 'sg_thermostat' || (entry.capabilities || ['onoff', 'dim']).includes(capability);
  driver.devices.push(device);
  await device.onInit();
  return device;
}

test('pairing lists the fake devices of each driver, found on the fake radio, and named FAKE', async () => {
  const run = fakeRun();
  const pills = await pair(run, 'sg_pill');
  assert.deepEqual(pills.map((d) => [d.name, d.data.id, d.store.meshId, d.store.fake, d.capabilities.join('+')]), [
    ['FAKE LEDDim Smart Pill 3B91', 'fake:@SC3B91', 0x7f01, true, 'onoff+dim'],
    ['FAKE Smart Pill ON-OFF 52C4', 'fake:@SE52C4', 0x7f02, true, 'onoff'],
  ]);
  const rotary = await pair(run, 'sg_mesh', { real: { devices: [], reason: 'none', note: '' } });
  assert.deepEqual(rotary.map((d) => d.data.id), ['fake:@SD6D17', 'fake:@SW8E2A']);
  assert.ok(run.drivers.sg_mesh.logs.includes('pair: list_devices: 2 device(s), 2 fake, in place of: none'));
  // An added one is not listed again.
  await add(run, 'sg_pill', pills[0]);
  assert.deepEqual((await pair(run, 'sg_pill')).map((d) => d.data.id), ['fake:@SE52C4']);
  assert.deepEqual(run.realSends, []);
  assert.deepEqual(run.bluetooth, []);
  assert.equal([...run.app.csr.nodes.keys()].length, 0, 'the real network never heard of them');
});

test('a fake device answers a command after 2 s, through the same reading as a real one, and the real radio gets nothing', async () => {
  const run = fakeRun();
  const [pill] = await pair(run, 'sg_pill');
  const [, tw] = await pair(run, 'sg_mesh', { real: { devices: [], reason: 'none', note: '' } });
  const device = await add(run, 'sg_pill', pill);
  const dimmer = await add(run, 'sg_mesh', tw);
  assert.ok(dimmer instanceof SGCsrDevice);

  device._request(40);
  await runTimers(run.app.homey, 0);
  assert.notEqual(device.getCapabilityValue('dim'), 0.4, 'not before 2 s');
  await runTimers(run.app.homey, 2000);
  assert.ok(run.app.logs.some((line) => /^\[FAKE\] \[CSR\] EXT src=0x7f01 dst=0x8000 op=FF05 len=7 data=7f000128/.test(line)));
  assert.notEqual(device.getCapabilityValue('dim'), 0.4, 'the answer to the command is in the quiet time');
  assert.ok(device.logs.includes('status FF05 not taken: within 8 s of a command from here'));
  await runTimers(run.app.homey, ...READ_BACK);
  assert.equal(device.getCapabilityValue('onoff'), true);
  assert.equal(device.getCapabilityValue('dim'), 0.4);

  dimmer._request(0);
  await runTimers(run.app.homey, 2000, ...READ_BACK);
  assert.equal(dimmer.getCapabilityValue('onoff'), false);

  // Status on request, and an order: changed on the device itself.
  device.requestStatus();
  await runTimers(run.app.homey, 2000);
  run.app.fakes.order('7F01 level 70');
  await runTimers(run.app.homey, 0);
  assert.equal(device.getCapabilityValue('dim'), 0.7);
  run.app.fakes.order('@SC3B91 silent');
  device._request(10);
  await runTimers(run.app.homey, 2000, ...READ_BACK);
  assert.equal(device.getCapabilityValue('dim'), 0.7, 'a silent one does not answer');
  run.app.fakes.order('7F01 answer');
  run.app.fakes.order('7F02 level 50');
  assert.ok(run.app.logs.includes('[FAKE] fake order not understood: "7F02 level 50"'), 'the ON-OFF Pill has no level');

  // Everything the fake devices sent and were asked went on the fake radio.
  const heard = run.app.fakes.bridge.heard.map((m) => `${m.opcode.toString(16)} ${m.dst.toString(16)}`);
  assert.ok(heard.includes('ff03 7f01') && heard.includes('ff03 7f04') && heard.includes('ff04 7f01') && heard.includes('ff10 0'));
  assert.deepEqual(run.realSends, []);
  assert.deepEqual(run.bluetooth, []);
  assert.equal(run.app.csr.nodes.size, 0);
  assert.deepEqual(run.app.knownLocations(), [], 'no fake location id for the real FF10');
  assert.deepEqual(run.app.fakes.bridge.refused, [], 'nothing the app sent was refused');
});

test('the real network\'s messages never reach a fake device, and the real key never comes from one', async () => {
  const run = fakeRun();
  const [pill] = await pair(run, 'sg_pill');
  const device = await add(run, 'sg_pill', { ...pill, store: { ...pill.store } });
  await runTimers(run.app.homey, 2000);
  const before = device.getCapabilityValue('dim');
  // A real FF05 from the same mesh id, location id and level as a fake would send.
  const plain = Buffer.from([0x00, 0x80, 0xff, 0x05, 0x7f, 0x00, 0x01, 0x05, 0x09, 0x01, 0x00]);
  run.app.csr.handleFrame({ src: 0x7f01, plain });
  assert.equal(device.getCapabilityValue('dim'), before);
  run.drivers.sg_pill.devices[0].getNetworkKey = () => Buffer.alloc(16, 0xaa);
  assert.notDeepEqual(run.app.getNetworkKey(), Buffer.alloc(16, 0xaa));
});

test('a fake device whose key is not the fake network\'s: its packet is not read, and nothing goes on the real radio', async () => {
  const run = fakeRun();
  const [pill] = await pair(run, 'sg_pill');
  const device = await add(run, 'sg_pill', pill);
  device.getNetworkKey = () => Buffer.alloc(16, 0x11);
  run.app.fakes.getNetworkKey = () => Buffer.alloc(16, 0x22);
  const heard = run.app.fakes.bridge.heard.length;
  device._request(30);
  await runTimers(run.app.homey, 2000);
  assert.equal(run.app.fakes.bridge.heard.length, heard);
  assert.ok(run.app.logs.some((line) => line === '[FAKE] fake radio: csr:32513 not read: not this network\'s key'));
  assert.deepEqual(run.realSends, []);
});

test('the fake devices\' packets are real CSRmesh packets, read with the fake network\'s key', async () => {
  const run = fakeRun();
  const packets = [];
  const send = run.app.fakes.bridge.send.bind(run.app.fakes.bridge);
  run.app.fakes.bridge.send = (packet, meta) => { packets.push(packet); return send(packet, meta); };
  await pair(run, 'sg_pill');
  const key = run.app.fakes.getNetworkKey();
  const plains = packets.map((p) => decryptPayload(key, p.subarray(0, 3), p.subarray(3, 5), p.subarray(5, p.length - 9)));
  assert.ok(plains.some((plain) => plain.subarray(0, 4).toString('hex') === '0000ff10'));
});

// ---- the fake network kept apart from the real one: location id, seq,
// guards, pairing and failures

const FAKE_PILL = {
  name: 'FAKE LEDDim Smart Pill 7F01', data: { id: `${FAKE_ID_PREFIX}@SC7F01` }, capabilities: ['onoff', 'dim'],
  store: { meshId: 0x7f01, prefix: '@SC', kind: 'dimmable', tunableWhite: false, fake: true },
};
const heardOf = (run, opcode, dst) => run.app.fakes.bridge.heard.filter((m) => m.opcode === opcode && m.dst === dst).length;
const thermostatNode = (location) => ({ meshId: 0x7f01, name: '@MT7F01', product: csrProductForName('@MT7F01'), location });

test('a pairing in the fake home before anything was heard from it lists no fake device; once one has sent its status, the next lists them (assumed of a real home)', async () => {
  const run = fakeRun();
  let clock = Date.now();
  run.app.fakes.csr.now = () => clock;
  const before = await pair(run, 'sg_pill', { heard: false }).catch((err) => err);
  assert.deepEqual(Array.isArray(before) ? before.map((d) => d.data.id) : [], []);
  assert.equal(heardOf(run, 0xff10, 0x0000), 1, 'FF10 with 00 00 only, which no device of a home answers');
  assert.equal(run.app.fakes.csr.nodes.size, 0);
  // A search waits NAME_REQUEST_MIN_MS before it asks again.
  clock += 31000;
  const after = await pair(run, 'sg_pill');
  assert.deepEqual(after.map((d) => d.data.id), ['fake:@SC3B91', 'fake:@SE52C4']);
  assert.equal(heardOf(run, 0xff10, 0x0000), 3, 'then 00 00 and the location id heard');
  assert.deepEqual(run.realSends, []);
});

test('a fake device without a location id, with nothing heard from its home: its FF10 with 00 00 gets no answer, and the kept level is dropped after 30 s (assumed of a real one)', async () => {
  const run = fakeRun();
  const device = await add(run, 'sg_pill', FAKE_PILL);
  device._request(40);
  await runTimers(run.app.homey, 0, 2000, 2000);
  assert.equal(heardOf(run, 0xff10, 0x0000), 1, 'only the FF10 with 00 00: no location id known');
  assert.equal(device.getCsrLocationId(), null);
  await runTimers(run.app.homey, 30000);
  assert.ok(device.logs.includes('kept level 40 dropped: no location id in 30 s'));
  assert.equal(heardOf(run, 0xff03, 0x7f01), 0);
  assert.deepEqual(run.realSends, []);
});

test('a fake device without a location id: its FF10 goes on the fake radio, never the real one, and the kept level follows the fake FF11', async () => {
  const run = fakeRun();
  // Another device of the home is heard, which gives its location id.
  run.app.fakes.order('7F02 status');
  await runTimers(run.app.homey, 0);
  const device = await add(run, 'sg_pill', FAKE_PILL);
  assert.equal(device.getCsrLocationId(), null);
  device._request(40);
  assert.ok(device.logs.includes('command level=40 kept: location id not known yet'));
  await runTimers(run.app.homey, 0, 2000, 2000);
  assert.equal(heardOf(run, 0xff10, 0x0000), 2, 'FF10 with 00 00, and with the location id heard');
  assert.equal(device.getCsrLocationId(), 0x7f00);
  assert.ok(device.logs.includes('location id known: sending the kept level 40'));
  assert.equal(heardOf(run, 0xff03, 0x7f01), 1);
  await runTimers(run.app.homey, ...READ_BACK);
  assert.equal(device.getCapabilityValue('dim'), 0.4);
  assert.deepEqual(run.realSends, []);
  assert.equal(run.app.csr._lastNameRequestAt, null, 'the real network sent no FF10');
});

test('the fake devices count their own seq: the app\'s seq and its stored counter are untouched', async () => {
  const run = fakeRun();
  const seqs = [];
  const send = run.app.fakes.bridge.send.bind(run.app.fakes.bridge);
  run.app.fakes.bridge.send = (packet, meta) => { seqs.push(packet.readUIntLE(0, 3)); return send(packet, meta); };
  const [pill] = await pair(run, 'sg_pill');
  const device = await add(run, 'sg_pill', pill);
  device._request(40);
  device.requestStatus();
  // The FF04s after the search go through the poll queue, one a slot.
  await runTimers(run.app.homey, 2000, 800, 800, 800, 800);
  assert.ok(seqs.length >= 4);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
  assert.equal(run.app._seq, 0x800000);
  assert.equal(run.app.homey.settings.get('seqCounter'), null);
});

test('the fake network never takes a real device: a fake answer never reaches a real one with the same mesh id, nor its key or location id', async () => {
  const run = fakeRun();
  const real = await add(run, 'sg_pill', {
    name: 'LEDDim Smart Pill 1A2B', data: { id: '@SC1A2B' },
    store: { meshId: 0x7f01, prefix: '@SC', kind: 'dimmable', tunableWhite: false, locationId: 0x5a3c },
  }, { settings: { passphrase: 'real-pass' } });
  const [pill] = await pair(run, 'sg_pill');
  const device = await add(run, 'sg_pill', pill);
  assert.deepEqual(run.app.fakes._devices(), [device]);
  assert.deepEqual(run.app.fakes.getNetworkKey(), deriveNetworkKey('1234'));
  assert.deepEqual(run.app.fakes.knownLocations(), [0x7f00]);
  run.app.fakes.order('7F01 level 70');
  await runTimers(run.app.homey, 0);
  device._request(20);
  await runTimers(run.app.homey, 2000, ...READ_BACK);
  assert.equal(device.getCapabilityValue('dim'), 0.2);
  assert.equal(real.getCapabilityValue('dim'), undefined);
  assert.equal(real.getCapabilityValue('onoff'), undefined);
  assert.deepEqual(run.realSends, []);
});

test('the thermostat guard of a fake device asks its own network, not the real one', async () => {
  const run = fakeRun();
  const [pill] = await pair(run, 'sg_pill');
  const device = await add(run, 'sg_pill', pill);
  // Only the real network knows 0x7f01 as a thermostat's: not the fake device's.
  run.app.csr.nodes.set(0x7f01, thermostatNode(0x5a3c));
  device._request(30);
  await runTimers(run.app.homey, 2000, ...READ_BACK);
  assert.equal(device.getCapabilityValue('dim'), 0.3);
  // The fake network knows it as one: no FF03.
  run.app.fakes.csr.nodes.set(0x7f01, thermostatNode(0x7f00));
  const before = heardOf(run, 0xff03, 0x7f01);
  device._request(60);
  await runTimers(run.app.homey, 2000);
  assert.equal(heardOf(run, 0xff03, 0x7f01), before);
  assert.ok(device.logs.includes('command FF03 id=0x7f01 level=60 not sent: that mesh id is a thermostat\'s now'));
  assert.deepEqual(run.realSends, []);
});

test('with fake devices, a pairing lists the real devices first, then the fake ones', async () => {
  const run = fakeRun();
  const realPill = { name: 'LEDDim Smart Pill 1A2B', data: { id: '@SC1A2B' }, capabilities: ['onoff', 'dim'], store: {} };
  const found = [{ name: '@SC1A2B', product: csrProductForName('@SC1A2B'), driver: 'sg_pill', state: 'add' }];
  const pills = await pair(run, 'sg_pill', { real: { devices: [realPill], found, out: true } });
  assert.deepEqual(pills.map((d) => d.data.id), ['@SC1A2B', 'fake:@SC3B91', 'fake:@SE52C4']);
  const realDimmer = { name: 'LEDDim Smart 1A2B', data: { id: '@ND1A2B' }, store: {} };
  const dimmers = await pair(run, 'sg_mesh', { real: { devices: [realDimmer], reason: null, note: '' } });
  assert.deepEqual(dimmers.map((d) => d.data.id), ['@ND1A2B', 'fake:@SD6D17', 'fake:@SW8E2A']);
});

test('a real search that fails: the fake devices are listed all the same, and with none of them the list fails as before', async () => {
  const run = fakeRun();
  const fails = async () => { throw new Error('scan failed on purpose'); };
  const pills = await pair(run, 'sg_pill', { search: fails });
  assert.deepEqual(pills.map((d) => d.data.id), ['fake:@SC3B91', 'fake:@SE52C4']);
  const driver = run.drivers.sg_pill;
  assert.ok(driver.errors.includes('pair: search failed: scan failed on purpose'));
  assert.ok(driver.logs.includes('pair: list_devices: 2 device(s), 2 fake, in place of: search failed'));
  for (const entry of pills) await add(run, 'sg_pill', entry);
  await assert.rejects(pair(run, 'sg_pill', { search: fails }), /^Error: pair\.csr\.failed$/);
  assert.deepEqual(run.realSends, []);
});

test('a fake device left without its network: a command, a status request and the rest each log one line, and nothing is sent or thrown', async () => {
  const sent = [];
  const app = { fakes: null, networkFor: SGSmartApp.prototype.networkFor, bridge: { send: async (p) => { sent.push(p); return { ok: true }; } } };
  const device = new SGCsrDevice({
    homey: fake.fakeHomey(app), store: { ...FAKE_PILL.store, locationId: 0x7f00 },
    settings: { passphrase: '1234' }, data: FAKE_PILL.data, name: FAKE_PILL.name,
  });
  await device.onInit();
  device._request(40);
  assert.equal(await device._send(40, { location: 0x7f00, borrowed: false }), false);
  device._keep(40);
  device.requestStatus();
  await device.updateAvailability();
  await tick();
  const without = ': nothing done, fake device without a fake network in this run';
  assert.deepEqual(device.logs.filter((line) => line.endsWith(without)),
    ['command level=40', 'command FF03 level=40', 'command level=40', 'status request', 'availability'].map((w) => `${w}${without}`));
  assert.deepEqual(device.errors, []);
  assert.deepEqual(sent, []);
  assert.equal(device.available, false);
});

test('fake devices that fail to load never stop the start: the error is logged, and fakes is null', async () => {
  for (const [broken, said] of [
    ["throw new Error('broken on purpose');\n", 'fake devices not loaded: broken on purpose'],
    ["module.exports = { start() { throw new Error('start failed on purpose'); } };\n", 'fake devices not loaded: start failed on purpose'],
  ]) {
    const dir = await buildCopy({ withFakes: true });
    fs.writeFileSync(path.join(dir, 'lib', 'fake', 'index.js'), broken);
    const { logs, errors, fakes } = await startApp(dir, '1');
    assert.equal(fakes, null);
    assert.ok(logs.includes('SG LEDDim v9.9.9 initialized'));
    assert.deepEqual(errors, [said]);
  }
});

test('a fake Smart Plug and Smart Socket: listed by sg_plug with their icons, turned on and off with an answer after 2 s, never on the real radio', async () => {
  const run = fakeRun();
  const listed = await pair(run, 'sg_plug');
  assert.deepEqual(listed.map((d) => [d.name, d.data.id, d.icon, d.capabilities.join('+')]), [
    ['FAKE Smart Plug 9F5D', 'fake:@GP9F5D', '/icons/plug.svg', 'onoff'],
    ['FAKE Smart Socket B460', 'fake:@GBB460', '/icons/socket.svg', 'onoff'],
  ]);
  const plugDevice = await add(run, 'sg_plug', listed[0]);
  const socket = await add(run, 'sg_plug', listed[1]);
  assert.ok(plugDevice instanceof SGPlugDevice);
  plugDevice._request(100);
  socket._request(100);
  await runTimers(run.app.homey, 2000);
  assert.deepEqual([plugDevice.getCapabilityValue('onoff'), socket.getCapabilityValue('onoff')], [true, true]);
  run.app.fakes.order('7F06 off');
  await runTimers(run.app.homey, 0);
  assert.equal(socket.getCapabilityValue('onoff'), false, 'turned off at the socket itself');
  assert.deepEqual(run.realSends, []);
  assert.deepEqual(run.bluetooth, []);
});

test('a fake HeatReg Smart: listed by sg_thermostat, read, set from Homey with control on, faults and its pause on order, never on the real radio', async () => {
  const run = fakeRun();
  const listed = await pair(run, 'sg_thermostat');
  assert.deepEqual(listed.map((d) => [d.name, d.data.id, d.store.meshId, d.capabilities]), [
    ['FAKE HeatReg Smart C7A3', 'fake:@MTC7A3', 0x7f07, undefined],
    ['FAKE HeatReg Smart D8E6', 'fake:@STD8E6', 0x8123, undefined],
  ]);
  // Control is on by default; the first is turned off by the user.
  const off = await add(run, 'sg_thermostat', listed[0]);
  const on = await add(run, 'sg_thermostat', listed[1]);
  assert.deepEqual([off.getSettings().control_from_homey, on.getSettings().control_from_homey], [true, true]);
  off.getSettings().control_from_homey = false;
  assert.ok(off instanceof SGThermostatDevice);
  // Read: status, temperatures and presets come through the same reading, in
  // the pace the requests share (a slot before each here, as the clock does
  // not move with the timers).
  for (let i = 0; i < 30; i += 1) await runTimers(run.app.homey, 0, 800, 2000);
  assert.deepEqual([on.getCapabilityValue('target_temperature'), on.getCapabilityValue('measure_temperature'),
    on.getCapabilityValue('measure_temperature.floor'), on.getCapabilityValue('sg_heat_preset')], [21, 20.5, 24, 'comfort']);
  // Control off refuses; on sends, and the answer comes 2 s later.
  await assert.rejects(off._setPoint(22.5), { message: 'thermostat.controlOff' });
  await on._setPoint(22.5);
  await on._preset('eco');
  await runTimers(run.app.homey, 2000);
  assert.equal(run.app.fakes.nodes.find((n) => n.meshId === 0x8123).setPoint, 16, 'set from Homey at a high mesh id');
  // Orders: a fault and the open window function, changed on the thermostat itself.
  run.app.fakes.order('8123 error FFF');
  run.app.fakes.order('8123 pause on');
  await runTimers(run.app.homey, 0);
  assert.equal(on.getCapabilityValue('alarm_problem'), true);
  assert.equal(on.warning, 'thermostat.fault.FFF');
  assert.equal(on.getCapabilityValue('sg_window_open'), true);
  assert.equal(on.getCapabilityValue('measure_temperature.floor'), null, 'no floor reading with its sensor fault');
  const heard = run.app.fakes.bridge.heard.map((m) => `${m.opcode.toString(16)} ${m.dst.toString(16)}`);
  assert.ok(heard.includes('ff3e 8123') && heard.includes('ff03 8123') && heard.includes('ff3c 7f07'));
  assert.ok(!heard.some((h) => h.endsWith(' 7f07') && /^ff(3e|42|03) /.test(h)), 'nothing set on the one with control off');
  assert.deepEqual(run.app.fakes.bridge.refused, []);
  assert.deepEqual(run.realSends, []);
  assert.deepEqual(run.bluetooth, []);
});
