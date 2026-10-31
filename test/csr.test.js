'use strict';

// SG's CSRmesh products after the first generation (2.5.0, sg_pill). Their
// formats are assumed: none is tried with a device yet. 0x5a3c and 0x0123 are
// a made-up location id and mesh id. Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fake = require('./helpers/fake-homey');

fake.install();

const { decryptPayload, deriveNetworkKey, makePacket } = require('../lib/csrmesh');
const proto = require('../lib/sgProtocol');
const {
  CSR_PRODUCTS, ICON_NAMES, PILL_PREFIXES, canBeBridge, csrDriverFor, csrProductForName, isCsrmeshAdvertisement,
} = require('../lib/sgProducts');
const {
  CsrNetwork, LISTEN_MARGIN_MS, LOG_PER_SENDER, NAME_LISTEN_MS, SEARCH_LISTEN_MS, STATUS_LISTEN_MS,
} = require('../lib/CsrNetwork');
const MeshBridge = require('../lib/MeshBridge');
const SGCsrDevice = require('../lib/SGCsrDevice');
const SGPillDriver = require('../drivers/sg_pill/driver');
const { FF10_WITHIN_MS, SCAN_MS, SEARCH_LIMIT_MS } = require('../lib/csrPairing');

const KEY = deriveNetworkKey('test-only-pass');
const LOC = 0x5a3c;
const MESH_ID = 0x0123;
const FEF1 = '0000fef1-0000-1000-8000-00805f9b34fb';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const plainOf = (packet) => decryptPayload(KEY, packet.subarray(0, 3), packet.subarray(3, 5), packet.subarray(5, packet.length - 9));
const ext = (dst, opcode, bytes) => Buffer.from([dst & 0xff, dst >> 8, opcode >> 8, opcode & 0xff, ...bytes]);
const nameBytes = (location, name, reset = 0) => [location >> 8, location & 0xff, ...Buffer.from(name.slice(1), 'latin1'), reset];

// ---- the formats

test('FF03: location id, power, level, tid low and high, white', () => {
  // Level 32, 40 and 55 with tid 3, 5 and 7.
  for (const [level, tid, tail] of [[0x20, 3, '0120030000'], [0x28, 5, '0128050000'], [0x37, 7, '0137070000']]) {
    assert.equal(proto.csrLevelData({ meshId: MESH_ID, location: LOC, level, tid }).toString('hex'), `2301ff035a3c${tail}`);
  }
  assert.equal(proto.csrLevelData({ meshId: MESH_ID, location: LOC, level: 0, tid: 0x0102, white: 0x33 }).toString('hex'),
    '2301ff035a3c0000020133');
});

test('FF10 to 0x0000 with 00 00 or a location id; FF04 with the location id', () => {
  assert.equal(proto.csrNameRequestData().toString('hex'), '0000ff100000');
  assert.equal(proto.csrNameRequestData(LOC).toString('hex'), '0000ff105a3c');
  assert.equal(proto.csrStatusRequestData({ meshId: MESH_ID, location: LOC }).toString('hex'), '2301ff045a3c');
});

test('FF11: location id, six name characters after @, resets; shorter is nothing', () => {
  assert.deepEqual(proto.parseCsrName(Buffer.from(nameBytes(LOC, '@SC1A2B', 2))),
    { location: LOC, name: '@SC1A2B', resets: 2 });
  assert.equal(proto.parseCsrName(Buffer.from(nameBytes(LOC, '@SC1A2B').slice(0, 8))), null);
  assert.equal(proto.parseCsrName(Buffer.from([0x5a, 0x3c, 0, 1, 2, 3, 4, 5, 0])), null);
});

test('FF05 and FF50: the level counts only when on and 1..100', () => {
  assert.deepEqual(proto.parseCsrStatus(Buffer.from([0x5a, 0x3c, 1, 40, 7])),
    { location: LOC, on: true, level: 40, number: 7, firmware: null, white: null });
  assert.deepEqual(proto.parseCsrStatus(Buffer.from([0x5a, 0x3c, 1, 40, 7, 1, 2, 0x33, 0x80])),
    { location: LOC, on: true, level: 40, number: 7, firmware: 0x0102, white: 0x33 });
  assert.equal(proto.parseCsrStatus(Buffer.from([0x5a, 0x3c, 0, 0, 8])).level, 0);
  assert.equal(proto.parseCsrStatus(Buffer.from([0x5a, 0x3c, 1, 0])).level, null);
  assert.equal(proto.parseCsrStatus(Buffer.from([0x5a, 0x3c, 1])), null);
  assert.deepEqual(proto.parseCsrFastStatus(Buffer.from([0x5a, 0x3c, 1, 55, 7, 0, 0x21, 0])),
    { location: LOC, on: true, level: 55, tid: 7, white: 0x21 });
  assert.deepEqual(proto.parseExt(ext(0x8000, 0xff05, [1, 2])), { dst: 0x8000, opcode: 0xff05, data: Buffer.from([1, 2]) });
  assert.equal(proto.parseExt(Buffer.from([0x01, 0x80, 0x73, 0xf7, 0, 0])), null);
});

test('products: 64 prefixes, Gen2 to Gen4, @ND not among them; CSRmesh service by its UUID', () => {
  assert.equal(Object.keys(CSR_PRODUCTS).length, 64);
  assert.deepEqual(csrProductForName('@sc1a2b'), { prefix: '@SC', ...CSR_PRODUCTS['@SC'], icon: 'pill' });
  assert.equal(csrProductForName('@GX1A2B').icon, null); // a switch is not added
  assert.equal(csrProductForName('@SC1A2B').name, 'LEDDim Smart Pill');
  assert.equal(csrProductForName('@GX1A2B').kind, 'switch');
  assert.equal(csrProductForName('@MW1A2B').tunableWhite, true);
  assert.equal(csrProductForName('@ND1A2B'), null);
  assert.equal(csrProductForName('Phone'), null);
  assert.equal(isCsrmeshAdvertisement({ serviceUuids: [FEF1] }), true);
  assert.equal(isCsrmeshAdvertisement({ serviceUuids: ['fef1'] }), true);
  assert.equal(isCsrmeshAdvertisement({ serviceUuids: ['1827'] }), false);
});

// ---- the bridge: @ND first, other CSRmesh nodes as a reserve, frames handed on

function bareBridge() {
  const app = { homey: fake.fakeHomey(null), log() {}, error() {}, getNetworkKey: () => KEY, _devices: () => [] };
  app.homey.app = app;
  return new MeshBridge(app);
}

test('bridge names: @N, @M, @S and @G, but not the switches, @MG or @GG', () => {
  for (const name of ['@ND1A2B', '@MC1A2B', '@SC1A2B', '@GC1A2B', '@GD1A2B', '@SA1A2B', '@sc1a2b', ' @GW1A2B ']) {
    assert.equal(canBeBridge(name), true, name);
  }
  for (const name of ['@MS1A2B', '@MX1A2B', '@SS1A2B', '@SX1A2B', '@GS1A2B', '@GX1A2B', '@MG1A2B', '@GG1A2B',
    '@A01A2B', 'Speaker', '', null]) {
    assert.equal(canBeBridge(name), false, String(name));
  }
});

