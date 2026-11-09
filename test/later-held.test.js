'use strict';

// "Keep SG LEDDim Gen2 to 4 connected (test)": in a home without first
// generation dimmers, the link is held through the strongest later node,
// chosen as today, and kept alive with one FF04 every HELD_ASK_MS to one of
// our devices, always the same, in place of a heartbeat. Off by default, and
// shown only with a later device and no first generation dimmer. A home with
// a first generation dimmer is unchanged. The log has a line each minute and
// one when the link goes down: how long it held and why it ended, the FF04s,
// and the frames by opcode, asked (from a sender asked within ASKED_MS) or
// unasked. The FF04s and their answers have no lines of their own. Whether a
// later node keeps a link up this way is assumed: not tried with a device.
// Made-up values: the location ids, mesh ids and names. Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fake = require('./helpers/fake-homey');

fake.install();

const MeshBridge = require('../lib/MeshBridge');
const { ASKED_MS, CsrNetwork, STATUS_LISTEN_MS } = require('../lib/CsrNetwork');
const SGSmartApp = require('../app');
const SGCsrDevice = require('../lib/SGCsrDevice');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const HELD_ASK_MS = Number(/^const HELD_ASK_MS = (\d+);/m.exec(read('lib/MeshBridge.js'))[1]);
const HOME = 0x4c2e;
const PILL_ID = 0x9a31;
const PLUG_ID = 0xb7e2;
const NO_ID = /9a31|b7e2|4c2e|1a2b|@[A-Z]{2}[0-9A-F]{4}/i;
const tick = () => new Promise((resolve) => setImmediate(resolve));

// A decrypted frame from src: FF05 by default, with its number byte.
const frame = (src, opcode = 0xff05, number = 1) => ({
  src, plain: Buffer.from([0x00, 0x80, 0xff, opcode & 0xff, HOME >> 8, HOME & 0xff, 1, 40, number, 0]),
});

// Date.now as the test sets it, for a run.
async function withClock(run) {
  const realNow = Date.now;
  const clock = { now: 9000000 };
  Date.now = () => clock.now;
  try {
    await run(clock);
  } finally {
    Date.now = realNow;
  }
}

// ---- when the link is held

function bridgeWith({
  gen1 = 0, later = 0, choice = null, laterChoice = null,
} = {}) {
  const app = {
    log() {}, error() {}, _devices: () => [], dimmerCount: () => gen1, laterCount: () => later,
  };
  app.homey = fake.fakeHomey(app);
  if (choice !== null) app.homey.settings.set('keepConnected', choice);
  if (laterChoice !== null) app.homey.settings.set('laterKeepConnected', laterChoice);
  return new MeshBridge(app);
}

test('without first generation dimmers: held only with "Keep SG LEDDim Gen2 to 4 connected" on and a later device', () => {
  assert.equal(bridgeWith({ later: 2 })._keepConnected(), false, 'off by default');
  assert.equal(bridgeWith({ later: 2, laterChoice: false })._keepConnected(), false);
  assert.equal(bridgeWith({ later: 2, laterChoice: true })._keepConnected(), true);
  assert.equal(bridgeWith({ later: 0, laterChoice: true })._keepConnected(), false, 'no later device');
  assert.equal(bridgeWith({ later: 2, choice: true })._keepConnected(), false, 'the first generation switch is not this one');
});

test('with first generation dimmers, the Gen2 to 4 switch changes nothing: the first generation rules as before', () => {
  assert.equal(bridgeWith({ gen1: 1, later: 2, laterChoice: true })._keepConnected(), false);
  assert.equal(bridgeWith({ gen1: 1, later: 2, laterChoice: true }).laterHeld(), false);
  assert.equal(bridgeWith({ gen1: 2, later: 2, laterChoice: false })._keepConnected(), true, 'on by default from two');
  assert.equal(bridgeWith({
    gen1: 2, later: 2, choice: false, laterChoice: true,
  })._keepConnected(), false);
});

// ---- the FF04s on a held link

