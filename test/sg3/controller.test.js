'use strict';

// The controller and the BLE layer against a fake Homey (settings, timers,
// ble) whose one proxy advertisement leads to a simulated SG node. The
// network comes as the SG account gives it. Keys are the specification's
// sample keys.

const test = require('node:test');
const assert = require('node:assert/strict');

const { HOMEY_FIRST, HOMEY_LAST, Sg3Controller } = require('../../lib/sg3/controller');
const { Sg3Bridge, proxyCandidates } = require('../../lib/sg3/bridge');
const proxy = require('../../lib/sigmesh/proxy');
const { SimulatedSgNode } = require('./simulated-node');
const { advert, fakeHomey, NETWORK_ID } = require('./fake-homey');

const hex = (s) => Buffer.from(s, 'hex');
const NET_KEY = '7dd7364cd842ad18c17c2b820c84c3d6';
const APP_KEY = '63964771734fbd76e3b40519d1d94a48';
const NETWORK = { netKey: NET_KEY, appKey: APP_KEY, addresses: [0x0003, 0x0005] };

function nodes() {
  const proxyNode = new SimulatedSgNode({ netKey: hex(NET_KEY), appKey: hex(APP_KEY), address: 0x0003, on: true, level: 40, statusGroup: 0xffff });
  const behind = new SimulatedSgNode({ netKey: hex(NET_KEY), appKey: hex(APP_KEY), address: 0x0005, level: 70, via: proxyNode, statusGroup: 0xffff });
  return { proxyNode, behind };
}

function controllerFor(homey, extra = {}) {
  const logs = [];
  const controller = new Sg3Controller({
    homey, network: NETWORK, deviceAddresses: () => homey.devices, log: (line) => logs.push(line), randomInt: () => 0, ...extra,
  });
  return { controller, logs };
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
  assert.ok(logs.includes(`network ${NETWORK_ID}: 2 node address(es) in the account, sending from 0x7ffe, IV Index unknown (from the beacon)`));
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
  assert.deepEqual(await first.controller.setLevel(0x0003, 25), { acked: true, segments: 2 });
  await first.controller.stop();
  const again = controllerFor(first.homey);
  // The TID goes on from the first run: a new random one is the same as the
  // last one 1 time in 255, and the node drops that repeat. SEQ is the test.
  again.controller.tid = first.controller.tid;
  assert.deepEqual(await again.controller.setLevel(0x0003, 60), { acked: true, segments: 2 });
  assert.equal(first.proxyNode.level, 60);
  await again.controller.stop();
});

test('the filter lets everything through, and a status to 0xFFFF from a node behind the proxy comes back', async () => {
  const { homey, controller, behind, proxyNode, logs } = setUp();
  homey.devices.push(0x0005);
  assert.deepEqual(await controller.setLevel(0x0005, 25), { acked: true, segments: 2 });
  assert.equal(behind.level, 25);
  assert.equal(proxyNode.filter.type, proxy.FILTER_REJECT_LIST);
  assert.ok(logs.some((line) => /^filter ok via 0x0003, an empty reject list \(all let through\)/.test(line)), logs.join('\n'));
  const heard = new Promise((resolve) => controller.once('status', resolve));
  behind.localChange({ on: false, level: 25 });
  assert.deepEqual(await heard, { node: 0x0005, kind: 0x03, on: false, level: 25 });
  assert.ok(logs.includes('status 0x0005 (by itself): off 25'));
  await controller.stop();
});

test('the log counts what comes in by destination and opcode: a first line for each, and the counts when the link closes', async () => {
  const { controller, behind, logs } = setUp();
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

test('the scan goes through the app\'s queue of scans when the app has one', async () => {
  const { homey, controller } = setUp();
  const asked = [];
  homey.app = { bleDiscover: (...args) => { asked.push(args); return homey.ble.discover(...args); } };
  await controller.getStatus(0x0003);
  assert.deepEqual(asked, [[['1828']]]);
  await controller.stop();
});

test('after a remote hang-up with dimmers and keep-alive 0, a reconnect is scheduled', async () => {
  const { homey, controller } = setUp();
  await controller.getStatus(0x0003);
  homey.devices.push(0x0003);
  homey.calls.peripherals[0].emit('disconnect');
  assert.equal(controller.status().connected, false);
  assert.ok(controller.reconnectTimer);
  await controller.stop();
  assert.equal(controller.reconnectTimer, null);
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
