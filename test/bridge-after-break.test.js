'use strict';

// The stored bridge (bridgeUuid) is not replaced right after a link to it
// went down. Another node carries the commands as early as before (the
// bridge in memory moves as before), but it is stored only once the stored
// bridge has been out of reach BRIDGE_GONE_TIMES times over at least
// BRIDGE_GONE_MS. A scan without a node while a link to it is up, or less
// than LINK_HIDES_MS after one ended, says nothing about it (the scan may give
// such a node without its name, or, just after the link, not at all: assumed):
// it counts for nothing and changes no bridge.
// "Peripheral Not Found" from disconnect() keeps the advertisement. With no
// node in the scan, the last known advertisement is tried, unless it failed
// in the same command. Made-up values: the names, uuids, location id and
// mesh id. Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const fake = require('./helpers/fake-homey');

fake.install();

const { deriveNetworkKey, makePacket } = require('../lib/csrmesh');
const { csrLevelData } = require('../lib/sgProtocol');
const MeshBridge = require('../lib/MeshBridge');

const KEY = deriveNetworkKey('1234');
const HOME = 0x4c2e;
const command = (level) => makePacket(KEY, 0x10, csrLevelData({
  meshId: 0x9a31, location: HOME, level, tid: 1,
}));

// The stored bridge A and a weaker node B, on Homey's clock vt, as on 10.11
// at 05:05: the link to A hung up at the start. Until aConnectsAfterMs after
// that, a connect to A hangs (the app gives up after its own timeout); until
// aSeenAfterMs, find() and the scan do not show A. B connects unless bHangs;
// withB false: no B at all. connects lists the connect calls by node.
function afterBreak({
  aConnectsAfterMs = 30000, aSeenAfterMs = 40000, bHangs = false, withB = true, cached = true,
} = {}) {
  const vt = fake.virtualTimers();
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
    dimmerCount: () => 2,
    reportSignal() {},
    bridgeChanged: () => {
      counts.bridgeChanged += 1;
    },
  };
  const brokeAt = vt.now();
  const since = () => vt.now() - brokeAt;
  const write = async () => {};
  const chars = [{ uuid: 'c4edc0009daf11e3800300025b000b00', write }, { uuid: 'c4edc0009daf11e3800400025b000b00', write }];
  const peripheral = () => ({
    once() {}, removeListener() {}, disconnect: async () => {}, getService: async () => ({ discoverCharacteristics: async () => chars }),
  });
  const hang = () => new Promise(() => {});
  const wait = (ms) => new Promise((resolve) => {
    app.homey.setTimeout(resolve, ms);
  });
  const node = (label, uuid, localName, rssi) => ({
    uuid,
    localName,
    rssi,
    serviceUuids: ['fef1'],
    connectable: true,
    connect: async () => {
      counts.connects.push(label);
      if (label === 'A' && since() < aConnectsAfterMs) return hang();
      if (label === 'B' && bHangs) return hang();
      await wait(3000);
      return peripheral();
    },
  });
  const nodes = {
    A: node('A', 'aaaa00001111', '@ND1A2B', -60),
    B: node('B', 'bbbb00002222', '@ND3C4D', -85),
  };
  const others = withB ? [nodes.B] : [];
  const ble = {
    find: async (uuid) => {
      counts.finds += 1;
      return uuid === nodes.A.uuid && since() >= aSeenAfterMs ? nodes.A : null;
    },
    discover: async () => {
      counts.scans += 1;
      await wait(10000);
      return since() >= aSeenAfterMs ? [nodes.A, ...others] : others;
    },
  };
  app.homey = fake.fakeHomey(app, { ...vt, ble });
  app.homey.settings.set('bridgeUuid', nodes.A.uuid);
  const bridge = new MeshBridge(app);
  // A was the link until it hung up.
  if (cached) bridge._cacheAdv(nodes.A.uuid, nodes.A);
  bridge._knownAdvs.set(nodes.A.uuid, nodes.A);
  bridge._linkEndedAt.set(nodes.A.uuid, brokeAt);
  bridge._hangupAt = brokeAt;
  return {
    bridge, app, vt, counts, lines, nodes,
  };
}

