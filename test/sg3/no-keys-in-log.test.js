'use strict';

// Every line the 3.0 code logs ends up in diagnostics reports, which testers
// send and Athom stores. This runs the whole flow against simulated nodes
// (import, search, link, commands, status, summary, a dropped link, errors,
// removal) and checks that no line carries a key, the export text, the
// network's name or a whole peripheral id. It also checks that a test round
// stays well inside the report's 100 lines.

const test = require('node:test');
const assert = require('node:assert/strict');

const { k2 } = require('../../lib/sigmesh/crypto');
const { beaconKey } = require('../../lib/sigmesh/beacon');
const { Sg3Controller } = require('../../lib/sg3/controller');
const { SimulatedSgNode } = require('./simulated-node');
const { advert, fakeHomey } = require('./fake-homey');

const hex = (s) => Buffer.from(s, 'hex');
const NET_KEY = '7dd7364cd842ad18c17c2b820c84c3d6';
const APP_KEY = '63964771734fbd76e3b40519d1d94a48';
const DEVICE_KEYS = ['0f1e2d3c4b5a69788796a5b4c3d2e1f0', 'a0b1c2d3e4f5061728394a5b6c7d8e9f'];
const NAME = 'Storgata 1, 0150 Oslo';
const PERIPHERAL = 'a1b2c3d4e5f6deadbeef';

const sgNode = (address, deviceKey, name) => ({
  UUID: `0000000${address}-0000-0000-0000-000000000000`,
  name,
  unicastAddress: address.toString(16).padStart(4, '0'),
  deviceKey,
  cid: '0EE8',
  pid: '00A2',
  elements: [{ index: 0, models: [{ modelId: '0EE80000', bind: [0] }, { modelId: '1000', bind: [0] }] }],
});

const EXPORT = JSON.stringify({
  meshName: NAME,
  meshUUID: '9D3A0F1E-0000-4000-8000-000000000001',
  netKeys: [{ index: 0, key: NET_KEY }],
  appKeys: [{ index: 0, key: APP_KEY }],
  nodes: [sgNode(3, DEVICE_KEYS[0], 'Lampe A'), sgNode(5, DEVICE_KEYS[1], 'Lampe B')],
});

// Everything secret about the network, in both cases.
const net = k2(hex(NET_KEY), hex('00'));
const SECRETS = [NET_KEY, APP_KEY, ...DEVICE_KEYS, net.encryptionKey.toString('hex'), net.privacyKey.toString('hex'), beaconKey(hex(NET_KEY)).toString('hex')];