test('bridge: @ND nodes first; without one, an FEF1 node with an SG bridge name, strongest first, and no other', () => {
  const bridge = bareBridge();
  const nd = { uuid: 'a', localName: '@ND1A2B', rssi: -80, serviceUuids: [FEF1] };
  const csrStrong = { uuid: 'b', localName: '@SC1A2B', rssi: -50, serviceUuids: [FEF1] };
  const csrWeak = { uuid: 'c', localName: '@GD3C4D', rssi: -70, serviceUuids: [FEF1] };
  const notConnectable = { uuid: 'd', localName: '@SD5E6F', rssi: -40, serviceUuids: [FEF1], connectable: false };
  const other = { uuid: 'e', localName: 'Speaker', rssi: -30, serviceUuids: ['180f'] };
  const foreign = { uuid: 'f', localName: 'Lamp', rssi: -20, serviceUuids: [FEF1] };
  const nameless = { uuid: 'g', localName: '', rssi: -25, serviceUuids: [FEF1] };
  const sgSwitch = { uuid: 'h', localName: '@SX7A8B', rssi: -35, serviceUuids: [FEF1] };
  const colour = { uuid: 'i', localName: '@GG7A8C', rssi: -36, serviceUuids: [FEF1] };
  const noFef1 = { uuid: 'j', localName: '@SC7A8D', rssi: -37, serviceUuids: ['180f'] };
  assert.deepEqual(bridge._bridgeNodes([csrStrong, nd, other, foreign]).map((a) => a.uuid), ['a']);
  assert.deepEqual(bridge._bridgeNodes([csrWeak, notConnectable, csrStrong, other, foreign, nameless, sgSwitch, colour, noFef1])
    .map((a) => a.uuid), ['b', 'c']);
  assert.deepEqual(bridge._bridgeNodes([other, foreign, nameless]), []);
  // Homey can return a node without its name: the name seen before counts.
  assert.deepEqual(bridge._bridgeNodes([{ ...csrStrong, localName: '' }, nameless]).map((a) => a.uuid), ['b']);
});

test('bridge: the log line for a bridge chosen by signal names it, also when it is not @ND', () => {
  const bridge = bareBridge();
  bridge.app.bridgeChanged = () => {};
  const lines = [];
  bridge._status = (line) => lines.push(line);
  bridge._pickBridge([{ uuid: 'b', localName: '@SC1A2B', rssi: -50, serviceUuids: [FEF1] }]);
  bridge._pickBridge([{ uuid: 'a', localName: '@ND1A2B', rssi: -40, serviceUuids: [FEF1] }]);
  bridge._preferredUuid = null;
  bridge._pickBridge([{ uuid: 'c', localName: '', rssi: -45, serviceUuids: [FEF1] }]);
  assert.deepEqual(lines, ['bridge selected by RSSI: @SC1A2B -50 dBm', 'bridge selected by RSSI: @ND1A2B -40 dBm',
    'bridge selected by RSSI: c -45 dBm']);
});

test('bridge: a frame that is not a first generation status goes to onFrame, with its sender', () => {
  const bridge = bareBridge();
  const frames = [];
  const statuses = [];
  bridge.onFrame((frame) => frames.push(frame));
  bridge._onStatus = (...args) => statuses.push(args);
  const name = ext(0x8000, 0xff11, nameBytes(LOC, '@SC1A2B'));
  bridge._rxDecodeFrame(makePacket(KEY, 0x000101, name));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].src, 0x8000); // read from the header; makePacket writes our own address
  assert.equal(frames[0].plain.toString('hex'), name.toString('hex'));
  const status = Buffer.from([0x00, 0x80, 0x73, 0xf7, 0x5a, 0x3c, 0x1a, 0x2b, 1, 0, 0, 3, 30]);
  bridge._rxDecodeFrame(makePacket(KEY, 0x000102, status));
  assert.equal(frames.length, 1);
  assert.equal(statuses.length, 1);
});

// ---- the network: names, statuses, the log

function networkApp(devices = []) {
  const app = {
    logs: [], errors: [], sent: [], seq: 0x800000,
    log(...args) { app.logs.push(args.join(' ')); },
    error(...args) { app.errors.push(args.join(' ')); },
    getNetworkKey: () => KEY,
    nextSeq() { app.seq += 1; return app.seq; },
    bridge: { send: async (packet, meta) => { app.sent.push({ plain: plainOf(packet), meta }); return { ok: true }; } },
    _devices: () => devices,
  };
  app.homey = fake.fakeHomey(app);
  return app;
}

function clock(start = 1000000) {
  const c = { t: start, now: () => c.t };
  return c;
}

test('FF11: the sender is the mesh id, the name gives the product, and each node is asked once for its status', async () => {
  const app = networkApp();
  const csr = new CsrNetwork(app);
  csr.handleFrame({ src: MESH_ID, plain: ext(0x8000, 0xff11, nameBytes(LOC, '@SC1A2B')) });
  csr.handleFrame({ src: MESH_ID, plain: ext(0x8000, 0xff11, nameBytes(LOC, '@SC1A2B')) });
  await tick();
  const node = csr.nodes.get(MESH_ID);
  assert.equal(node.meshId, MESH_ID);
  assert.equal(node.name, '@SC1A2B');
  assert.equal(node.product.name, 'LEDDim Smart Pill');
  assert.equal(node.location, LOC);
  assert.deepEqual(app.sent.map((s) => s.plain.toString('hex')), ['2301ff045a3c']);
  assert.ok(app.logs.some((line) => line.includes('EXT src=0x0123 dst=0x8000 op=FF11 len=9')
    && line.includes('name=@SC1A2B product="LEDDim Smart Pill (Gen3)" loc=0x5a3c')));
});

test('the FF04 after a first FF11 waits until the link no longer listens, also when the listening is made longer', async () => {
  const app = networkApp();
  let left = 6000;
  app.bridge.listenLeftMs = () => left;
  const csr = new CsrNetwork(app);
  csr.handleFrame({ src: MESH_ID, plain: ext(0x8000, 0xff11, nameBytes(LOC, '@SC1A2B')) });
  await tick();
  assert.equal(app.sent.length, 0, 'not while the search listens');
  assert.deepEqual([...app.homey.pending.values()].map((t) => t.ms), [6000]);
  left = 2000; // a second FF10 variant made it longer
  app.homey.runAll();
  await tick();
  assert.equal(app.sent.length, 0);
  assert.deepEqual([...app.homey.pending.values()].map((t) => t.ms), [2000]);
  left = 0;
  app.homey.runAll();
  await tick();
  assert.deepEqual(app.sent.map((s) => [s.plain.toString('hex'), s.meta]),
    [['2301ff045a3c', { key: `csr:status:${MESH_ID}`, listenMs: STATUS_LISTEN_MS }]]);

  const stopped = networkApp();
  stopped.bridge.listenLeftMs = () => 6000;
  const other = new CsrNetwork(stopped);
  other.handleFrame({ src: MESH_ID, plain: ext(0x8000, 0xff11, nameBytes(LOC, '@SC1A2B')) });
  other.stop();
  assert.equal(stopped.homey.pending.size, 0, 'stop clears a waiting FF04');
});

test('our own messages (from 0x8000) and the data model are not logged', () => {
  const app = networkApp();
  const csr = new CsrNetwork(app);
  csr.handleFrame({ src: 0x8000, plain: ext(0x0100, 0xff03, [0x5a, 0x3c, 1, 32, 3, 0, 0]) });
  csr.handleFrame({ src: MESH_ID, plain: Buffer.from([0x01, 0x80, 0x73, 0xcc, 0x40]) });
  assert.equal(app.logs.length, 0);
});

