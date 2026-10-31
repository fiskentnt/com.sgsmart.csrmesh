'use strict';

// "Keep dimmers connected" (MeshBridge._keepConnected): the link is held
// through a first generation dimmer, so without one the setting does nothing,
// whatever the choice. Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const fake = require('./helpers/fake-homey');

fake.install();

const MeshBridge = require('../lib/MeshBridge');

// A bridge in an app with this many first generation dimmers and this choice
// (true, false, or null for none made).
function bridgeWith(gen1, choice) {
  const app = {
    homey: fake.fakeHomey(null), log() {}, error() {}, _devices: () => [], dimmerCount: () => gen1,
  };
  app.homey.app = app;
  if (choice !== null) app.homey.settings.set('keepConnected', choice);
  return new MeshBridge(app);
}

test('no first generation dimmer: never held, whatever the choice', () => {
  for (const choice of [true, false, null]) assert.equal(bridgeWith(0, choice)._keepConnected(), false, String(choice));
});

test('with first generation dimmers: the choice, or on by default from two', () => {
  assert.equal(bridgeWith(1, true)._keepConnected(), true);
  assert.equal(bridgeWith(1, null)._keepConnected(), false);
  assert.equal(bridgeWith(2, null)._keepConnected(), true);
  assert.equal(bridgeWith(3, false)._keepConnected(), false);
});

test('switched on in a home without a first generation dimmer: no held link, status is polled as before', () => {
  const bridge = bridgeWith(0, true);
  bridge.applyMode();
  assert.equal(bridge._held, false);
  assert.deepEqual([...bridge.homey.pending.values()].map((t) => t.ms), [500]);
});