// A bridge holding a link that is up, with the Gen2 to 4 switch on: in a
// home without first generation dimmers through a later node (no @ND name,
// so no heartbeat), or in a home with one (gen1Home) through an @ND node
// (gen1Bridge) or another. The app's FF04 goes to one device through a real
// CsrNetwork, which counts the frames as the app does; every line the app
// would log is kept.
function holdingBridge({ gen1Home = false, gen1Bridge = gen1Home } = {}) {
  const asks = [];
  const lines = [];
  const app = {
    log: (...args) => lines.push(args.join(' ')),
    error: (...args) => lines.push(args.join(' ')),
    _devices: () => [],
    dimmerCount: () => (gen1Home ? 1 : 0),
    laterCount: () => 2,
    nextSeq: () => 1,
    getNetworkKey: () => Buffer.alloc(16),
    bridge: { send: async () => ({ ok: true }) },
    heldAsk: async () => {
      asks.push(Date.now());
      return app.csr.requestStatus(PILL_ID, HOME, STATUS_LISTEN_MS, { quiet: true });
    },
    frameCountsText: SGSmartApp.prototype.frameCountsText,
  };
  app.homey = fake.fakeHomey(app);
  app.csr = new CsrNetwork(app);
  app.homey.settings.set('laterKeepConnected', true);
  if (gen1Home) app.homey.settings.set('keepConnected', true);
  const bridge = new MeshBridge(app);
  bridge._held = true;
  bridge._heldLater = !gen1Home;
  bridge._peripheral = { disconnect: async () => {} };
  bridge._char8003 = {};
  bridge._char8004 = {};
  bridge._notifySubscribed = true;
  bridge._connNo = 1;
  bridge._preferredUuid = 'made-up-uuid';
  bridge._bridgeLocalName = gen1Bridge ? '@ND1A2B' : '';
  bridge._bridgeNodeId = gen1Bridge ? 0x1a2b : null;
  const heartbeats = [];
  bridge._startHeartbeat = (connNo) => heartbeats.push(connNo);
  return {
    bridge, app, asks, heartbeats, lines,
  };
}

const askTimers = (app) => [...app.homey.pending.values()].filter((t) => t.ms === HELD_ASK_MS).length;

// Runs the FF04s for n rounds; the device asked answers each one.
async function rounds(held, clock, n) {
  for (let i = 0; i < n; i += 1) {
    clock.now += HELD_ASK_MS;
    held.app.homey.runMs(HELD_ASK_MS);
    await tick();
    clock.now += 300;
    held.app.csr.handleFrame(frame(PILL_ID, 0xff05, i + 2));
    clock.now -= 300;
  }
}

test('a held link through a later node: no heartbeat, one FF04 every HELD_ASK_MS', async () => {
  const {
    bridge, app, asks, heartbeats,
  } = holdingBridge();
  bridge._keepHeldAlive(1);
  assert.deepEqual(heartbeats, [], 'no heartbeat to a later node');
  for (let i = 0; i < 3; i += 1) {
    app.homey.runMs(HELD_ASK_MS);
    await tick();
  }
  assert.equal(asks.length, 3);
  assert.equal(HELD_ASK_MS, 4000);
  bridge._keepHeldAlive(1);
  assert.equal(askTimers(app), 1, 'one timer, not two');
});

test('no FF04 while a command is queued or written; the next goes HELD_ASK_MS later', async () => {
  const { bridge, app, asks } = holdingBridge();
  bridge._keepHeldAlive(1);
  bridge._txPending = 1;
  app.homey.runMs(HELD_ASK_MS);
  await tick();
  assert.equal(asks.length, 0);
  bridge._txPending = 0;
  app.homey.runMs(HELD_ASK_MS);
  await tick();
  assert.equal(asks.length, 1);
});

test('the FF04s stop with their link: a new link, or the setting off', async () => {
  const one = holdingBridge();
  one.bridge._keepHeldAlive(1);
  one.bridge._connNo = 2;
  one.app.homey.runMs(HELD_ASK_MS);
  await tick();
  assert.equal(one.asks.length, 0);
  assert.equal(askTimers(one.app), 0, 'none left');
  const two = holdingBridge();
  two.bridge._keepHeldAlive(1);
  two.app.homey.settings.set('laterKeepConnected', false);
  two.app.homey.runMs(HELD_ASK_MS);
  await tick();
  assert.equal(two.asks.length, 0);
});

test('a first generation home, also with the Gen2 to 4 switch on: the heartbeat as before, never an FF04', async () => {
  for (const gen1Bridge of [true, false]) {
    const {
      bridge, app, asks, heartbeats,
    } = holdingBridge({ gen1Home: true, gen1Bridge });
    // While the link is up, and after a new held link came up.
    bridge._keepHeldAlive(1);
    bridge._scheduleIdleDisconnect('tx-queue-empty');
    bridge._peripheral = null;
    bridge._notifySubscribed = false;
    bridge._heldUpAt = Date.now();
    bridge._ensureConnected = async () => {
      bridge._peripheral = { disconnect: async () => {} };
      bridge._notifySubscribed = true;
      bridge._connNo = 2;
    };
    await bridge._heldTick();
    assert.deepEqual(heartbeats, gen1Bridge ? [1, 1, 2] : [2], 'as before: through an @ND node at each, after a connect always');
    app.homey.runMs(HELD_ASK_MS);
    await tick();
    assert.equal(asks.length, 0);
    assert.equal(askTimers(app), 0);
  }
});