async function at(t, run) {
  const realNow = Date.now;
  Date.now = t.vt.now;
  try {
    return await run();
  } finally {
    Date.now = realNow;
  }
}

// Sends one command and runs Homey's clock until it settles: the result and
// how long it took, in s.
function send(t, level = 40) {
  return at(t, async () => {
    const start = t.vt.now();
    let result = null;
    const done = t.bridge.send(command(level), { key: 'csr:a', level }).then((r) => {
      result = r;
    });
    for (let i = 0; i < 600 && result === null; i += 1) await t.vt.advance(500);
    await done;
    return { ...result, took: Math.round((t.vt.now() - start) / 1000) };
  });
}

const stored = (t) => t.app.homey.settings.get('bridgeUuid');

test('10.11 05:05: right after the hang-up, B carries the command as early as before, and the next one 10 s later as before; '
  + 'the stored bridge stays A', async () => {
  const t = afterBreak();
  const first = await send(t);
  assert.equal(first.ok, true, t.lines.join('\n'));
  assert.deepEqual(t.counts.connects, ['A', 'B'], 'the cached advertisement, then B: no second try of A first');
  assert.ok(first.took <= 34, `took ${first.took} s`);
  assert.equal(t.bridge._preferredUuid, t.nodes.B.uuid, 'the commands go to B now, as before');
  assert.equal(stored(t), t.nodes.A.uuid, 'the stored bridge stays A');
  assert.equal(t.bridge._storedGone, null, 'nothing counted: Homey had just been connected to A');
  assert.ok(t.lines.some((line) => /the stored bridge stays @ND1A2B: out of reach 0 of 3 times/.test(line)), t.lines.join('\n'));
  await at(t, () => t.vt.advance(10000));
  const next = await send(t, 50);
  assert.equal(next.ok, true);
  assert.ok(next.took <= 4, `took ${next.took} s`);
  assert.deepEqual(t.counts.connects, ['A', 'B'], 'the link to B is still up');
  assert.equal(stored(t), t.nodes.A.uuid);
});

test('the bridge gone for good: B carries the commands as before, and is stored once A has been out of reach 3 times '
  + 'over 60 s, the scans right after the link to A not counted, and B carries a link', async () => {
  const t = afterBreak({ aConnectsAfterMs: Infinity, aSeenAfterMs: Infinity });
  const first = await send(t);
  assert.equal(first.ok, true);
  assert.ok(first.took <= 34, `took ${first.took} s`);
  assert.equal(stored(t), t.nodes.A.uuid);
  await at(t, () => t.bridge._disconnect('test'));
  // Scans without A, more than LINK_HIDES_MS after the link to A ended.
  await at(t, async () => {
    await t.vt.advance(30000);
    for (let i = 1; i <= 3; i += 1) {
      assert.equal(t.bridge._pickBridge([t.nodes.B]), t.nodes.B);
      assert.equal(t.bridge._storedGone.times, i);
      await t.vt.advance(30000);
    }
  });
  assert.equal(stored(t), t.nodes.A.uuid, 'not on scans alone');
  const later = await send(t, 50);
  assert.equal(later.ok, true);
  assert.equal(stored(t), t.nodes.B.uuid, 'stored once B carried a link');
  assert.equal(t.bridge._storedGone, null);
});

test('the bridge gone and the other node hanging too: nothing is stored', async () => {
  const t = afterBreak({ aConnectsAfterMs: Infinity, aSeenAfterMs: Infinity, bHangs: true });
  for (const level of [40, 50, 60]) {
    const result = await send(t, level);
    assert.equal(result.failed, true);
    await at(t, () => t.vt.advance(60000));
  }
  assert.equal(stored(t), t.nodes.A.uuid);
});

