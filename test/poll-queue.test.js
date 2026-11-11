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
  CsrNetwork, POLL_GIVE_UP_MS, POLL_SKIP_HEARD_MS, POLL_SLOT_MS, STATUS_LISTEN_MS,
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
// With held, each send waits until the test lets it through (release), as a
// write waits for the link; release(result) gives the bridge's answer.
function network({ held = false } = {}) {
  const clock = { now: 1_700_000_000_000 };
  const app = {
    logs: [], sent: [], log: (...args) => app.logs.push(args.join(' ')), error: (...args) => app.logs.push(args.join(' ')),
  };
  app.homey = fake.fakeHomey(app);
  app.getNetworkKey = () => KEY;
  let seq = 0x800000;
  app.nextSeq = () => { seq += 1; return seq; };
  app._devices = () => [];
  const waiting = [];
  app.bridge = {
    send: async (packet, meta) => {
      const plain = plainOf(packet);
      app.sent.push({ dst: plain[0] | (plain[1] << 8), opcode: (plain[2] << 8) | plain[3], at: clock.now, meta });
      if (!held) return { ok: true };
      return new Promise((resolve) => {
        waiting.push(resolve);
      });
    },
  };
  app.release = (result = { ok: true }) => {
    const resolve = waiting.shift();
    if (resolve) resolve(result);
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

// ---- many at once, with a promise for the round: the SG account's check

const { SgAccount } = require('../lib/account');

const EMAIL = 'tester@example.invalid';
const PASSWORD = 'made-up pass 7';

// One made-up home with three later devices and a location id, as the
// account module gives it.
const home = () => ({
  passphrase: 'test-only-pass', locationId: LOC,
  devices: [{ meshId: 0x9c01, type: 1004 }, { meshId: 0x9c02, type: 1004 }, { meshId: 0x9c03, type: 1004 }],
});

const checkLine = (app) => app.logs.find((line) => line.startsWith('[SG account] check:'));

test('queueStatusAll: each queued as by queueStatus, one every POLL_SLOT_MS, and the promise ends STATUS_LISTEN_MS after the last with who was asked and skipped', async () => {
  const { app, csr, pass } = network();
  csr.handleFrame(status(0x9c02)); // sent its status just now: skipped
  csr.queueStatus(0x9c08, LOC); // two devices' own turns, queued first
  csr.queueStatus(0x9c09, LOC);
  await tick();
  let result = null;
  const all = csr.queueStatusAll([{ meshId: 0x9c01, location: LOC }, { meshId: 0x9c02, location: LOC }, { meshId: 0x9c09, location: LOC }])
    .then((r) => { result = r; });
  await tick();
  assert.equal(csr.pollQueueLength(), 3, 'the one still queued is not queued twice');
  for (let i = 0; i < 3; i += 1) await pass(POLL_SLOT_MS);
  assert.deepEqual(ff04To(app), [0x9c08, 0x9c09, 0x9c01], 'the devices first, then the check\'s; the heard one skipped');
  await pass(POLL_SLOT_MS);
  assert.equal(result, null, 'not before the round is over');
  await pass(STATUS_LISTEN_MS);
  await all;
  assert.deepEqual(result, { asked: [0x9c08, 0x9c09, 0x9c01], skipped: [0x9c02], ended: 'done' });
  assert.deepEqual(pollLines(app), ['[CSR] poll: 3 asked, 0 answered within 3 s, 1 skipped as heard']);
  // Nothing to queue: done at once. Stopped: so too, and said.
  assert.deepEqual(await csr.queueStatusAll([]), { asked: [], skipped: [], ended: 'done' });
  csr.stop();
  assert.deepEqual(await csr.queueStatusAll([{ meshId: 0x9c01, location: LOC }]), { asked: [], skipped: [], ended: 'stop' });
});

test('a pairing pause or stop in the middle ends the promise with what went out and why', async () => {
  for (const [why, end] of [
    ['pairing pause', async (app, csr) => {
      app.homey.ble = { discover: async () => [] };
      const bridge = new MeshBridge(app);
      app.bridge.pauseForScan = (label) => bridge.pauseForScan(label);
      (await bridge.pauseForScan('pairing scan'))('pairing done');
      assert.equal(csr.pollQueueLength(), 0);
    }],
    ['stop', async (app, csr) => csr.stop()],
  ]) {
    const { app, csr, pass } = network();
    let result = null;
    csr.queueStatusAll([{ meshId: 0x9c01, location: LOC }, { meshId: 0x9c02, location: LOC }, { meshId: 0x9c03, location: LOC }])
      .then((r) => { result = r; });
    await tick();
    await pass(POLL_SLOT_MS);
    assert.deepEqual(ff04To(app), [0x9c01, 0x9c02]);
    await end(app, csr);
    await tick();
    assert.deepEqual(result, { asked: [0x9c01, 0x9c02], skipped: [], ended: why }, why);
    assert.ok(pollLines(app).includes(`[CSR] poll: cleared, 1 queued (${why})`));
  }
});

// The account on the network's app: a fetch that gives the home, and a
// frame from a mesh id heard by the account too (app.js does that).
function withAccount(app, csr, homes = [home()]) {
  app.account = new SgAccount(app, { fetch: async () => ({ homes, loggedOut: true }) });
  return (meshId) => { csr.handleFrame(status(meshId)); app.account.heard(meshId); };
}

test('the SG account\'s check goes through the queue: one FF04 every POLL_SLOT_MS, the line STATUS_LISTEN_MS after the last, checking until then', async () => {
  const { app, csr, pass } = network();
  const heard = withAccount(app, csr);
  await app.account.login(EMAIL, PASSWORD);
  await tick();
  assert.equal(app.account.summary().checking, true);
  assert.equal((await app.account.login(EMAIL, PASSWORD)).error, 'busy', 'no second fetch while the devices are asked');
  assert.deepEqual(ff04To(app), [0x9c01], 'the first at once');
  heard(0x9c01);
  await pass(POLL_SLOT_MS);
  await pass(POLL_SLOT_MS);
  assert.deepEqual(ff04To(app), [0x9c01, 0x9c02, 0x9c03], 'one every slot, none twice');
  heard(0x9c03);
  await pass(POLL_SLOT_MS);
  assert.equal(checkLine(app), undefined, 'not before the round is over');
  assert.equal(app.account.summary().checking, true);
  await pass(STATUS_LISTEN_MS);
  await tick();
  assert.equal(checkLine(app), '[SG account] check: 2 of 3 answer, 3 asked, 0 skipped as heard, 0 unknown (no location id), 0 uncertain (not counted), 0 SG Smart 3.0 not asked');
  assert.equal(app.account.summary().checking, false);
  const [shown] = app.account.summary().homes;
  assert.deepEqual([shown.checked, shown.answering, shown.total, shown.quiet.length], [true, 2, 3, 1]);
  assert.deepEqual(pollLines(app), ['[CSR] poll: 3 asked, 2 answered within 3 s, 0 skipped as heard']);
});

test('a device heard in the last POLL_SKIP_HEARD_MS before the check is skipped by the queue and counts as answering', async () => {
  const { app, csr, pass } = network();
  const heard = withAccount(app, csr);
  heard(0x9c02);
  await pass(POLL_SKIP_HEARD_MS - 5000);
  await app.account.login(EMAIL, PASSWORD);
  await tick();
  await pass(POLL_SLOT_MS);
  await pass(POLL_SLOT_MS);
  assert.deepEqual(ff04To(app), [0x9c01, 0x9c03], 'the heard one not asked');
  await pass(STATUS_LISTEN_MS);
  await tick();
  assert.equal(checkLine(app), '[SG account] check: 1 of 3 answer, 2 asked, 1 skipped as heard, 0 unknown (no location id), 0 uncertain (not counted), 0 SG Smart 3.0 not asked');
  const [shown] = app.account.summary().homes;
  assert.deepEqual([shown.answering, shown.total], [1, 3]);
});

test('a pairing pause in the middle of the check ends it with what went out; the line says how many were not asked', async () => {
  const { app, csr, pass } = network();
  withAccount(app, csr);
  await app.account.login(EMAIL, PASSWORD);
  await tick();
  app.homey.ble = { discover: async () => [] };
  const bridge = new MeshBridge(app);
  app.bridge.pauseForScan = (label) => bridge.pauseForScan(label);
  const end = await bridge.pauseForScan('pairing scan');
  await tick();
  assert.deepEqual(ff04To(app), [0x9c01]);
  assert.equal(checkLine(app), '[SG account] check: 0 of 3 answer, 1 asked, 0 skipped as heard, 0 unknown (no location id), 0 uncertain (not counted), 0 SG Smart 3.0 not asked, 2 not asked (pairing pause)');
  assert.equal(app.account.summary().checking, false);
  end('pairing done');
  await pass(POLL_SLOT_MS * 3);
  assert.deepEqual(ff04To(app), [0x9c01], 'nothing more went out');
});

// ---- the queue waits for each write (2.8.9)

test('the next FF04 is handed over only POLL_SLOT_MS after the one before was written, however long the write took', async () => {
  const { app, csr, pass } = network({ held: true });
  for (const meshId of [0x9c01, 0x9c02, 0x9c03]) csr.queueStatus(meshId, LOC);
  await tick();
  assert.deepEqual(ff04To(app), [0x9c01]);
  for (let i = 0; i < 15; i += 1) await pass(POLL_SLOT_MS); // 12 s: the link is down, nothing written
  assert.deepEqual(ff04To(app), [0x9c01], 'no second while the first is not written');
  app.release();
  await tick(); await tick();
  assert.deepEqual(ff04To(app), [0x9c01], 'nor right after its write');
  await pass(POLL_SLOT_MS);
  assert.deepEqual(ff04To(app), [0x9c01, 0x9c02], 'the second a slot after the write');
});

test('asked and answered are counted from the write: an answer 1 s after a write that waited 10 s is answered within 3 s', async () => {
  const { app, csr, pass } = network({ held: true });
  csr.queueStatus(0x9c01, LOC);
  await tick();
  for (let i = 0; i < 12; i += 1) await pass(POLL_SLOT_MS); // waited about 10 s
  app.release();
  await tick(); await tick();
  await pass(1000);
  csr.handleFrame(status(0x9c01));
  await pass(POLL_SLOT_MS);
  await pass(STATUS_LISTEN_MS);
  assert.deepEqual(pollLines(app), ['[CSR] poll: 1 asked, 1 answered within 3 s, 0 skipped as heard']);
});

test('an FF04 the bridge gives up on ends the round: the line says so and how many were not asked, and they ask again at their next turn', async () => {
  const { app, csr, pass } = network({ held: true });
  let result = null;
  const all = csr.queueStatusAll([0x9c01, 0x9c02, 0x9c03].map((meshId) => ({ meshId, location: LOC })));
  all.then((r) => {
    result = r;
  }, () => {});
  await tick();
  for (let i = 0; i < 40; i += 1) await pass(POLL_SLOT_MS); // 32 s
  app.release({ failed: true });
  await tick(); await tick(); await tick();
  assert.deepEqual(ff04To(app), [0x9c01], 'the others not sent');
  assert.equal(csr.pollQueueLength(), 0);
  assert.equal(pollLines(app).length, 1);
  assert.match(pollLines(app)[0], /^\[CSR\] poll: 0 asked, 0 answered within 3 s, 0 skipped as heard; ended: an FF04 not written in 32 s \(given up\), 2 not asked$/);
  assert.deepEqual(result, { asked: [], skipped: [], ended: 'given up' });
  csr.queueStatus(0x9c02, LOC);
  await tick();
  assert.deepEqual(ff04To(app), [0x9c01, 0x9c02], 'a new round starts at the next turn');
});

test('a bridge that never answers (it shut down, or a Bluetooth call hangs) holds the queue at most POLL_GIVE_UP_MS: then the FF04 counts as given up and the round ends', async () => {
  assert.equal(POLL_GIVE_UP_MS, 60000);
  const { app, csr, pass } = network({ held: true });
  let result = null;
  const all = csr.queueStatusAll([0x9c01, 0x9c02, 0x9c03].map((meshId) => ({ meshId, location: LOC })));
  all.then((r) => {
    result = r;
  }, () => {});
  await tick();
  assert.deepEqual(ff04To(app), [0x9c01]);
  assert.equal(pollLines(app).length, 0, 'not before the limit');
  await pass(POLL_GIVE_UP_MS); // the limit's own timer, 60 s on
  await tick();
  assert.deepEqual(pollLines(app),
    ['[CSR] poll: 0 asked, 0 answered within 3 s, 0 skipped as heard; ended: an FF04 not written in 60 s (no answer from the bridge, given up), 2 not asked']);
  assert.deepEqual(result, { asked: [], skipped: [], ended: 'given up' });
  // The bridge answering late changes nothing, and the next turn starts anew.
  app.release();
  await tick(); await tick();
  assert.equal(pollLines(app).length, 1);
  csr.queueStatus(0x9c02, LOC);
  await tick();
  assert.deepEqual(ff04To(app), [0x9c01, 0x9c02]);
});

test('the FF04 a search sends each node that answered FF11 goes through the queue: one at a time, not all at once', async () => {
  const { app, csr, pass } = network();
  const name = (src) => ({ src, plain: ext(0x8000, 0xff11, [...loc(LOC), ...Buffer.from(`MC${src.toString(16).slice(-4).toUpperCase()}`, 'latin1'), 0]) });
  for (const src of [0x9c01, 0x9c02, 0x9c03]) csr.handleFrame(name(src));
  await tick();
  assert.deepEqual(ff04To(app), [0x9c01], 'the first at once');
  assert.equal(csr.pollQueueLength(), 2);
  await pass(POLL_SLOT_MS);
  await pass(POLL_SLOT_MS);
  assert.deepEqual(ff04To(app), [0x9c01, 0x9c02, 0x9c03]);
});

test('a device whose FF04 waits to be written is not queued again meanwhile; once it is written, it can be', async () => {
  const { app, csr, pass } = network({ held: true });
  assert.equal(csr.queueStatus(0x9c01, LOC), true);
  await tick();
  assert.deepEqual(ff04To(app), [0x9c01], 'its FF04 waits for the link');
  assert.equal(csr.queueStatus(0x9c01, LOC), false, 'not queued twice');
  assert.equal(csr.pollQueueLength(), 0);
  app.release();
  await tick(); await tick();
  await pass(POLL_SLOT_MS);
  assert.deepEqual(ff04To(app), [0x9c01], 'no second FF04 to it');
  assert.equal(csr.queueStatus(0x9c01, LOC), true, 'written: it can be queued again');
});

// ---- what counts as heard (2.8.9)

test('a status counts as heard, and changes the node\'s location id, only when a device here took it or no device here has the mesh id: one with another location id does not skip the next FF04', async () => {
  const { app, csr, pass } = network();
  const taking = new Map([[0x9c01, false], [0x9c02, true]]); // what each device answers
  app._devices = () => [...taking.keys()].map((meshId) => ({
    getCsrMeshId: () => meshId, applyCsrStatus: () => taking.get(meshId),
  }));
  for (const meshId of [0x9c01, 0x9c02, 0x9c03]) csr.nodes.set(meshId, { meshId, location: LOC }); // heard by FF11
  csr.handleFrame(status(0x9c01, 0x6b4d)); // another location id: its device does not take it
  csr.handleFrame(status(0x9c02)); // taken
  csr.handleFrame(status(0x9c03, 0x7a7a)); // no device here has 0x9c03
  assert.equal(csr.nodes.get(0x9c01).location, LOC, 'not taken: the node keeps its location id');
  assert.equal(csr.nodes.get(0x9c03).location, 0x7a7a, 'no device here: the node takes it, as before');
  await pass(5000);
  for (const meshId of [0x9c01, 0x9c02, 0x9c03]) csr.queueStatus(meshId, LOC);
  await tick();
  for (let i = 0; i < 3; i += 1) await pass(POLL_SLOT_MS);
  assert.deepEqual(ff04To(app), [0x9c01], 'only the one whose status was not taken is asked');
  await pass(STATUS_LISTEN_MS);
  assert.deepEqual(pollLines(app), ['[CSR] poll: 1 asked, 0 answered within 3 s, 2 skipped as heard']);
});

test('an answer its device does not take is not counted as answered in the round', async () => {
  const { app, csr, pass } = network();
  let takes = false;
  app._devices = () => [{ getCsrMeshId: () => 0x9c01, applyCsrStatus: () => takes }];
  csr.queueStatus(0x9c01, LOC);
  await tick();
  csr.handleFrame(status(0x9c01, 0x6b4d)); // answered with another location id: not taken
  await pass(POLL_SLOT_MS);
  await pass(STATUS_LISTEN_MS);
  assert.deepEqual(pollLines(app), ['[CSR] poll: 1 asked, 0 answered within 3 s, 0 skipped as heard']);
  takes = true;
  csr.queueStatus(0x9c01, LOC);
  await tick();
  csr.handleFrame(status(0x9c01));
  await pass(POLL_SLOT_MS);
  await pass(STATUS_LISTEN_MS);
  assert.equal(pollLines(app)[1], '[CSR] poll: 1 asked, 1 answered within 3 s, 0 skipped as heard');
});
