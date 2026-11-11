'use strict';

// The time from a command to the device's first status, one line per
// command that is written, always on: how long it waited in the queue, how
// the bridge was found (a link already up, a cached advertisement, find() or
// a scan), the connect, the write, and the first status after it, or none in
// NO_STATUS_MS. A command replaced in the queue before it is written gets no
// line. No address, name, mesh id or location id in the line.
// Made-up values: the keys, the location id 0x4c2e and the mesh ids.
// Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fake = require('./helpers/fake-homey');

fake.install();

const { deriveNetworkKey, makePacket } = require('../lib/csrmesh');
const { csrLevelData } = require('../lib/sgProtocol');
const MeshBridge = require('../lib/MeshBridge');
const { NO_STATUS_MS, timingLine } = require('../lib/commandTiming');
const SGCsrDevice = require('../lib/SGCsrDevice');
const SGThermostatDevice = require('../lib/SGThermostatDevice');
const SGMeshDevice = require('../lib/SGDeviceBase');

// MeshBridge's own constants, read from its source, as it exports only the
// class: the wait after a connect, and the gap between the two fragments.
const BRIDGE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'lib', 'MeshBridge.js'), 'utf8');
const bridgeConstant = (name) => {
  const found = new RegExp(`^const ${name} = (\\d+);`, 'm').exec(BRIDGE_SOURCE);
  assert.ok(found, `${name} in lib/MeshBridge.js`);
  return Number(found[1]);
};
const POST_CONNECT_DELAY_MS = bridgeConstant('POST_CONNECT_DELAY_MS');
const LOW_HIGH_GAP_MS = bridgeConstant('LOW_HIGH_GAP_MS');

const KEY = deriveNetworkKey('test-only-pass');
const HOME = 0x4c2e;
const PILL_ID = 0x9a31;
const tick = () => new Promise((resolve) => setImmediate(resolve));
// The lines the tests make, printed with TIMING_LINES=1.
const testLines = [];
test.after(() => {
  if (process.env.TIMING_LINES === '1') for (const line of testLines) process.stdout.write(`# line: ${line}\n`);
});
// Nothing that names a device or a home.
const NO_ID = /9a31|0x9a31|4c2e|0x4c2e|1a2b|@[A-Z]{2}[0-9A-F]{4}|02c4a17b/i;

// ---- the line

test('the line: waited, how the bridge was found, connect, write, the first status, all in ms', () => {
  assert.equal(timingLine({
    queueMs: 0, reused: false, cached: true, finds: 0, findMs: 0, scans: 0, scanMs: 0, connectMs: 1840, attempts: 1, writeMs: 95, toWriteMs: 1935,
  }, { statusMs: 2400 }), 'command to status: cached advertisement, connect 1840 ms, write 95 ms, status 2400 ms after the write, 4335 ms in all');
  assert.equal(timingLine({
    queueMs: 850, reused: false, cached: false, finds: 1, findMs: 210, scans: 1, scanMs: 10300, connectMs: 3100, attempts: 2, writeMs: 90, toWriteMs: 14550,
  }, {}), 'command to status: waited 850 ms, find 210 ms, scan 10300 ms, connect 3100 ms (2 attempts), write 90 ms, no status in 15 s');
  assert.equal(timingLine({
    queueMs: 0, reused: true, cached: false, finds: 0, findMs: 0, scans: 0, scanMs: 0, connectMs: 0, attempts: 0, writeMs: 80, toWriteMs: 80,
  }, { statusMs: 900 }), 'command to status: link reused, write 80 ms, status 900 ms after the write, 980 ms in all');
  assert.equal(timingLine({
    queueMs: 40, reused: true, cached: false, finds: 0, findMs: 0, scans: 0, scanMs: 0, connectMs: 0, attempts: 0, writeMs: 80, toWriteMs: 120,
  }, { next: true }), 'command to status: waited 40 ms, link reused, write 80 ms, no status before the next command');
  assert.equal(NO_STATUS_MS, 15000);
});

// ---- MeshBridge: the times of each command

