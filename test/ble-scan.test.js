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

function appWith(ble, sg3) {
  const app = Object.create(SGSmartApp.prototype);
  app.homey = { ble };
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
