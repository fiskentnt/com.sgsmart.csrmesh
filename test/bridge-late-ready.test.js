'use strict';

// A link without the heartbeat that becomes ready 7 s or more after its
// connect is let go before the first packet (Guard 2). A link to a sound
// bridge is now and then that slow, so one such link does not move the
// bridge: the next link goes to it again. PREFERRED_LATE_BEFORE_OTHERS (2)
// in a row, and a TX recovery tries the others, as after failed connects;
// the bridge is not tried a third time. The stored bridge is not changed by
// it. Made-up values: the names, uuids, location id and mesh id.
// Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const fake = require('./helpers/fake-homey');

fake.install();

const { deriveNetworkKey, makePacket } = require('../lib/csrmesh');
const { csrLevelData } = require('../lib/sgProtocol');
const MeshBridge = require('../lib/MeshBridge');

const KEY = deriveNetworkKey('1234');
const HOME = 0x4c2e;
const FEF1 = 'fef1';
const command = (level) => makePacket(KEY, 0x10, csrLevelData({
  meshId: 0x9a31, location: HOME, level, tid: 1,
}));

// A is the stored bridge, B a node a scan also finds, both later nodes.
const nodes = {
  A: {
    uuid: 'aaaa00001111', localName: '@GD1A2B', rssi: -50, serviceUuids: [FEF1], connectable: true,
  },
  B: {
    uuid: 'bbbb00002222', localName: '@GD3C4D', rssi: -62, serviceUuids: [FEF1], connectable: true,
  },
};

// readyMs: per node, how long each link takes from the connect to ready
// (the last value for every link after it). A connect takes 1 s, a scan
// 10 s. inScan: the nodes a scan finds.
function laterHome({ readyMs, inScan = ['A', 'B'] }) {
  const vt = fake.virtualTimers();
  const lines = [];
  const connects = [];
  const writes = [];
  const app = {
    log: (...args) => lines.push(args.join(' ')),
    error: (...args) => lines.push(args.join(' ')),
    getNetworkKey: () => KEY,
    nextSeq: () => 1,
    _devices: () => [],
    dimmerCount: () => 0,
    laterCount: () => 3,
    reportSignal() {},
    bridgeChanged() {},
  };
  const wait = (ms) => new Promise((resolve) => {
    app.homey.setTimeout(resolve, ms);
  });
  const made = { A: 0, B: 0 };
  const live = (label) => ({
    ...nodes[label],
    connect: async () => {
      connects.push(label);
      const n = made[label];
      made[label] += 1;
      const list = readyMs[label];
      const ms = list[Math.min(n, list.length - 1)];
      await wait(1000);
      // writes: the node of each link something was written on.
      let written = false;
      const write = async () => {
        if (!written) writes.push(label);
        written = true;
      };
      const chars = [{ uuid: 'c4edc0009daf11e3800300025b000b00', write }, { uuid: 'c4edc0009daf11e3800400025b000b00', write }];
      return {
        once() {},
        removeListener() {},
        disconnect: async () => {},
        getService: async () => {
          await wait(ms);
          return { discoverCharacteristics: async () => chars };
        },
      };
    },
  });
  let scans = 0;
  const ble = {
    find: async (uuid) => (uuid === nodes.A.uuid ? live('A') : null),
    discover: async () => {
      scans += 1;
      await wait(10000);
      return inScan.map(live);
    },
  };
  app.homey = fake.fakeHomey(app, { ...vt, ble });
  app.homey.settings.set('bridgeUuid', nodes.A.uuid);
  const bridge = new MeshBridge(app);
  return {
    bridge, app, vt, lines, connects, writes, scans: () => scans,
  };
}

// One command, on Homey's clock until it is done or given up.
async function oneCommand(t) {
  const realNow = Date.now;
  Date.now = t.vt.now;
  try {
    const startedAt = Date.now();
    let r = null;
    const done = t.bridge.send(command(40), { key: 'csr:a', level: 40 }).then((x) => {
      r = x;
    });
    for (let i = 0; i < 600 && r === null; i += 1) await t.vt.advance(250);
    await done;
    return { result: r, ms: Date.now() - startedAt };
  } finally {
    Date.now = realNow;
  }
}

// The lines for a link let go as ready too late.
const late = (lines) => lines.filter((line) => /GATT ready too late at \d+ms/.test(line));

test('one link to the stored bridge ready at 8.25 s: let go, and the next link goes to the same bridge; no scan, the bridge is not moved', async () => {
  const t = laterHome({ readyMs: { A: [8250, 1800], B: [2000] } });
  const { result, ms } = await oneCommand(t);
  assert.equal(result.ok, true, t.lines.join('\n'));
  assert.deepEqual(t.connects, ['A', 'A']);
  assert.deepEqual(t.writes, ['A']);
  assert.equal(t.scans(), 0);
  assert.equal(late(t.lines).length, 1);
  assert.equal(t.bridge._preferredUuid, nodes.A.uuid);
  assert.equal(t.app.homey.settings.get('bridgeUuid'), nodes.A.uuid);
  assert.ok(ms < 15000, `${ms} ms`);
});

test('every link to the stored bridge ready at 8.25 s: two, then the others; the command goes through B, and A is not tried a third time', async () => {
  const t = laterHome({ readyMs: { A: [8250], B: [2000] } });
  const { result, ms } = await oneCommand(t);
  assert.equal(result.ok, true, t.lines.join('\n'));
  assert.deepEqual(t.connects, ['A', 'A', 'B']);
  assert.deepEqual(t.writes, ['B']);
  assert.ok(t.lines.some((line) => /the preferred bridge had 2 links in a row ready too late; trying the nodes a scan finds/.test(line)), t.lines.join('\n'));
  assert.equal(t.bridge._preferredUuid, nodes.B.uuid, 'the commands go to B now');
  assert.equal(t.bridge._preferredFailing(), false, 'B starts at 0, and so does A if chosen again');
  assert.equal(t.app.homey.settings.get('bridgeUuid'), nodes.A.uuid, 'the stored bridge is not changed by it');
  assert.ok(ms < 45000, `${ms} ms`);
});

test('a home where a scan finds only the stored bridge, every link ready at 8.25 s: the command is given up as before, '
  + 'with A connected no more often than before; each look for the others is a scan', async () => {
  const t = laterHome({ readyMs: { A: [8250], B: [2000] }, inScan: ['A'] });
  const { result } = await oneCommand(t);
  assert.equal(result.failed, true, t.lines.join('\n'));
  assert.deepEqual(t.writes, []);
  assert.ok(!t.connects.includes('B'));
  assert.ok(t.connects.length <= 4, `connects: ${t.connects.join(' ')}`);
  assert.ok(t.scans() <= 2, `scans: ${t.scans()}`);
});

test('a link to the stored bridge in time after one ready too late: the count starts again, one more late link does not move the bridge', async () => {
  const t = laterHome({ readyMs: { A: [8250, 1800, 8250, 1800], B: [2000] } });
  const first = await oneCommand(t);
  assert.equal(first.result.ok, true);
  // The link from the first command is let go before the next.
  await t.bridge._disconnect('test');
  t.bridge._uncacheAdv(nodes.A.uuid);
  const second = await oneCommand(t);
  assert.equal(second.result.ok, true, t.lines.join('\n'));
  assert.deepEqual(t.connects, ['A', 'A', 'A', 'A']);
  assert.deepEqual(t.writes, ['A', 'A']);
  assert.equal(t.bridge._preferredUuid, nodes.A.uuid);
});