// A bridge with a fake node and a clock the fake radio moves on: find(),
// discover(), connect and each write take the times given.
// failConnects: the first that many connects fail, as a node that does not
// let Homey in.
function timedBridge({
  findMs = 0, scanMs = 0, connectMs = 0, writeMs = 0, cached = true, found = true, failConnects = 0,
} = {}) {
  let fails = failConnects;
  const clock = { now: 5000000 };
  const app = {
    log() {},
    error() {},
    getNetworkKey: () => KEY,
    nextSeq: () => 1,
    _devices: () => [],
    dimmerCount: () => 0,
    reportSignal() {},
    bridgeChanged() {},
    keepConnected: () => false,
  };
  const write = async () => {
    clock.now += writeMs;
  };
  const chars = [{ uuid: 'c4edc0009daf11e3800300025b000b00', write }, { uuid: 'c4edc0009daf11e3800400025b000b00', write }];
  const peripheral = {
    once() {},
    removeListener() {},
    disconnect: async () => {},
    getService: async () => ({ discoverCharacteristics: async () => chars }),
  };
  const adv = {
    uuid: '02c4a17be35f',
    localName: '@SC1A2B',
    rssi: -60,
    serviceUuids: ['fef1'],
    connectable: true,
    connect: async () => {
      clock.now += connectMs;
      if (fails > 0) {
        fails -= 1;
        throw new Error('Could not connect to peripheral');
      }
      return peripheral;
    },
  };
  const ble = {
    find: async () => {
      clock.now += findMs; return found ? adv : null;
    },
    discover: async () => {
      clock.now += scanMs; return [adv];
    },
  };
  app.homey = fake.fakeHomey(app, { ble });
  const bridge = new MeshBridge(app);
  bridge._sleep = async () => {};
  bridge._preferredUuid = adv.uuid;
  if (cached) bridge._cacheAdv(adv.uuid, adv);
  return { bridge, clock };
}

const command = (level) => makePacket(KEY, 0x10, csrLevelData({
  meshId: PILL_ID, location: HOME, level, tid: 1,
}));

async function withClock(clock, run) {
  const realNow = Date.now;
  Date.now = () => clock.now;
  try {
    return await run();
  } finally {
    Date.now = realNow;
  }
}

test('MeshBridge: a command on a cached advertisement: its connect and write times, no find or scan', async () => {
  const { bridge, clock } = timedBridge({ connectMs: 1800, writeMs: 40 });
  const result = await withClock(clock, () => bridge.send(command(40), { key: 'csr:a', level: 40 }));
  assert.equal(result.ok, true);
  const t = result.timing;
  assert.deepEqual([t.queueMs, t.reused, t.cached, t.finds, t.scans, t.connectMs, t.attempts], [0, false, true, 0, 0, 1800, 1]);
  assert.equal(t.writeMs, 80, 'two fragments');
  assert.equal(t.toWriteMs, 1880);
  assert.equal(t.writtenAt, 5001880);
});

test('MeshBridge: without a cached advertisement, find() first; without find(), a scan', async () => {
  const viaFind = timedBridge({ cached: false, findMs: 300, connectMs: 1000 });
  const t1 = (await withClock(viaFind.clock, () => viaFind.bridge.send(command(40), { key: 'csr:a' }))).timing;
  assert.deepEqual([t1.cached, t1.finds, t1.findMs, t1.scans, t1.connectMs], [false, 1, 300, 0, 1000]);
  const viaScan = timedBridge({
    cached: false, found: false, findMs: 200, scanMs: 10000, connectMs: 1000,
  });
  const t2 = (await withClock(viaScan.clock, () => viaScan.bridge.send(command(40), { key: 'csr:a' }))).timing;
  assert.deepEqual([t2.finds, t2.findMs, t2.scans, t2.scanMs, t2.connectMs], [1, 200, 1, 10000, 1000]);
});