test('after a held link through a later node comes up: the FF04s start, no heartbeat', async () => {
  const {
    bridge, app, heartbeats,
  } = holdingBridge();
  bridge._peripheral = null;
  bridge._notifySubscribed = false;
  bridge._ensureConnected = async () => {
    bridge._peripheral = { disconnect: async () => {} };
    bridge._notifySubscribed = true;
    bridge._connNo = 2;
  };
  await bridge._heldTick();
  assert.deepEqual(heartbeats, []);
  assert.equal(askTimers(app), 1);
});

test('a held link through a later node is not rolled for its age before a command, as a first generation one is not', async () => {
  const { bridge } = holdingBridge();
  bridge._connStartedAt = Date.now() - 600000;
  bridge._readyAgeMs = 3000;
  const closed = [];
  bridge._disconnect = async (reason) => { closed.push(reason); };
  bridge._preemptStatusForTx = async () => {};
  await bridge._ensureTxConnected();
  assert.deepEqual(closed, []);
});

test('when a held link through a later node goes down: how long it was up, why, the FF04s and the frames; no id', async () => {
  await withClock(async (clock) => {
    const held = holdingBridge();
    const { bridge, app, lines } = held;
    bridge._ensureConnected = async () => { throw new Error('no node now'); };
    bridge._heldUpAt = clock.now;
    bridge._heldWindowAt = clock.now;
    bridge._keepHeldAlive(1);
    await rounds(held, clock, 5);
    app.csr.handleFrame(frame(PLUG_ID, 0xff50));
    clock.now += 3000;
    await bridge._disconnect('remote-hangup');
    await bridge._heldTick();
    const line = lines.find((l) => l.includes('held link through a later node'));
    assert.equal(line, '[SG status] held link through a later node: up 23 s, ended by remote-hangup; FF04 sent 5; '
      + 'asked FF05 5; unasked FF50 1');
    assert.doesNotMatch(line, NO_ID);
  });
});

test('the switch turned off: the held link stops under its own name, with the line for the link; an FF04 that did not get out is counted as such', async () => {
  await withClock(async (clock) => {
    const held = holdingBridge();
    const { bridge, app, lines } = held;
    let ok = false;
    app.bridge.send = async () => ({ ok });
    bridge._heldUpAt = clock.now;
    bridge._keepHeldAlive(1);
    clock.now += HELD_ASK_MS;
    app.homey.runMs(HELD_ASK_MS);
    await tick();
    ok = true;
    await rounds(held, clock, 1);
    app.homey.settings.set('laterKeepConnected', false);
    bridge.applyMode();
    await tick();
    const switched = lines.filter((l) => /held link through a later node|connected \(test\) off/.test(l));
    assert.deepEqual(switched, [
      '[SG status] keep SG LEDDim Gen2 to 4 connected (test) off (setting off); status polling every 5 min',
      '[SG status] held link through a later node: up 8 s, ended by held-link-off; FF04 sent 1 (1 not delivered); asked FF05 1; unasked none',
    ]);
    assert.doesNotMatch(switched.join('\n'), NO_ID);
  });
});

test('the minute line of a held link through a later node is always logged, with its FF04s and frames; a first generation one only with detailed logging, as before', async () => {
  await withClock(async (clock) => {
    const held = holdingBridge();
    const { bridge, app, lines } = held;
    bridge._heldUpAt = clock.now;
    bridge._heldWindowAt = clock.now;
    bridge._heldLinks = 1;
    app.csr.takeFrameCounts('minute');
    bridge._keepHeldAlive(1);
    await rounds(held, clock, 15);
    app.csr.handleFrame(frame(PLUG_ID, 0xff05));
    app.csr.handleFrame(frame(PLUG_ID, 0xff50));
    bridge._logHeldSummary();
    const minute = lines.filter((l) => l.includes('held link: last'));
    assert.deepEqual(minute, ['[SG status] held link: last 60s up 60s (100%), links 1, drops 0, heartbeats 0, decode 0 call(s) 0ms, '
      + 'MAC failures 0, FF04 sent 15; asked FF05 15; unasked FF05 1, FF50 1']);
    assert.doesNotMatch(minute[0], NO_ID);
  });
  const gen1 = holdingBridge({ gen1Home: true });
  gen1.bridge._heldWindowAt = Date.now() - 60000;
  gen1.bridge._logHeldSummary();
  assert.equal(gen1.lines.filter((l) => l.includes('held link: last')).length, 0, 'not without detailed logging');
  gen1.app.homey.settings.set('debugLogging', true);
  gen1.bridge._logHeldSummary();
  assert.match(gen1.lines.find((l) => l.includes('held link: last')), /^\[MeshBridge\] held link: last \d+s .*MAC failures 0$/);
});

