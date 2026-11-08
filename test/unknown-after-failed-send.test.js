'use strict';

// After a send that did not get out (the phone held the dimmer, or the
// radio failed), the dimmer's state is unknown: the next "on" is sent, or the
// dimmer is asked first, not skipped as "already on". The first generation
// (lib/SGDeviceBase.js) and SG Smart 3.0 (lib/SG3Device.js). A stand-in
// bridge and controller; made-up passphrase and home key.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const fake = require('./helpers/fake-homey');

fake.install();

const SGMeshDevice = require('../lib/SGDeviceBase');
const SG3Device = require('../lib/SG3Device');

const tick = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

// A first generation dimmer, off by its status, with a bridge that delivers
// only while deliver.ok.
async function gen1() {
  const sent = [];
  const deliver = { ok: false };
  const app = {
    log() {}, error() {}, nextSeq: (() => { let seq = 0x100; return () => { seq += 1; return seq; }; })(),
    bridge: { send: async (packet, meta) => { sent.push(meta.level); return deliver.ok ? { ok: true } : { failed: true }; } },
    dimmersChanged() {}, requestStatus() {}, locationFor: () => null, bridgeMeshId: () => null, statusUnreadableText: () => null,
  };
  const homey = fake.fakeHomey(app);
  const device = new SGMeshDevice({
    homey, store: { localName: '@ND1A2B', locationId: 0x5a3c }, settings: { passphrase: 'test-only-pass' },
    data: { id: '@ND1A2B' }, name: 'dimmer',
  });
  await device.onInit();
  device.applyMeshStatus('1a2b', 0, 0x5a3c);
  return { device, homey, sent, deliver };
}

test('first generation: a level that did not get out leaves the state unknown, and the next "on" is sent', async () => {
  const { device, homey, sent, deliver } = await gen1();
  device._onCapabilities({ onoff: true, dim: 0.6 });
  await tick();
  assert.deepEqual(sent, [60], 'sent once, not delivered');
  assert.equal(device._lastAppliedLevel, null);
  assert.ok(device.logs.includes("level 60 not delivered: the dimmer's state is unknown until a status"), device.logs.join('\n'));
  assert.equal(device.getCapabilityValue('onoff'), true, 'the tile keeps what was asked');
  // The phone lets go; Siri says "on".
  deliver.ok = true;
  device._onCapabilities({ onoff: true });
  homey.runAll();
  await tick();
  assert.deepEqual(sent, [60, 60], '"on" goes out');
  assert.ok(!device.logs.some((line) => /skipped: "on" while already on/.test(line)), device.logs.join('\n'));
  // Delivered: known again, and the next "on" is skipped as before.
  assert.equal(device._lastAppliedLevel, 60);
  device._onCapabilities({ onoff: true });
  homey.runAll();
  await tick();
  assert.deepEqual(sent, [60, 60]);
  assert.ok(device.logs.some((line) => /level=60 skipped: "on" while already on/.test(line)));
});

test('first generation: a newer level that came while the failed one was out keeps its state', async () => {
  const { device, sent, deliver } = await gen1();
  let release;
  const app = device.homey.app;
  const send = app.bridge.send;
  app.bridge.send = async (packet, meta) => {
    if (meta.level === 60) {
      sent.push(60);
      await new Promise((resolve) => { release = resolve; });
      return { failed: true };
    }
    return send(packet, meta);
  };
  deliver.ok = true;
  device._onCapabilities({ onoff: true, dim: 0.6 });
  await tick();
  device._onCapabilities({ onoff: true, dim: 0.3 });
  release();
  await tick();
  assert.deepEqual(sent, [60, 30]);
  assert.equal(device._lastAppliedLevel, 30, 'the newer one is known');
});

// A 3.0 dimmer with a stand-in controller whose setLevel fails while fail.on.
async function sg3() {
  const sent = [];
  const asked = [];
  const fail = { on: true };
  const controller = Object.assign(new EventEmitter(), {
    start() {},
    setLevel: async (node, level) => {
      sent.push(level);
      if (fail.on) throw new Error('made-up: no link within 30 s');
      return {};
    },
    getStatus: async (node) => { asked.push(node); return { on: false, level: 40 }; },
    proxyNode: null,
  });
  const homey = fake.fakeHomey({ sg3: () => controller, sg3HomeKey: () => '0a1b2c3d4e5f' });
  const device = new SG3Device({ homey, data: { id: 'sig:0a1b2c3d4e5f:0003' }, store: { sg3Type: 3080 } });
  device.registerMultipleCapabilityListener = (capabilities, listener) => { device.listener = listener; };
  await device.onInit();
  device.applyStatus({ on: false, level: 40 });
  return { device, homey, sent, asked, fail };
}

test('SG Smart 3.0: a command that did not get out leaves the state unknown, and the next "on" asks the dimmer first', async () => {
  const { device, homey, sent, asked, fail } = await sg3();
  await device.listener({ dim: 0.4 });
  await tick();
  assert.deepEqual(sent, [40]);
  assert.equal(device.warning, 'device.sg3NotSent');
  fail.on = false;
  await device.listener({ onoff: true });
  assert.deepEqual(asked, [0x0003], 'asked first');
  assert.ok(!device.logs.includes('"on" while on: nothing sent'), device.logs.join('\n'));
  homey.runMs(800);
  await tick();
  assert.deepEqual(sent, [40, 101], 'off by its answer: "on" is sent');
  assert.ok(device.logs.includes('status before "on": off'), device.logs.join('\n'));
});