test('MeshBridge: the next command on the link that is up: link reused, and how long it waited in the queue', async () => {
  const { bridge, clock } = timedBridge({ connectMs: 1500, writeMs: 50 });
  const results = await withClock(clock, () => Promise.all([
    bridge.send(command(40), { key: 'csr:a', level: 40 }),
    bridge.send(command(60), { key: 'csr:b', level: 60 }),
  ]));
  const [first, second] = results.map((r) => r.timing);
  assert.equal(first.queueMs, 0);
  assert.equal(second.reused, true);
  assert.equal(second.connectMs, 0);
  assert.equal(second.queueMs, 1600, 'it waited for the first one: its connect and write');
});

// Runs until done settles, with the clock moving as time would: a sleep in
// MeshBridge moves it by its length, and each of Homey's timers fires in
// turn and moves it by its delay, as a wait for a recovery does.
async function runUntil(bridge, clock, done) {
  let settled = false;
  done.then(() => { settled = true; }, () => { settled = true; });
  for (let round = 0; round < 200 && !settled; round += 1) {
    await tick();
    const [next] = [...bridge.homey.pending.entries()].sort(([, a], [, b]) => a.ms - b.ms);
    if (next && !settled) {
      const [id, { fn, ms }] = next;
      bridge.homey.pending.delete(id);
      clock.now += ms;
      fn();
    }
  }
  assert.ok(settled, 'the command settled');
  return done;
}

test('MeshBridge: a connect that fails, then the recovery: both attempts and their time, and the line says so', async () => {
  const { bridge, clock } = timedBridge({
    connectMs: 1500, writeMs: 40, failConnects: 1, findMs: 250,
  });
  bridge._sleep = async (ms) => { clock.now += ms; };
  const result = await withClock(clock, () => runUntil(bridge, clock, bridge.send(command(40), { key: 'csr:a', level: 40 })));
  assert.equal(result.ok, true);
  const t = result.timing;
  assert.equal(t.attempts, 2, 'the failed connect and the one in the recovery');
  const connectMs = 2 * 1500 + POST_CONNECT_DELAY_MS;
  const writeMs = 2 * 40 + LOW_HIGH_GAP_MS;
  assert.equal(t.connectMs, connectMs, 'two connects of 1500 ms, and the wait after the one that worked');
  assert.equal(t.cached, true, 'first on the cached advertisement');
  assert.equal(t.finds, 1, 'then find() in the recovery');
  assert.equal(t.writeMs, writeMs, 'two fragments of 40 ms, and the gap between them');
  const line = timingLine(t, { statusMs: 700 });
  assert.match(line, new RegExp(`^command to status: cached advertisement, find 250 ms, connect ${connectMs} ms \\(2 attempts\\), `
    + `write ${writeMs} ms, status 700 ms after the write, \\d+ ms in all$`));
  assert.doesNotMatch(line, NO_ID);
  testLines.push(line);
});

test('MeshBridge: a command replaced in the queue before it is written gets no times, only the one written', async () => {
  const { bridge, clock } = timedBridge({ connectMs: 1500 });
  const results = await withClock(clock, () => {
    const first = bridge.send(command(40), { key: 'csr:a', level: 40 });
    const second = bridge.send(command(60), { key: 'csr:a', level: 60 });
    return Promise.all([first, second]);
  });
  assert.deepEqual(results[0], { superseded: true });
  assert.equal(results[1].ok, true);
  assert.ok(results[1].timing);
});

// ---- the devices: one line at the first status, or after NO_STATUS_MS

const written = (fields = {}) => ({
  ok: true,
  timing: {
    queueMs: 0,
    reused: false,
    cached: true,
    finds: 0,
    findMs: 0,
    scans: 0,
    scanMs: 0,
    connectMs: 1200,
    attempts: 1,
    writeMs: 60,
    toWriteMs: 1260,
    writtenAt: Date.now(),
    ...fields,
  },
});

function deviceApp(sendResult) {
  const app = {
    seq: 0x800000,
    nextSeq() {
      app.seq += 1; return app.seq;
    },
    sharedLocation: () => null,
    statusUnreadableText: () => null,
    sent: 0,
    bridge: {
      send: async () => {
        app.sent += 1; return sendResult();
      },
    },
    csr: {
      requestNames: async () => true, requestStatus: async () => true, isThermostat: () => false, watchThermostat() {}, unwatchThermostat() {},
    },
    locationFor: () => null,
    dimmersChanged() {},
    requestStatus() {},
    bridgeMeshId: () => null,
  };
  return app;
}

