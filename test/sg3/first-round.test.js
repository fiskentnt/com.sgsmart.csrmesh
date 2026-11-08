'use strict';

// The first 3.0 status round after the app started, not held
// (lib/sg3/controller.js, startPoll): FIRST_POLL_MS (30 s) after start, not
// after the 5 min of the regular rounds, which keep their times. Once per
// start; none when stopped or held first. Against the fake Homey and a
// simulated node; the specification's sample keys.

const test = require('node:test');
const assert = require('node:assert/strict');

const { FIRST_POLL_MS, Sg3Controller } = require('../../lib/sg3/controller');
const { SimulatedSgNode } = require('./simulated-node');
const { advert, fakeHomey } = require('./fake-homey');

const hex = (s) => Buffer.from(s, 'hex');
const NET_KEY = '7dd7364cd842ad18c17c2b820c84c3d6';
const APP_KEY = '63964771734fbd76e3b40519d1d94a48';
const NETWORK = { netKey: NET_KEY, appKey: APP_KEY, addresses: [0x0003] };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setUp({ pollMs = 600000, firstPollMs = 50 } = {}) {
  const node = new SimulatedSgNode({ netKey: hex(NET_KEY), appKey: hex(APP_KEY), address: 0x0003, on: true, level: 40, statusGroup: 0xffff });
  const homey = fakeHomey({ adverts: (calls) => [advert(node, { calls })] });
  homey.devices.push(0x0003);
  const logs = [];
  const mode = { held: false };
  const controller = new Sg3Controller({
    homey, network: NETWORK, deviceAddresses: () => homey.devices, held: () => ({ held: mode.held, why: 'by the test' }),
    log: (line) => logs.push(line), randomInt: () => 0, lingerMs: 20, pollMs, firstPollMs,
  });
  return { homey, node, logs, mode, controller };
}

test('30 s after start by default', () => {
  assert.equal(FIRST_POLL_MS, 30000);
  const controller = new Sg3Controller({ homey: fakeHomey(), network: NETWORK, log: () => {} });
  assert.equal(controller.firstPollMs, 30000);
  controller.stopSummary();
});

test('not held: the first round comes soon after start and reads the status; the regular rounds keep their times', async () => {
  const t = setUp({ pollMs: 400 });
  t.controller.start();
  const timer = t.controller.pollTimer;
  await pause(150);
  assert.ok(t.logs.includes('first status round, 0 s after start'), t.logs.join('\n'));
  assert.equal(t.homey.calls.discover, 1, 'one round so far');
  assert.ok(t.logs.some((line) => /^0x0003 status: on 40 after/.test(line)), t.logs.join('\n'));
  assert.equal(t.controller.pollTimer, timer, 'the regular rounds\' timer as before');
  await pause(330);
  assert.equal(t.homey.calls.discover, 2, 'the regular round at 400 ms');
  await t.controller.stop();
});

test('once per start: a second startPoll (after held, or a pause) sets no first round again', async () => {
  const t = setUp();
  t.controller.start();
  await pause(120);
  assert.equal(t.homey.calls.discover, 1);
  t.controller.stopPoll();
  t.controller.startPoll();
  await pause(120);
  assert.equal(t.homey.calls.discover, 1, 'no second first round');
  assert.equal(t.logs.filter((line) => /^first status round/.test(line)).length, 1);
  await t.controller.stop();
});

test('none when the app stops first, or when the link is held from the start', async () => {
  const t = setUp();
  t.controller.start();
  await t.controller.stop();
  await pause(120);
  assert.equal(t.homey.calls.discover, 0);
  assert.equal(t.controller.firstPollTimer, null);

  const held = setUp();
  held.mode.held = true;
  held.controller.start();
  await pause(120);
  assert.ok(!held.logs.some((line) => /^first status round/.test(line)), 'held: the link asks by itself');
  await held.controller.stop();
});