test('the log: the same message once a minute, at most 20 lines a minute per sender, first FF11 and FF05 always', () => {
  const app = networkApp();
  const c = clock();
  const csr = new CsrNetwork(app, { now: c.now });
  const lines = () => app.logs.filter((line) => line.startsWith('[CSR] EXT'));
  const fast = (n) => ext(0x8000, 0xff50, [0x5a, 0x3c, 1, n, 1, 0, 0, 0]);
  csr.handleFrame({ src: MESH_ID, plain: fast(10) });
  csr.handleFrame({ src: MESH_ID, plain: fast(10) });
  assert.equal(lines().length, 1);
  for (let n = 11; n < 11 + LOG_PER_SENDER + 5; n += 1) csr.handleFrame({ src: MESH_ID, plain: fast(n) });
  assert.equal(lines().length, LOG_PER_SENDER);
  csr.handleFrame({ src: MESH_ID, plain: ext(0x8000, 0xff05, [0x5a, 0x3c, 1, 40, 7]) });
  csr.handleFrame({ src: MESH_ID, plain: ext(0x8000, 0xff11, nameBytes(LOC, '@SC1A2B')) });
  assert.equal(lines().length, LOG_PER_SENDER + 2);
  csr.handleFrame({ src: MESH_ID, plain: ext(0x8000, 0xff05, [0x5a, 0x3c, 1, 41, 8]) });
  assert.equal(lines().length, LOG_PER_SENDER + 2); // not the first FF05 any more
  c.t += 60 * 1000;
  csr.handleFrame({ src: MESH_ID, plain: fast(10) });
  assert.equal(lines().length, LOG_PER_SENDER + 3);
  assert.match(lines().find((line) => line.includes('op=FF05')), /, 6 not logged since$/);
  assert.match(lines()[lines().length - 1], /op=FF50 .*, 1 not logged since$/);
});

test('FF10 to everyone: not more often than every 10 min, or every 30 s when asked', async () => {
  const app = networkApp();
  const c = clock();
  const csr = new CsrNetwork(app, { now: c.now });
  assert.equal(await csr.requestNames(), true);
  assert.equal(await csr.requestNames(), false);
  c.t += 31 * 1000;
  assert.equal(await csr.requestNames(), false);
  assert.equal(await csr.requestNames({ asked: true }), true);
  c.t += 10 * 1000;
  assert.equal(await csr.requestNames({ asked: true }), false);
  assert.deepEqual(app.sent.map((s) => [s.plain.toString('hex'), s.meta.key]), [['0000ff100000', 'csr:names'], ['0000ff100000', 'csr:names']]);
});

test('a search sends FF10, listens, and gives the nodes heard', async () => {
  const app = networkApp();
  const csr = new CsrNetwork(app);
  const result = csr.search();
  await tick();
  assert.deepEqual([...app.homey.pending.values()].map((t) => t.ms), [SEARCH_LISTEN_MS]);
  csr.handleFrame({ src: MESH_ID, plain: ext(0x8000, 0xff11, nameBytes(LOC, '@GD3C4D')) });
  app.homey.runAll();
  const nodes = await result;
  assert.deepEqual(nodes.map((n) => [n.meshId, n.name, n.product.generation]), [[MESH_ID, '@GD3C4D', 'Gen4']]);
  assert.deepEqual(app.sent[0].meta, { key: 'csr:names', listenMs: SEARCH_LISTEN_MS + LISTEN_MARGIN_MS },
    'its link listens for the answers, also when it is not held');
});

// Runs requestNames to its end: the gaps between the variants are fake timers.
async function namesSent(csr, c, options) {
  let done = false;
  const result = csr.requestNames(options).then((value) => { done = true; return value; });
  while (!done) {
    await tick();
    if (done) break;
    c.t += 2000;
    csr.homey.runAll();
  }
  return result;
}

test('FF10 with each location id known: 00 00 first, then each one, on links that listen; the limit stops none', async () => {
  const app = networkApp();
  app.knownLocations = () => [LOC, 0x1234];
  const c = clock();
  const csr = new CsrNetwork(app, { now: c.now });
  const listenMs = SEARCH_LISTEN_MS + LISTEN_MARGIN_MS;
  assert.equal(await namesSent(csr, c, { asked: true, listenMs }), true);
  assert.deepEqual(app.sent.map((s) => [s.plain.toString('hex'), s.meta]), [
    ['0000ff100000', { key: 'csr:names', listenMs }],
    ['0000ff105a3c', { key: `csr:names:${LOC}`, listenMs }],
    ['0000ff101234', { key: 'csr:names:4660', listenMs }],
  ]);
  assert.deepEqual(csr._nameRequests.map((r) => r.at - csr._nameRequests[0].at), [0, 2000, 4000]);
  assert.deepEqual(app.logs.filter((line) => line.startsWith('[CSR] FF10')), [
    '[CSR] FF10 name request to everyone, loc=0x0000',
    '[CSR] FF10 name request to everyone, loc=0x5a3c',
    '[CSR] FF10 name request to everyone, loc=0x1234',
  ]);
  // Within NAME_REQUEST_MIN_MS of the request as a whole: none of it again.
  assert.equal(await csr.requestNames({ asked: true, listenMs }), false);
  assert.equal(app.sent.length, 3);
});

test('an FF11 says which FF10 variant it came after; the same answer after each variant is logged', async () => {
  const app = networkApp();
  app.knownLocations = () => [LOC];
  const c = clock();
  const csr = new CsrNetwork(app, { now: c.now });
  let done = false;
  const sending = csr.requestNames({ asked: true, listenMs: 9000 }).then(() => { done = true; });
  await tick();
  c.t += 400;
  const answer = ext(0x8000, 0xff11, nameBytes(LOC, '@SC1A2B'));
  csr.handleFrame({ src: MESH_ID, plain: answer });
  c.t += 1600;
  app.homey.runAll();
  await tick();
  await tick();
  assert.equal(done, true);
  c.t += 700;
  csr.handleFrame({ src: MESH_ID, plain: answer });
  await sending;
  const lines = app.logs.filter((line) => line.includes('op=FF11'));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /reset=0 after FF10 loc=0x0000 \(\+0\.4 s\)$/);
  assert.match(lines[1], /reset=0 after FF10 loc=0x5a3c \(\+0\.7 s\)$/);
});

test('FF10 at start listens, as in a search; FF04 listens for its FF05', async () => {
  const app = networkApp();
  const csr = new CsrNetwork(app);
  csr.start();
  app.homey.runAll();
  await tick();
  await csr.requestStatus(MESH_ID, LOC);
  assert.deepEqual(app.sent.map((s) => s.meta),
    [{ key: 'csr:names', listenMs: NAME_LISTEN_MS }, { key: `csr:status:${MESH_ID}`, listenMs: STATUS_LISTEN_MS }]);
  assert.equal(NAME_LISTEN_MS, SEARCH_LISTEN_MS + LISTEN_MARGIN_MS);
});

test('an FF10 whose link did not listen does not stop one that listens; one that listened does', async () => {
  const app = networkApp();
  const c = clock();
  const csr = new CsrNetwork(app, { now: c.now });
  assert.equal(await csr.requestNames({ asked: true }), true);
  c.t += 5000;
  assert.equal(await csr.requestNames({ asked: true }), false, 'without listening, the limit as before');
  assert.equal(await csr.requestNames({ asked: true, listenMs: NAME_LISTEN_MS }), true);
  c.t += 5000;
  assert.equal(await csr.requestNames({ asked: true, listenMs: NAME_LISTEN_MS }), false);
  assert.equal(await csr.requestNames({ asked: true }), false);
  assert.deepEqual(app.sent.map((s) => s.meta), [{ key: 'csr:names' }, { key: 'csr:names', listenMs: NAME_LISTEN_MS }]);
});

