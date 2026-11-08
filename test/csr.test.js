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
  THERMOSTAT_EVERY_MS, THERMOSTAT_GAP_MS, THERMOSTAT_LISTEN_MS, THERMOSTAT_SETTINGS_EVERY_MS,
  THERMOSTAT_SCAN_RETRY_MS,
} = require('../lib/CsrNetwork');
const MeshBridge = require('../lib/MeshBridge');
const SGCsrDevice = require('../lib/SGCsrDevice');
const SGPillDriver = require('../drivers/sg_pill/driver');
const {
  FF10_WITHIN_MS, SCAN_MS, SEARCH_LIMIT_MS, laterFindings, withStates,
} = require('../lib/csrPairing');

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
    { location: LOC, on: true, level: 40, number: 7, firmware: null, white: null, flags: null });
  assert.deepEqual(proto.parseCsrStatus(Buffer.from([0x5a, 0x3c, 1, 40, 7, 1, 2, 0x33, 0x80])),
    { location: LOC, on: true, level: 40, number: 7, firmware: 0x0102, white: 0x33, flags: 0x80 });
  assert.equal(proto.parseCsrStatus(Buffer.from([0x5a, 0x3c, 0, 0, 8])).level, 0);
  assert.equal(proto.parseCsrStatus(Buffer.from([0x5a, 0x3c, 1, 0])).level, null);
  assert.equal(proto.parseCsrStatus(Buffer.from([0x5a, 0x3c, 1])), null);
  assert.deepEqual(proto.parseCsrFastStatus(Buffer.from([0x5a, 0x3c, 1, 55, 7, 0, 0x21, 0])),
    { location: LOC, on: true, level: 55, tid: 7, white: 0x21 });
  // FF50: six bytes at least, and the white value only with eight.
  assert.equal(proto.parseCsrFastStatus(Buffer.from([0x5a, 0x3c, 1, 55, 7])), null);
  assert.deepEqual(proto.parseCsrFastStatus(Buffer.from([0x5a, 0x3c, 1, 55, 7, 0])),
    { location: LOC, on: true, level: 55, tid: 7, white: null });
  assert.equal(proto.parseCsrFastStatus(Buffer.from([0x5a, 0x3c, 1, 55, 7, 0, 0x21])).white, null);
  assert.deepEqual(proto.parseExt(ext(0x8000, 0xff05, [1, 2])), { dst: 0x8000, opcode: 0xff05, data: Buffer.from([1, 2]) });
  assert.equal(proto.parseExt(Buffer.from([0x01, 0x80, 0x73, 0xf7, 0, 0])), null);
});

test('products: 63 prefixes, Gen2 to Gen4, @ND and @GG not among them; CSRmesh service by its UUID', () => {
  assert.equal(Object.keys(CSR_PRODUCTS).length, 63);
  assert.deepEqual(csrProductForName('@sc1a2b'), { prefix: '@SC', ...CSR_PRODUCTS['@SC'], icon: 'pill' });
  assert.equal(csrProductForName('@GX1A2B').icon, null); // a switch is not added
  assert.equal(csrProductForName('@SC1A2B').name, 'LEDDim Smart Pill');
  assert.equal(csrProductForName('@GX1A2B').kind, 'switch');
  assert.equal(csrProductForName('@MW1A2B').tunableWhite, true);
  assert.equal(csrProductForName('@ND1A2B'), null);
  // A gateway's node may be named @GG: not a Color Controller; @GU still is.
  assert.equal(csrProductForName('@GG7A8C'), null);
  assert.equal(csrProductForName('@GU7A8C').name, 'LEDDim Smart Color Controller');
  assert.equal(canBeBridge('@GG7A8C'), false);
  const found = laterFindings([{ localName: '@GG7A8C', rssi: -60 }, { localName: '@GU7A8D', rssi: -60 }], []);
  assert.deepEqual(withStates(found, 'sg_mesh', new Set()).map((f) => [f.name, f.state]), [['@GU7A8D', 'notYet']]);
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
  // A peripheral without a name, by the last four characters of its id.
  bridge._preferredUuid = null;
  bridge._pickBridge([{ uuid: '0a1b2c3d4e5f60718293', localName: '', rssi: -47, serviceUuids: [FEF1] }]);
  assert.deepEqual(lines, ['bridge selected by RSSI: @SC1A2B -50 dBm', 'bridge selected by RSSI: @ND1A2B -40 dBm',
    'bridge selected by RSSI: c -45 dBm', 'bridge selected by RSSI: …8293 -47 dBm']);
});

test('the log names an id by its last four characters; four or fewer as they are', () => {
  const { lastFour } = require('../lib/lastFour');
  assert.equal(lastFour('0a1b2c3d4e5f60718293'), '…8293');
  assert.equal(lastFour('3ecaff672f673370'), '…3370');
  assert.equal(lastFour('abcd'), 'abcd');
  assert.equal(lastFour('c'), 'c');
  assert.equal(lastFour(undefined), '');
  assert.equal(lastFour(null), '');
});

