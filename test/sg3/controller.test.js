'use strict';

// The controller and the BLE layer against a fake Homey (settings, drivers,
// ble) whose one proxy advertisement leads to a simulated SG node. Keys are
// the specification's sample keys.

const test = require('node:test');
const assert = require('node:assert/strict');

const { Sg3Controller } = require('../../lib/sg3/controller');
const { Sg3Bridge, proxyCandidates } = require('../../lib/sg3/bridge');
const { SimulatedSgNode } = require('./simulated-node');
const { advert, fakeHomey, NETWORK_ID } = require('./fake-homey');

const hex = (s) => Buffer.from(s, 'hex');
const NET_KEY = '7dd7364cd842ad18c17c2b820c84c3d6';
const APP_KEY = '63964771734fbd76e3b40519d1d94a48';

function nodes() {
  const proxyNode = new SimulatedSgNode({ netKey: hex(NET_KEY), appKey: hex(APP_KEY), address: 0x0003, on: true, level: 40 });
  const behind = new SimulatedSgNode({ netKey: hex(NET_KEY), appKey: hex(APP_KEY), address: 0x0005, level: 70, via: proxyNode });
  return { proxyNode, behind };
}

async function setUp() {
  const { proxyNode, behind } = nodes();
  const homey = fakeHomey({ adverts: (calls) => [advert(proxyNode, { calls })] });
  const controller = new Sg3Controller({ homey, searchAnswerMs: 50 });
  assert.deepEqual(await controller.importNetwork({ netKey: NET_KEY, appKey: APP_KEY }), { ok: true });
  return { homey, controller, proxyNode, behind };
}

// ------------------------------------------------------------ controller

test('not set up: status says so, and nothing touches Bluetooth', () => {
  const homey = fakeHomey();
  const controller = new Sg3Controller({ homey });
  assert.deepEqual(controller.status(), { configured: false });
  assert.equal(homey.calls.discover, 0);
});

test('import from the key fields: name, no dimmers, not connected, the rest under advanced', async () => {
  const { homey, controller } = await setUp();
  assert.deepEqual(controller.status(), {
    configured: true,
    name: 'SG Smart 3.0',
    dimmers: 0,
    connected: false,
    advanced: { networkId: NETWORK_ID, ivIndex: null, address: 0x7ff0, proxy: null, keepAlive: 0 },
  });
  assert.equal(typeof homey.store.get('sg3Network'), 'string');
  assert.equal(homey.calls.discover, 0);
  await controller.stop();
});

test('import errors come back as codes, with HA\'s detail', async () => {
  const controller = new Sg3Controller({ homey: fakeHomey() });
  assert.deepEqual(await controller.importNetwork({ netKey: 'abc', appKey: APP_KEY }), { error: 'invalid_net_key', detail: 'must be 32 hex digits' });
  const json = await controller.importNetwork({ json: '{"netKeys": [' });
  assert.equal(json.error, 'invalid_json');
  const noNodes = await controller.importNetwork({ json: JSON.stringify({ netKeys: [{ key: NET_KEY }], appKeys: [{ key: APP_KEY }] }) });
  assert.deepEqual(noNodes, { error: 'invalid_export', detail: "connect document has no 'nodes' list" });
  assert.equal(controller.configured, false);
});

test('the same network as JSON is accepted, another network is not', async () => {
  const { controller } = await setUp();
  const sameAsJson = JSON.stringify({ meshUUID: 'X', meshName: 'Hjemme', netKeys: [{ key: NET_KEY }], appKeys: [{ key: APP_KEY }], nodes: [] });
  assert.deepEqual(await controller.importNetwork({ json: sameAsJson }), { ok: true });
  assert.equal(controller.status().name, 'Hjemme');
  const other = await controller.importNetwork({ netKey: '00112233445566778899aabbccddeeff', appKey: APP_KEY });
  assert.equal(other.error, 'other_network');
  await controller.stop();
});

test('search with no dimmers in the export: one Generic OnOff Get, then an SG status request per node', async () => {
  const { homey, controller, proxyNode, behind } = await setUp();
  const found = await controller.searchDimmers();
  assert.deepEqual(found, [
    { unicast: 0x0003, name: '', source: 'search', on: true, level: 40 },
    { unicast: 0x0005, name: '', source: 'search', on: false, level: 70 },
  ]);
  assert.equal(homey.calls.discover, 1);
  assert.deepEqual(proxyNode.events.filter((e) => e === 'generic onoff get'), ['generic onoff get']);
  assert.deepEqual(behind.events.filter((e) => e === 'generic onoff get'), ['generic onoff get']);
  assert.equal(controller.status().connected, true);
  assert.equal(controller.status().advanced.proxy, 0x0003);
  await controller.stop();
});

test('search with SG dimmers in the export: no Bluetooth at all', async () => {
  const homey = fakeHomey();
  const controller = new Sg3Controller({ homey });
  const json = JSON.stringify({
    netKeys: [{ key: NET_KEY }], appKeys: [{ key: APP_KEY }],
    nodes: [{ UUID: 'a', unicastAddress: '0003', deviceKey: APP_KEY, cid: '0EE8', pid: '00A2', name: 'Lampe A', elements: [{ index: 0, models: [{ modelId: '0EE80000', bind: [0] }] }] }],
  });
  assert.deepEqual(await controller.importNetwork({ json }), { ok: true });
  assert.deepEqual(await controller.searchDimmers(), [{ unicast: 0x0003, name: 'Lampe A', source: 'export' }]);
  assert.equal(homey.calls.discover, 0);
  await controller.stop();
});

