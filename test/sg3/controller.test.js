'use strict';

// The controller and the BLE layer against a fake Homey (settings, timers,
// ble) whose one proxy advertisement leads to a simulated SG node. The
// network comes as the SG account gives it. Keys are the specification's
// sample keys.

const test = require('node:test');
const assert = require('node:assert/strict');

const { HOMEY_FIRST, HOMEY_LAST, STATUS_BLOCK_MS, Sg3Controller } = require('../../lib/sg3/controller');
const { Sg3Bridge, advertAge, proxyCandidates } = require('../../lib/sg3/bridge');
const proxy = require('../../lib/sigmesh/proxy');
const { SimulatedSgNode } = require('./simulated-node');
const { advert, fakeHomey, NETWORK_ID } = require('./fake-homey');

const hex = (s) => Buffer.from(s, 'hex');
// What a command result says of the sending, without the times.
const sent = ({ acked, segments, writes }) => ({ acked, segments, writes });
const NET_KEY = '7dd7364cd842ad18c17c2b820c84c3d6';
const APP_KEY = '63964771734fbd76e3b40519d1d94a48';
const NETWORK = { netKey: NET_KEY, appKey: APP_KEY, addresses: [0x0003, 0x0005] };

function nodes() {
  const proxyNode = new SimulatedSgNode({ netKey: hex(NET_KEY), appKey: hex(APP_KEY), address: 0x0003, on: true, level: 40, statusGroup: 0xffff });
  const behind = new SimulatedSgNode({ netKey: hex(NET_KEY), appKey: hex(APP_KEY), address: 0x0005, level: 70, via: proxyNode, statusGroup: 0xffff });
  return { proxyNode, behind };
}

// The controller's clock (the status block and the TIDs): real time plus
// what a test moves it on by.
function clockFor() {
  const clock = { ahead: 0, now: () => Date.now() + clock.ahead };
  clock.pastBlock = () => { clock.ahead += STATUS_BLOCK_MS; };
  return clock;
}

function controllerFor(homey, extra = {}) {
  const logs = [];
  const clock = clockFor();
  const controller = new Sg3Controller({
    homey, network: NETWORK, deviceAddresses: () => homey.devices, log: (line) => logs.push(line), randomInt: () => 0, now: clock.now, ...extra,
  });
  return { controller, logs, clock };
}

function setUp(extra) {
  const { proxyNode, behind } = nodes();
  const homey = fakeHomey({ adverts: (calls) => [advert(proxyNode, { calls })] });
  return { homey, proxyNode, behind, ...controllerFor(homey, extra) };
}

// ------------------------------------------------------------ controller

test('keys that do not import: no 3.0 network, a line in the log, and nothing touches Bluetooth', async () => {
  const homey = fakeHomey();
  const logs = [];
  const controller = new Sg3Controller({ homey, network: { netKey: 'zz', appKey: APP_KEY }, log: (line) => logs.push(line) });
  assert.equal(controller.configured, false);
  assert.deepEqual(controller.status(), { configured: false });
  assert.ok(logs.includes('the account\'s 3.0 keys do not import (invalid_net_key): no 3.0 network'));
  await assert.rejects(controller.getStatus(0x0003), /not set up/);
  assert.equal(homey.calls.discover, 0);
  assert.deepEqual([...homey.store.keys()], []);
});

test('the network from the account: its Network ID, an address drawn and kept, and the IV Index from the beacon', async () => {
  const { homey, controller, logs } = setUp({ randomInt: (n) => n - 1 });
  assert.equal(controller.networkId, NETWORK_ID);
  assert.equal(controller.address, HOMEY_LAST);
  assert.equal(homey.store.get(`sg3Addr:${NETWORK_ID}`), HOMEY_LAST);
  assert.ok(logs.includes(`no address kept for this network on this Homey: drew 0x${HOMEY_LAST.toString(16)}`));
  assert.ok(logs.includes(`network …${NETWORK_ID.slice(-4)}: 2 node address(es) in the account, sending from 0x7ffe, `
    + 'IV Index unknown (from the beacon), commands to the node'), logs.join('\n'));
  await controller.getStatus(0x0003);
  assert.equal(homey.store.get(`sg3Iv:${NETWORK_ID}`), 0);
  await controller.stop();
  const again = controllerFor(homey, { randomInt: () => 0 });
  assert.equal(again.controller.address, HOMEY_LAST, 'the kept address, not a new draw');
  assert.equal(again.controller.storedIvIndex(), 0);
  await again.controller.stop();
});

