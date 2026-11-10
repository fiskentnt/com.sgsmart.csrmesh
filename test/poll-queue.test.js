'use strict';

// The status polls of the devices after the first generation go through one
// queue (lib/CsrNetwork.js, queueStatus): one FF04 every POLL_SLOT_MS, five
// in four seconds, the oldest first, each device once; a device that sent a
// status in the last POLL_SKIP_HEARD_MS is skipped; one line per round with
// the counts. A pairing pause and stop empty the queue. The first generation
// dimmers' status poll is not touched. Made-up mesh ids and location ids.
// Run with: node --test test/*.test.js

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const fake = require('./helpers/fake-homey');

fake.install();

const { decryptPayload, deriveNetworkKey } = require('../lib/csrmesh');
const {
  CsrNetwork, POLL_SKIP_HEARD_MS, POLL_SLOT_MS, STATUS_LISTEN_MS,
} = require('../lib/CsrNetwork');
const MeshBridge = require('../lib/MeshBridge');
const SGSmartApp = require('../app');

const KEY = deriveNetworkKey('test-only-pass');
const LOC = 0x5a3c;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const ext = (dst, opcode, bytes) => Buffer.from([dst & 0xff, dst >> 8, opcode >> 8, opcode & 0xff, ...bytes]);
const loc = (location) => [location >> 8, location & 0xff];
const status = (src, location = LOC) => ({ src, plain: ext(0x8000, 0xff05, [...loc(location), 1, 40, 7]) });
const plainOf = (packet) => decryptPayload(KEY, packet.subarray(0, 3), packet.subarray(3, 5), packet.subarray(5, packet.length - 9));

// A CsrNetwork with a fake clock and a bridge that records every FF04 sent.
function network() {
  const clock = { now: 1_700_000_000_000 };
  const app = {
    logs: [], sent: [], log: (...args) => app.logs.push(args.join(' ')), error: (...args) => app.logs.push(args.join(' ')),
  };
  app.homey = fake.fakeHomey(app);
  app.getNetworkKey = () => KEY;
  let seq = 0x800000;
  app.nextSeq = () => { seq += 1; return seq; };
  app._devices = () => [];
  app.bridge = {
    send: async (packet, meta) => {
      const plain = plainOf(packet);
      app.sent.push({ dst: plain[0] | (plain[1] << 8), opcode: (plain[2] << 8) | plain[3], at: clock.now, meta });
      return { ok: true };
    },
  };
  const csr = new CsrNetwork(app, { now: () => clock.now });
  app.csr = csr;
  // Runs the timers set for ms, moving the clock, and lets the sends settle.
  const pass = async (ms) => { clock.now += ms; app.homey.runMs(ms); await tick(); await tick(); };
  return {
    app, clock, csr, pass,
  };
}

const ff04To = (app) => app.sent.filter((s) => s.opcode === 0xff04).map((s) => s.dst);
const pollLines = (app) => app.logs.filter((line) => line.startsWith('[CSR] poll:'));

test('27 devices queued at once go out one every POLL_SLOT_MS, the oldest first: five in four seconds, not a burst', async () => {
  const { app, csr, pass } = network();
  const devices = Array.from({ length: 27 }, (_, i) => 0x9c01 + i);
  for (const meshId of devices) assert.equal(csr.queueStatus(meshId, LOC), true);
  await tick();
  assert.deepEqual(ff04To(app), [0x9c01], 'the first at once');
  assert.equal(csr.pollQueueLength(), 26);
  for (let i = 0; i < 4; i += 1) await pass(POLL_SLOT_MS);
  assert.equal(ff04To(app).length, 5, 'five within four seconds');
  assert.deepEqual(ff04To(app), devices.slice(0, 5));
  for (let i = 0; i < 22; i += 1) await pass(POLL_SLOT_MS);
  assert.deepEqual(ff04To(app), devices, 'all 27, in order');
  assert.equal(csr.pollQueueLength(), 0);
  assert.equal(POLL_SLOT_MS, 800);
  assert.deepEqual(app.sent.map((s) => s.meta.listenMs), Array(27).fill(STATUS_LISTEN_MS), 'each link listens as before');
});

