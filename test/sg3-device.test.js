'use strict';

// "On" to an SG Smart 3.0 dimmer, as to the first generation
// (lib/SGDeviceBase.js): to a dimmer known to be on, nothing is sent; to one
// known to be off, it waits up to 0.8 s for a level, so "on" and then a
// level from Siri (0.28 to 0.38 s apart) is the level alone. The dimmer
// turned off and on again on an "on" (level 101) while on. What is known
// goes stale at start and when the link goes (the wall switch may change it
// unheard); "on" then asks the dimmer first. A stand-in controller records
// what is sent; the timers run when the test says so. Made-up home key.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const fake = require('./helpers/fake-homey');

fake.install();

const SG3Device = require('../lib/SG3Device');

const HOME_KEY = '0a1b2c3d4e5f';
const ON_WAIT_MS = 800;

// A 3.0 dimmer with Homey's kept onoff (or none), its controller, what it
// was sent, and what it answers to a status request (answer: a status, or
// null for none).
async function dimmer({ on, answer = { on: false, level: 0 } } = {}) {
  const sent = [];
  const asked = [];
  const controller = Object.assign(new EventEmitter(), {
    start() {},
    setLevel: async (node, level) => { sent.push(level); return controller.result || {}; },
    getStatus: async (node) => {
      asked.push(node);
      if (!controller.answer) throw new Error('made-up: no answer within 3000 ms');
      return controller.answer;
    },
    answer,
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
  // The 0.8 s run out, and what the timer then awaits.
  const waitOver = async () => {
    homey.runMs(ON_WAIT_MS);
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return { device, controller, sent, asked, homey, waiting, waitOver };
}

// Known: a status came, so what is known is fresh.
async function known(on) {
  const d = await dimmer();
  d.device.applyStatus({ on, level: 30 });
  return d;
}

test('Siri on a dimmer known to be on: "on" sends nothing, and the level after it is sent alone', async () => {
  const { device, sent, asked, waiting } = await known(true);
  await device.listener({ onoff: true });
  assert.deepEqual(sent, []);
  assert.deepEqual(asked, []);
  assert.equal(waiting(), false);
  assert.ok(device.logs.includes('"on" while on: nothing sent'));
  await device.listener({ dim: 0.2 });
  assert.deepEqual(sent, [20]);
});

test('"on" to a dimmer known to be off waits up to 0.8 s: a level within it is sent alone, no 101', async () => {
  const { device, sent, asked, waiting, waitOver } = await known(false);
  await device.listener({ onoff: true });
  assert.deepEqual(sent, []);
  assert.deepEqual(asked, [], 'known: not asked');
  assert.equal(waiting(), true);
  await device.listener({ dim: 0.3 });
  assert.deepEqual(sent, [30]);
  assert.equal(waiting(), false);
  await waitOver();
  assert.deepEqual(sent, [30]);
});

test('"on" to a dimmer known to be off, with no level after it: 101 after 0.8 s', async () => {
  const { device, sent, waitOver } = await known(false);
  await device.listener({ onoff: true });
  await waitOver();
  assert.deepEqual(sent, [101]);
  await device.listener({ onoff: true });
  assert.deepEqual(sent, [101], 'now it is on: a second "on" sends nothing');
});

test('off while "on" waits: only off is sent', async () => {
  const { device, sent, waitOver } = await known(false);
  await device.listener({ onoff: true });
  await device.listener({ onoff: false });
  await waitOver();
  assert.deepEqual(sent, [0]);
});

test('the slider on a dark dimmer (on and a level together) is one level at once', async () => {
  const { device, sent, waiting } = await known(false);
  await device.listener({ onoff: true, dim: 0.5 });
  assert.deepEqual(sent, [50]);
  assert.equal(waiting(), false);
});

test('stale at start, even with onoff kept on: "on" asks the dimmer at once, and its answer decides after 0.8 s', async () => {
  for (const [answer, expected, line] of [
    [{ on: true, level: 40 }, [], 'status before "on": on, nothing sent'],
    [{ on: false, level: 40 }, [101], 'status before "on": off'],
    [null, [101], 'status before "on": no answer'],
  ]) {
    const { device, sent, asked, waitOver } = await dimmer({ on: true, answer });
    await device.listener({ onoff: true });
    assert.deepEqual(asked, [0x0003], 'asked at once');
    assert.deepEqual(sent, []);
    await waitOver();
    assert.deepEqual(sent, expected, JSON.stringify(answer));
    assert.ok(device.logs.includes(line), device.logs.join('\n'));
  }
});

test('stale: a level within the 0.8 s is sent alone, and the answer that comes later sends nothing', async () => {
  const { device, sent, waitOver } = await dimmer({ on: true, answer: { on: false, level: 10 } });
  await device.listener({ onoff: true });
  await device.listener({ dim: 0.25 });
  await waitOver();
  assert.deepEqual(sent, [25]);
});

test('when the link goes, what is known goes stale: "on" asks again', async () => {
  const { device, controller, asked, sent, waitOver } = await known(true);
  await device.listener({ onoff: true });
  assert.deepEqual(asked, []);
  controller.emit('connection', false);
  controller.answer = { on: false, level: 30 };
  await device.listener({ onoff: true });
  assert.deepEqual(asked, [0x0003]);
  await waitOver();
  assert.deepEqual(sent, [101], 'switched off at the wall meanwhile: "on" is sent');
});

test('a command a newer one took the place of gives no warning; one that does not get out does', async () => {
  const { device, controller } = await known(true);
  controller.result = { superseded: true };
  await device.listener({ dim: 0.4 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(device.warning, null);
  controller.setLevel = async () => { throw new Error('made-up: no link within 30 s'); };
  await device.listener({ dim: 0.5 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(device.warning, 'device.sg3NotSent');
});

test('a pending "on" is dropped when the device is deleted or stops', async () => {
  for (const end of ['onDeleted', 'onUninit']) {
    const { device, sent, waiting, waitOver } = await known(false);
    await device.listener({ onoff: true });
    await device[end]();
    assert.equal(waiting(), false, end);
    await waitOver();
    assert.deepEqual(sent, [], end);
  }
});
