'use strict';

// A link can die without a disconnect from Homey: then only a write fails
// (ATT error 0x0e), unsubscribing throws, and disconnect() says "Peripheral
// Not Found". Two heartbeats failed in a row on one link, and the link is
// taken as dead and let go (HEARTBEAT_FAILS_DEAD), so the held link comes
// back by itself, and a command waiting behind the failing heartbeat goes on
// the new link, never on the dead one. One failed heartbeat changes nothing.
// Made-up values: the name, uuid and key. Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const fake = require('./helpers/fake-homey');

fake.install();

const { deriveNetworkKey, makePacket } = require('../lib/csrmesh');
const proto = require('../lib/sgProtocol');
const MeshBridge = require('../lib/MeshBridge');

const KEY = deriveNetworkKey('test-only-pass');
const CHAR_8003 = 'c4edc0009daf11e3800300025b000b00';
const CHAR_8004 = 'c4edc0009daf11e3800400025b000b00';

// One first generation bridge, held ("Keep dimmers connected"), on Homey's
// clock vt. Each connect gives a new link in links: its writes (tried, and
// written when they got through). A link marked dead fails every write with
// 0x0e and gives no disconnect event; failOnce fails one write only. The
// failed write number state.holdFail on a dead link waits for
// state.release() before it fails.
function heldBridge() {
  const vt = fake.virtualTimers();
  const lines = [];
  const links = [];
  const state = { holdFail: 0, release: null };
  let seq = 0x100;
  const app = {
    log: (...args) => lines.push(args.join(' ')),
    error: (...args) => lines.push(args.join(' ')),
    getNetworkKey: () => KEY,
    nextSeq: () => {
      seq += 1;
      return seq;
    },
    _devices: () => [],
    dimmerCount: () => 1,
    reportSignal() {},
    bridgeChanged() {},
  };
  const node = {
    uuid: 'aaaa00001111',
    localName: '@ND1A2B',
    rssi: -50,
    serviceUuids: ['fef1'],
    connectable: true,
    connect: async () => {
      const link = {
        no: links.length + 1, dead: false, failOnce: false, fails: 0, tried: [], written: [],
      };
      links.push(link);
      const char = (uuid) => ({
        uuid,
        async write(data) {
          link.tried.push(Buffer.from(data));
          if (link.failOnce) {
            link.failOnce = false;
            throw new Error('Operation failed with ATT error: 0x0e');
          }
          if (link.dead) {
            link.fails += 1;
            if (link.fails === state.holdFail) {
              await new Promise((resolve) => {
                state.release = resolve;
              });
            }
            throw new Error('Operation failed with ATT error: 0x0e');
          }
          link.written.push(Buffer.from(data));
        },
        subscribeToNotifications: async () => {},
        unsubscribeFromNotifications: async () => {
          if (link.dead) throw new Error('Not connected');
        },
      });
      const chars = [char(CHAR_8003), char(CHAR_8004)];
      return {
        once() {},
        removeListener() {},
        disconnect: async () => {
          if (link.dead) throw new Error('Peripheral Not Found: test');
        },
        getService: async () => ({ discoverCharacteristics: async () => chars }),
      };
    },
  };
  const ble = { find: async () => node, discover: async () => [node] };
  app.homey = fake.fakeHomey(app, { ...vt, ble });
  app.homey.settings.set('debugLogging', true);
  const bridge = new MeshBridge(app);
  bridge._preferredUuid = node.uuid;
  bridge._cacheAdv(node.uuid, node);
  bridge._held = true;
  return {
    bridge, vt, lines, links, state, node,
  };
}

async function withHeld(run) {
  const t = heldBridge();
  const realNow = Date.now;
  Date.now = t.vt.now;
  try {
    t.bridge._heldTick();
    await t.vt.advance(1000);
    assert.equal(t.links.length, 1, 'the held link is up');
    await run(t);
  } finally {
    t.bridge._held = false;
    Date.now = realNow;
  }
}

