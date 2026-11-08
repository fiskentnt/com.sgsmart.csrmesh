'use strict';

// "On" and a level close together, as Siri and Matter send them (about
// 0.3 s apart), to a LEDDim Smart Pill or a later rotary dimmer
// (lib/SGCsrDevice.js): the same wait as the first generation. "On" alone
// to a dimmer not known to be on waits up to 0.8 s for a level, and a level
// within it is sent alone; to one known to be on, nothing is sent; after a
// command that did not get out, the state is unknown again. A device without
// dimming (the plug) is not held. A stand-in network; made-up passphrase.

const test = require('node:test');
const assert = require('node:assert/strict');

const fake = require('./helpers/fake-homey');

fake.install();

const SGCsrDevice = require('../lib/SGCsrDevice');

const ON_WAIT_MS = 800;
const tick = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

// A Pill (dimmable) or a device without dimming, with a bridge that
// records the level of each command and delivers while deliver.ok.
async function device({ dimmable = true } = {}) {
  const sent = [];
  const deliver = { ok: true };
  let seq = 0x100;
  const app = {
    log() {}, error() {}, nextSeq: () => { seq += 1; return seq; }, _devices: () => [], statusUnreadableText: () => null, sharedLocation: () => null,
    bridge: { send: async (packet, meta) => { sent.push(meta.level); return deliver.ok ? { ok: true } : { failed: true }; } },
    csr: { requestNames: async () => true, requestStatus: async () => true, isThermostat: () => false },
  };
  const homey = fake.fakeHomey(app);
  const csr = new SGCsrDevice({
    homey, store: { meshId: 0x0123, prefix: '@SC', kind: dimmable ? 'dimmable' : 'onoff', locationId: 0x5a3c },
    settings: { passphrase: 'test-only-pass' }, data: { id: '@SC1A2B' }, name: 'csr',
  });
  csr.hasCapability = (capability) => (dimmable ? ['onoff', 'dim'] : ['onoff']).includes(capability);
  csr.registerMultipleCapabilityListener = (capabilities, listener) => { csr.listener = listener; };
  await csr.onInit();
  const waiting = () => [...homey.pending.values()].some((timer) => timer.ms === ON_WAIT_MS);
  const waitOver = async () => {
    homey.runMs(ON_WAIT_MS);
    await tick();
  };
  return { csr, sent, deliver, waiting, waitOver };
}

test('"on" and then a level within 0.8 s: the level alone, no "on" first', async () => {
  const { csr, sent, waiting, waitOver } = await device();
  await csr.listener({ onoff: true });
  assert.deepEqual(sent, [], 'waits');
  assert.equal(waiting(), true);
  await csr.listener({ dim: 0.5 });
  await tick();
  assert.deepEqual(sent, [50]);
  assert.equal(waiting(), false);
  await waitOver();
  assert.deepEqual(sent, [50]);
});

test('"on" alone, not known to be on: "on" after 0.8 s; a level and then "on": the level alone', async () => {
  const first = await device();
  await first.csr.listener({ onoff: true });
  await first.waitOver();
  assert.deepEqual(first.sent, ['on']);

  const second = await device();
  await second.csr.listener({ dim: 0.5 });
  await tick();
  await second.csr.listener({ onoff: true });
  await second.waitOver();
  assert.deepEqual(second.sent, [50], 'known to be on: nothing more');
  assert.ok(second.csr.logs.includes('"on" while on: nothing sent'), second.csr.logs.join('\n'));
});

test('known from its status: "on" to one that is on sends nothing, to one that is off waits; off is never held', async () => {
  const { csr, sent, waitOver } = await device();
  csr.applyCsrStatus({ on: true, level: 40, location: 0x5a3c, number: null }, 'FF50');
  await csr.listener({ onoff: true });
  await waitOver();
  assert.deepEqual(sent, []);
  await csr.listener({ onoff: false });
  await tick();
  assert.deepEqual(sent, [0], 'off at once');
  csr._quietUntil = 0;
  csr.applyCsrStatus({ on: false, level: 40, location: 0x5a3c, number: null }, 'FF50');
  await csr.listener({ onoff: true });
  assert.deepEqual(sent, [0]);
  await waitOver();
  assert.deepEqual(sent, [0, 'on']);
});

test('after a command that did not get out, the state is unknown: the next "on" is sent', async () => {
  const { csr, sent, deliver, waitOver } = await device();
  deliver.ok = false;
  await csr.listener({ dim: 0.6 });
  await tick();
  assert.deepEqual(sent, [60]);
  assert.equal(csr._knownOn, null);
  deliver.ok = true;
  await csr.listener({ onoff: true });
  await waitOver();
  assert.deepEqual(sent, [60, 'on']);
});

test('a device without dimming: "on" goes at once, as before; a pending "on" is dropped when the device stops', async () => {
  const plug = await device({ dimmable: false });
  await plug.csr.listener({ onoff: true });
  await tick();
  assert.deepEqual(plug.sent, [100]);
  assert.equal(plug.waiting(), false);

  const pill = await device();
  await pill.csr.listener({ onoff: true });
  await pill.csr.onDeleted();
  assert.equal(pill.waiting(), false);
  await pill.waitOver();
  assert.deepEqual(pill.sent, []);
});
