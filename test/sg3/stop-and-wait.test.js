'use strict';

// The 3.0 link when it is stopped while being opened, a write that fails at
// the start of a session, and a command that waits for a link
// (lib/sg3/bridge.js, lib/sigmesh/session.js, lib/sg3/controller.js):
// - a link that comes up after stop(), a pairing pause or "no 3.0 device"
//   is closed at once, and no 'connected' comes; after stop() no new link is
//   opened;
// - a first write that fails in MeshSession.start leaves no unhandled
//   rejection behind;
// - a command that waits for a link gets a new try soon after each one that
//   failed, also the second command, and is sent once when the link comes.
// Against the fake Homey and a simulated node; the specification's sample
// keys.

const test = require('node:test');
const assert = require('node:assert/strict');

const { Sg3Controller } = require('../../lib/sg3/controller');
const { MeshSession } = require('../../lib/sigmesh/session');
const { SeqStore } = require('../../lib/sigmesh/seq-store');
const { SimulatedSgNode } = require('./simulated-node');
const { advert, fakeHomey } = require('./fake-homey');

const hex = (s) => Buffer.from(s, 'hex');
const NET_KEY = '7dd7364cd842ad18c17c2b820c84c3d6';
const APP_KEY = '63964771734fbd76e3b40519d1d94a48';
const NETWORK = { netKey: NET_KEY, appKey: APP_KEY, addresses: [0x0003] };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One node, reachable while reach.on (also its kept advertisement), whose
// connect takes connectMs.
function setUp({ held = false, connectMs = 0, reachable = true, ...options } = {}) {
  const node = new SimulatedSgNode({ netKey: hex(NET_KEY), appKey: hex(APP_KEY), address: 0x0003, statusGroup: 0xffff });
  const reach = { on: reachable };
  const homey = fakeHomey({
    adverts: (calls) => {
      if (!reach.on) return [];
      const ad = advert(node, { calls });
      const connect = ad.connect.bind(ad);
      ad.connect = async () => {
        await pause(connectMs);
        if (!reach.on) throw new Error('made-up: out of reach');
        return connect();
      };
      return [ad];
    },
  });
  homey.devices.push(0x0003);
  const logs = [];
  const controller = new Sg3Controller({
    homey, network: NETWORK, deviceAddresses: () => homey.devices,
    held: () => ({ held, why: 'by the test' }), log: (line) => logs.push(line), randomInt: () => 0, lingerMs: 20, ...options,
  });
  return { homey, node, reach, logs, controller };
}

test('stop() while a link is being opened: it is closed as soon as it is up, no "connected", and no new link after', async () => {
  const t = setUp({ held: true, connectMs: 200 });
  t.controller.start();
  await pause(60);
  assert.ok(t.controller.bridge && t.controller.bridge.opening, 'being opened');
  await t.controller.stop();
  await pause(300);
  assert.equal(t.controller.bridge.link, null, 'no link');
  assert.equal(t.controller.counts.links, 0, 'no "connected"');
  assert.ok(t.homey.calls.order.includes('disconnect'), 'Homey was told to disconnect');
  assert.ok(t.logs.includes('a link being opened is closed when it is up: app stopping'), t.logs.join('\n'));
  await assert.rejects(t.controller.setLevel(0x0003, 50), /has stopped/);
  assert.equal(t.homey.calls.connect.length, 1, 'no new connect after stop');
});

test('a pairing pause, and "no 3.0 device", while a link is being opened: closed as soon as it is up', async () => {
  const t = setUp({ held: true, connectMs: 200 });
  t.controller.start();
  await pause(60);
  const end = await t.controller.pauseForScan('pairing scan');
  assert.ok(t.logs.includes('pairing scan pause: link let go'), t.logs.join('\n'));
  await pause(300);
  assert.equal(t.controller.bridge.link, null, 'no link during the pause');
  end();
  await t.controller.stop();

  const none = setUp({ held: true, connectMs: 200 });
  none.controller.start();
  await pause(60);
  none.homey.devices.length = 0;
  none.controller.applyMode();
  await pause(300);
  assert.equal(none.controller.bridge.link, null);
  assert.equal(none.controller.counts.links, 0);
  await none.controller.stop();
});

test('a first write that fails in MeshSession.start: start() fails with it, and no unhandled rejection is left', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(String(reason && reason.message));
  process.on('unhandledRejection', onUnhandled);
  try {
    const kept = new Map();
    const session = new MeshSession({
      netKey: hex(NET_KEY), appKey: hex(APP_KEY), address: 0x7f80, ivIndex: 0,
      seqStore: new SeqStore({ get: (k) => kept.get(k), set: (k, v) => kept.set(k, v) }),
      write: async () => { throw new Error('made-up: write failed'); },
    });
    await assert.rejects(session.start({ passAll: true, filterTimeoutMs: 100, beaconTimeoutMs: 10 }), /write failed/);
    session.close();
    await pause(250);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test('a command that waits for a link: a new try soon after each one that failed, also for the next command, and sent once', async () => {
  const t = setUp({ reachable: false, commandWaitMs: 2000, commandRetryMs: 50 });
  const first = t.controller.setLevel(0x0003, 50);
  await pause(200);
  assert.ok(t.homey.calls.discover >= 3, `tried again: ${t.homey.calls.discover} scans`);
  t.reach.on = true;
  await first;
  assert.equal(t.node.level, 50);
  assert.deepEqual(t.node.events.filter((event) => event.startsWith('level')), ['level 50'], 'sent once');
  assert.ok(t.logs.some((line) => /^new link for a waiting command in 0\.1 s$/.test(line)), t.logs.join('\n'));
  assert.ok(!t.logs.some((line) => /^new link in (60|300) s$/.test(line)), 'not the held link\'s steps');

  // The link goes; the node is out of reach; the next command waits and is tried again soon.
  await t.controller.disconnect('idle');
  t.reach.on = false;
  const scans = t.homey.calls.discover;
  const second = t.controller.setLevel(0x0003, 20);
  await pause(200);
  assert.ok(t.homey.calls.discover - scans >= 3, 'the second command is tried again too');
  t.reach.on = true;
  await second;
  assert.equal(t.node.level, 20);
  assert.deepEqual(t.node.events.filter((event) => event.startsWith('level')), ['level 50', 'level 20']);
  await t.controller.stop();
  assert.equal(t.controller.waitRetryTimer, null, 'none left after stop');
});