test('FFFF: 00 to the app\'s own address, once, on a link that listens for the status it brings', async () => {
  const app = networkApp();
  const csr = new CsrNetwork(app);
  await csr.requestAllStatus();
  assert.deepEqual(app.sent.map((s) => [s.plain.toString('hex'), s.meta]),
    [['0080ffff00', { key: 'csr:status-all', listenMs: STATUS_LISTEN_MS }]]);
  assert.ok(app.logs.includes('[CSR] FFFF status request to everyone'));
  assert.equal(proto.statusRequestData().toString('hex'), '0080ffff00');
});

// ---- the device

function deviceApp(extra = {}) {
  const app = networkApp();
  app.shared = null;
  app.sharedLocation = () => app.shared;
  app.statusUnreadableText = () => null;
  app.csr = { names: 0, statuses: [], requestNames: async (options) => { app.csr.names += 1; app.csr.asked = options; return true; },
    requestStatus: async (id, loc) => { app.csr.statuses.push([id, loc]); return true; } };
  return Object.assign(app, extra);
}

async function csrDevice(app, store = {}, { dim = true } = {}) {
  const device = new SGCsrDevice({
    homey: fake.fakeHomey(app), store: { meshId: MESH_ID, prefix: '@SC', kind: dim ? 'dimmable' : 'onoff', ...store },
    settings: { passphrase: 'test-only-pass' }, data: { id: '@SC1A2B' }, name: 'csr',
  });
  if (!dim) device.hasCapability = (capability) => capability === 'onoff';
  await device.onInit();
  return device;
}

