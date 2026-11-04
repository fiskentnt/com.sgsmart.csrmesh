'use strict';

// Every line the 3.0 code logs ends up in diagnostics reports, which testers
// send and Athom stores. This runs the whole flow against simulated nodes
// (the network from the account, link, commands, status, summary, a dropped
// link, errors, a restart) and checks that no line carries a key, the home's
// key, a name or a whole peripheral id. It also checks that a test round
// stays well inside the report's 100 lines.

const test = require('node:test');
const assert = require('node:assert/strict');

const { k2 } = require('../../lib/sigmesh/crypto');
const { beaconKey } = require('../../lib/sigmesh/beacon');
const { STATUS_BLOCK_MS, Sg3Controller } = require('../../lib/sg3/controller');
const { SimulatedSgNode } = require('./simulated-node');
const { advert, fakeHomey } = require('./fake-homey');

const hex = (s) => Buffer.from(s, 'hex');
const NET_KEY = '7dd7364cd842ad18c17c2b820c84c3d6';
const APP_KEY = '63964771734fbd76e3b40519d1d94a48';
const HOME_KEY = '0a1b2c3d4e5f';
const NAMES = ['Made-up stue', 'Made-up kjøkken'];
const PERIPHERAL = 'a1b2c3d4e5f6deadbeef';

// Everything secret about the network, in both cases.
const net = k2(hex(NET_KEY), hex('00'));
const SECRETS = [NET_KEY, APP_KEY, HOME_KEY, net.encryptionKey.toString('hex'), net.privacyKey.toString('hex'),
  beaconKey(hex(NET_KEY)).toString('hex')];

// The network as the account gives it (lib/account.js, sg3Network), names
// and the home's key with it, though the controller is handed only what it
// uses.
const ACCOUNT_NETWORK = {
  homeKey: HOME_KEY, netKey: NET_KEY, appKey: APP_KEY,
  devices: [{ meshId: 3, type: 3080, name: NAMES[0] }, { meshId: 5, type: 3081, name: NAMES[1] }], addresses: [3, 5],
};