async function pill(app) {
  const device = new SGCsrDevice({
    homey: fake.fakeHomey(app),
    store: {
      meshId: PILL_ID, prefix: '@SC', kind: 'dimmable', locationId: HOME,
    },
    settings: { passphrase: '1234' },
    data: { id: '@SC1A2B' },
    name: 'pill',
  });
  await device.onInit();
  return device;
}

const timingLines = (device) => device.logs.filter((line) => line.startsWith('command to status:'));

test('a later device: one line at its first status after the command, none for a command replaced in the queue', async () => {
  let result = written();
  const app = deviceApp(() => result);
  const device = await pill(app);
  await device._send(40, { location: HOME, borrowed: false });
  device.applyCsrStatus({
    location: HOME, on: true, level: 40, number: 1,
  }, 'FF05');
  device.applyCsrStatus({
    location: HOME, on: true, level: 40, number: 2,
  }, 'FF05');
  const lines = timingLines(device);
  assert.equal(lines.length, 1, 'the first status only');
  assert.match(lines[0], /^command to status: cached advertisement, connect 1200 ms, write 60 ms, status \d+ ms after the write, \d+ ms in all$/);
  assert.doesNotMatch(lines[0], NO_ID);
  result = { superseded: true };
  await device._send(60, { location: HOME, borrowed: false });
  device.applyCsrStatus({
    location: HOME, on: true, level: 60, number: 3,
  }, 'FF05');
  assert.equal(timingLines(device).length, 1, 'no line for a command that was replaced');
});

test('a later device: no status in 15 s, and a command written before the status came', async () => {
  let result = written({ queueMs: 300 });
  const app = deviceApp(() => result);
  const device = await pill(app);
  await device._send(40, { location: HOME, borrowed: false });
  device.homey.runMs(NO_STATUS_MS);
  assert.equal(timingLines(device).at(-1), 'command to status: waited 300 ms, cached advertisement, connect 1200 ms, write 60 ms, no status in 15 s');
  result = written({
    reused: true, cached: false, connectMs: 0, attempts: 0,
  });
  await device._send(50, { location: HOME, borrowed: false });
  await device._send(55, { location: HOME, borrowed: false });
  assert.equal(timingLines(device).at(-1), 'command to status: link reused, write 60 ms, no status before the next command');
});

test('a thermostat: its first status or acknowledgement after a setting ends the line', async () => {
  const app = deviceApp(() => written());
  const device = new SGThermostatDevice({
    homey: fake.fakeHomey(app),
    store: {
      meshId: 0xc05d, prefix: '@ST', kind: 'thermostat', locationId: HOME,
    },
    settings: { passphrase: '1234', sensor: 'floor' },
    data: { id: '@ST08D6' },
    name: 'thermostat',
  });
  await device.onInit();
  await device._send(app, Buffer.alloc(8), 'FF42 on', 'power');
  device.applyThermostat('FF08', { location: HOME, opcode: 0x42, tid: 1 });
  const lines = timingLines(device);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^command to status: cached advertisement, connect 1200 ms, write 60 ms, status \d+ ms after the write/);
  assert.doesNotMatch(lines[0], NO_ID);
});

test('a first generation dimmer: its first status after the command ends the line', async () => {
  const app = deviceApp(() => written({ queueMs: 120 }));
  app.homey = null;
  const device = new SGMeshDevice({
    homey: fake.fakeHomey(app), store: { localName: '@ND1A2B', locationId: HOME }, settings: { passphrase: '1234' }, name: 'gen1',
  });
  app.homey = device.homey;
  await device.onInit();
  await device._sendOnce(30);
  await tick();
  device.applyMeshStatus('1a2b', 30, HOME);
  const lines = timingLines(device);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^command to status: waited 120 ms, cached advertisement, connect 1200 ms, write 60 ms, status \d+ ms after the write/);
  assert.doesNotMatch(lines[0], NO_ID);
});