test('a command is one FF03 to the mesh id, with the location id and tid 1, 2 and 1 again after 10 s', async () => {
  const app = deviceApp();
  const device = await csrDevice(app, { locationId: LOC });
  const realNow = Date.now;
  let t = 5000000;
  Date.now = () => t;
  try {
    device._request(40);
    await tick();
    t += 3000;
    device._request(0);
    await tick();
    t += 11000;
    device._request(55);
    await tick();
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(app.sent.map((s) => s.plain.toString('hex')),
    ['2301ff035a3c0128010000', '2301ff035a3c0000020000', '2301ff035a3c0137010000']);
  assert.deepEqual(app.sent.map((s) => s.meta.key), ['csr:291', 'csr:291', 'csr:291']);
});

test('tid: 10.5 s after the last command it goes on, 11 s after it is 1 again (whole seconds)', async () => {
  const app = deviceApp();
  const device = await csrDevice(app, { locationId: LOC });
  const realNow = Date.now;
  let t = 5000000;
  Date.now = () => t;
  try {
    for (const gap of [0, 2000, 10500, 10999, 11000, 3000]) {
      t += gap;
      device._request(40);
      await tick();
    }
  } finally {
    Date.now = realNow;
  }
  // tid is the two bytes after the level: 1, 2, 3 (10.5 s), 4 (10.999 s), 1 (11 s), 2.
  assert.deepEqual(app.sent.map((s) => s.plain.readUInt16LE(8)), [1, 2, 3, 4, 1, 2]);
});

test('tunable white: FF03 carries the last white value reported; other products send 0', async () => {
  const app = deviceApp();
  const tw = await csrDevice(app, { locationId: LOC, tunableWhite: true });
  tw.applyCsrStatus(proto.parseCsrStatus(Buffer.from([0x5a, 0x3c, 1, 40, 7, 1, 2, 0x33, 0x80])), 'FF05');
  tw._request(60);
  await tick();
  assert.equal(app.sent[0].plain.toString('hex').slice(-2), '33');
  const plain = await csrDevice(app, { locationId: LOC });
  plain.applyCsrStatus(proto.parseCsrStatus(Buffer.from([0x5a, 0x3c, 1, 40, 7, 1, 2, 0x33, 0x80])), 'FF05');
  plain._request(60);
  await tick();
  assert.equal(app.sent[1].plain.toString('hex').slice(-2), '00');
});

test('without a location id: the level waits, names are asked for, and FF11 brings the location id and sends it', async () => {
  const app = deviceApp();
  const device = await csrDevice(app);
  assert.equal(device.warning, 'device.waitingForStatus');
  device._request(30);
  await tick();
  assert.equal(app.sent.length, 0);
  assert.equal(app.csr.names, 1);
  assert.deepEqual(app.csr.asked, { asked: true, listenMs: NAME_LISTEN_MS }, 'its link listens for the FF11');
  device.applyCsrName({ location: LOC, name: '@SC1A2B', resets: 0 });
  await tick();
  assert.equal(app.sent.length, 1);
  assert.equal(app.sent[0].plain.toString('hex'), '2301ff035a3c011e010000');
  assert.equal(device._store.locationId, LOC);
  assert.equal(device.warning, null);
  assert.equal(device.available, true);
});

test('without its own location id it uses the one the first generation dimmers share; a kept level is dropped after 30 s', async () => {
  const app = deviceApp();
  app.shared = LOC;
  const device = await csrDevice(app);
  device._request(20);
  await tick();
  assert.equal(app.sent[0].plain.toString('hex'), '2301ff035a3c0114010000');
  assert.ok(device.logs.some((line) => line.includes('(from the other devices)')));

  const lonely = await csrDevice(deviceApp());
  lonely._request(20);
  lonely.homey.runAll();
  assert.equal(lonely._pendingLevel, null);
  assert.ok(lonely.logs.some((line) => line.includes('kept level 20 dropped')));
});

test('status: FF05 and FF50 set onoff and dim; a repeated or older number soon after (Gen3) and another home are ignored', async () => {
  const app = deviceApp();
  const device = await csrDevice(app, { locationId: LOC });
  device.applyCsrStatus(proto.parseCsrStatus(Buffer.from([0x5a, 0x3c, 1, 40, 7])), 'FF05');
  await tick();
  assert.equal(device.getCapabilityValue('onoff'), true);
  assert.equal(device.getCapabilityValue('dim'), 0.4);
  device.applyCsrStatus(proto.parseCsrStatus(Buffer.from([0x5a, 0x3c, 1, 70, 7])), 'FF05');
  device.applyCsrStatus(proto.parseCsrStatus(Buffer.from([0x5a, 0x3c, 1, 70, 6])), 'FF05');
  await tick();
  assert.equal(device.getCapabilityValue('dim'), 0.4);
  device.applyCsrStatus(proto.parseCsrStatus(Buffer.from([0x5a, 0x3c, 0, 0, 8])), 'FF05');
  await tick();
  assert.equal(device.getCapabilityValue('onoff'), false);
  device.applyCsrStatus(proto.parseCsrFastStatus(Buffer.from([0x5a, 0x3c, 1, 55, 2, 0, 0, 0])), 'FF50');
  await tick();
  assert.equal(device.getCapabilityValue('dim'), 0.55);
  device.applyCsrStatus(proto.parseCsrFastStatus(Buffer.from([0x11, 0x11, 1, 90, 3, 0, 0, 0])), 'FF50');
  await tick();
  assert.equal(device.getCapabilityValue('dim'), 0.55);
  assert.equal(device.getCsrLocationId(), LOC);
});

test('the number in FF05: Gen3 and Gen4 only, up to 8 whole seconds after the last status taken, round past 255', async () => {
  const app = deviceApp();
  const gen3 = await csrDevice(app, { locationId: LOC, prefix: '@SC' });
  const gen2 = await csrDevice(app, { locationId: LOC, prefix: '@MC' });
  const realNow = Date.now;
  let t = 5000000;
  Date.now = () => t;
  const levels = [];
  const ff05 = (device, id, level, ms) => {
    t += ms;
    const bytes = id === null ? [0x5a, 0x3c, 1, level] : [0x5a, 0x3c, 1, level, id];
    device.applyCsrStatus(proto.parseCsrStatus(Buffer.from(bytes)), 'FF05');
    levels.push(Math.round(device._lastDim * 100));
  };
  try {
    ff05(gen3, 7, 40, 0); // taken
    ff05(gen3, 7, 41, 3000); // the same, 3 s later: dropped
    ff05(gen3, 7, 42, 5900); // 8.9 s after the last one taken: dropped
    ff05(gen3, 7, 43, 100); // 9 s: taken
    t += 3000;
    gen3.applyCsrStatus(proto.parseCsrFastStatus(Buffer.from([0x5a, 0x3c, 1, 44, 1, 0, 0, 0])), 'FF50'); // taken, 12 s
    ff05(gen3, 7, 45, 8500); // 8.5 s after the FF50: dropped
    ff05(gen3, 250, 46, 0); // higher: taken
    ff05(gen3, 5, 47, 1000); // round past 255, 10 back: taken
    ff05(gen3, 200, 48, 1000); // higher: taken
    ff05(gen3, 150, 49, 1000); // lower, not round: dropped
    ff05(gen3, null, 50, 1000); // no byte 4 is 256, higher: taken
    ff05(gen3, null, 51, 1000); // 256 again: dropped
    ff05(gen2, 7, 60, 0);
    ff05(gen2, 7, 61, 1000); // Gen2: not checked
    ff05(gen2, 6, 62, 1000);
  } finally {
    Date.now = realNow;
  }
  // The level shown after each FF05 (the FF50 set 44 in between).
  assert.deepEqual(levels, [40, 40, 40, 43, 44, 46, 47, 48, 48, 50, 50, 60, 61, 62]);
});

test('an ON-OFF Pill: on is pwr 01 with level 00, off is 00 00', async () => {
  const app = deviceApp();
  const pill = await csrDevice(app, { locationId: LOC, prefix: '@SE' }, { dim: false });
  pill._request(pill._levelFor({ onoff: true }));
  await tick();
  pill._request(pill._levelFor({ onoff: false }));
  await tick();
  assert.deepEqual(app.sent.map((s) => s.plain.toString('hex').slice(12, 16)), ['0100', '0000']);
  assert.ok(pill.logs.some((line) => /^command FF03 id=0x0123 on level=0 /.test(line)));
  assert.ok(pill.logs.some((line) => /^command FF03 id=0x0123 off level=0 /.test(line)));
  // A dimmable device as before: the power byte follows the level.
  assert.equal(proto.csrLevelData({ meshId: MESH_ID, location: LOC, level: 40, tid: 1 }).toString('hex').slice(12, 16), '0128');
  assert.equal(proto.csrLevelData({ meshId: MESH_ID, location: LOC, level: 0, on: true, tid: 1 }).toString('hex').slice(12, 16), '0100');
});

test('status is asked for after start and then every 10 minutes; without a location id, names instead', async () => {
  const app = deviceApp();
  const device = await csrDevice(app, { locationId: LOC });
  device.requestStatus();
  await tick();
  assert.deepEqual(app.csr.statuses, [[MESH_ID, LOC]]);
  const unknown = await csrDevice(app);
  unknown.requestStatus();
  assert.equal(app.csr.names, 1);
  assert.deepEqual(app.csr.asked, { asked: true, listenMs: NAME_LISTEN_MS });
});

test('the password warning shows on these devices too, and they stay available', async () => {
  const app = deviceApp();
  app.statusUnreadableText = () => 'device.passwordWrong';
  const device = await csrDevice(app, { locationId: LOC });
  assert.equal(device.warning, 'device.passwordWrong');
  assert.equal(device.available, true);
});

// ---- pairing

test('the Pill family: 15 prefixes, Gen2 to Gen4, the DALI Pill not among them; sg_pill adds them', () => {
  assert.equal(PILL_PREFIXES.length, 15);
  assert.equal(new Set(PILL_PREFIXES).size, 15);
  for (const prefix of PILL_PREFIXES) {
    const product = csrProductForName(`${prefix}0000`);
    assert.equal(product.form, 'pill', prefix);
    assert.ok(['dimmable', 'onoff'].includes(product.kind), prefix);
  }
  assert.ok(!PILL_PREFIXES.includes('@GY'));
  const pills = Object.keys(CSR_PRODUCTS).filter((prefix) => CSR_PRODUCTS[prefix].form === 'pill' && prefix !== '@GY');
  assert.deepEqual([...pills].sort(), [...PILL_PREFIXES].sort());
  for (const prefix of PILL_PREFIXES) assert.equal(csrDriverFor(csrProductForName(`${prefix}0000`)), 'sg_pill', prefix);
  assert.equal(csrDriverFor(null), null);
});

test('pairing: scanned names and FF11 answers together; a Pill with a mesh id can be added, other products are logged', async () => {
  const app = networkApp();
  const nodes = [
    { meshId: MESH_ID, name: '@SC1A2B', product: csrProductForName('@SC1A2B'), location: LOC },
    { meshId: 0x0126, name: '@GE9C0D', product: csrProductForName('@GE9C0D'), location: LOC },
    { meshId: 0x0124, name: '@GB3C4D', product: csrProductForName('@GB3C4D'), location: LOC },
    { meshId: 0x0125, name: '@SX5E6F', product: csrProductForName('@SX5E6F'), location: LOC },
  ];
  app.csr = fake.fakeCsr(nodes);
  const advertisements = [
    { uuid: 'a', localName: '@SC1A2B', rssi: -60 },
    { uuid: 'b', localName: '@MJ7A8B', rssi: -70 },
    { uuid: 'c', localName: '@ND1A2B', rssi: -50 },
  ];
  const driver = new SGPillDriver({ homey: fake.listenAtOnce(fake.fakeHomey(app, { ble: { discover: async () => advertisements } })) });
  driver.getDevices = () => [];
  const { devices, found } = await driver._search();
  assert.deepEqual(found.map((f) => [f.name, f.state]).sort(),
    [['@GB3C4D', 'notYet'], ['@GE9C0D', 'add'], ['@MJ7A8B', 'noAnswer'], ['@SC1A2B', 'add'], ['@SX5E6F', 'notYet']]);
  const pill = devices.find((d) => d.data.id === '@SC1A2B');
  assert.equal(pill.name, 'LEDDim Smart Pill 1A2B');
  assert.equal(pill.class, undefined, 'a light, the driver\'s class');
  assert.equal(pill.icon, '/icons/pill.svg');
  assert.deepEqual(pill.capabilities, ['onoff', 'dim']);
  assert.deepEqual(pill.store, { meshId: MESH_ID, prefix: '@SC', kind: 'dimmable', tunableWhite: false, locationId: LOC });
  const onOff = devices.find((d) => d.data.id === '@GE9C0D');
  assert.equal(onOff.name, 'Smart Pill ON-OFF 9C0D');
  assert.equal(onOff.class, undefined, 'a light, the driver\'s class');
  assert.deepEqual(onOff.capabilities, ['onoff']);
  assert.equal(devices.length, 2);
  assert.ok(driver.logs.some((line) => line.includes('4 FF11 answer(s), 5 SG device(s) after Gen1')));
  assert.ok(driver.logs.some((line) => line.includes('@GB Gen4 onoff notYet') && line.includes('@SX Gen3 switch notYet')));
  assert.ok(!driver.logs.some((line) => /1A2B|3C4D|5E6F|7A8B|9C0D/.test(line)));

  driver.getDevices = () => [{ getData: () => ({ id: '@SC1A2B' }) }];
  const again = await driver._search();
  assert.equal(again.found.find((f) => f.name === '@SC1A2B').state, 'added');
  assert.ok(!again.devices.some((d) => d.data.id === '@SC1A2B'));
});

test('icons: the Pill icon for every Pill, no other icons, the driver icon, and the guide before the search', () => {
  const fs = require('fs');
  const path = require('path');
  const assets = path.join(__dirname, '..', 'drivers', 'sg_pill', 'assets');
  assert.ok(fs.existsSync(path.join(assets, 'icon.svg')));
  assert.deepEqual(ICON_NAMES, ['pill']);
  assert.deepEqual(fs.readdirSync(path.join(assets, 'icons')).filter((file) => file.endsWith('.svg')), ['pill.svg']);
  for (const prefix of PILL_PREFIXES) assert.equal(csrProductForName(`${prefix}0000`).icon, 'pill', prefix);
  for (const prefix of Object.keys(CSR_PRODUCTS)) {
    const { icon } = csrProductForName(`${prefix}0000`);
    assert.ok(icon === null || ICON_NAMES.includes(icon), prefix);
  }
  const pair = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'drivers', 'sg_pill', 'driver.compose.json'), 'utf8')).pair;
  assert.deepEqual(pair.map((step) => [step.id, step.template, step.navigation]), [
    ['guide', undefined, { next: 'loading' }],
    ['loading', 'loading', { next: 'list_devices' }],
    ['list_devices', 'list_devices', { prev: 'guide', next: 'add_devices' }],
    ['add_devices', 'add_devices', undefined],
  ]);
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'drivers', 'sg_pill', 'pair', 'search.html')));
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'drivers', 'sg_csr')), 'the driver is sg_pill now');
});

