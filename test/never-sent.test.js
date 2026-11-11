'use strict';

// What this app never sends (the list in lib/fake/bridge.js says what each
// is assumed to change in a device). No file in a build of the app can build
// them, nothing the app does sends them, the first generation's A0 and
// heartbeat among it, and the fake radio refuses them. Those a device may
// send this app (READ_ONLY) may be read, never sent.
// Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fake = require('./helpers/fake-homey');

fake.install();

const { decryptPayload, deriveNetworkKey, makePacket } = require('../lib/csrmesh');
const { CsrNetwork } = require('../lib/CsrNetwork');
const MeshBridge = require('../lib/MeshBridge');
const SGCsrDevice = require('../lib/SGCsrDevice');
const SGMeshDevice = require('../lib/SGDeviceBase');
const SGPlugDevice = require('../drivers/sg_plug/device');
const SGThermostatDevice = require('../lib/SGThermostatDevice');
const { loadFakes } = require('../lib/fakeDevices');
const { REFUSED } = require('../lib/fake/bridge');
const { ROOT, buildFiles } = require('./helpers/build-files');

// The two bytes after the destination, as they go on the air.
const NEVER = [
  '8100', '7313', 'ef10', 'ef11', 'ff0f', 'ff28', 'ffaa', 'ff12', 'ff52', 'ff13', 'ff14', 'ff15', 'ff16', 'ff17',
  'ff1e', 'ff39', 'ff51', 'ff00', 'ff5a', 'ff40', 'ff3f', 'ff41', 'ff5b', 'ff43',
  'ff0a', 'ff33', 'ff47', 'ff29', 'ff2a', 'ff48', 'ff4b', 'ff36', 'ff81',
];
// Of NEVER, what a device may send this app. Its opcode may stand in
// lib/sgProtocol.js only, as a constant whose name begins with IN_ (it is
// only read), and that name never in a call to extData, which builds
// everything the app sends.
const READ_ONLY = ['ff0a'];
const READ_ONLY_FILE = 'lib/sgProtocol.js';
const KEY = deriveNetworkKey('test-only-pass');
const LOC = 0x5a3c;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const opcodeOf = (plain) => plain.subarray(2, 4).toString('hex');

// The ways a file could build one: as a number (0xff39), as an opcode array
// ([0xff, 0x39]), as two bytes in a row (0xff, 0x39), or as hex text
// ('ff39'). FF00 is not looked for as two bytes in a row: "& 0xff, 0x00"
// is how an id's low byte is followed by a zero byte.
function waysToBuild(hex) {
  const [hi, lo] = [hex.slice(0, 2), hex.slice(2)];
  const ways = [
    new RegExp(`\\b0x${hex}\\b`, 'i'),
    new RegExp(`\\[\\s*0x${hi}\\s*,\\s*0x${lo}\\s*\\]`, 'i'),
    new RegExp(`['"\`]${hex}['"\`]`, 'i'),
  ];
  if (hex !== 'ff00') ways.push(new RegExp(`\\b0x${hi}\\s*,\\s*0x${lo}\\b`, 'i'));
  // A first generation (data model) message, built as the app builds A0.
  if (hi === '73') ways.push(new RegExp(`MCP_DATA_BLOCK\\s*,\\s*0x${lo}\\b`, 'i'), new RegExp(`OP_DATA_\\w+\\s*=\\s*0x${lo}\\b`, 'i'));
  return ways;
}

// A read-only constant: const IN_<name> = [0xff, 0x0a];
const readOnlyConstant = (hex) => new RegExp(`^\\s*const (IN_\\w+) = \\[0x${hex.slice(0, 2)}, 0x${hex.slice(2)}\\];\\s*$`, 'i');

// The text of each call to name in text: from the name to its closing bracket.
function callsTo(name, text) {
  const calls = [];
  for (let at = text.indexOf(`${name}(`); at !== -1; at = text.indexOf(`${name}(`, at + 1)) {
    let depth = 0;
    let end = at + name.length;
    for (; end < text.length; end += 1) {
      if (text[end] === '(') depth += 1;
      else if (text[end] === ')' && (depth -= 1) === 0) break;
    }
    calls.push(text.slice(at, end + 1));
  }
  return calls;
}

