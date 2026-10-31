'use strict';

// A dimmer just paired gets its first status at once: on a held link the app
// sends FFFF once, otherwise it starts a status poll soon. The choice is made
// after applyMode, which may just have started holding the link. Run with:
// node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const fake = require('./helpers/fake-homey');

fake.install();

const SGSmartApp = require('../app');
const SGMeshDevice = require('../lib/SGDeviceBase');

// The app with a bridge whose applyMode holds the link or not; the calls are
// recorded in order.
function appWith({ heldAfterApplyMode }) {
  const app = new SGSmartApp();
  app.homey = fake.fakeHomey(app);
  const calls = [];
  app.bridge = {
    _held: false,
    applyMode() { calls.push('applyMode'); this._held = heldAfterApplyMode; },
    pollSoon() { calls.push('pollSoon'); },
  };
  app.csr = { requestAllStatus: async () => { calls.push('FFFF'); return true; } };
  app.dimmerCount = () => 2;
  return { app, calls };
}

test('added while the link is held, or just held by applyMode: FFFF once, also for two added together', () => {
  const { app, calls } = appWith({ heldAfterApplyMode: true });
  app.dimmerAdded();
  app.dimmerAdded();
  assert.deepEqual([...app.homey.pending.values()].map((timer) => timer.ms), [2000]);
  app.homey.runAll();
  assert.deepEqual(calls, ['applyMode', 'FFFF']);
});

test('added while the link is not held: a status poll soon, also when the location id is known; no FFFF', () => {
  const { app, calls } = appWith({ heldAfterApplyMode: false });
  app.dimmerAdded();
  app.homey.runAll();
  assert.deepEqual(calls, ['applyMode', 'pollSoon']);
});

test('a start or a deletion asks for nothing: only applyMode, as before', () => {
  const { app, calls } = appWith({ heldAfterApplyMode: true });
  app.dimmersChanged();
  app.homey.runAll();
  assert.deepEqual(calls, ['applyMode']);
});

test('a dimmer just paired tells the app (onAdded); one initialised at start does not', async () => {
  let added = 0;
  let changed = 0;
  const app = { dimmerAdded: () => { added += 1; }, dimmersChanged: () => { changed += 1; } };
  const dimmer = new SGMeshDevice({ homey: fake.fakeHomey(app), store: { localName: '@ND1A2B' } });
  await dimmer.onAdded();
  assert.equal(added, 1);
  assert.equal(changed, 0);
});