test('the FF04s give no line of their own: not the request, not its answer, not a timing line, also with detailed logging', async () => {
  await withClock(async (clock) => {
    const held = holdingBridge();
    const { bridge, app, lines } = held;
    app.homey.settings.set('debugLogging', true);
    app.csr.handleFrame(frame(PILL_ID, 0xff05, 1)); // the device's first, logged as always
    const before = lines.length;
    bridge._keepHeldAlive(1);
    await rounds(held, clock, 10);
    assert.deepEqual(lines.slice(before), []);
  });
});

// ---- asked and unasked frames

function network() {
  const app = {
    log() {}, error() {}, nextSeq: () => 1, getNetworkKey: () => Buffer.alloc(16), _devices: () => [],
    bridge: { send: async () => ({ ok: true }) },
  };
  app.homey = fake.fakeHomey(app);
  let now = 1000000;
  const csr = new CsrNetwork(app, { now: () => now });
  return { csr, app, at: (ms) => { now += ms; } };
}

test('a frame from a sender asked within ASKED_MS is asked, whatever its opcode; from any other sender, unasked; our own, not counted', async () => {
  const { csr, at } = network();
  await csr.requestStatus(PILL_ID, HOME);
  at(1000);
  csr.handleFrame(frame(PILL_ID, 0xff50));
  csr.handleFrame(frame(PILL_ID, 0xff05));
  csr.handleFrame(frame(PLUG_ID, 0xff05));
  csr.handleFrame(frame(0x8000, 0xff04));
  at(ASKED_MS + 1);
  csr.handleFrame(frame(PILL_ID, 0xff05, 2));
  assert.equal(ASKED_MS, 3000);
  assert.deepEqual(csr.takeFrameCounts('minute'), { asked: { FF05: 1, FF50: 1 }, unasked: { FF05: 2 } });
  assert.deepEqual(csr.takeFrameCounts('minute'), { asked: {}, unasked: {} }, 'taken: the bucket starts again');
  assert.deepEqual(csr.takeFrameCounts('link'), { asked: { FF05: 1, FF50: 1 }, unasked: { FF05: 2 } }, 'each bucket on its own');
  assert.equal(CsrNetwork.frameCountsText({ asked: { FF50: 1, FF05: 1 }, unasked: { FF05: 2 } }), 'asked FF05 1, FF50 1; unasked FF05 2');
  assert.equal(CsrNetwork.frameCountsText({ asked: {}, unasked: {} }), 'asked none; unasked none');
});

test('an FF10 to everyone asks everyone; a command to a device asks that device', async () => {
  const { csr, at } = network();
  await csr.requestNames({ asked: true });
  at(500);
  csr.handleFrame(frame(PLUG_ID, 0xff11));
  at(ASKED_MS);
  csr.noteAsked(PILL_ID);
  at(500);
  csr.handleFrame(frame(PILL_ID, 0xff05));
  csr.handleFrame(frame(PLUG_ID, 0xff05));
  assert.deepEqual(csr.takeFrameCounts('minute'), { asked: { FF05: 1, FF11: 1 }, unasked: { FF05: 1 } });
});

test('the held link\'s FF04 is quiet: no line for the request, none for its answers but the sender\'s first; the others as before', async () => {
  const { csr, app, at } = network();
  const lines = [];
  const metas = [];
  app.log = (...args) => lines.push(args.join(' '));
  app.bridge.send = async (packet, meta) => { metas.push(meta); return { ok: true }; };
  for (let i = 1; i <= 3; i += 1) {
    await csr.requestStatus(PILL_ID, HOME, STATUS_LISTEN_MS, { quiet: true });
    at(500);
    csr.handleFrame(frame(PILL_ID, 0xff05, i));
    at(3500);
  }
  csr.handleFrame(frame(PLUG_ID, 0xff05));
  await csr.requestStatus(PILL_ID, HOME);
  at(500);
  csr.handleFrame(frame(PILL_ID, 0xff05, 9));
  assert.equal(lines.filter((line) => line.includes('FF04 status request')).length, 1, 'only the one that is not the held link\'s');
  assert.equal(lines.filter((line) => line.startsWith('[CSR] EXT')).length, 3, 'the first answer, the unasked one, and the answer to the other request');
  assert.deepEqual(metas.map((meta) => meta.quiet === true), [true, true, true, false]);
});