test('the round\'s line: asked, answered within STATUS_LISTEN_MS, skipped as heard; a device queued twice goes once', async () => {
  const { app, csr, pass } = network();
  csr.handleFrame(status(0x9c03)); // sent its status just now
  await pass(POLL_SKIP_HEARD_MS - 5000);
  for (const meshId of [0x9c01, 0x9c02, 0x9c03, 0x9c02]) csr.queueStatus(meshId, LOC);
  await tick();
  csr.handleFrame(status(0x9c01)); // answers at once
  await pass(POLL_SLOT_MS);
  await pass(POLL_SLOT_MS);
  assert.deepEqual(ff04To(app), [0x9c01, 0x9c02], 'the third skipped, the second once');
  await pass(POLL_SLOT_MS);
  await pass(STATUS_LISTEN_MS);
  csr.handleFrame(status(0x9c02)); // too late to count
  assert.deepEqual(pollLines(app), ['[CSR] poll: 2 asked, 1 answered within 3 s, 1 skipped as heard']);
  // Heard long enough ago: asked again.
  await pass(POLL_SKIP_HEARD_MS);
  csr.queueStatus(0x9c03, LOC);
  await tick();
  assert.deepEqual(ff04To(app).slice(-1), [0x9c03]);
});

test('a pairing pause empties the queue and forgets the round; the devices ask again at their next turn', async () => {
  const { app, csr, pass } = network();
  for (const meshId of [0x9c01, 0x9c02, 0x9c03]) csr.queueStatus(meshId, LOC);
  await tick();
  assert.equal(csr.pollQueueLength(), 2);
  app.homey.ble = { discover: async () => [] };
  const bridge = new MeshBridge(app);
  app.bridge.pauseForScan = (label) => bridge.pauseForScan(label);
  const end = await bridge.pauseForScan('pairing scan');
  assert.equal(csr.pollQueueLength(), 0);
  assert.equal([...app.homey.pending.values()].filter((t) => t.ms === POLL_SLOT_MS || t.ms === STATUS_LISTEN_MS).length, 0, 'no poll timer left');
  assert.ok(pollLines(app).includes('[CSR] poll: cleared, 2 queued (pairing pause)'));
  end('pairing done');
  await pass(POLL_SLOT_MS * 3);
  assert.deepEqual(ff04To(app), [0x9c01], 'nothing more went out');
  csr.queueStatus(0x9c02, LOC);
  await tick();
  assert.deepEqual(ff04To(app), [0x9c01, 0x9c02], 'a new round starts clean');
});

test('stop empties the queue too, and nothing is queued after it', async () => {
  const { app, csr } = network();
  for (const meshId of [0x9c01, 0x9c02]) csr.queueStatus(meshId, LOC);
  await tick();
  csr.stop();
  assert.equal(csr.pollQueueLength(), 0);
  assert.equal([...app.homey.pending.values()].filter((t) => t.ms === POLL_SLOT_MS || t.ms === STATUS_LISTEN_MS).length, 0);
  assert.ok(pollLines(app).includes('[CSR] poll: cleared, 1 queued (stop)'));
  assert.equal(csr.queueStatus(0x9c03, LOC), false);
});

test('the first generation is not touched: the dimmers\' status poll goes to the bridge as before, never through the queue', () => {
  const app = new SGSmartApp();
  app.homey = fake.fakeHomey(app);
  let polls = 0;
  app.bridge = { pollSoon: () => { polls += 1; } };
  app.log = () => {};
  app.error = () => {};
  app.getNetworkKey = () => KEY;
  app._devices = () => [];
  app.csr = new CsrNetwork(app);
  app.requestStatus();
  assert.equal(polls, 1);
  assert.equal(app.csr.pollQueueLength(), 0);
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert.doesNotMatch(read('lib/SGDeviceBase.js'), /queueStatus|clearPollQueue/);
  assert.doesNotMatch(read('app.js'), /queueStatus/);
  assert.match(read('lib/SGCsrDevice.js'), /csr\.queueStatus\(this\.getCsrMeshId\(\), location\)/, 'the later devices go through the queue');
  // MeshBridge touches the queue only to empty it before a pairing scan.
  const bridge = read('lib/MeshBridge.js');
  assert.equal((bridge.match(/PollQueue|queueStatus/g) || []).length, 2, 'clearPollQueue, checked and called');
});
