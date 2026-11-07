'use strict';

// The one more status round (lib/sg3/controller.js, pollAgain): a round
// that gets no link is tried once more POLL_RETRY_MS later, with one line in
// the log when it starts. Only once, and only for the round; skipped when a
// link came up meanwhile; cancelled when the app stops. The regular rounds
// keep their times. Against the fake Homey and a simulated node; the
// specification's sample keys.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POLL_RETRY_MS, Sg3Controller } = require('../../lib/sg3/controller');
const { SimulatedSgNode } = require('./simulated-node');
const { advert, fakeHomey } = require('./fake-homey');

const hex = (s) => Buffer.from(s, 'hex');
const NET_KEY = '7dd7364cd842ad18c17c2b820c84c3d6';
const APP_KEY = '63964771734fbd76e3b40519d1d94a48';
const NETWORK = { netKey: NET_KEY, appKey: APP_KEY, addresses: [0x0003] };
const RETRY_MS = 50; // for 15 s
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A controller that does not hold the link, with one 3.0 dimmer (0x0003).
// The scan finds the node only while reach.on; each scan's time is kept.
function setUp({ pollMs = 600000 } = {}) {
  const node = new SimulatedSgNode({ netKey: hex(NET_KEY), appKey: hex(APP_KEY), address: 0x0003, on: true, level: 40, statusGroup: 0xffff });
  const reach = { on: false };
  const homey = fakeHomey({ adverts: (calls) => (reach.on ? [advert(node, { calls })] : []) });
  homey.devices.push(0x0003);
  const scans = [];
  const discover = homey.ble.discover;
  homey.ble.discover = (...args) => { scans.push(Date.now()); return discover(...args); };
  const logs = [];
  const controller = new Sg3Controller({
    homey,
    network: NETWORK,
    deviceAddresses: () => homey.devices,
    held: () => ({ held: false, why: 'by the test' }),
    log: (line) => logs.push(line),
    randomInt: () => 0,
    lingerMs: 20,
    pollMs,
    pollRetryMs: RETRY_MS,
  });
  return { homey, node, reach, scans, logs, controller };
}

const count = (logs, pattern) => logs.filter((line) => pattern.test(line)).length;
const AGAIN = /^status round again, \d+ s after the one that failed$/;

test('15 s after a round that failed, by default', () => {
  assert.equal(POLL_RETRY_MS, 15000);
  const controller = new Sg3Controller({ homey: fakeHomey(), network: NETWORK, log: () => {} });
  assert.equal(controller.pollRetryMs, 15000);
  controller.stopSummary();
});

test('a round that gets no link is tried once more after the wait, with one line when it starts, and asks the status', async () => {
  const t = setUp();
  await t.controller.pollStatus();
  assert.ok(t.logs.includes('status round: no proxy node of this network in range'), t.logs.join('\n'));
  assert.equal(count(t.logs, AGAIN), 0, 'not before the wait');
  t.reach.on = true;
  await pause(RETRY_MS + 60);
  assert.equal(count(t.logs, AGAIN), 1, t.logs.join('\n'));
  assert.equal(t.scans.length, 2);
  assert.ok(t.logs.some((line) => /^0x0003 status: on 40 after/.test(line)), t.logs.join('\n'));
  assert.ok(t.logs.some((line) => /^link #1 closed after \d+\.\d s: status read/.test(line)), t.logs.join('\n'));
  await t.controller.stop();
});

test('in the log: the failed round, the one line when the next starts, and its own result, in that order', async () => {
  const t = setUp();
  await t.controller.pollStatus();
  await pause(RETRY_MS + 40);
  const rounds = t.logs.filter((line) => /^status round/.test(line));
  assert.deepEqual(rounds.map((line) => line.replace(/\d+ s after/, 'N s after')), [
    'status round: no proxy node of this network in range',
    'status round again, N s after the one that failed',
    'status round again: no proxy node of this network in range',
  ]);
  await t.controller.stop();
});

test('if that one fails too, no third: the next round comes at its usual time', async () => {
  const t = setUp({ pollMs: 200 });
  t.controller.start();
  const timer = t.controller.pollTimer;
  const started = Date.now();
  await pause(330);
  // The round at 200 ms and the one more at about 250 ms, both without a link.
  assert.equal(t.scans.length, 2, t.logs.join('\n'));
  assert.ok(t.scans[0] - started >= 190 && t.scans[1] - t.scans[0] >= RETRY_MS - 5, JSON.stringify(t.scans.map((at) => at - started)));
  assert.equal(count(t.logs, AGAIN), 1);
  assert.equal(count(t.logs, /^status round again: no proxy node/), 1);
  assert.equal(t.controller.pollRetryTimer, null, 'none waiting after the one more');
  assert.equal(t.controller.pollTimer, timer, 'the regular rounds keep their timer');
  t.reach.on = true;
  await pause(140);
  // The regular round at 400 ms, not one after the one more.
  assert.equal(t.scans.length, 3, t.logs.join('\n'));
  assert.ok(t.scans[2] - started >= 390, JSON.stringify(t.scans.map((at) => at - started)));
  assert.ok(t.logs.some((line) => /^0x0003 status: on 40 after/.test(line)), t.logs.join('\n'));
  await t.controller.stop();
});

test('skipped when a command opened a link meanwhile', async () => {
  const t = setUp();
  await t.controller.pollStatus();
  t.reach.on = true;
  await t.controller.setLevel(0x0003, 25);
  assert.equal(t.node.level, 25);
  await pause(RETRY_MS + 40);
  assert.equal(count(t.logs, AGAIN), 0, t.logs.join('\n'));
  assert.ok(t.logs.includes('status round again skipped: a link came up meanwhile'), t.logs.join('\n'));
  assert.equal(t.scans.length, 2, 'the round and the command, no third');
  await t.controller.stop();
});

test('cancelled when the app stops, and when the link is to be held', async () => {
  const t = setUp();
  await t.controller.pollStatus();
  assert.ok(t.controller.pollRetryTimer);
  await t.controller.stop();
  assert.equal(t.controller.pollRetryTimer, null);
  t.reach.on = true;
  await pause(RETRY_MS + 40);
  assert.equal(count(t.logs, /^status round again/), 0, t.logs.join('\n'));
  assert.equal(t.scans.length, 1);

  const held = setUp();
  const mode = { held: false };
  held.controller.held = () => ({ held: mode.held, why: 'by the test' });
  await held.controller.pollStatus();
  assert.ok(held.controller.pollRetryTimer);
  mode.held = true;
  held.controller.applyMode();
  assert.equal(held.controller.pollRetryTimer, null, 'held: the link comes up by itself');
  await held.controller.stop();
});

test('only for the status round: a dimmer\'s own status question that gets no link starts none', async () => {
  const t = setUp();
  await assert.rejects(t.controller.getStatus(0x0003), /no proxy node/);
  assert.equal(t.controller.pollRetryTimer, null);
  await pause(RETRY_MS + 40);
  assert.equal(count(t.logs, /^status round again/), 0, t.logs.join('\n'));
  await t.controller.stop();
});