test('setLevel reaches a node behind the proxy, and a local change comes back as status', async () => {
  const { controller, behind } = await setUp();
  assert.deepEqual(await controller.setLevel(0x0005, 25), { acked: true, segments: 2 });
  assert.equal(behind.level, 25);
  const heard = new Promise((resolve) => controller.once('status', resolve));
  behind.localChange({ on: false, level: 25 });
  assert.deepEqual(await heard, { node: 0x0005, kind: 0x03, on: false, level: 25 });
  await controller.stop();
});

test('remove keeps SEQ, and a new import of the same network goes on above it', async () => {
  const { homey, controller, proxyNode } = await setUp();
  await controller.setLevel(0x0003, 10);
  homey.devices.push({});
  assert.deepEqual(await controller.removeNetwork(), { error: 'devices_left', detail: '1' });
  homey.devices.pop();
  const seqBefore = homey.store.get(`sg3Seq:${NETWORK_ID}`);
  assert.deepEqual(await controller.removeNetwork(), { ok: true });
  assert.equal(homey.store.has('sg3Network'), false);
  assert.deepEqual(homey.store.get(`sg3Seq:${NETWORK_ID}`), seqBefore);

  assert.deepEqual(await controller.importNetwork({ netKey: NET_KEY, appKey: APP_KEY }), { ok: true });
  assert.deepEqual(await controller.setLevel(0x0003, 90), { acked: true, segments: 2 });
  assert.equal(proxyNode.level, 90);
  assert.ok(!proxyNode.events.some((e) => e.startsWith('replay')));
  await controller.stop();
});

test('advanced: our address must be unicast and free, the keep-alive 0 to 3600 s', async () => {
  const homey = fakeHomey();
  const controller = new Sg3Controller({ homey });
  const json = JSON.stringify({
    netKeys: [{ key: NET_KEY }], appKeys: [{ key: APP_KEY }],
    nodes: [{ UUID: 'a', unicastAddress: '0003', deviceKey: APP_KEY, elements: [{ index: 0, models: [] }] }],
  });
  await controller.importNetwork({ json });
  assert.deepEqual(await controller.setAdvanced({ address: 0x0003 }), { error: 'address_taken' });
  assert.deepEqual(await controller.setAdvanced({ address: 0x8000 }), { error: 'invalid_address' });
  assert.deepEqual(await controller.setAdvanced({ keepAlive: -1 }), { error: 'invalid_keep_alive' });
  assert.deepEqual(await controller.setAdvanced({ address: 0x7000, keepAlive: 30 }), { ok: true });
  assert.equal(controller.status().advanced.address, 0x7000);
  assert.equal(controller.status().advanced.keepAlive, 30);
  await controller.stop();
});

test('a damaged stored network leaves 3.0 unconfigured, with a line in the log', () => {
  const homey = fakeHomey();
  homey.store.set('sg3Network', '{"netKeys": [');
  const lines = [];
  const controller = new Sg3Controller({ homey, log: (line) => lines.push(line) });
  assert.equal(controller.configured, false);
  assert.match(lines.join('\n'), /unreadable/);
});

test('after a remote hang-up with dimmers and keep-alive 0, a reconnect is scheduled', async () => {
  const { homey, controller } = await setUp();
  await controller.searchDimmers();
  homey.devices.push({});
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

test('the bridge tries the next proxy when one fails, and releases 2ADE before disconnecting', async () => {
  const { proxyNode } = nodes();
  const homey = fakeHomey({
    adverts: (calls) => [advert(proxyNode, { uuid: 'bad', rssi: -40, fail: true, calls }), advert(proxyNode, { uuid: 'good', calls })],
  });
  const controller = new Sg3Controller({ homey });
  await controller.importNetwork({ netKey: NET_KEY, appKey: APP_KEY });
  await controller.getStatus(0x0003);
  assert.deepEqual(homey.calls.connect, ['bad', 'good']);
  await controller.stop();
  assert.deepEqual(homey.calls.order, ['unsubscribe', 'disconnect']);
});

test('no proxy of this network in range is an error, not a hang', async () => {
  const homey = fakeHomey({ adverts: () => [] });
  const controller = new Sg3Controller({ homey });
  await controller.importNetwork({ netKey: NET_KEY, appKey: APP_KEY });
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
  const controller = new Sg3Controller({ homey });
  await controller.importNetwork({ netKey: NET_KEY, appKey: APP_KEY });
  await assert.rejects(controller.getStatus(0x0003), /service 1828 not found/);
  assert.deepEqual(homey.calls.order, ['disconnect']);
  await controller.stop();
});

test('Homey sends from 0x7FF0, not HA\'s 0x7FFF, and steps down past a node there', async () => {
  const homey = fakeHomey();
  const controller = new Sg3Controller({ homey });
  const node = (address) => ({ UUID: address, unicastAddress: address, deviceKey: APP_KEY, elements: [{ index: 0, models: [] }] });
  await controller.importNetwork({ json: JSON.stringify({ netKeys: [{ key: NET_KEY }], appKeys: [{ key: APP_KEY }], nodes: [node('7FF0')] }) });
  assert.equal(controller.status().advanced.address, 0x7fef);
  await controller.stop();
});