function setUp({ homey: given } = {}) {
  const proxyNode = new SimulatedSgNode({ netKey: hex(NET_KEY), appKey: hex(APP_KEY), address: 0x0003, on: true, level: 40, statusGroup: 0xffff });
  const behind = new SimulatedSgNode({ netKey: hex(NET_KEY), appKey: hex(APP_KEY), address: 0x0005, level: 70, via: proxyNode, statusGroup: 0xffff });
  const homey = given || fakeHomey({ adverts: (calls) => [advert(proxyNode, { uuid: PERIPHERAL, calls })] });
  const lines = [];
  // The controller's clock: moved on past the status block before a test
  // waits for a status after a command.
  const clock = { ahead: 0 };
  const controller = new Sg3Controller({
    homey, network: ACCOUNT_NETWORK, deviceAddresses: () => homey.devices, log: (line) => lines.push(line), summaryMs: 20, randomInt: () => 0,
    now: () => Date.now() + clock.ahead,
  });
  const pastBlock = () => { clock.ahead += STATUS_BLOCK_MS; };
  return { homey, controller, lines, proxyNode, behind, pastBlock };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertClean(lines) {
  for (const line of lines) {
    assert.doesNotMatch(line, /[0-9a-f]{32}/i, `a 32-digit hex string in: ${line}`);
    for (const secret of SECRETS) {
      assert.ok(!line.toLowerCase().includes(secret.toLowerCase()), `a key in: ${line}`);
    }
    for (const name of NAMES) assert.ok(!line.toLowerCase().includes(name.toLowerCase()), `a name in: ${line}`);
    assert.ok(!line.includes(PERIPHERAL), `a whole peripheral id in: ${line}`);
  }
}

test('no key, home key, name or peripheral id in any log line', async () => {
  // Keys that do not import.
  const broken = [];
  for (const network of [{ ...ACCOUNT_NETWORK, netKey: NET_KEY.slice(0, 30) }, { ...ACCOUNT_NETWORK, appKey: `${APP_KEY.slice(2)}zz` }]) {
    new Sg3Controller({ homey: fakeHomey(), network, log: (line) => broken.push(line) });
  }

  const { homey, controller, lines, behind, pastBlock } = setUp();
  // T2, T3: commands, status, a local change.
  homey.devices.push(3, 5);
  for (const level of [101, 0, 30, 100, 0]) await controller.setLevel(0x0005, level);
  await controller.getStatus(0x0005);
  pastBlock();
  const heard = new Promise((resolve) => controller.once('status', resolve));
  behind.localChange({ on: true, level: 55 });
  await heard;

  // Summary, a dropped link, the reconnect, a restart on the same settings.
  await pause(50);
  homey.calls.peripherals[0].emit('disconnect');
  await controller.getStatus(0x0003);
  await controller.stop();
  const again = setUp({ homey });
  await again.controller.getStatus(0x0003);
  await again.controller.stop();

  const all = [...broken, ...lines, ...again.lines];
  assert.ok(all.length > 20, `only ${all.length} lines logged`);
  assertClean(all);
});

test('the lines say what the test needs to see', async () => {
  const { homey, controller, lines, behind, pastBlock } = setUp();
  homey.devices.push(5);
  await controller.setLevel(0x0005, 30);
  await controller.getStatus(0x0005);
  pastBlock();
  const heard = new Promise((resolve) => controller.once('status', resolve));
  behind.localChange({ on: false, level: 30 });
  await heard;
  await pause(50);
  homey.calls.peripherals[0].emit('disconnect');
  await controller.stop();

  const text = lines.join('\n');
  assert.match(text, /^v2\.9\.0, node v\d+/m);
  assert.match(text, /aes-128-ccm yes/);
  assert.match(text, /^no address kept for this network on this Homey: drew 0x7f80$/m);
  assert.match(text, /^network 3ecaff672f673370: 2 node address\(es\) in the account, sending from 0x7f80, IV Index unknown \(from the beacon\), commands to the node$/m);
  assert.match(text, /^scan \d+\.\d s: 1 advert\(s\) with 1828, 1 with its service data \(1 Network ID, 0 Node Identity\), 1 of this network, best -60 dBm$/m);
  assert.match(text, /^link #1 …beef \(-60 dBm\): connect .*2ADD \[writeWithoutResponse\], 2ADE \[notify\], subscribed/m);
  assert.match(text, /^beacon: IV Index 0, update no/m);
  assert.match(text, /^filter ok via 0x0003, an empty reject list \(all let through\)/m);
  assert.match(text, /^in: first control 0x00 to 0x7f80 \(Homey\)$/m);
  assert.match(text, /^in: first op f0e80e to 0x7f80 \(Homey\)$/m);
  assert.match(text, /^in: first op f0e80e to 0xffff$/m);
  assert.match(text, /^0x0005 level 30 to 0x0005: 2 segment\(s\), \d+ write\(s\) \(avg \d+ ms\), acked yes after/m);
  assert.match(text, /^0x0005 status: on 30 after/m);
  assert.match(text, /^status 0x0005 \(by itself\): off 30$/m);
  // The replies within 4 s of the command are held back; the local change
  // after it is passed on.
  assert.match(text, /^link #1 up \d+ s, in \d+: to .*; since start: commands 1 \(acked 1\), status 1 \(other nodes 0, held back [12]\), drops 0, links 1, unreadable 0$/m);
  assert.match(text, /^link #1 dropped after \d+\.\d s: remote hang-up; in \d+: to 0x7f80 \(Homey\) \d+, 0xffff 1; /m);
  assertClean(lines);
});

test('a round of T3 (five commands on two dimmers and a switch) stays well inside 100 lines', async () => {
  const { homey, controller, lines, behind, pastBlock } = setUp();
  homey.devices.push(3, 5);
  await controller.getStatus(0x0003);
  const before = lines.length;
  for (const node of [0x0003, 0x0005]) {
    for (const level of [101, 0, 30, 100, 0]) await controller.setLevel(node, level);
  }
  pastBlock();
  const heard = new Promise((resolve) => controller.once('status', resolve));
  behind.localChange({ on: true, level: 20 });
  await heard;
  await controller.stop();
  const round = lines.length - before;
  assert.ok(round <= 50, `${round} lines for one round of T3`);
  assertClean(lines);
});
