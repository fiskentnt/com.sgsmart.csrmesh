'use strict';

// The bridge falls back to the other nodes after two failed connects to the
// preferred one in a row, the same for every generation: find() keeps giving
// Homey's known advertisement of the preferred node also when the node does
// not take a connection, so without this the recovery tries that node again
// and again. After two, the same recovery round scans and tries the nodes
// _candidates() gives, the failing node last, and the node that connects
// becomes the preferred one. One failure changes nothing. The held link keeps
// its own rule (a scan after three failures). Made-up values: the names,
// uuids, location id and mesh id. Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const fake = require('./helpers/fake-homey');

fake.install();

const { deriveNetworkKey, makePacket } = require('../lib/csrmesh');
const { csrLevelData } = require('../lib/sgProtocol');
const MeshBridge = require('../lib/MeshBridge');

const KEY = deriveNetworkKey('1234');
const HOME = 0x4c2e;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const command = (level) => makePacket(KEY, 0x10, csrLevelData({
  meshId: 0x9a31, location: HOME, level, tid: 1,
}));

// A bridge with two nodes: A, the preferred one, which find() always gives
// and which fails the first aFails connects (all of them by default), and B,
// which connects. The scan sees both, A the stronger, unless scanSees says
// otherwise. connects lists the connect calls by node, finds and scans count.
function twoNodes({ gen1 = false, aFails = Infinity, scanSees = ['A', 'B'] } = {}) {
  const clock = { now: 5000000 };
  const lines = [];
  const counts = {
    connects: [], finds: 0, scans: 0, bridgeChanged: 0,
  };
  const app = {
    log: (...args) => lines.push(args.join(' ')),
    error: (...args) => lines.push(args.join(' ')),
    getNetworkKey: () => KEY,
    nextSeq: () => 1,
    _devices: () => [],
    dimmerCount: () => (gen1 ? 2 : 0),
    reportSignal() {},
    bridgeChanged: () => { counts.bridgeChanged += 1; },
  };
  const write = async () => { clock.now += 40; };
  const chars = [{ uuid: 'c4edc0009daf11e3800300025b000b00', write }, { uuid: 'c4edc0009daf11e3800400025b000b00', write }];
  const peripheral = () => ({
    once() {}, removeListener() {}, disconnect: async () => {}, getService: async () => ({ discoverCharacteristics: async () => chars }),
  });
  let failsLeft = aFails;
  const node = (label, uuid, localName, rssi) => ({
    uuid,
    localName,
    rssi,
    serviceUuids: ['fef1'],
    connectable: true,
    connect: async () => {
      counts.connects.push(label);
      clock.now += 1500;
      if (label === 'A' && failsLeft > 0) {
        failsLeft -= 1;
        throw new Error('Could not connect to peripheral');
      }
      return peripheral();
    },
  });
  const nodes = {
    A: node('A', 'aaaa00001111', gen1 ? '@ND1A2B' : '@MC1A2B', -42),
    B: node('B', 'bbbb00002222', gen1 ? '@ND3C4D' : '@MC3C4D', -60),
  };
  const ble = {
    find: async (uuid) => {
      counts.finds += 1;
      return uuid === nodes.A.uuid ? nodes.A : null;
    },
    discover: async () => {
      counts.scans += 1;
      clock.now += 10000;
      return scanSees.map((label) => nodes[label]);
    },
  };
  app.homey = fake.fakeHomey(app, { ble });
  const bridge = new MeshBridge(app);
  bridge._sleep = async (ms) => { clock.now += ms; };
  bridge._preferredUuid = nodes.A.uuid;
  bridge._cacheAdv(nodes.A.uuid, nodes.A);
  return {
    bridge, app, clock, counts, lines, nodes,
  };
}

async function withClock(clock, run) {
  const realNow = Date.now;
  Date.now = () => clock.now;
  try {
    return await run();
  } finally {
    Date.now = realNow;
  }
}

