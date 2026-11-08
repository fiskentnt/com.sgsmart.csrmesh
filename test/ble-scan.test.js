'use strict';

// The app's queue of Bluetooth scans (app.js, bleDiscover, 2.8.0): while the
// SG Smart 3.0 link exists, a scan waits for the one before it, so the
// CSRmesh bridge and the 3.0 link never scan at the same time; without it a
// scan starts at once, as before. MeshBridge scans through it.

const test = require('node:test');
const assert = require('node:assert/strict');

const fake = require('./helpers/fake-homey');

fake.install();

const SGSmartApp = require('../app');
const MeshBridge = require('../lib/MeshBridge');

const tick = () => new Promise((resolve) => setImmediate(resolve));

// A homey.ble whose scans end when the test says so.
function scans() {
  const started = [];
  const ble = {
    discover: (...args) => new Promise((resolve, reject) => started.push({ args, resolve, reject })),
  };
  return { ble, started };
}

// The app with that ble, Homey's timers run when the test says so
// (runTimers), and its log.
function appWith(ble, sg3) {
  const app = Object.create(SGSmartApp.prototype);
  const timers = new Map();
  let next = 1;
  app.logs = [];
  app.log = (...args) => app.logs.push(args.join(' '));
  app.homey = {
    ble,
    setTimeout: (fn, ms) => { const id = next; next += 1; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  app.timers = timers;
  app.runTimers = () => { for (const [id, { fn }] of [...timers]) { timers.delete(id); fn(); } };
  if (sg3) app._sg3 = sg3;
  return app;
}

test('without a 3.0 link: each scan starts at once, also while another runs', async () => {
  const { ble, started } = scans();
  const app = appWith(ble);
  app.bleDiscover();
  app.bleDiscover(['1828']);
  assert.equal(started.length, 2);
  assert.deepEqual(started[1].args, [['1828']]);
});

test('with a 3.0 link: a scan waits for the one before it, also when that one failed', async () => {
  const { ble, started } = scans();
  const app = appWith(ble, {});
  const first = app.bleDiscover();
  const second = app.bleDiscover(['1828']);
  const third = app.bleDiscover();
  await tick();
  assert.equal(started.length, 1);
  started[0].reject(new Error('made-up scan failure'));
  await assert.rejects(first, /made-up scan failure/);
  await tick();
  assert.equal(started.length, 2);
  assert.deepEqual(started[1].args, [['1828']]);
  started[1].resolve(['advert']);
  assert.deepEqual(await second, ['advert']);
  await tick();
  assert.equal(started.length, 3);
  started[2].resolve([]);
  assert.deepEqual(await third, []);
});

test('MeshBridge scans through the app\'s queue, and straight through Homey without one', async () => {
  const asked = [];
  const bridge = Object.create(MeshBridge.prototype);
  bridge.app = { bleDiscover: (...args) => { asked.push(args); return Promise.resolve(['queued']); } };
  bridge.homey = { ble: { discover: () => Promise.resolve(['direct']) } };
  assert.deepEqual(await bridge._discover(), ['queued']);
  assert.deepEqual(asked, [[]]);
  bridge.app = {};
  assert.deepEqual(await bridge._discover(), ['direct']);
});

test('with a 3.0 link: a scan that never ends holds the next one 20 s at most, then it scans anyway, and the queue goes on', async () => {
  const { ble, started } = scans();
  const app = appWith(ble, { stopped: false });
  app.bleDiscover(['1828']); // never ends
  const second = app.bleDiscover();
  await tick();
  assert.equal(started.length, 1, 'waits for the one before');
  assert.deepEqual([...app.timers.values()].map((timer) => timer.ms), [20000]);
  app.runTimers();
  for (let i = 0; i < 3; i += 1) await tick();
  assert.equal(started.length, 2, 'scans anyway');
  assert.ok(app.logs.includes('[BLE] the scan before has not ended in 20 s: scanning anyway'), app.logs.join('\n'));
  started[1].resolve(['made-up advertisement']);
  assert.deepEqual(await second, ['made-up advertisement']);
  // The next waits for the second, which ended: it starts at once, no timer left.
  app.bleDiscover();
  for (let i = 0; i < 3; i += 1) await tick();
  assert.equal(started.length, 3);
  assert.equal(app.timers.size, 0, 'the wait\'s timer cleared when the one before ended');
});
