'use strict';

// The kept advertisement (lib/sg3/bridge.js): a command, or a dimmer asking
// its status, opens a link on the advertisement of the last link while it is
// under 6 min old, without find; its connect gives up after 3 s, and then the
// link is opened as before. The status round and a new link after a drop use
// find, and what find gives takes the place of the kept one. Against the
// fake Homey and a simulated node; the specification's sample keys.

const test = require('node:test');
const assert = require('node:assert/strict');

const { KEPT_CONNECT_MS, KEPT_MAX_MS, Sg3Bridge } = require('../../lib/sg3/bridge');
const { Sg3Controller } = require('../../lib/sg3/controller');
const { SimulatedSgNode } = require('./simulated-node');
const { advert, fakeHomey, NETWORK_ID } = require('./fake-homey');

const hex = (s) => Buffer.from(s, 'hex');
const NET_KEY = '7dd7364cd842ad18c17c2b820c84c3d6';
const APP_KEY = '63964771734fbd76e3b40519d1d94a48';
const NETWORK = { netKey: NET_KEY, appKey: APP_KEY, addresses: [0x0003] };
const CONNECT_MS = 40; // the give-up in these tests, for 3 s
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Long enough for a link to be let go after the linger (20 ms here).
const letGo = () => pause(60);

// An advertisement of the node that says which way it came (from: 'scan' or
// 'find') each time it is connected on, and connects as the test says next:
// 'ok', 'refuse', 'late' (the peripheral comes after 80 ms), 'slowFail'
// (Homey gives up after 120 ms) or 'hang' (never ends). Each connect's start
// and end are kept in conduct.spans.
function watched(node, calls, from, conduct, rssi = -60) {
  const adv = advert(node, { calls, rssi });
  const connect = adv.connect;
  adv.connect = async () => {
    conduct.used.push(from);
    const how = conduct.next.shift() || 'ok';
    const span = { from, how, start: Date.now(), end: null };
    conduct.spans.push(span);
    const ended = (value) => { span.end = Date.now(); return value; };
    if (how === 'refuse') throw new Error('made-up: refused');
    if (how === 'hang') return new Promise(() => {});
    if (how === 'slowFail') {
      return new Promise((resolve, reject) => {
        setTimeout(() => { ended(); reject(new Error('made-up: Could not connect')); }, 120);
      });
    }
    if (how === 'ok') return connect().then(ended);
    if (how === 'late') {
      return new Promise((resolve) => {
        setTimeout(async () => {
          const peripheral = await connect();
          peripheral.disconnect = async () => { conduct.lateLetGo += 1; };
          resolve(peripheral);
        }, 80);
      });
    }
    return connect();
  };
  return adv;
}

// A controller that does not hold the link, with one 3.0 dimmer (0x0003),
// the proxy node. The scan finds it at -60 dBm, find at -71 dBm.
function keptSetUp() {
  const node = new SimulatedSgNode({ netKey: hex(NET_KEY), appKey: hex(APP_KEY), address: 0x0003, on: true, level: 40, statusGroup: 0xffff });
  const conduct = { used: [], next: [], lateLetGo: 0, findFails: false, spans: [] };
  const homey = fakeHomey({ adverts: (calls) => [watched(node, calls, 'scan', conduct)] });
  homey.devices.push(0x0003);
  const found = [];
  homey.ble.find = async (uuid) => {
    found.push(uuid);
    if (conduct.findFails) throw new Error('made-up: not known');
    return watched(node, homey.calls, 'find', conduct, -71);
  };
  const logs = [];
  const clock = { ahead: 0, now: () => Date.now() + clock.ahead };
  const controller = new Sg3Controller({
    homey,
    network: NETWORK,
    deviceAddresses: () => homey.devices,
    held: () => ({ held: false, why: 'by the test' }),
    log: (line) => logs.push(line),
    randomInt: () => 0,
    now: clock.now,
    lingerMs: 20,
    pollMs: 600000,
    keptConnectMs: CONNECT_MS,
  });
  return { homey, node, conduct, found, logs, clock, controller };
}

const has = (logs, pattern) => assert.ok(logs.some((line) => pattern.test(line)), logs.join('\n'));
const hasNot = (logs, pattern) => assert.ok(!logs.some((line) => pattern.test(line)), logs.join('\n'));