// A pair session as far as onPair uses it: handlers, and the step to the next view.
const pairSession = () => {
  const session = { handlers: {}, views: [] };
  session.setHandler = (name, handler) => { session.handlers[name] = handler; };
  session.showView = async (view) => { session.views.push(view); };
  session.show = (view) => session.handlers.showView(view);
  return session;
};

// sg_pill with these FF11 answers and this scan (a list, or a function giving
// one); the listening after FF10 is over at once unless listen is false.
const pairDriver = (nodes, advertisements = [], { listen = true } = {}) => {
  const app = networkApp();
  app.csr = fake.fakeCsr(nodes);
  const discover = async () => (typeof advertisements === 'function' ? advertisements() : advertisements);
  const homey = fake.fakeHomey(app, { ble: { discover } });
  const driver = new SGPillDriver({ homey: listen ? fake.listenAtOnce(homey) : homey });
  driver.getDevices = () => [];
  return { driver, searches: () => app.csr.sent };
};

// The pairing steps in the log (the search's own summary line left out).
const pairSteps = (driver) => driver.logs.filter((line) => /^pair: (showView|to the list|not to the list|list_devices)/.test(line));

const PILL = { meshId: MESH_ID, name: '@SC1A2B', product: csrProductForName('@SC1A2B'), location: LOC };
const SWITCH = { meshId: 0x0125, name: '@SX5E6F', product: csrProductForName('@SX5E6F'), location: LOC };
const PLUG = { meshId: 0x0124, name: '@GB3C4D', product: csrProductForName('@GB3C4D'), location: LOC };

test('pairing: the search runs in Homey\'s loading view, which moves on to the list by itself', async () => {
  const { driver, searches } = pairDriver([PILL, SWITCH]);
  const session = pairSession();
  await driver.onPair(session);
  await session.show('guide');
  assert.equal(searches(), 0);
  await session.show('loading');
  assert.equal(searches(), 1);
  assert.deepEqual(session.views, ['list_devices'], 'the list by name, not nextView');
  assert.equal(driver.homey.pending.size, 0, 'the time limit is cleared');
  const devices = await session.handlers.list_devices();
  assert.deepEqual(devices.map((d) => d.data.id), ['@SC1A2B']);
  assert.equal(searches(), 1, 'the list uses the search from the loading view');
  assert.deepEqual(pairSteps(driver), [
    'pair: showView guide', 'pair: showView loading', 'pair: to the list', 'pair: to the list done',
    'pair: list_devices', 'pair: list_devices: 1 device(s)',
  ]);
});

test('pairing: nothing found moves on all the same, to an empty list: Homey says no new devices were found, the log says why', async () => {
  const { driver } = pairDriver([], [{ uuid: 'a', localName: '@ND1A2B', rssi: -50 }]);
  const session = pairSession();
  await driver.onPair(session);
  await session.show('loading');
  assert.equal(session.views.length, 1);
  assert.deepEqual(await session.handlers.list_devices(), []);
  assert.equal(pairSteps(driver).at(-1), 'pair: list_devices: 0 device(s), none found');
});

test('pairing: no Pill, but other products: the list says so, and names those that cannot be added yet', async () => {
  const { driver } = pairDriver([SWITCH, PLUG, { ...PLUG, meshId: 0x0127, name: '@GB7A8B' }]);
  driver.homey.__ = (key, tokens) => (tokens ? `${key} ${JSON.stringify(tokens)}` : key);
  const session = pairSession();
  await driver.onPair(session);
  await session.show('loading');
  assert.equal(session.views.length, 1);
  await assert.rejects(session.handlers.list_devices(),
    { message: 'pair.found.noPill pair.found.notYet {"products":"Smart Switch, Smart Socket"}' });
  assert.equal(pairSteps(driver).at(-1), 'pair: list_devices: error found, none to add');
});

test('pairing: found, nothing to add and nothing else to say, goes on to Homey\'s list, which shows that itself', async () => {
  const { driver } = pairDriver([PILL]);
  driver.getDevices = () => [{ getData: () => ({ id: '@SC1A2B' }) }];
  const session = pairSession();
  await driver.onPair(session);
  await session.show('loading');
  assert.deepEqual(await session.handlers.list_devices(), []);
  assert.equal(pairSteps(driver).at(-1), 'pair: list_devices: 0 device(s), all added');
});

test('pairing: a failed scan fails the search: it moves on, and the list says the search failed', async () => {
  const { driver, searches } = pairDriver([PILL], () => { throw new Error('radio busy'); });
  const session = pairSession();
  await driver.onPair(session);
  await session.show('loading');
  assert.equal(session.views.length, 1);
  await assert.rejects(session.handlers.list_devices(), { message: 'pair.csr.failed' });
  assert.equal(searches(), 0, 'no FF10 after a failed scan');
  assert.ok(driver.errors.some((line) => line.includes('pair: scan failed: radio busy')));
  assert.ok(driver.errors.some((line) => line.includes('pair: search failed: radio busy')));
  assert.equal(pairSteps(driver).at(-1), 'pair: list_devices: error failed');
});