// What in these files ([{ file, text }]) could build one, as 'file: hex' or
// 'file: IN_<name> in extData'. A read-only constant in READ_ONLY_FILE is
// left out of the search; its name may not stand in a call to extData.
function neverHits(files) {
  const hits = [];
  const readOnlyNames = [];
  for (const { file, text } of files) {
    let rest = text;
    if (file === READ_ONLY_FILE) {
      rest = text.split('\n').filter((line) => {
        const match = READ_ONLY.map((hex) => line.match(readOnlyConstant(hex))).find(Boolean);
        if (match) readOnlyNames.push(match[1]);
        return !match;
      }).join('\n');
    }
    for (const hex of NEVER) if (waysToBuild(hex).some((way) => way.test(rest))) hits.push(`${file}: ${hex}`);
  }
  for (const { file, text } of files) {
    for (const name of readOnlyNames) {
      if (callsTo('extData', text).some((call) => new RegExp(`\\b${name}\\b`).test(call))) hits.push(`${file}: ${name} in extData`);
    }
  }
  return hits;
}

test('the list is the one the fake radio refuses', () => {
  assert.deepEqual([...REFUSED].sort(), [...NEVER].sort());
});

test('a read-only opcode: an IN_ constant in lib/sgProtocol.js is fine; in extData, in another file or by another name it is caught', () => {
  const constant = 'const IN_SCENE = [0xff, 0x0a];';
  assert.deepEqual(neverHits([{ file: READ_ONLY_FILE, text: `// FF0A\n${constant}\n` }]), []);
  assert.deepEqual(neverHits([{ file: READ_ONLY_FILE, text: `${constant}\nconst x = extData(dst, IN_SCENE, [1, (2)]);` }]),
    ['lib/sgProtocol.js: IN_SCENE in extData']);
  assert.deepEqual(neverHits([{ file: READ_ONLY_FILE, text: constant }, { file: 'lib/CsrNetwork.js', text: 'extData(\n  dst,\n  IN_SCENE, data)' }]),
    ['lib/CsrNetwork.js: IN_SCENE in extData']);
  assert.deepEqual(neverHits([{ file: 'lib/CsrNetwork.js', text: constant }]), ['lib/CsrNetwork.js: ff0a']);
  assert.deepEqual(neverHits([{ file: READ_ONLY_FILE, text: 'const OP_EXT_SCENE = [0xff, 0x0a];' }]), ['lib/sgProtocol.js: ff0a']);
  assert.deepEqual(neverHits([{ file: READ_ONLY_FILE, text: 'const IN_TRIM = [0xff, 0x29];' }]), ['lib/sgProtocol.js: ff29'],
    'only READ_ONLY may be read');
  assert.deepEqual(neverHits([{ file: READ_ONLY_FILE, text: `${constant}\nextData(dst, OP_EXT_LEVEL, data);` }]), []);
});

test('the ways to build one are caught, and the bytes the app does build are not', () => {
  const caught = ['const OP = [0xff, 0x39];', 'Buffer.from([1, 0x81, 0x00, 2])', 'if (op === 0xEF10)', "send('ff40')",
    'extData(dst, [0xFF, 0x5B], data)', 'const X = [0xff, 0x00];', '...addrBytes(ADDR_DEVICES), MCP_DATA_BLOCK, 0x13, tid,',
    'const OP_DATA_UNPAIR = 0x13;', 'const OP = [0xff, 0x28];', "Buffer.from('ffaa', 'hex')", 'op === 0xff1e'];
  const fine = ['const OP_EXT_NAME_GET = [0xff, 0x10];', 'const OP_EXT_NAME = [0xff, 0x11];', 'const OP_EXT_LEVEL = [0xff, 0x03];',
    '(nodeId >> 8) & 0xff, nodeId & 0xff, 0x00, 0x00, 0x00, 0x00,', 'const OP_EXT_THERMOSTAT_GET = [0xff, 0x3c];',
    '...addrBytes(ADDR_DEVICES), MCP_DATA_BLOCK, OP_DATA_LEVEL, tid & 0xff,', 'const OP_DATA_LEVEL = 0xa0;'];
  const found = (text) => NEVER.filter((hex) => waysToBuild(hex).some((way) => way.test(text)));
  for (const text of caught) assert.notDeepEqual(found(text), [], text);
  for (const text of fine) assert.deepEqual(found(text), [], text);
});

test('no file in a build of the app can build them', async () => {
  const files = (await buildFiles()).filter((file) => /\.(js|json|html)$/.test(file));
  assert.ok(files.includes('lib/sgProtocol.js') && files.includes('drivers/sg_plug/device.js'));
  assert.ok(!files.some((file) => file.startsWith('lib/fake/')), 'the fake radio, which names them to refuse them, is not in a build');
  assert.deepEqual(neverHits(files.map((file) => ({ file, text: fs.readFileSync(path.join(ROOT, file), 'utf8') }))), []);
});