const isHeartbeat = (data) => data.length === 20 || data.length === 7;
const dead = (lines) => lines.filter((line) => /heartbeats failed in a row/.test(line));

test('a held link that dies without a disconnect: after two failed heartbeats in a row it is let go, and the held link comes back by itself', async () => {
  await withHeld(async ({
    bridge, vt, lines, links,
  }) => {
    await vt.advance(9000);
    assert.ok(links[0].written.length >= 6, 'heartbeats on the first link');
    links[0].dead = true;
    await vt.advance(6000);
    assert.equal(dead(lines).length, 1, lines.join('\n'));
    assert.match(dead(lines)[0], /2 heartbeats failed in a row on link #1 with no disconnect from Homey/);
    assert.ok(lines.some((line) => /LOCAL DISCONNECT request #1 .*reason=heartbeat-failed/.test(line)));
    assert.equal(links[0].tried.filter((data) => data.length === 20).length - links[0].written.filter((data) => data.length === 20).length, 2,
      'two failed heartbeats on the dead link, no more');
    assert.equal(links.length, 2, 'a new held link');
    assert.equal(bridge._connNo, 2);
    const before = links[1].written.length;
    await vt.advance(9000);
    assert.ok(links[1].written.length > before, 'the heartbeats go on the new link');
    assert.ok(links[1].written.every(isHeartbeat));
  });
});

test('one failed heartbeat changes nothing: the link stays, and the heartbeats go on on it', async () => {
  await withHeld(async ({
    bridge, vt, lines, links,
  }) => {
    await vt.advance(4000);
    links[0].failOnce = true;
    await vt.advance(12000);
    assert.equal(dead(lines).length, 0, lines.join('\n'));
    assert.equal(links.length, 1);
    assert.equal(bridge._connNo, 1);
    assert.ok(lines.some((line) => /keep-alive: heartbeat failed on link #1/.test(line)), 'the one failure is logged as before');
    const after = links[0].written.length;
    await vt.advance(6000);
    assert.ok(links[0].written.length > after);
  });
});

test('a command that comes while the second failing heartbeat is being written: it waits behind it, '
  + 'writes nothing on the dead link, and goes once on the new link', async () => {
  await withHeld(async ({
    bridge, vt, lines, links, state,
  }) => {
    await vt.advance(4000);
    state.holdFail = 2;
    links[0].dead = true;
    // The first failure, then the chain starts again within the held tick,
    // and its heartbeat, the second to fail, is held in the write.
    for (let i = 0; i < 40 && !state.release; i += 1) await vt.advance(100);
    assert.ok(state.release, 'the second failing heartbeat is being written');
    assert.equal(links[0].fails, 2);
    assert.equal(dead(lines).length, 0, 'not yet let go');
    const packet = makePacket(KEY, 0x123456, proto.gen1LevelData({
      location: 0x5a3c, id: 0x1a2b, level: 30, tid: 7,
    }));
    let result = null;
    const sent = bridge.send(packet, { key: 'gen1:1a2b', level: 30 }).then((r) => {
      result = r;
    });
    await vt.advance(200);
    assert.equal(result, null, 'the command waits behind the heartbeat');
    state.release();
    for (let i = 0; i < 100 && result === null; i += 1) await vt.advance(500);
    await sent;
    assert.equal(result && result.ok, true, lines.join('\n'));
    assert.equal(dead(lines).length, 1);
    const head = packet.subarray(0, 20);
    assert.ok(!links[0].tried.some((data) => data.equals(head)), 'nothing of the command on the dead link');
    assert.equal(links.length, 2);
    const tail = packet.subarray(20);
    assert.deepEqual(links[1].written.filter((data) => data.equals(head) || data.equals(tail)).map((data) => data.length),
      [20, tail.length], 'the command once, whole, on the new link');
    assert.ok(lines.some((line) => /ABORT attempt=1\/2 firstWritten=false conn=#1/.test(line)));
    assert.ok(lines.some((line) => /COMPLETE after retry #2/.test(line)));
  });
});