test('no log line in the first generation bridge prints a peripheral id whole', () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'MeshBridge.js'), 'utf8');
  const logCalls = source.split('\n').filter((line) => /(_status|this\.log|this\.error|_debug)\(/.test(line) || /^\s+`/.test(line));
  // A characteristic's uuid (_char8003) is a fixed one, not a peripheral's.
  for (const line of logCalls) {
    assert.doesNotMatch(line, /\$\{(?![^}]*_char)[^}]*\b(?:uuid|_preferredUuid)\}/, line.trim());
  }
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

// ---- HeatReg Smart thermostats: read when added in Homey

// 0x0201 and 0x0202 are made-up mesh ids for an @MT and an @ST. The formats
// are assumed, not tried with a thermostat.
const THERMO_MT = 0x0201;
const THERMO_ST = 0x0202;
// What would set a thermostat (assumed): FF03, a light's level or a preset,
// FF3E the set point, FF40 the settings, FF42 on/off. The reading sends none.
const SETS_A_THERMOSTAT = [0xff03, 0xff3e, 0xff40, 0xff42];
// A thermostat added in Homey, as far as the network sees it: what it is
// handed is recorded.
const thermostatStub = (meshId) => {
  const stub = { handed: [], getCsrMeshId: () => meshId, applyCsrName() {}, getName: () => 'thermostat' };
  stub.applyThermostat = (kind, parsed) => stub.handed.push([kind, parsed]);
  stub.applyThermostatCommand = (kind, parsed, src) => stub.handed.push([kind, parsed, src]);
  return stub;
};
// The network with the two thermostats added, and any other devices.
const thermostatApp = (devices = []) => networkApp([thermostatStub(THERMO_MT), thermostatStub(THERMO_ST), ...devices]);
const opOf = (plain) => (plain[2] << 8) | plain[3];
const dstOf = (plain) => plain.readUInt16LE(0);
const nameFrom = (src, name) => ({ src, plain: ext(0x8000, 0xff11, nameBytes(LOC, name)) });

// Runs each THERMOSTAT_GAP_MS timer in turn, until a reading is done.
async function readingsDone(app) {
  for (let i = 0; i < 100; i += 1) {
    await tick();
    await tick();
    if (![...app.homey.pending.values()].some((t) => t.ms === THERMOSTAT_GAP_MS)) return;
    app.homey.runMs(THERMOSTAT_GAP_MS);
  }
  throw new Error('the readings never ended');
}

test('thermostat: FF3C with 00, 01 or 02; FF05, FF3D, FF5C and FF5D are read; shorter is nothing', () => {
  assert.equal(proto.thermostatRequestData({ meshId: THERMO_MT, location: LOC, what: 0 }).toString('hex'), '0102ff3c5a3c00');
  assert.equal(proto.thermostatRequestData({ meshId: THERMO_MT, location: LOC, what: 2 }).toString('hex'), '0102ff3c5a3c02');
  // On, heating, clock set; 21.5 °C; firmware 1.4; schedule on; no errors.
  assert.deepEqual(proto.parseThermostatStatus(Buffer.from([0x5a, 0x3c, 0xa1, 21, 5, 1, 4, 0x00, 0x00])), {
    location: LOC, on: true, window: false, heating: true, childLock: false, clockSet: true,
    setPoint: 21.5, firmware: '1.4', paused: false, schedule: true, errors: 0,
  });
  // Off with the clock set is not 0, but it is off. Window open, child lock,
  // paused, schedule off, an error flag.
  const off = proto.parseThermostatStatus(Buffer.from([0x5a, 0x3c, 0xc4, 5, 0, 1, 4, 0x81, 0x80]));
  assert.deepEqual([off.on, off.window, off.heating, off.childLock, off.clockSet, off.setPoint, off.paused, off.schedule, off.errors],
    [false, true, false, true, true, 5, true, false, 0x80]);
  assert.equal(proto.parseThermostatStatus(Buffer.alloc(8)), null);
  assert.deepEqual(proto.parseThermostatTemperatures(Buffer.from([0x5a, 0x3c, 22, 3, 24, 0, 28, 0])),
    { location: LOC, room: 22.3, floor: 24, floorLimit: 28 });
  assert.equal(proto.parseThermostatTemperatures(Buffer.alloc(7)), null);
  assert.deepEqual(proto.parseThermostatSettings(Buffer.from([0x5a, 0x3c, 0x45, 0x03, 20, 50, 0x23])), {
    location: LOC, roomOffset: 0.5, floorOffset: -0.3, b4: 20, b5: 50, sensorType: 3, adaptive: false, windowDetection: true,
  });
  assert.equal(proto.parseThermostatSettings(Buffer.alloc(6)), null);
  assert.deepEqual(proto.parseThermostatPresets(Buffer.from([0x5a, 0x3c, 21, 0, 16, 0, 5, 0])), { location: LOC, presets: [21, 16, 5] });
  assert.equal(proto.parseThermostatPresets(Buffer.alloc(7)), null);
});

test('thermostat: FF04 and FF3C 00 every 5 min, FF3C 01 and 02 at first and once an hour, each listening 10 s; nothing that sets it', async () => {
  const app = thermostatApp();
  const c = clock();
  const csr = new CsrNetwork(app, { now: c.now });
  csr.handleFrame(nameFrom(THERMO_MT, '@MT1A2B'));
  csr.handleFrame(nameFrom(THERMO_ST, '@ST3C4D'));
  csr.handleFrame(nameFrom(MESH_ID, '@SC1A2B'));
  await readingsDone(app);
  const to = (meshId) => app.sent.filter((s) => dstOf(s.plain) === meshId);
  const hexTo = (meshId) => to(meshId).map((s) => s.plain.toString('hex').slice(4));
  const first = ['ff045a3c', 'ff3c5a3c00', 'ff3c5a3c01', 'ff3c5a3c02'];
  assert.deepEqual(hexTo(THERMO_MT), first);
  assert.deepEqual(hexTo(THERMO_ST), first);
  assert.deepEqual(to(THERMO_MT).map((s) => s.meta), [
    { key: `csr:status:${THERMO_MT}`, listenMs: THERMOSTAT_LISTEN_MS },
    { key: `csr:thermostat:${THERMO_MT}:0`, listenMs: THERMOSTAT_LISTEN_MS },
    { key: `csr:thermostat:${THERMO_MT}:1`, listenMs: THERMOSTAT_LISTEN_MS },
    { key: `csr:thermostat:${THERMO_MT}:2`, listenMs: THERMOSTAT_LISTEN_MS },
  ]);
  // Every request listens 10 s, the last as well: nothing listens longer.
  assert.deepEqual(to(THERMO_ST).map((s) => s.meta.listenMs), Array(4).fill(THERMOSTAT_LISTEN_MS));
  assert.deepEqual([THERMOSTAT_LISTEN_MS, THERMOSTAT_SETTINGS_EVERY_MS], [10 * 1000, 60 * 60 * 1000]);
  assert.ok(app.logs.includes('[CSR] thermostat 0x0201: read every 5 min'));
  assert.ok(app.logs.includes('[CSR] FF3C 00 (temperatures) to thermostat 0x0201 loc=0x5a3c'));
  assert.ok(!app.logs.some((line) => /listens 60 s/.test(line)));

  // An hour: twelve more readings, FF04 and FF3C 00 each time, FF3C 01 and
  // 02 again in the twelfth.
  for (let round = 1; round <= 12; round += 1) {
    assert.equal([...app.homey.pending.values()].filter((t) => t.ms === THERMOSTAT_EVERY_MS).length, 1);
    c.t += THERMOSTAT_EVERY_MS;
    app.homey.runMs(THERMOSTAT_EVERY_MS);
    await readingsDone(app);
  }
  assert.equal(THERMOSTAT_EVERY_MS, 5 * 60 * 1000);
  for (const meshId of [THERMO_MT, THERMO_ST]) {
    const hex = hexTo(meshId);
    assert.deepEqual([hex.filter((h) => h === 'ff045a3c').length, hex.filter((h) => h === 'ff3c5a3c00').length,
      hex.filter((h) => h === 'ff3c5a3c01').length, hex.filter((h) => h === 'ff3c5a3c02').length, hex.length], [13, 13, 2, 2, 30]);
  }
  assert.ok(app.sent.filter((s) => [THERMO_MT, THERMO_ST].includes(dstOf(s.plain)))
    .every((s) => s.meta.listenMs === THERMOSTAT_LISTEN_MS));
  // Only requests to a thermostat, and nothing that sets one goes anywhere.
  assert.ok(app.sent.filter((s) => [THERMO_MT, THERMO_ST].includes(dstOf(s.plain)))
    .every((s) => [0xff04, 0xff3c].includes(opOf(s.plain))));
  assert.deepEqual(app.sent.filter((s) => SETS_A_THERMOSTAT.includes(opOf(s.plain))), []);
  // The Pill is asked once, as before.
  assert.deepEqual(to(MESH_ID).map((s) => [s.plain.toString('hex'), s.meta]),
    [['2301ff045a3c', { key: `csr:status:${MESH_ID}`, listenMs: STATUS_LISTEN_MS }]]);

  csr.stop();
  assert.equal([...app.homey.pending.values()].filter((t) => t.ms === THERMOSTAT_EVERY_MS).length, 0, 'stop ends the readings');
});

test('thermostat: its FF05 is logged as a thermostat\'s, not a dimmer\'s, and goes to no light; FF3D, FF5C and FF5D in words', () => {
  const statuses = [];
  const device = { applyCsrStatus: (...args) => statuses.push(args), applyCsrName() {}, getCsrMeshId: () => THERMO_MT };
  const app = thermostatApp([device]);
  const csr = new CsrNetwork(app);
  csr.handleFrame(nameFrom(THERMO_MT, '@MT1A2B'));
  const answer = (opcode, bytes) => csr.handleFrame({ src: THERMO_MT, plain: ext(0x8000, opcode, bytes) });
  answer(0xff05, [0x5a, 0x3c, 0xa1, 21, 5, 1, 4, 0x00, 0x00]);
  answer(0xff3d, [0x5a, 0x3c, 22, 3, 24, 0, 28, 0]);
  answer(0xff5c, [0x5a, 0x3c, 0x45, 0x03, 20, 50, 0x23]);
  answer(0xff5d, [0x5a, 0x3c, 21, 0, 16, 0, 5, 0]);
  answer(0xff42, [0x5a, 0x3c, 1, 0, 7]);
  answer(0xff3d, [0x5a, 0x3c, 22]);
  assert.deepEqual(statuses, []);
  const lines = app.logs.filter((line) => line.startsWith('[CSR] EXT src=0x0201') && !line.includes('op=FF11'));
  assert.deepEqual(lines, [
    '[CSR] EXT src=0x0201 dst=0x8000 op=FF05 len=9 data=5a3ca1150501040000 thermostat on=1 heating=1 setPoint=21.5'
      + ' window=0 childLock=0 clockSet=1 paused=0 schedule=1 errors=0x00 firmware=1.4 loc=0x5a3c',
    '[CSR] EXT src=0x0201 dst=0x8000 op=FF3D len=8 data=5a3c160318001c00 thermostat room=22.3 floor=24.0 floorLimit=28.0 loc=0x5a3c',
    '[CSR] EXT src=0x0201 dst=0x8000 op=FF5C len=7 data=5a3c4503143223 thermostat roomOffset=+0.5 floorOffset=-0.3 b4=20 b5=50'
      + ' sensorType=3 adaptive=0 windowDetection=1 loc=0x5a3c',
    '[CSR] EXT src=0x0201 dst=0x8000 op=FF5D len=8 data=5a3c150010000500 thermostat presets=21.0/16.0/5.0 loc=0x5a3c',
    '[CSR] EXT src=0x0201 dst=0x8000 op=FF42 len=5 data=5a3c010007 thermostat',
    '[CSR] EXT src=0x0201 dst=0x8000 op=FF3D len=3 data=5a3c16 thermostat',
  ]);
  // Before its FF11 a node is not known as a thermostat: its FF05 is read as before.
  csr.handleFrame({ src: THERMO_ST, plain: ext(0x8000, 0xff05, [0x5a, 0x3c, 1, 40, 7]) });
  assert.match(app.logs[app.logs.length - 1], /op=FF05 len=5 data=5a3c012807 on=1 level=40 loc=0x5a3c$/);
});

test('thermostat: a reading waits while a pairing scan has the radio, and is tried again 30 s later', async () => {
  const app = thermostatApp();
  app.bridge._scanPauses = 1;
  const csr = new CsrNetwork(app);
  csr.handleFrame(nameFrom(THERMO_MT, '@MT1A2B'));
  await tick();
  await tick();
  assert.equal(app.sent.length, 0);
  assert.ok(app.logs.includes('[CSR] thermostat reading waits 30 s for the pairing scan'));
  app.bridge._scanPauses = 0;
  app.homey.runMs(THERMOSTAT_SCAN_RETRY_MS);
  await readingsDone(app);
  assert.deepEqual(app.sent.map((s) => s.plain.toString('hex')),
    ['0102ff045a3c', '0102ff3c5a3c00', '0102ff3c5a3c01', '0102ff3c5a3c02']);
});

test('thermostat: a pairing search that begins in the middle of a reading holds its next request back until it is over', async () => {
  const app = thermostatApp();
  const csr = new CsrNetwork(app);
  csr.handleFrame(nameFrom(THERMO_MT, '@MT1A2B'));
  await tick();
  await tick();
  assert.deepEqual(app.sent.map((s) => s.plain.toString('hex')), ['0102ff045a3c']);
  app.bridge._scanPauses = 1; // the search begins
  app.homey.runMs(THERMOSTAT_GAP_MS);
  await tick();
  await tick();
  assert.equal(app.sent.length, 1, 'no FF3C while the scan has the radio');
  app.homey.runMs(THERMOSTAT_SCAN_RETRY_MS); // still searching: it waits again
  await tick();
  await tick();
  assert.equal(app.sent.length, 1);
  assert.equal(app.logs.filter((line) => line === '[CSR] thermostat reading waits 30 s for the pairing scan').length, 2);
  app.bridge._scanPauses = 0;
  app.homey.runMs(THERMOSTAT_SCAN_RETRY_MS);
  await readingsDone(app);
  assert.deepEqual(app.sent.map((s) => s.plain.toString('hex')),
    ['0102ff045a3c', '0102ff3c5a3c00', '0102ff3c5a3c01', '0102ff3c5a3c02']);
});

test('thermostat: the pause it waits for is the one MeshBridge.pauseForScan counts', async () => {
  const real = bareBridge();
  assert.equal(real._scanPauses, 0);
  const end = await real.pauseForScan('pairing scan');
  assert.equal(real._scanPauses, 1);
  const app = thermostatApp();
  Object.defineProperty(app.bridge, '_scanPauses', { get: () => real._scanPauses });
  const csr = new CsrNetwork(app);
  csr.handleFrame(nameFrom(THERMO_MT, '@MT1A2B'));
  await tick();
  await tick();
  assert.equal(app.sent.length, 0, 'not while the bridge pauses');
  end('list answered');
  assert.equal(real._scanPauses, 0);
  app.homey.runMs(THERMOSTAT_SCAN_RETRY_MS);
  await readingsDone(app);
  assert.equal(app.sent.length, 4);
});

test('thermostat: a request whose answer has not come when the listening is over gets a line in the log', async () => {
  const app = thermostatApp();
  const csr = new CsrNetwork(app);
  csr.handleFrame(nameFrom(THERMO_MT, '@MT1A2B'));
  await tick();
  await tick();
  csr.handleFrame({ src: THERMO_MT, plain: ext(0x8000, 0xff05, [0x5a, 0x3c, 0xa1, 21, 5, 1, 4, 0x00, 0x00]) });
  await readingsDone(app);
  csr.handleFrame({ src: THERMO_MT, plain: ext(0x8000, 0xff3d, [0x5a, 0x3c, 22, 3, 24, 0, 28, 0]) });
  app.homey.runMs(THERMOSTAT_LISTEN_MS);
  assert.deepEqual(app.logs.filter((line) => line.includes(': no FF')), [
    '[CSR] thermostat 0x0201: no FF5C within 10 s of FF3C 01 (settings)',
    '[CSR] thermostat 0x0201: no FF5D within 10 s of FF3C 02 (presets)',
  ]);
});

test('thermostat: stopped in the middle of a reading, nothing more goes out', async () => {
  const settle = async (app) => {
    for (let i = 0; i < 20; i += 1) {
      app.homey.runAll();
      await tick();
      await tick();
    }
  };
  // Between two requests.
  const app = thermostatApp();
  const csr = new CsrNetwork(app);
  csr.handleFrame(nameFrom(THERMO_MT, '@MT1A2B'));
  csr.handleFrame(nameFrom(THERMO_ST, '@ST3C4D'));
  await tick();
  await tick();
  assert.equal(app.sent.length, 1);
  csr.stop();
  await settle(app);
  assert.equal(app.sent.length, 1);
  assert.equal(app.homey.pending.size, 0, 'no timer left');
  assert.ok(!app.logs.some((line) => line.includes(': no FF')), 'and no line about a missing answer');

  // As one thermostat's reading ends: the next one is not read.
  const other = thermostatApp();
  const csr2 = new CsrNetwork(other);
  const send = other.bridge.send;
  other.bridge.send = async (packet, meta) => {
    const result = await send(packet, meta);
    if (other.sent.length === 4) csr2.stop();
    return result;
  };
  csr2.handleFrame(nameFrom(THERMO_MT, '@MT1A2B'));
  csr2.handleFrame(nameFrom(THERMO_ST, '@ST3C4D'));
  await settle(other);
  assert.deepEqual(other.sent.map((s) => dstOf(s.plain)), [THERMO_MT, THERMO_MT, THERMO_MT, THERMO_MT]);

  // While a pairing scan holds the reading back.
  const third = thermostatApp();
  third.bridge._scanPauses = 1;
  const csr3 = new CsrNetwork(third);
  csr3.handleFrame(nameFrom(THERMO_MT, '@MT1A2B'));
  await tick();
  await tick();
  csr3.stop();
  third.bridge._scanPauses = 0;
  await settle(third);
  assert.equal(third.sent.length, 0);
});

test('thermostat: a mesh id that names another product now is no longer read, and the log says so', async () => {
  const app = thermostatApp();
  const csr = new CsrNetwork(app);
  csr.handleFrame(nameFrom(THERMO_MT, '@MT1A2B'));
  await readingsDone(app);
  assert.equal(app.sent.length, 4);
  csr.handleFrame(nameFrom(THERMO_MT, '@SC1A2B')); // a Pill has the mesh id now
  assert.ok(app.logs.includes('[CSR] 0x0201 is @SC1A2B now, not a thermostat: no longer read'));
  assert.equal(csr.isThermostat(THERMO_MT), false);
  app.homey.runMs(THERMOSTAT_EVERY_MS);
  await readingsDone(app);
  // It is asked once, as any Pill, and gets no FF3C.
  assert.deepEqual(app.sent.slice(4).map((s) => [s.plain.toString('hex'), s.meta.listenMs]),
    [['0102ff045a3c', STATUS_LISTEN_MS]]);

  // In the middle of a reading: the next request does not go.
  const other = thermostatApp();
  const csr2 = new CsrNetwork(other);
  csr2.handleFrame(nameFrom(THERMO_MT, '@MT1A2B'));
  await tick();
  await tick();
  csr2.handleFrame(nameFrom(THERMO_MT, '@SC1A2B'));
  await readingsDone(other);
  assert.deepEqual(other.sent.map((s) => [s.plain.toString('hex'), s.meta.listenMs]),
    [['0102ff045a3c', THERMOSTAT_LISTEN_MS], ['0102ff045a3c', STATUS_LISTEN_MS]]);
});

test('thermostat: a round that comes while the reading before is not done is skipped, and the log says so', async () => {
  const app = thermostatApp();
  const c = clock();
  const send = app.bridge.send;
  const held = [];
  app.bridge.send = (packet, meta) => new Promise((resolve) => held.push(() => resolve(send(packet, meta))));
  const csr = new CsrNetwork(app, { now: c.now });
  csr.handleFrame(nameFrom(THERMO_MT, '@MT1A2B'));
  csr.handleFrame(nameFrom(THERMO_ST, '@ST3C4D'));
  await tick();
  assert.equal(held.length, 1, 'the first FF04 is not delivered yet');
  c.t += THERMOSTAT_EVERY_MS;
  app.homey.runMs(THERMOSTAT_EVERY_MS);
  await tick();
  assert.ok(app.logs.includes('[CSR] thermostat round skipped: the reading that began 300 s ago is not done'));
  assert.equal(held.length, 1, 'nothing more goes out');
  // Delivered at last: both readings go on, and the next round is read.
  app.bridge.send = send;
  held.shift()();
  await readingsDone(app);
  const count = (hex) => app.sent.filter((s) => s.plain.toString('hex').slice(4) === hex).length;
  assert.deepEqual([count('ff045a3c'), count('ff3c5a3c00'), count('ff3c5a3c01')], [2, 2, 2]);
  c.t += THERMOSTAT_EVERY_MS;
  app.homey.runMs(THERMOSTAT_EVERY_MS);
  await readingsDone(app);
  assert.deepEqual([count('ff045a3c'), count('ff3c5a3c00'), count('ff3c5a3c01')], [4, 4, 2]);
  assert.equal(app.logs.filter((line) => line.includes('round skipped')).length, 1);
});

test('thermostat: sg_thermostat adds @MT and @ST, no light driver does; only the thermostat device builds what sets one', () => {
  for (const name of ['@MT1A2B', '@ST3C4D']) {
    const product = csrProductForName(name);
    assert.deepEqual([product.name, product.kind, csrDriverFor(product)], ['HeatReg Smart', 'thermostat', 'sg_thermostat']);
    const found = laterFindings([{ localName: name, rssi: -60 }], [{ meshId: THERMO_MT, name, product, location: LOC }]);
    for (const driverId of ['sg_mesh', 'sg_pill', 'sg_plug']) {
      assert.deepEqual(withStates(found, driverId, new Set()).map((f) => f.state), ['elsewhere']);
    }
    assert.deepEqual(withStates(found, 'sg_thermostat', new Set()).map((f) => f.state), ['add']);
  }
  // A light's FF03 is built by the light and plug devices only; the set
  // point, on/off and a thermostat's preset by the thermostat device only;
  // FF3E and FF42 are named in lib/sgProtocol.js only.
  const files = ['app.js', ...['lib', 'drivers/sg_mesh', 'drivers/sg_pill', 'drivers/sg_plug', 'drivers/sg_thermostat', 'drivers/sg_group']
    .flatMap((dir) => fs.readdirSync(path.join(__dirname, '..', dir)).filter((f) => f.endsWith('.js')).map((f) => `${dir}/${f}`))];
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const using = (pattern) => files.filter((file) => file !== 'lib/sgProtocol.js' && pattern.test(read(file)));
  assert.deepEqual(using(/csrLevelData\(/), ['lib/SGCsrDevice.js']);
  assert.deepEqual(using(/thermostat(?:SetPoint|Power|Preset)Data\(/), ['lib/SGThermostatDevice.js']);
  assert.deepEqual(files.filter((file) => /0xff,\s*0x(?:3e|42)\]/i.test(read(file))), ['lib/sgProtocol.js']);
  // FF40, the settings, nowhere.
  for (const file of files) assert.doesNotMatch(read(file), /0xff,\s*0x40\]/i, file);
});

// ---- the device

function deviceApp(extra = {}) {
  const app = networkApp();
  app.shared = null;
  app.sharedLocation = () => app.shared;
  app.statusUnreadableText = () => null;
  app.csr = { names: 0, statuses: [], requestNames: async (options) => { app.csr.names += 1; app.csr.asked = options; return true; },
    requestStatus: async (id, loc) => { app.csr.statuses.push([id, loc]); return true; },
    isThermostat: (id) => (app.csr.thermostats || []).includes(id) };
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

test('no FF03 to a mesh id that the network now knows as a thermostat\'s, and the log says so', async () => {
  const app = deviceApp();
  const device = await csrDevice(app, { locationId: LOC });
  app.csr.thermostats = [MESH_ID];
  device._request(40);
  await tick();
  assert.equal(app.sent.length, 0);
  assert.ok(device.logs.includes('command FF03 id=0x0123 level=40 not sent: that mesh id is a thermostat\'s now'));
  app.csr.thermostats = [];
  device._request(40);
  await tick();
  assert.deepEqual(app.sent.map((s) => s.plain.toString('hex')), ['2301ff035a3c0128010000']);
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

test('white: FF03 carries 0 for every product, also a tunable white one that reported its white value, on and off too', async () => {
  const app = deviceApp();
  const tw = await csrDevice(app, { locationId: LOC, tunableWhite: true });
  tw.applyCsrStatus(proto.parseCsrStatus(Buffer.from([0x5a, 0x3c, 1, 40, 7, 1, 2, 0x33, 0x80])), 'FF05');
  assert.ok(tw.logs.includes('status FF05 applied: on=true level=40 white=51'), 'only logged');
  tw._request(60);
  tw._request(tw._levelFor({ onoff: true }));
  tw._request(0);
  await tick();
  const plain = await csrDevice(app, { locationId: LOC });
  plain.applyCsrStatus(proto.parseCsrStatus(Buffer.from([0x5a, 0x3c, 1, 40, 7, 1, 2, 0x33, 0x80])), 'FF05');
  plain._request(60);
  await tick();
  assert.deepEqual(app.sent.map((s) => s.plain.toString('hex').slice(-2)), ['00', '00', '00', '00']);
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

test('status: FF05 and FF50 set onoff and dim, but not within 8 s of a command from here; a repeated or older number soon after (Gen3) and another home are ignored', async () => {
  const app = deviceApp();
  const device = await csrDevice(app, { locationId: LOC });
  const realNow = Date.now;
  let t = 5000000;
  Date.now = () => t;
  try {
    device._request(30);
    await tick();
    t += 7999;
    assert.equal(device.applyCsrStatus(proto.parseCsrStatus(Buffer.from([0x5a, 0x3c, 1, 90, 1])), 'FF05'), false);
    assert.equal(device.applyCsrStatus(proto.parseCsrFastStatus(Buffer.from([0x5a, 0x3c, 1, 90, 1, 0])), 'FF50'), false);
    await tick();
    assert.equal(device.getCapabilityValue('dim'), undefined);
    assert.ok(device.logs.includes('status FF05 not taken: within 8 s of a command from here'));
    assert.ok(device.logs.includes('status FF50 not taken: within 8 s of a command from here'));
    t += 1;
    assert.equal(device.applyCsrStatus(proto.parseCsrStatus(Buffer.from([0x5a, 0x3c, 1, 30, 2])), 'FF05'), true);
    await tick();
    assert.equal(device.getCapabilityValue('dim'), 0.3);
    // A device without dimming takes its status at once.
    const onOff = await csrDevice(app, { locationId: LOC, prefix: '@SE' }, { dim: false });
    onOff._request(100);
    await tick();
    assert.equal(onOff.applyCsrStatus(proto.parseCsrStatus(Buffer.from([0x5a, 0x3c, 1, 0, 1])), 'FF05'), true);
  } finally {
    Date.now = realNow;
  }
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
    levels.push(Math.round(device.getCapabilityValue('dim') * 100));
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

test('a dimmer turned on without a level: pwr 01 with level 00, whatever level Homey shows; with a level, that level', async () => {
  const app = deviceApp();
  const device = await csrDevice(app, { locationId: LOC });
  await device.setCapabilityValue('dim', 0.7);
  for (const values of [{ onoff: true }, { onoff: true, dim: 0.4 }, { dim: 0.55 }, { onoff: false }]) {
    device._request(device._levelFor(values));
  }
  await tick();
  assert.deepEqual(app.sent.map((s) => s.plain.toString('hex').slice(12, 16)), ['0100', '0128', '0137', '0000']);
  assert.ok(device.logs.some((line) => /^command FF03 id=0x0123 on level=0 /.test(line)));
});

test('after a command: one FF04 9 s after the last one, to a dimmer and to a device without dimming; only a dimmer has the quiet time', async () => {
  const app = deviceApp();
  const device = await csrDevice(app, { locationId: LOC });
  const readBacks = (d) => [...d.homey.pending.values()].filter((timer) => timer.ms === 9000).length;
  const realNow = Date.now;
  let t = 5000000;
  Date.now = () => t;
  try {
    device._request(40);
    await tick();
    t += 3000;
    device._request(60);
    await tick();
    assert.equal(readBacks(device), 1, 'counted from the last command');
    t += 5000;
    assert.equal(device.applyCsrStatus(proto.parseCsrStatus(Buffer.from([0x5a, 0x3c, 1, 40, 1])), 'FF05'), false);
    device.homey.runMs(9000);
    await tick();
    assert.deepEqual(app.csr.statuses, [[MESH_ID, LOC]]);
    assert.equal(device.applyCsrStatus(proto.parseCsrStatus(Buffer.from([0x5a, 0x3c, 1, 60, 2])), 'FF05'), true);
  } finally {
    Date.now = realNow;
  }
  // A device without dimming (an ON-OFF Pill, a plug): read back as well, so
  // the log shows whether on and off reached it; its status is taken at once.
  const onOff = await csrDevice(app, { locationId: LOC, prefix: '@SE' }, { dim: false });
  onOff._request(100);
  await tick();
  assert.equal(readBacks(onOff), 1, 'one FF04 after on');
  assert.equal(onOff.applyCsrStatus(proto.parseCsrStatus(Buffer.from([0x5a, 0x3c, 1, 0, 3])), 'FF05'), true, 'no quiet time');
  onOff.homey.runMs(9000);
  await tick();
  assert.deepEqual(app.csr.statuses, [[MESH_ID, LOC], [MESH_ID, LOC]]);
  onOff._request(0);
  await tick();
  assert.equal(readBacks(onOff), 1, 'and after off');
});

test('a dimmer deleted or stopped 2 s after a command: nothing goes out at 9 s, also when its send ends after that', async () => {
  const readBacks = (d) => [...d.homey.pending.values()].filter((timer) => timer.ms === 9000).length;
  for (const stop of ['onDeleted', 'onUninit']) {
    const app = deviceApp();
    const device = await csrDevice(app, { locationId: LOC });
    const realNow = Date.now;
    let t = 5000000;
    Date.now = () => t;
    try {
      device._request(40);
      await tick();
      assert.equal(readBacks(device), 1, stop);
      t += 2000;
      await device[stop]();
      assert.equal(readBacks(device), 0, stop);
      t += 7000;
      device.homey.runMs(9000);
      await tick();
    } finally {
      Date.now = realNow;
    }
    assert.equal(app.sent.length, 1, `${stop}: only the FF03`);
    assert.deepEqual(app.csr.statuses, [], stop);
  }
  // Its send still on its way when it is deleted.
  const app = deviceApp();
  let finish;
  app.bridge.send = () => new Promise((resolve) => { finish = resolve; });
  const device = await csrDevice(app, { locationId: LOC });
  device._request(40);
  await tick();
  await device.onDeleted();
  finish({ ok: true });
  await tick();
  assert.equal(readBacks(device), 0);
  device.homey.runMs(9000);
  await tick();
  assert.deepEqual(app.csr.statuses, []);
});

test('a read-back that fails gets a line in the log, and nothing is thrown', async () => {
  const app = deviceApp();
  const device = await csrDevice(app, { locationId: LOC });
  device._request(40);
  await tick();
  app.csr.requestStatus = async () => { throw new Error('link lost'); };
  device.homey.runMs(9000);
  await tick();
  assert.ok(device.errors.includes('read-back failed: link lost'));
  device._request(50);
  await tick();
  device.getCsrLocationId = () => { throw new Error('no location'); };
  assert.doesNotThrow(() => device.homey.runMs(9000));
  assert.ok(device.errors.includes('read-back failed: no location'));
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
    [['@GB3C4D', 'elsewhere'], ['@GE9C0D', 'add'], ['@MJ7A8B', 'noAnswer'], ['@SC1A2B', 'add'], ['@SX5E6F', 'notYet']]);
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
  assert.ok(driver.logs.some((line) => line.includes('@GB Gen4 onoff elsewhere') && line.includes('@SX Gen3 switch notYet')));
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
  assert.deepEqual(ICON_NAMES, ['pill', 'plug', 'socket']);
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

test('pairing: no Pill, but other products: the list says so, where to add those another driver adds, and names those that cannot be added yet', async () => {
  const { driver } = pairDriver([SWITCH, PLUG, { ...PLUG, meshId: 0x0127, name: '@GB7A8B' }]);
  driver.homey.__ = (key, tokens) => (tokens ? `${key} ${JSON.stringify(tokens)}` : key);
  const session = pairSession();
  await driver.onPair(session);
  await session.show('loading');
  assert.equal(session.views.length, 1);
  await assert.rejects(session.handlers.list_devices(),
    { message: 'pair.found.noPill pair.found.goToPlug {"products":"Smart Socket"} pair.found.notYet {"products":"Smart Switch"}' });
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

test('pairing: the 02FA data of each SG node by its last four characters, strongest first, with the first three characters of its name only', async () => {
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
    'pair: SG nodes: 1: 02FA …0000, -50 dB, not connectable; 2: 02FA …0102, -60 dB, @SC; 3: 02FA …1101, -80 dB, @ND',
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
  assert.deepEqual(driver.homey.app.csr.asked, { asked: true, listenMs: SEARCH_LISTEN_MS + LISTEN_MARGIN_MS, direct: true },
    'the search\'s FF10 goes on a link that listens, and to each device known by its mesh id');
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
  assert.deepEqual(driver.homey.app.csr.asked, { asked: true, listenMs: NAME_LISTEN_MS, direct: true });
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