test('pairing: the 02FA data of each SG node, strongest first, with the first three characters of its name only', async () => {
  const fa = '000002fa-0000-1000-8000-00805f9b34fb';
  const { driver } = pairDriver([PILL], [
    { uuid: 'a', localName: '@SC1A2B', rssi: -72, serviceData: [{ uuid: fa, data: Buffer.from([0x10, 0x5a, 0x3c, 1, 2]) }] },
    { uuid: 'a', localName: '', rssi: -60 },
    { uuid: 'b', localName: '@ND3C4D', rssi: -80, serviceData: { '02fa': '105A3C1101' } },
    { uuid: 'c', localName: '', rssi: -50, serviceData: [{ uuid: fa, data: [0x10, 0, 0] }], connectable: false },
    { uuid: 'd', localName: 'Speaker', rssi: -40 },
  ]);
  await driver._search();
  assert.deepEqual(driver.logs.filter((line) => line.startsWith('pair: SG nodes')), [
    'pair: SG nodes: 1: 02FA 100000, -50 dB, not connectable; 2: 02FA 105a3c0102, -60 dB, @SC; 3: 02FA 105a3c1101, -80 dB, @ND',
  ]);
  assert.ok(!driver.logs.some((line) => /1A2B|3C4D|Speaker/.test(line)), 'no name, no address');
  const none = pairDriver([], [{ uuid: 'd', localName: 'Speaker', rssi: -40 }]).driver;
  await none._search();
  assert.ok(none.logs.includes('pair: SG nodes: none'));
});

// A bridge pause that records itself in steps: its start, and each end with why.
const recordPause = (steps) => async (label) => {
  steps.push(`pause ${label}`);
  return (why) => steps.push(`end ${why}`);
};

// Enough turns for a search with its pause to get as far as it can.
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise(setImmediate);
};

test('pairing: the held link and the status poll wait from before the scan until the list is answered, also after FF10', async () => {
  for (const fails of [false, true]) {
    const steps = [];
    const { driver } = pairDriver(() => { steps.push('FF10'); return [PILL]; }, async () => {
      steps.push('scan');
      if (fails) throw new Error('radio busy');
      return [{ uuid: 'a', localName: '@SC1A2B', rssi: -60 }];
    });
    driver.homey.app.bridge.pauseForScan = recordPause(steps);
    const session = pairSession();
    await driver.onPair(session);
    await session.show('loading');
    assert.deepEqual(steps, fails ? ['pause pairing scan', 'scan'] : ['pause pairing scan', 'scan', 'FF10'],
      'not over with the search, nor after the listening');
    if (fails) await assert.rejects(session.handlers.list_devices(), { message: 'pair.csr.failed' });
    else assert.equal((await session.handlers.list_devices()).length, 1);
    assert.deepEqual(steps.slice(-1), ['end list answered']);
    await session.handlers.disconnect();
    await settle();
    assert.equal(steps.filter((step) => step.startsWith('end')).length, 1, 'closed after the list: nothing more to end');
    assert.ok(driver.logs.includes('pair: closed, nothing paused'));
  }
});

test('pairing: closed in the middle, the pause ends once the search is over, after FF10 and its listening', async () => {
  const steps = [];
  const { driver } = pairDriver(() => { steps.push('FF10'); return [PILL]; }, [{ uuid: 'a', localName: '@SC1A2B', rssi: -60 }],
    { listen: false });
  driver.homey.app.bridge.pauseForScan = recordPause(steps);
  const session = pairSession();
  await driver.onPair(session);
  const searching = session.show('loading');
  await settle();
  assert.deepEqual(steps, ['pause pairing scan', 'FF10']);
  assert.ok([...driver.homey.pending.values()].some((timer) => timer.ms === SEARCH_LISTEN_MS), 'it listens');
  await session.handlers.disconnect();
  assert.ok(driver.logs.includes('pair: closed'));
  await settle();
  assert.deepEqual(steps, ['pause pairing scan', 'FF10'], 'not while it listens for the answers');
  driver.homey.runMs(SEARCH_LISTEN_MS);
  await searching;
  await settle();
  assert.deepEqual(steps, ['pause pairing scan', 'FF10', 'end pairing closed']);
});

test('pairing: the scan first, then FF10, so that connecting for it does not compete with the scan', async () => {
  const steps = [];
  const { driver } = pairDriver(() => { steps.push('FF10'); return [PILL]; }, async () => {
    steps.push('scan');
    await new Promise(setImmediate);
    steps.push('scan done');
    return [{ uuid: 'a', localName: '@SC1A2B', rssi: -60 }];
  });
  const { devices } = await driver._search();
  assert.deepEqual(steps, ['scan', 'scan done', 'FF10']);
  assert.deepEqual(driver.homey.app.csr.asked, { asked: true, listenMs: SEARCH_LISTEN_MS + LISTEN_MARGIN_MS },
    'the search\'s FF10 goes on a link that listens');
  assert.deepEqual(devices.map((d) => d.data.id), ['@SC1A2B']);
  assert.ok(driver.logs.some((line) => /^pair: scan \d+\.\d s, 1 advertisement\(s\), 1 FF11 answer\(s\)/.test(line)));
});

test('pairing: FF10 out, then SEARCH_LISTEN_MS of answers before the list', async () => {
  const { driver } = pairDriver([PILL], [], { listen: false });
  const searching = driver._search();
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.deepEqual([...driver.homey.pending.values()].map((t) => t.ms), [SEARCH_LISTEN_MS]);
  assert.ok(driver.logs.some((line) => /^pair: FF10 out after \d+\.\d s$/.test(line)));
  driver.homey.runMs(SEARCH_LISTEN_MS);
  assert.deepEqual((await searching).devices.map((d) => d.data.id), ['@SC1A2B']);
});

test('pairing: FF10 that fails: no listening, the list shows what was found, and the log says FF10 did not get out', async () => {
  const { driver } = pairDriver(() => { throw new Error('radio busy'); }, [{ uuid: 'a', localName: '@SC1A2B', rssi: -60 }]);
  driver.homey.app.csr.nodes.set(MESH_ID, { ...PILL, seenAt: 1 }); // heard before, from the FF10 at start
  const session = pairSession();
  await driver.onPair(session);
  await session.show('loading');
  assert.deepEqual((await session.handlers.list_devices()).map((d) => d.data.id), ['@SC1A2B']);
  assert.ok(driver.errors.some((line) => line.includes('pair: FF10 failed: radio busy')));
  assert.ok(driver.errors.some((line) => /^pair: FF10 not delivered after \d+\.\d s, no listening$/.test(line)));
  assert.ok(!driver.errors.some((line) => line.includes('search failed')));
});

test('pairing: the list without a search from the loading view searches itself, and says so', async () => {
  const { driver, searches } = pairDriver([PILL]);
  const session = pairSession();
  await driver.onPair(session);
  assert.equal((await session.handlers.list_devices()).length, 1);
  assert.equal(searches(), 1);
  assert.deepEqual(pairSteps(driver), ['pair: list_devices, no search yet', 'pair: list_devices: 1 device(s)']);
});

test('pairing: a failed move to the list is logged and passed on', async () => {
  const { driver } = pairDriver([PILL]);
  const session = pairSession();
  session.showView = async () => { throw new Error('no such view'); };
  await driver.onPair(session);
  await assert.rejects(session.show('loading'), { message: 'no such view' });
  assert.ok(driver.errors.some((line) => line.includes('pair: to the list failed: no such view')));
  assert.ok(!pairSteps(driver).includes('pair: to the list done'));
});

