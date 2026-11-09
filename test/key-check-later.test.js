'use strict';

// The check of the network key (lib/MeshBridge.js) and the password warning
// (app.js) in a home without first generation dimmers: a frame that passes
// the check from another sender than this app shows that the key is right,
// whichever device sent it, so it ends the check and clears the warning.
// This app's own frames coming back (from 0x8000) do not: they pass with
// whatever key the app uses. Made-up values: the keys, the location id
// 0x4c2e and the mesh ids. Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const fake = require('./helpers/fake-homey');

fake.install();

const { deriveNetworkKey } = require('../lib/csrmesh');
const MeshBridge = require('../lib/MeshBridge');
const SGSmartApp = require('../app');
const { meshFrame } = require('./helpers/mesh-frame');

const KEY = deriveNetworkKey('test-only-pass');
const WRONG_KEY = deriveNetworkKey('another-pass');
const HOME = 0x4c2e;
const PILL_ID = 0x9a31;
const OWN = 0x8000;
// FF05 from a device to this app, and this app's FF10 to everyone.
const statusFF05 = Buffer.from([0x00, 0x80, 0xff, 0x05, HOME >> 8, HOME & 0xff, 1, 40, 7]);
const nameRequest = Buffer.from([0x00, 0x00, 0xff, 0x10, HOME >> 8, HOME & 0xff]);

function keyCheckBridge(key) {
  const app = {
    unreadable: 0,
    lines: [],
    log(...args) { app.lines.push(args.join(' ')); },
    error() {},
    getNetworkKey: () => key,
    statusUnreadable() { app.unreadable += 1; },
  };
  app.homey = fake.fakeHomey(app);
  const bridge = new MeshBridge(app);
  bridge._onStatus = () => {};
  bridge.frames = [];
  bridge._onFrame = (frame) => bridge.frames.push(frame.src);
  return { app, bridge };
}

test('a home without the first generation: frames that fail, then an FF05 under the right key from a later device: the check ends, no warning', () => {
  const { app, bridge } = keyCheckBridge(KEY);
  bridge._startKeyCheck();
  bridge._rxDecodeFrame(meshFrame(WRONG_KEY, 1, PILL_ID, statusFF05));
  bridge._rxDecodeFrame(meshFrame(WRONG_KEY, 2, PILL_ID, statusFF05));
  bridge._startKeyCheck(); // the next link
  bridge._rxDecodeFrame(meshFrame(WRONG_KEY, 3, PILL_ID, statusFF05));
  bridge._rxDecodeFrame(meshFrame(KEY, 4, PILL_ID, statusFF05));
  assert.equal(bridge._keyCheckDone, true);
  app.homey.runAll();
  assert.equal(app.unreadable, 0);
  assert.deepEqual(bridge.frames, [PILL_ID], 'the frame still goes on to the CSRmesh network');
  bridge._startKeyCheck(); // decided: no further checks
  assert.equal(app.homey.pending.size, 0);
});

test('this app\'s own frame coming back, from 0x8000, does not end the check', () => {
  const { app, bridge } = keyCheckBridge(KEY);
  bridge._startKeyCheck();
  bridge._rxDecodeFrame(meshFrame(KEY, 1, OWN, nameRequest));
  assert.equal(bridge._keyCheckDone, false);
  bridge._rxDecodeFrame(meshFrame(WRONG_KEY, 2, PILL_ID, statusFF05));
  bridge._startKeyCheck();
  bridge._rxDecodeFrame(meshFrame(WRONG_KEY, 3, PILL_ID, statusFF05));
  bridge._rxDecodeFrame(meshFrame(WRONG_KEY, 4, PILL_ID, statusFF05));
  app.homey.runAll();
  assert.equal(app.unreadable, 1, 'only our own frame passed: the password is still probably wrong');
});

test('a frame from a later device under the right key clears the password warning; one from 0x8000 does not', () => {
  const app = new SGSmartApp();
  const logs = [];
  app.log = (...args) => logs.push(args.join(' '));
  app.homey = fake.fakeHomey(app, { drivers: { getDrivers: () => ({}) } });
  app._statusUnreadable = false;
  app.account = { heard() {}, available: () => false, fetched: () => false };
  app.csr = { handleFrame() {} };
  app._startNotHeardCheck();
  app.statusUnreadable();
  assert.equal(app.statusUnreadableText(), 'device.passwordWrong');
  app._onCsrFrame({ src: OWN, plain: nameRequest });
  assert.equal(app._statusUnreadable, true, 'our own frame proves nothing');
  app._onCsrFrame({ src: PILL_ID, plain: statusFF05 });
  assert.equal(app._statusUnreadable, false);
  assert.equal(app.statusUnreadableText(), null);
  assert.ok(logs.includes('status can be read again'));
});