test('the limits: kept for 6 min from when it was fetched, as the first generation, and its connect gives up after 3 s', () => {
  assert.equal(KEPT_MAX_MS, 6 * 60 * 1000);
  assert.equal(KEPT_CONNECT_MS, 3000);
  const controller = new Sg3Controller({ homey: fakeHomey(), network: NETWORK, log: () => {} });
  assert.equal(controller.keptConnectMs, 3000);
  const bridge = controller.createBridge();
  assert.equal(bridge.keptConnectMs, 3000);
  assert.equal(bridge.keptMaxMs, KEPT_MAX_MS);
  assert.equal(bridge.kept, null, 'a new bridge has none');
});

test('a command within 6 min connects on the kept advertisement, without find and without a scan; the log says so, and the link gives no signal', async () => {
  const t = keptSetUp();
  await t.controller.pollStatus();
  assert.equal(t.homey.calls.discover, 1, 'the first link: a scan');
  assert.equal(t.homey.store.get(`sg3Proxy:${NETWORK_ID}`), 'proxy-a');
  const seen = [];
  t.controller.on('proxy', (node) => seen.push(node));
  t.clock.ahead += 95 * 1000;
  const result = await t.controller.setLevel(0x0003, 25);
  assert.equal(result.acked, true);
  assert.equal(t.node.level, 25);
  assert.deepEqual(t.found, [], 'no find');
  assert.equal(t.homey.calls.discover, 1, 'no new scan');
  assert.deepEqual(t.conduct.used, ['scan', 'scan'], 'the second link on the same advertisement');
  has(t.logs, /^the proxy used last, …xy-a, from the kept advertisement \(95\.\d s old\)$/);
  has(t.logs, /^link #2 …xy-a \(kept advertisement, 95\.\d s old, signal not used\): connect \d+\.\d s, /);
  assert.deepEqual(seen, [{ address: 0x0003, rssi: null }], 'the node, without a signal');
  assert.deepEqual(t.controller.proxyNode, { address: 0x0003, rssi: null });
  await t.controller.stop();
});

test('the age counts from when it was fetched, not from its last use: under 6 min it is used, at 6 min find opens the link', async () => {
  const t = keptSetUp();
  await t.controller.pollStatus();
  t.clock.ahead += KEPT_MAX_MS - 1000;
  await t.controller.setLevel(0x0003, 25);
  assert.deepEqual(t.found, []);
  has(t.logs, /from the kept advertisement \(359\.\d s old\)$/);
  await letGo();
  t.clock.ahead += 1000;
  await t.controller.setLevel(0x0003, 30);
  assert.equal(t.node.level, 30);
  assert.deepEqual(t.found, ['proxy-a'], 'find');
  has(t.logs, /^the kept advertisement of …xy-a is 360\.\d s old: find$/);
  has(t.logs, /^the proxy used last, …xy-a, without a scan \(find \d+\.\d s\)$/);
  assert.equal(t.homey.calls.discover, 1);
  await t.controller.stop();
});

test('the status round and a new link after a drop use find, also with a fresh kept advertisement, and what find gives takes its place', async () => {
  const t = keptSetUp();
  await t.controller.pollStatus();
  t.clock.ahead += 60 * 1000;
  await t.controller.pollStatus();
  assert.deepEqual(t.found, ['proxy-a'], 'the round: find');
  assert.deepEqual(t.conduct.used, ['scan', 'find']);
  hasNot(t.logs, /kept advertisement/);
  // 5 min after the round's find, 6 min after the scan: the find one is kept.
  t.clock.ahead += 5 * 60 * 1000;
  await t.controller.setLevel(0x0003, 25);
  assert.deepEqual(t.conduct.used, ['scan', 'find', 'find'], 'on the advertisement from find');
  has(t.logs, /from the kept advertisement \(300\.\d s old\)$/);
  assert.deepEqual(t.found, ['proxy-a'], 'no find for the command');
  await letGo();
  t.controller.connectSoon(0);
  await pause(30);
  assert.deepEqual(t.found, ['proxy-a', 'proxy-a'], 'a new link after a drop: find');
  assert.deepEqual(t.conduct.used, ['scan', 'find', 'find', 'find']);
  await t.controller.stop();
});

test('a slow connect on the kept advertisement is waited for and used: one connect, no find, nothing let go', async () => {
  const t = keptSetUp();
  await t.controller.pollStatus();
  t.conduct.next.push('late');
  await t.controller.setLevel(0x0003, 25);
  assert.equal(t.node.level, 25);
  assert.deepEqual(t.conduct.used, ['scan', 'scan'], 'the kept one only');
  assert.deepEqual(t.found, [], 'no find');
  await pause(100);
  hasNot(t.logs, /let go/);
  has(t.logs, /^link #2: the connect takes over 0\.0 s: waiting for it, up to 20\.0 s in all$/);
  has(t.logs, /^link #2: the connect came after \d+\.\d s, used$/);
  has(t.logs, /^link #2 …xy-a \(kept advertisement/);
  await t.controller.stop();
});

test('a connect slower than the 20 s limit is given up: find connects at once, the limit being reached, and the late one is let go when it comes', async () => {
  const t = keptSetUp();
  await t.controller.pollStatus();
  t.controller.bridge.connectSettleMs = 60;
  t.conduct.next.push('late');
  await t.controller.setLevel(0x0003, 25);
  assert.equal(t.node.level, 25);
  assert.deepEqual(t.conduct.used, ['scan', 'scan', 'find'], 'the kept one, then find');
  assert.deepEqual(t.found, ['proxy-a']);
  has(t.logs, /^the kept advertisement of …xy-a gave up after \d+\.\d s \(connect took over 60 ms\): find$/);
  await pause(100);
  const order = [/^link #2: the connect takes over 0\.0 s: waiting for it/, /gave up/, /without a scan \(find/,
    /^link #3: Homey's connect to …xy-a before this one has not ended: waiting$/, /^link #3: the connect before did not end within 0\.1 s: connecting anyway$/,
    /^link #3 …xy-a /, /^link #2: the connect came after giving up, let go$/];
  let from = 0;
  for (const pattern of order) {
    const at = t.logs.findIndex((line, i) => i >= from && pattern.test(line));
    assert.ok(at >= 0, `${pattern} after line ${from}:\n${t.logs.join('\n')}`);
    from = at + 1;
  }
  await t.controller.stop();
});

test('as at 13:44 on 2026-11-08: Homey\'s first connect fails late; the next connect to the same node starts only after it, and the link comes', async () => {
  const t = keptSetUp();
  await t.controller.pollStatus();
  t.conduct.next.push('slowFail');
  await t.controller.setLevel(0x0003, 30);
  assert.equal(t.node.level, 30);
  const [, first, second] = t.conduct.spans;
  assert.deepEqual([first.how, second.how], ['slowFail', 'ok']);
  assert.ok(second.start >= first.end, `the second began ${second.start - first.end} ms after the first ended`);
  has(t.logs, /^link #2: the connect takes over 0\.0 s: waiting for it/);
  has(t.logs, /^the kept advertisement of …xy-a gave up after \d+\.\d s \(made-up: Could not connect\): find$/);
  await t.controller.stop();
});

test('one connect at a time to the same node: a connect waits until Homey has ended the one before to it, and then connects', async () => {
  const t = keptSetUp();
  const bridge = t.controller.createBridge();
  t.controller.bridge = bridge;
  const adv = watched(t.node, t.homey.calls, 'scan', t.conduct);
  const before = Date.now();
  bridge.connects.set(adv.uuid, { started: before, ended: pause(100) });
  await bridge.openVia(adv, 'scan');
  assert.ok(t.conduct.spans[0].start - before >= 95, `connected ${t.conduct.spans[0].start - before} ms after`);
  has(t.logs, /^link #1: Homey's connect to …xy-a before this one has not ended: waiting$/);
  has(t.logs, /^link #1: the connect before ended after \d+\.\d s more$/);
  assert.ok(bridge.link, 'the link is up');
  await t.controller.stop();
});

test('a connect before that never ends: the next waits CONNECT_SETTLE_MS (20 s) at most, then connects anyway with a line in the log', async () => {
  const { CONNECT_SETTLE_MS } = require('../../lib/sg3/bridge');
  assert.equal(CONNECT_SETTLE_MS, 20000);
  const t = keptSetUp();
  await t.controller.pollStatus();
  t.controller.bridge.connectSettleMs = 150;
  t.conduct.next.push('hang');
  const started = Date.now();
  await t.controller.setLevel(0x0003, 35);
  assert.equal(t.node.level, 35);
  assert.ok(Date.now() - started >= 140, 'waited for the limit');
  has(t.logs, /^link #3: the connect before did not end within 0\.1 s: connecting anyway$/);
  await t.controller.stop();
});

test('a kept advertisement that is refused is forgotten; then find, then a scan, as before', async () => {
  const t = keptSetUp();
  await t.controller.pollStatus();
  t.conduct.next.push('refuse');
  t.conduct.findFails = true;
  await t.controller.setLevel(0x0003, 25);
  assert.equal(t.node.level, 25);
  assert.deepEqual(t.conduct.used, ['scan', 'scan', 'scan'], 'kept, then a new scan');
  assert.equal(t.homey.calls.discover, 2);
  const order = [/gave up after \d+\.\d s \(made-up: refused\): find$/, /did not answer \(made-up: not known\): scanning$/, /^scan \d+\.\d s: /];
  // Each after the one before (the first link's scan line comes earlier).
  let from = 0;
  for (const pattern of order) {
    const at = t.logs.findIndex((line, i) => i >= from && pattern.test(line));
    assert.ok(at >= 0, `${pattern} after line ${from}:\n${t.logs.join('\n')}`);
    from = at + 1;
  }
  await t.controller.stop();
});

test('the bridge alone: a kept advertisement that fails, with no find answer and nothing in the scan, is forgotten and the error says no proxy', async () => {
  const logs = [];
  const calls = { connect: [], order: [], peripherals: [] };
  const refusing = { uuid: 'proxy-a', rssi: -60, connect: async () => { calls.connect.push('proxy-a'); throw new Error('made-up: refused'); } };
  const bridge = new Sg3Bridge({
    ble: { discover: async () => [], find: async () => { throw new Error('made-up: not known'); } },
    networkId: hex(NETWORK_ID),
    createSession: () => { throw new Error('not reached'); },
    lastProxy: () => 'proxy-a',
    keptConnectMs: CONNECT_MS,
  });
  bridge.on('log', (line) => logs.push(line));
  bridge.kept = { advertisement: refusing, uuid: 'proxy-a', fetchedAt: Date.now() };
  await assert.rejects(bridge.ensureConnected({ kept: true }), /no proxy node of this network in range/);
  assert.equal(bridge.kept, null);
  assert.deepEqual(calls.connect, ['proxy-a']);
  await assert.rejects(bridge.ensureConnected({ kept: true }), /no proxy node/);
  assert.deepEqual(calls.connect, ['proxy-a'], 'not tried again');
  // Without kept, a fresh kept advertisement is not used either.
  bridge.kept = { advertisement: refusing, uuid: 'proxy-a', fetchedAt: Date.now() };
  await assert.rejects(bridge.ensureConnected(), /no proxy node/);
  assert.deepEqual(calls.connect, ['proxy-a']);
  assert.equal(logs.filter((line) => /from the kept advertisement/.test(line)).length, 1, logs.join('\n'));
});

test('the kept advertisement of another proxy than the one used last is not used', async () => {
  const t = keptSetUp();
  await t.controller.pollStatus();
  t.homey.store.set(`sg3Proxy:${NETWORK_ID}`, 'proxy-b');
  await t.controller.setLevel(0x0003, 25);
  assert.deepEqual(t.found, ['proxy-b']);
  assert.deepEqual(t.conduct.used, ['scan', 'find']);
  hasNot(t.logs, /kept advertisement/);
  await t.controller.stop();
});

test('a link that fails after the connect keeps nothing: no service, or a proxy that may not be a bridge', async () => {
  for (const [extra, network] of [[{ noService: true }, NETWORK], [{}, { ...NETWORK, bridges: [0x0009] }]]) {
    const node = new SimulatedSgNode({ netKey: hex(NET_KEY), appKey: hex(APP_KEY), address: 0x0003, statusGroup: 0xffff });
    const homey = fakeHomey({ adverts: (calls) => [advert(node, { calls, ...extra })] });
    homey.devices.push(0x0003);
    const controller = new Sg3Controller({ homey, network, deviceAddresses: () => homey.devices, log: () => {}, randomInt: () => 0 });
    await assert.rejects(controller.getStatus(0x0003));
    assert.equal(controller.bridge.kept, null, JSON.stringify(extra));
    await controller.stop();
  }
});

test('a new controller (an app restart, or a new network) has no kept advertisement: its first command uses find', async () => {
  const t = keptSetUp();
  await t.controller.pollStatus();
  await t.controller.stop();
  const logs = [];
  const again = new Sg3Controller({
    homey: t.homey, network: NETWORK, deviceAddresses: () => t.homey.devices, held: () => ({ held: false, why: 'by the test' }),
    log: (line) => logs.push(line), randomInt: () => 0, lingerMs: 20,
  });
  again.ids = t.controller.ids;
  await again.setLevel(0x0003, 25);
  assert.deepEqual(t.found, ['proxy-a']);
  hasNot(logs, /kept advertisement/);
  await again.stop();
  t.controller.use(NETWORK);
  t.controller.stopSummary();
  assert.equal(t.controller.bridge, null, 'a new network: the bridge, and what it kept, are gone');
});