test('a scan while the held link to the bridge is up, without the bridge (not in it, or without its name): no bridge changed, the link stays, '
  + 'nothing counted', async () => {
  const t = afterBreak();
  const { bridge, nodes } = t;
  const reasons = [];
  bridge._held = true;
  bridge._peripheral = {};
  bridge._char8003 = {};
  bridge._char8004 = {};
  bridge._linkedUuid = nodes.A.uuid;
  bridge._linkEndedAt.clear();
  bridge._discover = async () => [nodes.B];
  bridge._disconnect = async (reason) => {
    reasons.push(reason);
  };
  await at(t, () => bridge._heldRescan());
  assert.equal(bridge._preferredUuid, nodes.A.uuid);
  assert.equal(stored(t), nodes.A.uuid);
  assert.deepEqual(reasons, [], 'the held link is not moved');
  assert.equal(bridge._storedGone, null);
  assert.equal(t.counts.bridgeChanged, 0);
  assert.ok(t.lines.some((line) => /@ND3C4D -85 dBm for this link only: the bridge is not in the scan, but Homey is or was just connected to it/.test(line)));
  bridge._held = false;
});

test('a status poll\'s scan right after the link to the bridge ended: the strongest carries that link only; '
  + 'a minute later the same scan counts, and the commands go to B as before', async () => {
  const t = afterBreak();
  const { bridge, nodes } = t;
  await at(t, async () => {
    assert.equal(bridge._pickBridge([nodes.B]), nodes.B);
    assert.equal(bridge._preferredUuid, nodes.A.uuid);
    assert.equal(bridge._storedGone, null);
    await t.vt.advance(61000);
    bridge._pickBridge([nodes.B]);
    assert.equal(bridge._preferredUuid, nodes.B.uuid);
    assert.equal(bridge._storedGone.times, 1);
    assert.equal(stored(t), nodes.A.uuid);
    // A seen again: not out of reach; 8 dB stronger, so back to A.
    bridge._pickBridge([nodes.A, nodes.B]);
    assert.equal(bridge._preferredUuid, nodes.A.uuid);
    assert.equal(bridge._storedGone, null);
  });
});

test('with no other node: the last known advertisement when the command has not tried it, never a second time in the same command', async () => {
  const fresh = afterBreak({ withB: false, cached: false, aConnectsAfterMs: 0 });
  const result = await send(fresh);
  assert.equal(result.ok, true, fresh.lines.join('\n'));
  assert.deepEqual(fresh.counts.connects, ['A']);
  assert.ok(fresh.lines.some((line) => /no node in the scan; the bridge's last known advertisement/.test(line)));
  const failed = afterBreak({ withB: false, aConnectsAfterMs: Infinity });
  const again = await send(failed);
  assert.equal(again.failed, true);
  assert.deepEqual(failed.counts.connects, ['A'], 'the cached advertisement failed; not tried again in this command');
});

test('"Peripheral Not Found" from disconnect() after a failed write keeps the advertisement for the next connect', async () => {
  const t = afterBreak();
  t.bridge._peripheral = {
    disconnect: async () => {
      throw new Error('Peripheral Not Found: test');
    },
  };
  t.bridge._char8003 = {};
  t.bridge._char8004 = {};
  await at(t, () => t.bridge._disconnect('tx5-attempt1-failure'));
  assert.equal(t.bridge._cachedAdv(t.nodes.A.uuid), t.nodes.A);
  assert.ok(t.lines.some((line) => /LOCAL DISCONNECT call failed #0: Peripheral Not Found/.test(line)));
});

test('two failed connects in a row to a stored bridge that find() still gives: B carries the command, and the next one, '
  + 'as before; the stored bridge stays', async () => {
  const t = afterBreak({ aConnectsAfterMs: Infinity, aSeenAfterMs: 0 });
  const first = await send(t);
  assert.equal(first.ok, true, t.lines.join('\n'));
  assert.deepEqual(t.counts.connects, ['A', 'A', 'B']);
  assert.equal(t.bridge._preferredUuid, t.nodes.B.uuid);
  assert.equal(stored(t), t.nodes.A.uuid);
  await at(t, () => t.bridge._disconnect('test'));
  const next = await send(t, 50);
  assert.equal(next.ok, true);
  assert.deepEqual(t.counts.connects, ['A', 'A', 'B', 'B'], 'straight to B, as before');
});
