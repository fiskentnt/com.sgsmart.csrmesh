'use strict';

// "On" to an SG Smart 3.0 dimmer, as to the first generation
// (lib/SGDeviceBase.js): to a dimmer that is on, nothing is sent; to one that
// is off, it waits up to 0.8 s for a level, so "on" and then a level from
// Siri (0.28 to 0.38 s apart) is the level alone. The dimmer turned off and
// on again on an "on" (level 101) while on. A stand-in controller records
// what is sent; the timers run when the test says so. Made-up home key.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const fake = require('./helpers/fake-homey');

fake.install();

const SG3Device = require('../lib/SG3Device');

const HOME_KEY = '0a1b2c3d4e5f';
const ON_WAIT_MS = 800;

// A 3.0 dimmer with Homey's kept onoff (or none), its controller and what it
// was sent.
async function dimmer({ on } = {}) {
  const sent = [];
  const controller = Object.assign(new EventEmitter(), {
    start() {},
    setLevel: async (node, level) => { sent.push(level); return {}; },
  });
  const app = { sg3: () => controller, sg3HomeKey: () => HOME_KEY };
  const homey = fake.fakeHomey(app);
  const device = new SG3Device({ homey, data: { id: `sig:${HOME_KEY}:0003` }, store: { sg3Type: 3080 } });
  if (on !== undefined) device._capabilities.onoff = on;
  device.registerMultipleCapabilityListener = (capabilities, listener, debounceMs) => {
    device.listener = listener;
    device.debounceMs = debounceMs;
  };
  await device.onInit();
  const waiting = () => [...homey.pending.values()].some((timer) => timer.ms === ON_WAIT_MS);
  return { device, controller, sent, homey, waiting };
}

test('Siri on a dimmer that is on: "on" sends nothing, and the level after it is sent alone', async () => {
  const { device, sent, waiting } = await dimmer({ on: true });
  await device.listener({ onoff: true });
  assert.deepEqual(sent, []);
  assert.equal(waiting(), false);
  assert.ok(device.logs.includes('"on" while on: nothing sent'));
  await device.listener({ dim: 0.2 });
  assert.deepEqual(sent, [20]);
});

test('"on" to a dimmer that is off waits up to 0.8 s: a level within it is sent alone, no 101', async () => {
  const { device, sent, homey, waiting } = await dimmer({ on: false });
  await device.listener({ onoff: true });
  assert.deepEqual(sent, []);
  assert.equal(waiting(), true);
  await device.listener({ dim: 0.3 });
  assert.deepEqual(sent, [30]);
  assert.equal(waiting(), false);
  homey.runMs(ON_WAIT_MS);
  assert.deepEqual(sent, [30]);
});

test('"on" to a dimmer that is off, with no level after it: 101 after 0.8 s', async () => {
  const { device, sent, homey } = await dimmer({ on: false });
  await device.listener({ onoff: true });
  homey.runMs(ON_WAIT_MS);
  assert.deepEqual(sent, [101]);
  await device.listener({ onoff: true });
  assert.deepEqual(sent, [101], 'now it is on: a second "on" sends nothing');
});

test('off while "on" waits: only off is sent', async () => {
  const { device, sent, homey } = await dimmer({ on: false });
  await device.listener({ onoff: true });
  await device.listener({ onoff: false });
  homey.runMs(ON_WAIT_MS);
  assert.deepEqual(sent, [0]);
});

test('the slider on a dark dimmer (on and a level together) is one level at once', async () => {
  const { device, sent, waiting } = await dimmer({ on: false });
  await device.listener({ onoff: true, dim: 0.5 });
  assert.deepEqual(sent, [50]);
  assert.equal(waiting(), false);
});

test('whether it is on follows the status and the commands; not known counts as off', async () => {
  const { device, sent, homey, waiting } = await dimmer();
  await device.listener({ onoff: true });
  assert.equal(waiting(), true, 'not known: waits as for off');
  await device.listener({ onoff: false });
  assert.deepEqual(sent, [0]);
  device.applyStatus({ on: true, level: 40 });
  await device.listener({ onoff: true });
  assert.equal(waiting(), false, 'on by its status: nothing');
  device.applyStatus({ on: false, level: 40 });
  await device.listener({ onoff: true });
  assert.equal(waiting(), true, 'off by its status: waits');
  await device.listener({ dim: 0.5 });
  await device.listener({ onoff: true });
  assert.equal(waiting(), false, 'on after a level was sent: nothing');
  homey.runMs(ON_WAIT_MS);
  assert.deepEqual(sent, [0, 50]);
});

test('a pending "on" is dropped when the device is deleted or stops', async () => {
  for (const end of ['onDeleted', 'onUninit']) {
    const { device, sent, homey, waiting } = await dimmer({ on: false });
    await device.listener({ onoff: true });
    await device[end]();
    assert.equal(waiting(), false, end);
    homey.runMs(ON_WAIT_MS);
    assert.deepEqual(sent, [], end);
  }
});