test('the address is drawn from 0x7F80 to 0x7FFE, never one a node of the account has, and drawn again when a node has the kept one', async () => {
  const homey = fakeHomey();
  const drawn = [];
  const randomInt = (n) => { drawn.push(n); return 0; };
  const network = { ...NETWORK, addresses: [0x0003, HOMEY_FIRST] };
  const first = new Sg3Controller({ homey, network, randomInt });
  assert.equal(first.address, HOMEY_FIRST + 1);
  assert.deepEqual(drawn, [HOMEY_LAST - HOMEY_FIRST]);
  const logs = [];
  const moved = new Sg3Controller({ homey, network: { ...NETWORK, addresses: [HOMEY_FIRST + 1] }, randomInt, log: (line) => logs.push(line) });
  assert.equal(moved.address, HOMEY_FIRST);
  assert.ok(logs.includes('address 0x7f81 is taken now or out of range; drawing one'));
  homey.store.set(`sg3Addr:${NETWORK_ID}`, 0x7ff0 + 0x10);
  assert.equal(new Sg3Controller({ homey, network: NETWORK, randomInt: () => 5 }).address, HOMEY_FIRST + 5);
});

test('a restart on the same settings goes on above the old SEQs, so the node takes the next command', async () => {
  const first = setUp();
  assert.deepEqual(sent(await first.controller.setLevel(0x0003, 25)), { acked: true, segments: 2, writes: 4 });
  await first.controller.stop();
  const again = controllerFor(first.homey);
  // The TID and SEQ go on from the first run: with a new start the first
  // command may repeat the last TID and SEQ the node handled (as here, with
  // the same draws), and the node drops that repeat. The mesh SEQ is the test.
  again.controller.ids = first.controller.ids;
  assert.deepEqual(sent(await again.controller.setLevel(0x0003, 60)), { acked: true, segments: 2, writes: 4 });
  assert.equal(first.proxyNode.level, 60);
  await again.controller.stop();
});