// ---- nothing the app does sends them

// An app whose bridge only records what it would send.
function recordingApp(devices = []) {
  const sent = [];
  const app = {
    logs: [], errors: [], seq: 0x800000,
    log(...args) { app.logs.push(args.join(' ')); },
    error(...args) { app.errors.push(args.join(' ')); },
    getNetworkKey: () => KEY,
    nextSeq() { app.seq += 1; return app.seq; },
    knownLocations: () => [LOC],
    sharedLocation: () => null,
    statusUnreadableText: () => null,
    bridge: {
      _scanPauses: 0,
      listenLeftMs: () => 0,
      send: async (packet) => {
        sent.push(decryptPayload(KEY, packet.subarray(0, 3), packet.subarray(3, 5), packet.subarray(5, packet.length - 9)));
        return { ok: true };
      },
    },
    _devices: () => devices,
  };
  const flow = { getDeviceTriggerCard: () => ({ trigger: async () => {} }) };
  app.homey = fake.fakeHomey(app, { flow });
  app.csr = new CsrNetwork(app);
  return { app, sent };
}

async function runAllTimers(homey, rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    for (let j = 0; j < 5; j += 1) await tick();
    homey.runAll();
  }
  for (let j = 0; j < 5; j += 1) await tick();
}

test('nothing the app does sends them: names, statuses, a thermostat read and set, lights, plugs and their countdown, a first generation dimmer and its heartbeat', async () => {
  const { app, sent } = recordingApp();
  const device = (Class, store, dim) => {
    const d = new Class({
      homey: app.homey, store: { locationId: LOC, ...store }, settings: { passphrase: 'test-only-pass' },
      data: { id: `${store.prefix}1A2B` }, name: store.prefix,
    });
    d.hasCapability = (capability) => (dim ? ['onoff', 'dim'] : ['onoff']).includes(capability);
    return d;
  };
  const light = device(SGCsrDevice, { meshId: 0x0123, prefix: '@SW', kind: 'dimmable', tunableWhite: true }, true);
  const onOff = device(SGCsrDevice, { meshId: 0x0124, prefix: '@SE', kind: 'onoff' }, false);
  const plug = device(SGPlugDevice, { meshId: 0x0125, prefix: '@GB', kind: 'onoff' }, false);
  // A thermostat added in Homey.
  const thermostat = new SGThermostatDevice({
    homey: app.homey, store: { meshId: 0x0126, prefix: '@MT', kind: 'thermostat', locationId: LOC },
    settings: { passphrase: 'test-only-pass' }, data: { id: '@MT7A8B' }, name: 'thermostat',
  });
  thermostat.hasCapability = () => true;
  app._devices = () => [light, onOff, plug, thermostat];
  for (const d of [light, onOff, plug, thermostat]) await d.onInit();

  // FF10 waits between its variants: the timers below let it go on.
  const names = app.csr.requestNames({ listenMs: 1000 });
  await app.csr.requestStatus(0x0123, LOC);
  await app.csr.requestAllStatus();
  // The thermostat: read, also its settings and presets, and set from Homey.
  const name = Buffer.from([LOC >> 8, LOC & 0xff, ...Buffer.from('MT7A8B', 'latin1'), 0]);
  app.csr.handleFrame({ src: 0x0126, plain: Buffer.concat([Buffer.from([0x00, 0x80, 0xff, 0x11]), name]) });
  await thermostat._setPoint(22.5);
  await thermostat._power(false, 'onoff');
  for (const preset of ['comfort', 'eco', 'min']) await thermostat._preset(preset);
  for (const level of [0, 1, 40, 100]) light._request(level);
  onOff._request(100);
  onOff._request(0);
  plug._request(100);
  await plug.offIn(1);
  await plug.onFor(2);
  await plug.cancelCountdown();
  await plug.offIn(3);
  light.requestStatus();
  await runAllTimers(app.homey);
  assert.equal(await names, true);

  // The first generation: A0 from a dimmer, and the heartbeat that holds a
  // link (written straight to the link, not through send).
  Object.assign(app, {
    bridgeMeshId: () => null, dimmersChanged() {}, locationFor: () => null, requestStatus() {},
  });
  const gen1 = new SGMeshDevice({
    homey: app.homey, store: { localName: '@ND1A2B', locationId: LOC }, settings: { passphrase: 'test-only-pass' }, name: 'gen1',
  });
  await gen1.onInit();
  for (const level of [0, 30, 100]) await gen1._sendOnce(level);
  const bridge = new MeshBridge(app);
  const parts = [];
  Object.assign(bridge, {
    _bridgeLocalName: '@ND1A2B', _bridgeNodeId: 0x1a2b, _connNo: 1, _peripheral: {},
    _char8003: { write: async (part) => { parts.push(part); } }, _char8004: { write: async (part) => { parts.push(part); } },
    _sleep: async () => {},
  });
  await bridge._writeHeartbeat();
  const heartbeat = Buffer.concat(parts);
  sent.push(decryptPayload(KEY, heartbeat.subarray(0, 3), heartbeat.subarray(3, 5), heartbeat.subarray(5, heartbeat.length - 9)));

  const opcodes = new Set(sent.map(opcodeOf));
  for (const expected of ['ff10', 'ff04', 'ffff', 'ff3c', 'ff03', 'ff3e', 'ff42', '73a0', '73cc']) assert.ok(opcodes.has(expected), `${expected} was sent`);
  assert.deepEqual(sent.filter((plain) => NEVER.includes(opcodeOf(plain))).map(opcodeOf), []);
  assert.ok(sent.length >= 15, `${sent.length} sent`);
});