function setUp() {
  const proxyNode = new SimulatedSgNode({ netKey: hex(NET_KEY), appKey: hex(APP_KEY), address: 0x0003, on: true, level: 40 });
  const behind = new SimulatedSgNode({ netKey: hex(NET_KEY), appKey: hex(APP_KEY), address: 0x0005, level: 70, via: proxyNode });
  const homey = fakeHomey({ adverts: (calls) => [advert(proxyNode, { uuid: PERIPHERAL, calls })] });
  const lines = [];
  const controller = new Sg3Controller({ homey, log: (line) => lines.push(line), searchAnswerMs: 30, summaryMs: 20 });
  return { homey, controller, lines, proxyNode, behind };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertClean(lines) {
  for (const line of lines) {
    assert.doesNotMatch(line, /[0-9a-f]{32}/i, `a 32-digit hex string in: ${line}`);
    for (const secret of SECRETS) {
      assert.ok(!line.toLowerCase().includes(secret.toLowerCase()), `a key in: ${line}`);
    }
    assert.ok(!line.includes(NAME) && !line.includes('Storgata'), `the network's name in: ${line}`);
    assert.ok(!line.includes('"netKeys"') && !line.includes('"appKeys"'), `export text in: ${line}`);
    assert.ok(!line.includes(PERIPHERAL), `a whole peripheral id in: ${line}`);
  }
}

test('no key, export text, network name or peripheral id in any log line', async () => {
  const { homey, controller, lines, behind } = setUp();

  // T1, errors and the import from JSON.
  await controller.importNetwork({ netKey: NET_KEY.slice(0, 30), appKey: APP_KEY });
  await controller.importNetwork({ json: EXPORT.slice(0, 50) });
  assert.deepEqual(await controller.importNetwork({ json: EXPORT }), { ok: true });
  await controller.importNetwork({ netKey: '00112233445566778899aabbccddeeff', appKey: APP_KEY });

  // T2, T3: search (from the export), commands, status, a local change.
  homey.devices.push({ getStore: () => ({ unicast: 3 }) }, { getStore: () => ({ unicast: 5 }) });
  await controller.searchDimmers();
  for (const level of [101, 0, 30, 100, 0]) await controller.setLevel(0x0005, level);
  await controller.getStatus(0x0005);
  const heard = new Promise((resolve) => controller.once('status', resolve));
  behind.localChange({ on: true, level: 55 });
  await heard;

  // Summary, a dropped link, the reconnect, advanced settings.
  await pause(50);
  homey.calls.peripherals[0].emit('disconnect');
  await controller.setAdvanced({ keepAlive: 30, address: 0x7ff0 });
  await controller.getStatus(0x0003);

  // Removal and a new import from the key fields, with a live search.
  homey.devices.length = 0;
  await controller.removeNetwork();
  assert.deepEqual(await controller.importNetwork({ netKey: NET_KEY, appKey: APP_KEY }), { ok: true });
  await controller.searchDimmers();
  await controller.stop();

  assert.ok(lines.length > 20, `only ${lines.length} lines logged`);
  assertClean(lines);
});

test('the lines say what the test needs to see', async () => {
  const { homey, controller, lines, behind } = setUp();
  await controller.importNetwork({ netKey: NET_KEY, appKey: APP_KEY });
  homey.devices.push({ getStore: () => ({ unicast: 5 }) });
  await controller.searchDimmers();
  await controller.setLevel(0x0005, 30);
  const heard = new Promise((resolve) => controller.once('status', resolve));
  behind.localChange({ on: false, level: 30 });
  await heard;
  await pause(50);
  homey.calls.peripherals[0].emit('disconnect');
  await controller.stop();

  const text = lines.join('\n');
  assert.match(text, /^v2\.9\.0, node v\d+/m);
  assert.match(text, /aes-128-ccm yes/);
  assert.match(text, /^network 3ecaff672f673370: 0 node\(s\) in the export, sending from 0x7fff, IV Index unknown$/m);
  assert.match(text, /^import \(keys\): ok$/m);
  assert.match(text, /^scan \d+\.\d s: 1 proxy advert\(s\), 1 of this network, best -60 dBm$/m);
  assert.match(text, /^link #1 …beef \(-60 dBm\): connect .*2ADD \[writeWithoutResponse\], 2ADE \[notify\], subscribed/m);
  assert.match(text, /^beacon: IV Index 0, update no/m);
  assert.match(text, /^filter ok via 0x0003, 3 address\(es\)/m);
  assert.match(text, /^search .*: Generic OnOff answered by 0x0003 0x0005; SG status from 0x0003 on 40, 0x0005 off 70$/m);
  assert.match(text, /^0x0005 level 30: 2 segment\(s\), \d+ write\(s\) \(avg \d+ ms\), acked yes after/m);
  assert.match(text, /^status 0x0005 \(by itself\): off 30$/m);
  // Two statuses from a dimmer in Homey: its reply to the search, and the local change.
  assert.match(text, /^link #1 up \d+ s; since start: commands 1 \(acked 1\), status 2 \(other nodes 1\), drops 0, links 1, unreadable 0$/m);
  assert.match(text, /^link #1 dropped after \d+\.\d s: remote hang-up$/m);
  assertClean(lines);
});

test('a round of T3 (five commands on two dimmers and a switch) stays well inside 100 lines', async () => {
  const { homey, controller, lines, behind } = setUp();
  await controller.importNetwork({ json: EXPORT });
  homey.devices.push({ getStore: () => ({ unicast: 3 }) }, { getStore: () => ({ unicast: 5 }) });
  await controller.searchDimmers();
  const before = lines.length;
  for (const node of [0x0003, 0x0005]) {
    for (const level of [101, 0, 30, 100, 0]) await controller.setLevel(node, level);
  }
  const heard = new Promise((resolve) => controller.once('status', resolve));
  behind.localChange({ on: true, level: 20 });
  await heard;
  await controller.stop();
  const round = lines.length - before;
  assert.ok(round <= 50, `${round} lines for one round of T3`);
  assertClean(lines);
});