test('pairing: FF10 that never gets out: after FF10_WITHIN_MS, no listening, and the list shows what the scan found', async () => {
  const { driver } = pairDriver(() => new Promise(() => {}), [{ uuid: 'a', localName: '@SC1A2B', rssi: -60 }]);
  driver.homey.app.csr.nodes.set(MESH_ID, { ...PILL, seenAt: 1 });
  const session = pairSession();
  await driver.onPair(session);
  const searching = session.show('loading');
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.deepEqual([...driver.homey.pending.values()].map((t) => t.ms).sort((a, b) => a - b), [FF10_WITHIN_MS, SEARCH_LIMIT_MS]);
  driver.homey.runMs(FF10_WITHIN_MS);
  await searching;
  assert.equal(driver.homey.pending.size, 0, 'no listening, and the whole limit is cleared');
  assert.deepEqual(session.views, ['list_devices']);
  assert.deepEqual((await session.handlers.list_devices()).map((d) => d.data.id), ['@SC1A2B']);
  assert.ok(driver.errors.some((line) => line === `pair: FF10 not out in ${FF10_WITHIN_MS / 1000} s, no listening`));
});

test('pairing: the limits, from the longest a send may take to connect in lib/MeshBridge.js', () => {
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'lib', 'MeshBridge.js'), 'utf8');
  const ms = (name) => Number(new RegExp(`const ${name} = (\\d+);`).exec(bridge)[1]);
  const round = ms('CONNECT_WINDOW_MS') + ms('CONNECT_AFTER_HANGUP_TIMEOUT_MS') + ms('MAX_READY_AGE_MS');
  assert.equal(round, 54000);
  assert.ok(ms('RETRY_STRONG_AFTER_MS') < ms('CONNECT_WINDOW_MS'));
  const send = 3000 + round + 2 * 10000 + round + 1000; // status link, two rounds, find() and discover(), write
  assert.equal(send, 132000);
  assert.ok(FF10_WITHIN_MS >= send && FF10_WITHIN_MS <= send + 5000, `${FF10_WITHIN_MS} ms`);
  assert.equal(SEARCH_LIMIT_MS, SCAN_MS + FF10_WITHIN_MS + SEARCH_LISTEN_MS + 7000);
  assert.equal(SEARCH_LIMIT_MS, 160000);
  assert.equal(ms('PAIRING_PAUSE_MAX_MS'), SEARCH_LIMIT_MS + 20000, 'the longest search and 20 s for the list');
});

test('pairing: FF10 that does not get out, and nothing to add: "Search failed", as no Pill can be added without its answer', async () => {
  const seen = [{ uuid: 'a', localName: '@SC1A2B', rssi: -60 }];
  const late = pairDriver(() => new Promise(() => {}), seen);
  const session = pairSession();
  await late.driver.onPair(session);
  const searching = session.show('loading');
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  late.driver.homey.runMs(FF10_WITHIN_MS);
  await searching;
  await assert.rejects(session.handlers.list_devices(), { message: 'pair.csr.failed' });
  assert.equal(pairSteps(late.driver).at(-1), 'pair: list_devices: error failed, FF10 not out');

  const failing = pairDriver(() => { throw new Error('radio busy'); }, seen);
  const again = pairSession();
  await failing.driver.onPair(again);
  await again.show('loading');
  await assert.rejects(again.handlers.list_devices(), { message: 'pair.csr.failed' });

  const nothing = pairDriver(() => { throw new Error('radio busy'); });
  const third = pairSession();
  await nothing.driver.onPair(third);
  await third.show('loading');
  await assert.rejects(third.handlers.list_devices(), { message: 'pair.csr.failed' }, 'also with nothing seen');
});

test('pairing: a Pill seen but without an answer, FF10 out: an empty list, and the log says why', async () => {
  const { driver } = pairDriver([], [{ uuid: 'a', localName: '@SC1A2B', rssi: -60 }]);
  const session = pairSession();
  await driver.onPair(session);
  await session.show('loading');
  assert.deepEqual(await session.handlers.list_devices(), []);
  assert.equal(pairSteps(driver).at(-1), 'pair: list_devices: 0 device(s), no answer from a Pill seen');
});

test('pairing: FF10 out less than 30 s ago: none now, the answers are listened for, and an empty search is an empty list', async () => {
  const { driver, searches } = pairDriver([PILL]);
  driver.homey.app.csr._lastNameRequestAt = Date.now() - 5000;
  driver.homey.app.csr._lastListeningNameRequestAt = Date.now() - 5000;
  const session = pairSession();
  await driver.onPair(session);
  await session.show('loading');
  assert.equal(searches(), 0, 'no FF10 now');
  assert.ok(driver.logs.includes('pair: FF10 out less than 30 s ago, none now'));
  assert.deepEqual(await session.handlers.list_devices(), []);
  assert.equal(pairSteps(driver).at(-1), 'pair: list_devices: 0 device(s), none found');
});

test('pairing: an FF10 less than 30 s ago whose link did not listen does not count: the search sends its own', async () => {
  const { driver, searches } = pairDriver([PILL]);
  driver.homey.app.csr._lastNameRequestAt = Date.now() - 5000;
  driver.homey.app.csr._lastListeningNameRequestAt = null;
  const session = pairSession();
  await driver.onPair(session);
  await session.show('loading');
  assert.equal(searches(), 1, 'FF10 now');
  assert.deepEqual(driver.homey.app.csr.asked, { asked: true, listenMs: NAME_LISTEN_MS });
  assert.ok(!driver.logs.includes('pair: FF10 out less than 30 s ago, none now'));
  assert.deepEqual((await session.handlers.list_devices()).map((d) => d.data.id), ['@SC1A2B']);
});

test('pairing: a scan that never ends fails after the whole limit, and the loading view moves on', async () => {
  const { driver } = pairDriver([PILL], () => new Promise(() => {}));
  const session = pairSession();
  await driver.onPair(session);
  const searching = session.show('loading');
  await new Promise(setImmediate);
  assert.deepEqual([...driver.homey.pending.values()].map((t) => t.ms), [SEARCH_LIMIT_MS]);
  driver.homey.runAll();
  await searching;
  assert.equal(session.views.length, 1);
  await assert.rejects(session.handlers.list_devices(), { message: 'pair.csr.failed' });
});

test('pairing: only the last search, while its loading view shows, moves on', async () => {
  const answers = [];
  const { driver } = pairDriver(() => new Promise((resolve) => { answers.push(resolve); }));
  const session = pairSession();
  await driver.onPair(session);
  const first = session.show('loading');
  await new Promise(setImmediate);
  await session.show('guide');
  const second = session.show('loading');
  await new Promise(setImmediate);
  answers[0]([PILL]);
  await first;
  assert.equal(session.views.length, 0, 'an earlier search does not move on');
  answers[1]([PILL]);
  await second;
  assert.equal(session.views.length, 1);
  const third = session.show('loading');
  await new Promise(setImmediate);
  await session.show('guide');
  answers[2]([PILL]);
  await third;
  assert.equal(session.views.length, 1, 'back to the guide during the search: no move');
  assert.ok(pairSteps(driver).includes('pair: not to the list, a newer search runs'));
  assert.equal(pairSteps(driver).at(-1), 'pair: not to the list, guide shows');
});