test('the filter lets everything through, and a status to 0xFFFF from a node behind the proxy comes back', async () => {
  const { homey, controller, behind, proxyNode, logs, clock } = setUp();
  homey.devices.push(0x0005);
  assert.deepEqual(sent(await controller.setLevel(0x0005, 25)), { acked: true, segments: 2, writes: 4 });
  assert.equal(behind.level, 25);
  assert.equal(proxyNode.filter.type, proxy.FILTER_REJECT_LIST);
  assert.ok(logs.some((line) => /^filter ok via 0x0003, an empty reject list \(all let through\)/.test(line)), logs.join('\n'));
  assert.ok(logs.some((line) => /^0x0005 level 25 to 0x0005 on link #1: 2 segment\(s\), 4 write\(s\) in \d+\.\d s after \d+\.\d s in the queue, acked yes after/.test(line)),
    logs.join('\n'));
  clock.pastBlock();
  const heard = new Promise((resolve) => controller.once('status', resolve));
  behind.localChange({ on: false, level: 25 });
  assert.deepEqual(await heard, { node: 0x0005, kind: 0x03, on: false, level: 25 });
  assert.ok(logs.includes('status 0x0005 (by itself): off 25'));
  await controller.stop();
});

test('for 4 s after a command to a node, a status from it is held back and counted; then it is passed on', async () => {
  const { homey, controller, behind, clock, logs } = setUp();
  homey.devices.push(0x0005);
  const passed = [];
  controller.on('status', (status) => passed.push(status));
  await controller.setLevel(0x0005, 25);
  // The answer to the status request of the new link may come after the
  // command too, and is held back with it.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const before = controller.counts.blocked;
  behind.localChange({ on: true, level: 26 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(passed, []);
  assert.equal(controller.counts.blocked, before + 1);
  clock.pastBlock();
  const heard = new Promise((resolve) => controller.once('status', resolve));
  behind.localChange({ on: true, level: 27 });
  assert.deepEqual(await heard, { node: 0x0005, kind: 0x03, on: true, level: 27 });
  controller.logSummary();
  assert.ok(logs.some((line) => line.includes(`(other nodes 0, held back ${before + 1})`)), logs.join('\n'));
  await controller.stop();
});

// The timer the controller sets to ask a node when its block ends (the
// only one between 3 and STATUS_BLOCK_MS), so a test can run it at once.
function catchAsks(homey) {
  const asks = [];
  const setTimeoutBefore = homey.setTimeout;
  homey.setTimeout = (fn, ms) => {
    const id = setTimeoutBefore(fn, ms);
    if (ms > 3000 && ms <= STATUS_BLOCK_MS) asks.push({ fn, id });
    return id;
  };
  // The last one set, run now instead of when it is due.
  asks.runLast = () => {
    const last = asks[asks.length - 1];
    homey.clearTimeout(last.id);
    last.fn();
  };
  return asks;
}

test('held: a status held back by the block makes the node be asked once when the block ends, and with detailed logging the held-back status is in the log', async () => {
  const { homey, controller, behind, clock, logs } = setUp({ detailed: () => true });
  homey.devices.push(0x0005);
  const asks = catchAsks(homey);
  await controller.setLevel(0x0005, 25);
  await pause(20);
  behind.localChange({ on: true, level: 26 });
  await pause(20);
  assert.ok(logs.includes('status 0x0005 held back (within the block): on 26'), logs.join('\n'));
  assert.ok(asks.length >= 1, 'a question set for when the block ends');
  clock.pastBlock();
  const answered = new Promise((resolve) => controller.once('status', resolve));
  asks.runLast();
  assert.deepEqual(await answered, { node: 0x0005, kind: 0x09, on: true, level: 26 });
  assert.ok(logs.includes('0x0005: a status came within the block, asking once'), logs.join('\n'));
  assert.equal(logs.filter((line) => line.endsWith('asking once')).length, 1);
  await controller.stop();
  assert.equal(controller.blockedAsk.size, 0, 'stop clears the questions');
});

test('not held, or after a newer command to the node, the node is not asked when the block ends; without detailed logging the held-back status is only counted', async () => {
  for (const newer of [false, true]) {
    const { homey, controller, behind, clock, logs } = setUp(newer ? {} : { held: () => ({ held: false, why: 'test' }) });
    homey.devices.push(0x0005);
    const asks = catchAsks(homey);
    await controller.setLevel(0x0005, 25);
    await pause(20);
    behind.localChange({ on: true, level: 26 });
    await pause(20);
    assert.ok(asks.length >= 1);
    const question = asks[asks.length - 1];
    if (newer) await controller.setLevel(0x0005, 40);
    clock.pastBlock();
    homey.clearTimeout(question.id);
    question.fn();
    await pause(20);
    assert.ok(!logs.some((line) => line.endsWith('asking once')), `${newer ? 'newer command' : 'not held'}: ${logs.join('\n')}`);
    assert.ok(!logs.some((line) => line.includes('held back (within the block)')));
    await controller.stop();
  }
});

test('the reserve: to 0xFFFF with the node in the payload, nothing to acknowledge, and the status request answered', async () => {
  const { controller, behind, logs, clock } = setUp({ sendTo: 'all' });
  assert.deepEqual(sent(await controller.setLevel(0x0005, 35)), { acked: undefined, segments: 2, writes: 4 });
  assert.equal(behind.level, 35);
  clock.pastBlock();
  assert.deepEqual(await controller.getStatus(0x0005), { on: true, level: 35 });
  assert.ok(logs.some((line) => /commands to 0xffff$/.test(line)), logs.join('\n'));
  assert.ok(logs.some((line) => /^0x0005 level 35 to 0xffff on link #1: 2 segment\(s\), 4 write\(s\) .*acked not asked/.test(line)), logs.join('\n'));
  await controller.stop();
  assert.throws(() => new Sg3Controller({ homey: fakeHomey(), network: NETWORK, sendTo: 'group' }), /sendTo must be node or all/);
});

test('when a link comes up, each 3.0 device in Homey is asked for its status once, and its answer is passed on', async () => {
  const { homey, controller, behind, proxyNode } = setUp();
  homey.devices.push(0x0003, 0x0005);
  behind.localChange({ on: false, level: 70 });
  const passed = [];
  controller.on('status', (status) => passed.push(status));
  controller.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(passed.filter((status) => status.kind === 0x09).map(({ node, on, level }) => [node, on, level]),
    [[0x0003, true, 40], [0x0005, false, 70]]);
  assert.equal(proxyNode.events.filter((event) => event.startsWith('level')).length, 0, 'no command, only status requests');
  await controller.stop();
});

test('the log counts what comes in by destination and opcode: with detailed logging a first line for each, and the counts when the link closes', async () => {
  const { controller, behind, logs } = setUp({ detailed: () => true });
  await controller.setLevel(0x0005, 25);
  behind.localChange({ on: true, level: 30 });
  behind.localChange({ on: true, level: 31 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await controller.stop();
  const address = `0x${controller.address.toString(16)}`;
  assert.ok(logs.includes(`in: first control 0x00 to ${address} (Homey)`), logs.join('\n'));
  assert.ok(logs.includes('in: first op f0e80e to 0xffff'), logs.join('\n'));
  assert.ok(logs.some((line) => line.startsWith('link #1 closed after ')
    && line.endsWith(`app stopping; in 3: to 0xffff 2, ${address} (Homey) 1; op f0e80e 2, control 0x00 1`)), logs.join('\n'));
});

test('without detailed logging: no "in: first" and no "proxy in:" lines, and the counts are still in the line when the link closes', async () => {
  const { controller, behind, logs } = setUp();
  await controller.setLevel(0x0005, 25);
  behind.localChange({ on: true, level: 30 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await controller.stop();
  assert.ok(!logs.some((line) => line.startsWith('in: first') || line.startsWith('proxy in:')), logs.join('\n'));
  assert.ok(logs.some((line) => line.startsWith('link #1 closed after ') && line.includes('; in ')), logs.join('\n'));
});

test('the scan goes through the app\'s queue of scans when the app has one', async () => {
  const { homey, controller } = setUp();
  const asked = [];
  homey.app = { bleDiscover: (...args) => { asked.push(args); return homey.ble.discover(...args); } };
  await controller.getStatus(0x0003);
  assert.deepEqual(asked, [[['1828']]]);
  await controller.stop();
});

test('held, after a remote hang-up with dimmers: a new link in 2 s', async () => {
  const { homey, controller, logs } = setUp();
  await controller.getStatus(0x0003);
  homey.devices.push(0x0003);
  homey.calls.peripherals[0].emit('disconnect');
  assert.equal(controller.status().connected, false);
  assert.ok(controller.reconnectTimer);
  assert.ok(logs.includes('new link in 2 s'), logs.join('\n'));
  await controller.stop();
  assert.equal(controller.reconnectTimer, null);
});

// ------------------------------------------------------------ held or not

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A controller whose held() the test sets (mode.held), with short times.
function modeSetUp({ held = false, ...extra } = {}) {
  const mode = { held };
  const made = setUp({ held: () => ({ held: mode.held, why: 'by the test' }), lingerMs: 60, pollMs: 80, ...extra });
  made.homey.devices.push(0x0003);
  return { ...made, mode };
}

test('not held: no link at start; a command opens it, a second shares it, and it is let go after the linger', async () => {
  const { controller, logs, proxyNode } = modeSetUp({ pollMs: 60000 });
  controller.start();
  await pause(20);
  assert.equal(controller.counts.links, 0);
  assert.ok(logs.includes('link: let go 0 s after the last command, status every 1 min (by the test)'), logs.join('\n'));
  await controller.setLevel(0x0003, 20);
  await pause(20);
  await controller.setLevel(0x0003, 30);
  assert.equal(proxyNode.level, 30);
  await pause(120);
  assert.equal(controller.counts.links, 1, 'both on one link');
  assert.ok(logs.some((line) => /^link #1 closed after \d+\.\d s: idle/.test(line)), logs.join('\n'));
  await controller.stop();
});

test('not held: the status round opens a link, asks each 3.0 device, and lets it go after the answers', async () => {
  const { controller, logs } = modeSetUp();
  controller.start();
  await pause(150);
  assert.ok(logs.some((line) => /^0x0003 status: on 40 after/.test(line)), logs.join('\n'));
  assert.ok(logs.some((line) => /^link #1 closed after \d+\.\d s: status read/.test(line)), logs.join('\n'));
  await controller.stop();
});

test('switched to held, the link comes up and stays; switched back, it is let go after the linger', async () => {
  const { controller, mode, logs } = modeSetUp({ pollMs: 60000 });
  controller.start();
  mode.held = true;
  controller.applyMode();
  await pause(60);
  assert.ok(controller.bridge.link, 'held: up');
  assert.ok(logs.includes('link: held (by the test)'));
  await pause(100);
  assert.ok(controller.bridge.link, 'held: still up after the linger');
  mode.held = false;
  controller.applyMode();
  await pause(120);
  assert.equal(controller.bridge.link, null, 'let go');
  await controller.stop();
});

test('a pairing search lets a held link go, and it comes back when the pause ends', async () => {
  const { controller, logs } = modeSetUp({ held: true });
  controller.start();
  await pause(60);
  assert.ok(controller.bridge.link);
  const end = await controller.pauseForScan('pairing scan');
  assert.equal(controller.bridge.link, null);
  assert.ok(logs.includes('pairing scan pause: link let go'), logs.join('\n'));
  await controller.setLevel(0x0003, 25);
  await pause(120);
  assert.equal(controller.bridge.link, null, 'a command meanwhile is let go as not held');
  end('list answered');
  await pause(60);
  assert.ok(controller.bridge.link, 'back');
  assert.ok(logs.includes('pairing scan pause over (list answered)'), logs.join('\n'));
  await controller.stop();
});

test('a command that finds no proxy waits for a link and goes out when it comes; a newer one to the node takes its place', async () => {
  const { proxyNode } = nodes();
  let visible = false;
  const homey = fakeHomey({ adverts: (calls) => (visible ? [advert(proxyNode, { calls })] : []) });
  homey.devices.push(0x0003);
  const { controller, logs } = controllerFor(homey, { held: () => ({ held: false, why: 'by the test' }), commandWaitMs: 2000 });
  const first = controller.setLevel(0x0003, 20);
  await pause(20);
  const second = controller.setLevel(0x0003, 30);
  assert.deepEqual(await first, { superseded: true });
  visible = true;
  await controller.session();
  const result = await second;
  assert.equal(result.acked, true);
  assert.equal(proxyNode.level, 30);
  assert.deepEqual(proxyNode.events.filter((event) => event.startsWith('level')), ['level 30'], 'the older is not sent');
  assert.ok(logs.some((line) => /^0x0003 level 30 waits up to 2 s for a link: no proxy node/.test(line)), logs.join('\n'));
  await controller.stop();
});

test('a waiting command with no link within the time is not sent, and says so', async () => {
  const homey = fakeHomey({ adverts: () => [] });
  homey.devices.push(0x0003);
  const { controller, logs } = controllerFor(homey, { held: () => ({ held: false, why: 'by the test' }), commandWaitMs: 50 });
  await assert.rejects(controller.setLevel(0x0003, 20), /no link within 0 s/);
  assert.ok(logs.some((line) => /^0x0003 level 20: no link within 0 s, not sent$/.test(line)), logs.join('\n'));
  await controller.stop();
});

test('after a failed connect, the next try is in 15 s', async () => {
  const homey = fakeHomey({ adverts: () => [] });
  homey.devices.push(0x0003);
  const { controller, logs } = controllerFor(homey);
  controller.start();
  await pause(30);
  assert.ok(logs.includes('connect failed: no proxy node of this network in range'), logs.join('\n'));
  assert.ok(logs.includes('new link in 15 s'), logs.join('\n'));
  await controller.stop();
});

test('the proxy used last is reached with find, without a scan; when find fails, it scans', async () => {
  const first = setUp();
  await first.controller.getStatus(0x0003);
  await first.controller.stop();
  assert.equal(first.homey.store.get(`sg3Proxy:${NETWORK_ID}`), 'proxy-a');
  const scans = first.homey.calls.discover;
  const found = [];
  first.homey.ble.find = async (uuid) => { found.push(uuid); return advert(first.proxyNode, { calls: first.homey.calls }); };
  // The TID and SEQ go on, so the node does not take the request for a repeat.
  const again = controllerFor(first.homey);
  again.controller.ids = first.controller.ids;
  await again.controller.getStatus(0x0003);
  assert.deepEqual(found, ['proxy-a']);
  assert.equal(first.homey.calls.discover, scans, 'no scan');
  assert.ok(again.logs.some((line) => /^the proxy used last, …xy-a, without a scan/.test(line)), again.logs.join('\n'));
  await again.controller.stop();
  first.homey.ble.find = async () => { throw new Error('made-up: not known'); };
  const third = controllerFor(first.homey);
  third.controller.ids = first.controller.ids;
  await third.controller.getStatus(0x0003);
  assert.equal(first.homey.calls.discover, scans + 1, 'scanned');
  assert.ok(third.logs.some((line) => /did not answer \(made-up: not known\): scanning$/.test(line)), third.logs.join('\n'));
  await third.controller.stop();
});

test('a link names its node and the signal of its advertisement, and its log line says where the advertisement came from and how old it was', async () => {
  const first = setUp();
  const nodesSeen = [];
  first.controller.on('proxy', (node) => nodesSeen.push(node));
  await first.controller.getStatus(0x0003);
  assert.deepEqual(nodesSeen, [{ address: 0x0003, rssi: -60 }]);
  assert.deepEqual(first.controller.proxyNode, { address: 0x0003, rssi: -60 });
  assert.ok(first.logs.some((line) => /^link #1 …xy-a \(-60 dBm from a new scan, no age from Homey\): connect /.test(line)), first.logs.join('\n'));
  await first.controller.stop();
  // Without a scan, with the time Homey last saw it.
  first.homey.ble.find = async () => Object.assign(advert(first.proxyNode, { rssi: -71, calls: first.homey.calls }), { lastSeen: Date.now() - 2000 });
  const again = controllerFor(first.homey);
  again.controller.ids = first.controller.ids;
  await again.controller.getStatus(0x0003);
  assert.deepEqual(again.controller.proxyNode, { address: 0x0003, rssi: -71 });
  assert.ok(again.logs.some((line) => /^link #1 …xy-a \(-71 dBm from find without a scan, advert 2\.\d s old\): connect /.test(line)), again.logs.join('\n'));
  await again.controller.stop();
});

test('the age of an advertisement: from lastSeen in ms or as a date, none without it', () => {
  assert.equal(advertAge({ lastSeen: 1000 }, 3500), 2500);
  assert.equal(advertAge({ lastSeen: '1970-01-01T00:00:01.000Z' }, 3500), 2500);
  assert.equal(advertAge({ lastSeen: 5000 }, 3500), 0, 'a clock ahead is no age below 0');
  for (const advertisement of [{}, { lastSeen: null }, { lastSeen: 0 }, { lastSeen: 'not a date' }, null]) {
    assert.equal(advertAge(advertisement, 3500), null, JSON.stringify(advertisement));
  }
});

test('a proxy that may not be a bridge is let go, and the next one is used', async () => {
  const netKey = hex(NET_KEY);
  const appKey = hex(APP_KEY);
  const gateway = new SimulatedSgNode({ netKey, appKey, address: 0x0009, statusGroup: 0xffff });
  const dimmer = new SimulatedSgNode({ netKey, appKey, address: 0x0003, on: true, level: 40, statusGroup: 0xffff });
  const homey = fakeHomey({ adverts: (calls) => [advert(gateway, { uuid: 'gateway', rssi: -40, calls }), advert(dimmer, { uuid: 'dimmer', rssi: -70, calls })] });
  const { controller, logs } = controllerFor(homey, { network: { ...NETWORK, addresses: [0x0003, 0x0009], bridges: [0x0003] } });
  assert.deepEqual(await controller.getStatus(0x0003), { on: true, level: 40 });
  assert.deepEqual(homey.calls.connect, ['gateway', 'dimmer']);
  assert.ok(logs.some((line) => /proxy …eway \(-40 dBm\) failed: 0x0009 may not be a bridge$/.test(line)), logs.join('\n'));
  assert.equal(homey.store.get(`sg3Proxy:${NETWORK_ID}`), 'dimmer');
  await controller.stop();
});

// ------------------------------------------------------------ bridge

test('proxy candidates: our Network ID only, as list or object, strongest first', () => {
  const calls = { connect: [], order: [], peripherals: [] };
  const node = {};
  const near = advert(node, { uuid: 'near', rssi: -50, calls });
  const far = advert(node, { uuid: 'far', rssi: -80, calls });
  const other = advert(node, { uuid: 'other', networkId: '0011223344556677', calls });
  const identity = advert(node, { uuid: 'identity', type: 0x01, calls });
  const asObject = { uuid: 'object', rssi: -70, serviceData: { 1828: Buffer.concat([Buffer.from([0]), hex(NETWORK_ID)]) } };
  const picked = proxyCandidates([far, other, identity, asObject, near], hex(NETWORK_ID));
  assert.deepEqual(picked.map((a) => a.uuid), ['near', 'object', 'far']);
});

test('the scan line counts adverts with a Network ID and with a Node Identity, and those of this network', async () => {
  const { proxyNode } = nodes();
  const homey = fakeHomey({
    adverts: (calls) => [advert(proxyNode, { calls }), advert(proxyNode, { uuid: 'identity', type: 0x01, calls }),
      advert(proxyNode, { uuid: 'other', networkId: '0011223344556677', calls }), { uuid: 'bare', rssi: -90 }],
  });
  const { controller, logs } = controllerFor(homey);
  await controller.getStatus(0x0003);
  assert.ok(logs.some((line) => /^scan \d+\.\d s: 4 advert\(s\) with 1828, 3 with its service data \(2 Network ID, 1 Node Identity\), 1 of this network, best -60 dBm$/.test(line)),
    logs.join('\n'));
  await controller.stop();
});

test('the bridge tries the next proxy when one fails, and releases 2ADE before disconnecting', async () => {
  const { proxyNode } = nodes();
  const homey = fakeHomey({
    adverts: (calls) => [advert(proxyNode, { uuid: 'bad', rssi: -40, fail: true, calls }), advert(proxyNode, { uuid: 'good', calls })],
  });
  const { controller } = controllerFor(homey);
  await controller.getStatus(0x0003);
  assert.deepEqual(homey.calls.connect, ['bad', 'good']);
  await controller.stop();
  assert.deepEqual(homey.calls.order, ['unsubscribe', 'disconnect']);
});

test('no proxy of this network in range is an error, not a hang', async () => {
  const homey = fakeHomey({ adverts: () => [] });
  const { controller } = controllerFor(homey);
  await assert.rejects(controller.getStatus(0x0003), /no proxy node of this network/);
  await controller.stop();
});

test('a remote hang-up is not answered with an unsubscribe', async () => {
  const { proxyNode } = nodes();
  const calls = { connect: [], order: [], peripherals: [] };
  const bridge = new Sg3Bridge({
    ble: { discover: async () => [advert(proxyNode, { calls })] },
    networkId: hex(NETWORK_ID),
    createSession: (write) => new (require('../../lib/sigmesh/session').MeshSession)({
      netKey: hex(NET_KEY), appKey: hex(APP_KEY), address: 0x7fff,
      seqStore: new (require('../../lib/sigmesh/seq-store').SeqStore)({ get: () => null, set: () => {} }), write,
    }),
  });
  const reasons = [];
  bridge.on('disconnected', (reason) => reasons.push(reason));
  await bridge.ensureConnected();
  calls.peripherals[0].emit('disconnect');
  assert.deepEqual(reasons, ['remote hang-up']);
  assert.deepEqual(calls.order, []);
  assert.equal(bridge.session, null);
});

test('a link that fails before subscribing is closed without an unsubscribe', async () => {
  const { proxyNode } = nodes();
  const homey = fakeHomey({ adverts: (calls) => [advert(proxyNode, { noService: true, calls })] });
  const { controller } = controllerFor(homey);
  await assert.rejects(controller.getStatus(0x0003), /service 1828 not found/);
  assert.deepEqual(homey.calls.order, ['disconnect']);
  await controller.stop();
});