// Runs until done settles, firing Homey's timers in turn and moving the clock.
async function runUntil(bridge, clock, done) {
  let settled = false;
  done.then(() => { settled = true; }, () => { settled = true; });
  for (let round = 0; round < 400 && !settled; round += 1) {
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

const send = (t, level = 40) => withClock(t.clock, () => runUntil(t.bridge, t.clock, t.bridge.send(command(level), { key: 'csr:a', level })));

test('one failed connect to the preferred node: the recovery tries it again through find(), no scan, as before', async () => {
  const t = twoNodes({ aFails: 1 });
  const result = await send(t);
  assert.equal(result.ok, true);
  assert.deepEqual(t.counts.connects, ['A', 'A']);
  assert.equal(t.counts.scans, 0);
  assert.equal(t.bridge._preferredUuid, t.nodes.A.uuid);
  assert.equal(t.counts.bridgeChanged, 0);
});

for (const gen1 of [false, true]) {
  const kind = gen1 ? 'a first generation bridge' : 'a later bridge';
  test(`${kind}: after two failed connects in a row, the same recovery scans, tries the other node first, and it becomes the preferred one`, async () => {
    const t = twoNodes({ gen1 });
    const result = await send(t);
    assert.equal(result.ok, true, 'the command got out');
    assert.deepEqual(t.counts.connects, ['A', 'A', 'B'], 'the cached advertisement, find(), then B before A');
    assert.equal(t.counts.scans, 1);
    assert.equal(t.bridge._preferredUuid, t.nodes.B.uuid);
    assert.equal(t.app.homey.settings.get('bridgeUuid'), t.nodes.B.uuid);
    assert.equal(t.counts.bridgeChanged, 1);
    assert.ok(!t.lines.some((line) => /cooling down/.test(line)), 'in the same round, no cooldown first');
    const said = t.lines.filter((line) => /failed 2 connects in a row/.test(line));
    assert.equal(said.length, 1);
    assert.doesNotMatch(said[0], /aaaa00001111|bbbb00002222/);
    // The next link goes straight to B, on its cached advertisement.
    await withClock(t.clock, () => t.bridge._disconnect('test'));
    const again = await send(t, 60);
    assert.equal(again.ok, true);
    assert.deepEqual(t.counts.connects, ['A', 'A', 'B', 'B']);
    assert.equal(t.counts.scans, 1);
  });
}

test('the count is of failures in a row: a connect to the preferred node that works starts it again', async () => {
  const t = twoNodes({ aFails: 1 });
  await send(t);
  assert.equal(t.bridge._preferredFails, 0);
  await withClock(t.clock, () => t.bridge._disconnect('test'));
  t.nodes.A.connect = (() => {
    const real = t.nodes.A.connect;
    let once = true;
    return async () => {
      if (once) {
        once = false;
        t.counts.connects.push('A');
        throw new Error('Could not connect to peripheral');
      }
      return real();
    };
  })();
  const result = await send(t, 60);
  assert.equal(result.ok, true);
  assert.equal(t.counts.scans, 0, 'one failure again, not two in a row');
});

test('with no other node in the scan: the preferred node is tried as before, and the command is given up after 30 s as before', async () => {
  const t = twoNodes({ scanSees: ['A'] });
  const result = await send(t);
  assert.equal(result.failed, true);
  assert.ok(!t.counts.connects.includes('B'));
  assert.equal(t.bridge._preferredUuid, t.nodes.A.uuid);
});

test('the held link keeps its own rule: a scan after three failed attempts, not two', async () => {
  const t = twoNodes();
  const asked = [];
  t.bridge._held = true;
  t.bridge._ensureConnected = async (options) => { asked.push(options.fastPreferred); throw new Error('no node'); };
  t.bridge._scheduleHeld = () => {};
  t.bridge._preferredFails = 2;
  for (const failures of [0, 1, 2, 3]) {
    t.bridge._heldFailures = failures;
    await withClock(t.clock, () => t.bridge._heldTick());
  }
  assert.deepEqual(asked, [true, true, true, false]);
});