test('MeshBridge: the held link\'s FF04 writes no line, also with detailed logging; another request its lines as before', async () => {
  const lines = [];
  const app = {
    log: (...args) => lines.push(args.join(' ')),
    error: (...args) => lines.push(args.join(' ')),
    getNetworkKey: () => Buffer.alloc(16),
    nextSeq: () => 1,
    _devices: () => [],
    dimmerCount: () => 0,
  };
  app.homey = fake.fakeHomey(app);
  app.homey.settings.set('debugLogging', true);
  const bridge = new MeshBridge(app);
  bridge._held = true;
  bridge._ensureTxConnected = async () => {};
  bridge._peripheral = {};
  bridge._char8003 = { write: async () => {} };
  bridge._char8004 = { write: async () => {} };
  bridge._notifySubscribed = true;
  bridge._sleep = async () => {};
  await bridge.send(Buffer.alloc(30), { key: 'csr:status:1', listenMs: STATUS_LISTEN_MS, quiet: true });
  assert.deepEqual(lines, []);
  await bridge.send(Buffer.alloc(30), { key: 'csr:status:2', listenMs: STATUS_LISTEN_MS });
  for (const part of ['PACKET queued', '8003 BEGIN', '8003 OK', 'GAP', '8004 BEGIN', '8004 OK', 'COMPLETE', 'TX csr:status:2 done']) {
    assert.ok(lines.some((line) => line.includes(part)), part);
  }
});

// ---- the app: the device asked, the switch

const later = (meshId, location, { thermostat = false } = {}) => {
  const device = { getCsrMeshId: () => meshId, getCsrLocationId: () => location, logs: [] };
  device.log = (line) => device.logs.push(line);
  if (!thermostat) device.applyCsrStatus = () => true;
  return device;
};
const gen1 = { getData: () => ({ id: '@ND1A2B' }), getMeshId: () => 0x1a2b };

function appWith(devices) {
  const app = Object.create(SGSmartApp.prototype);
  app.homey = fake.fakeHomey(app, { drivers: { getDrivers: () => ({ any: { getDevices: () => devices } }) } });
  app.log = () => {};
  app.error = () => {};
  app.asked = [];
  app.csr = {
    requestStatus: async (meshId, location, listenMs, options) => { app.asked.push([meshId, location, listenMs, options]); return true; },
  };
  return app;
}

test('the held link asks one device of ours, always the same: a light with a location id, the lowest mesh id', async () => {
  const thermostat = later(0x1001, HOME, { thermostat: true });
  const plug = later(PLUG_ID, HOME);
  const pill = later(PILL_ID, HOME);
  const app = appWith([plug, thermostat, later(0x2002, null), pill, gen1]);
  for (let i = 0; i < 3; i += 1) assert.equal(await app.heldAsk(), true);
  assert.deepEqual(app.asked.map(([meshId]) => meshId), [PILL_ID, PILL_ID, PILL_ID], 'not the thermostat, not one without a location id');
  assert.deepEqual(app.asked[0].slice(1), [HOME, STATUS_LISTEN_MS, { quiet: true }]);
  assert.deepEqual(pill.logs, ['asked for its status every 4 s while the link is held through a later node'], 'said once');
  assert.equal(app.laterCount(), 4);
  assert.equal(await appWith([thermostat]).heldAsk(), true, 'a thermostat when there is no light');
  assert.equal(await appWith([later(0x2002, null)]).heldAsk(), false, 'none to ask');
});

test('the switch is shown only with a later device and no first generation dimmer, as the 3.0 box is', () => {
  const devices = [];
  const app = appWith(devices);
  app.bridge = { applyMode() {} };
  const shown = () => app.homey.settings.get('laterKeepConnectedShown');
  app.dimmersChanged();
  app.laterDevicesChanged();
  app.homey.runMs(2000);
  assert.equal(shown(), false, 'hidden without a device of Gen2 to 4');
  devices.push(later(PILL_ID, HOME));
  app.laterDevicesChanged();
  app.homey.runMs(2000);
  assert.equal(shown(), true, 'shown with one, and no first generation dimmer');
  devices.push(gen1);
  app.dimmersChanged();
  app.homey.runMs(2000);
  assert.equal(shown(), false, 'hidden with a first generation dimmer');
  devices.pop();
  app.dimmersChanged();
  app.homey.runMs(2000);
  assert.equal(shown(), true);
});