test('an FF0A that comes in is only logged: nothing goes out as an answer', async () => {
  const { app, sent } = recordingApp();
  const light = new SGCsrDevice({
    homey: app.homey, store: { meshId: 0x0123, prefix: '@SW', kind: 'dimmable', locationId: LOC },
    settings: { passphrase: 'test-only-pass' }, data: { id: '@SW1A2B' }, name: '@SW',
  });
  light.hasCapability = (capability) => ['onoff', 'dim'].includes(capability);
  app._devices = () => [light];
  await light.onInit();
  const before = { sent: sent.length, timers: app.homey.pending.size };
  for (const dst of [0x0000, 0x8000, 0x0123]) {
    app.csr.handleFrame({ src: 0x0124, plain: Buffer.from([dst & 0xff, dst >> 8, 0xff, 0x0a, LOC >> 8, LOC & 0xff, 0x01, 0x05, 0x00]) });
  }
  for (let j = 0; j < 5; j += 1) await tick();
  assert.equal(sent.length, before.sent);
  assert.equal(app.homey.pending.size, before.timers, 'nothing on its way either');
  assert.ok(app.logs.some((line) => /\bop=FF0A\b/.test(line)), 'logged');
});

// ---- the fake radio refuses them

test('the fake radio refuses every one of them: not heard by a fake device, logged, and the radio goes on', async () => {
  const app = { logs: [], errors: [] };
  app.log = (...args) => app.logs.push(args.join(' '));
  app.error = (...args) => app.errors.push(args.join(' '));
  app.homey = fake.fakeHomey(app, { drivers: { getDrivers: () => ({}) } });
  const fakes = loadFakes(app, { env: { DEBUG: '1' } });
  const key = fakes.getNetworkKey();
  const plug = fakes.nodes.find((node) => node.name === '@GP9F5D');
  let seq = 0x100;
  const packet = (dst, hex, data) => makePacket(key, (seq += 1), Buffer.from([dst & 0xff, dst >> 8,
    parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2), 16), ...data]));
  for (const hex of NEVER) {
    const dst = hex.startsWith('ef') ? 0x0000 : plug.meshId;
    const result = await fakes.bridge.send(packet(dst, hex, [0x7f, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01]));
    assert.deepEqual(result, { ok: false }, hex);
    assert.ok(app.logs.includes(`[FAKE] fake radio: ${hex.toUpperCase()} to 0x${dst.toString(16).padStart(4, '0')} refused: `
      + 'this app never sends it'), hex);
  }
  assert.deepEqual(fakes.bridge.refused.map((r) => r.opcode), NEVER);
  assert.deepEqual(fakes.bridge.heard, []);
  assert.equal(app.homey.pending.size, 1, 'no answer on its way: only the first FF10 of the fake network waits');
  // A command it may get still goes through.
  assert.deepEqual(await fakes.bridge.send(packet(plug.meshId, 'ff03', [0x7f, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])), { ok: true });
  assert.equal(plug.on, true);
  fakes.stop();
});