test('the switch\'s texts as Trond worded them, and its box on the settings page', () => {
  const [en, no] = ['en', 'no'].map((language) => JSON.parse(read(`locales/${language}.json`)));
  assert.deepEqual(no.settings.laterKeepConnected, {
    label: 'Hold SG LEDDim Gen2 til 4 tilkoblet (test)',
    hint: 'Holder lenken gjennom den sterkeste enheten og spør én enhet hvert 4. sekund. Bare for testing: mer '
      + 'Bluetooth-trafikk, og SG-appen på telefonen når ikke den enheten mens dette er på.',
  });
  assert.deepEqual(en.settings.laterKeepConnected, {
    label: 'Keep SG LEDDim Gen2 to 4 connected (test)',
    hint: 'Holds the link through the strongest device and asks one device every 4 seconds. For testing only: '
      + 'more Bluetooth traffic, and the SG app on your phone cannot reach that device while this is on.',
  });
  const page = read('settings/index.html');
  const start = page.indexOf('<div id="laterKeepConnectedBox" hidden>');
  assert.ok(start > 0);
  const inside = page.slice(start, page.indexOf('</div>', start));
  assert.ok(inside.includes('id="laterKeepConnected"'));
  assert.ok(inside.includes(`data-i18n="settings.laterKeepConnected.label">${en.settings.laterKeepConnected.label}<`));
  assert.ok(inside.includes(`data-i18n="settings.laterKeepConnected.hint">${en.settings.laterKeepConnected.hint}<`));
  assert.ok(page.includes("get('laterKeepConnectedShown')"));
  assert.ok(page.includes('laterKeepConnectedBox.hidden = laterShown !== true;'));
  assert.ok(page.includes('laterKeepConnected.checked = laterChoice === true;'), 'off unless chosen');
  assert.ok(page.includes("set('laterKeepConnected', laterKeepConnected.checked)"));
});

// ---- the log does not fill up

test('while the switch is in effect, a status line the same as the device\'s last is logged only every 10 min; otherwise each one', async () => {
  await withClock(async (clock) => {
    const app = appWith([]);
    let held = true;
    app.bridge = { laterHeld: () => held };
    const device = later(PILL_ID, HOME);
    for (const line of ['status FF05 applied: on=true level=40', 'status FF05 applied: on=true level=40',
      'status FF05 applied: on=true level=60']) app.logStatus(device, line);
    assert.equal(device.logs.length, 2, 'the same again: not logged; a change: logged');
    clock.now += 10 * 60 * 1000;
    app.logStatus(device, 'status FF05 applied: on=true level=60');
    assert.equal(device.logs.length, 3, 'after 10 min: logged');
    held = false;
    app.logStatus(device, 'status FF05 applied: on=true level=60');
    app.logStatus(device, 'status FF05 applied: on=true level=60');
    assert.equal(device.logs.length, 5, 'off: every one, as before');
  });
});

test('a later device logs its status through the app, and its command counts as asking it', async () => {
  const lines = [];
  const noted = [];
  const app = {
    nextSeq: () => 1,
    logStatus: (device, line) => lines.push(line),
    bridge: { send: async () => ({ ok: true }) },
    csr: {
      requestNames: async () => true, requestStatus: async () => true, isThermostat: () => false, noteAsked: (id) => noted.push(id),
    },
  };
  const device = new SGCsrDevice({
    homey: fake.fakeHomey(app),
    store: {
      meshId: PILL_ID, prefix: '@SC', kind: 'dimmable', locationId: HOME,
    },
    settings: { passphrase: '1234' },
    data: { id: '@SC1A2B' },
    name: 'pill',
  });
  device._quietUntil = 0;
  device._number = null;
  device.applyCsrStatus({
    location: HOME, on: true, level: 40, number: 1,
  }, 'FF05');
  assert.deepEqual(lines, ['status FF05 applied: on=true level=40']);
  device._tid = 0;
  device._lastTxAt = 0;
  await device._send(50, { location: HOME });
  assert.deepEqual(noted, [PILL_ID, PILL_ID], 'when queued and again when written');
  device._stopTimers();
});
