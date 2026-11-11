'use strict';

// "No contact" for the devices after the first generation (SGCsrDevice and
// SGThermostatDevice): a device that nothing has been heard from for
// LATER_NOT_HEARD_MS gets a warning, and the next frame from its mesh id
// clears it. They are asked for their status every 10 min (a thermostat
// every 5), so the limit is the same with a held link and without one.
// Whether they send their status by themselves is not known.
// Made-up values: the location id 0x4c2e and the mesh ids below.
// Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const fake = require('./helpers/fake-homey');

fake.install();

const SGSmartApp = require('../app');
const SGCsrDevice = require('../lib/SGCsrDevice');
const SGPlugDevice = require('../drivers/sg_plug/device');
const SGThermostatDevice = require('../lib/SGThermostatDevice');
const { ADDR_APP } = require('../lib/sgProtocol');

const HOME = 0x4c2e;
const PILL_ID = 0x9a31;
const PLUG_ID = 0xb7e2;
const THERMOSTAT_ID = 0xc05d;
const MIN = 60 * 1000;
const tick = () => new Promise((resolve) => setImmediate(resolve));

// The real app with these devices added, no bridge and no account.
function realApp(devices, { held = false } = {}) {
  const app = new SGSmartApp();
  app.homey = fake.fakeHomey(app, { drivers: { getDrivers: () => ({ any: { getDevices: () => devices } }) } });
  app._locations = new Map();
  app._statusUnreadable = false;
  app.bridge = { _held: held, send: async () => ({ ok: true }) };
  app.account = { heard() {}, available: () => false, fetched: () => false };
  app.handled = [];
  app.csr = {
    handleFrame: (frame) => app.handled.push(frame.src),
    requestStatus: async () => true,
    requestNames: async () => true,
    isThermostat: () => false,
    watchThermostat() {},
    unwatchThermostat() {},
  };
  app._startNotHeardCheck();
  return app;
}

async function start(app, Class, {
  meshId, prefix, kind, dim, locationId = HOME,
}) {
  const device = new Class({
    homey: fake.fakeHomey(app),
    store: {
      meshId, prefix, kind, locationId,
    },
    settings: { passphrase: '1234' },
    data: { id: `${prefix}0000` },
    name: prefix,
  });
  device.hasCapability = (capability) => (dim ? ['onoff', 'dim'] : ['onoff']).includes(capability);
  await device.onInit();
  return device;
}

async function homeOf(options) {
  const devices = [];
  const app = realApp(devices, options);
  devices.push(
    await start(app, SGCsrDevice, {
      meshId: PILL_ID, prefix: '@SC', kind: 'dimmable', dim: true,
    }),
    await start(app, SGPlugDevice, {
      meshId: PLUG_ID, prefix: '@GP', kind: 'onoff', dim: false,
    }),
    await start(app, SGThermostatDevice, {
      meshId: THERMOSTAT_ID, prefix: '@ST', kind: 'thermostat', dim: false,
    }),
  );
  return { app, devices };
}

// Runs the app's check at these minutes after t0.
async function checkAt(app, clock, ...minutes) {
  for (const m of minutes) {
    clock.now = clock.t0 + m * MIN;
    app._checkNotHeard();
    await tick();
  }
}

function withClock(run) {
  const realNow = Date.now;
  const clock = { t0: 7000000000, now: 7000000000 };
  Date.now = () => clock.now;
  return run(clock).finally(() => {
    Date.now = realNow;
  });
}

test('a later device that nothing is heard from for 30 min gets "no contact": the dimmer its text, one without dimming and a thermostat theirs', () => withClock(async (clock) => {
  const { app, devices: [pill, plug, thermostat] } = await homeOf();
  await checkAt(app, clock, 0, 29);
  assert.deepEqual([pill.warning, plug.warning, thermostat.warning], [null, null, null], 'not before 30 min');
  await checkAt(app, clock, 31);
  assert.equal(pill.warning, 'device.notHeard');
  assert.equal(plug.warning, 'device.notHeardDevice');
  assert.equal(thermostat.warning, 'thermostat.notHeard');
  assert.equal(pill.available, true, 'still available, so a tap still goes out');
  assert.ok(pill.logs.some((line) => /no frame from it for 31 min \(limit 30 min\)/.test(line)));
}));

test('a frame from its mesh id clears it; one from another device or from this app\'s own address does not', () => withClock(async (clock) => {
  const { app, devices: [pill, plug] } = await homeOf();
  await checkAt(app, clock, 0, 31);
  clock.now = clock.t0 + 32 * MIN;
  app._onCsrFrame({ src: ADDR_APP, plain: Buffer.alloc(4) });
  app._onCsrFrame({ src: PLUG_ID, plain: Buffer.alloc(4) });
  await tick();
  assert.equal(pill.warning, 'device.notHeard', 'not by our own frame, nor by another device\'s');
  assert.equal(plug.warning, null);
  app._onCsrFrame({ src: PILL_ID, plain: Buffer.alloc(4) });
  await tick();
  assert.equal(pill.warning, null);
  assert.ok(pill.logs.some((line) => /heard again after 32 min/.test(line)));
  assert.deepEqual(app.handled, [ADDR_APP, PLUG_ID, PILL_ID], 'every frame still goes to the CSRmesh network');
  // Heard at 32 min: no warning again before 62.
  await checkAt(app, clock, 61);
  assert.equal(pill.warning, null);
  await checkAt(app, clock, 63);
  assert.equal(pill.warning, 'device.notHeard');
}));

test('with a held link (first generation dimmers in the home), a later device still has 30 min, as it is asked every 10', () => withClock(async (clock) => {
  const { app, devices: [pill] } = await homeOf({ held: true });
  await checkAt(app, clock, 0, 6, 29);
  assert.equal(pill.warning, null);
  await checkAt(app, clock, 31);
  assert.equal(pill.warning, 'device.notHeard');
}));

test('a later device that waits for its location id keeps "waiting for the first status", and one without dimming says device', () => withClock(async (clock) => {
  const devices = [];
  const app = realApp(devices);
  const pill = await start(app, SGCsrDevice, {
    meshId: PILL_ID, prefix: '@SC', kind: 'dimmable', dim: true, locationId: null,
  });
  const plug = await start(app, SGPlugDevice, {
    meshId: PLUG_ID, prefix: '@GP', kind: 'onoff', dim: false, locationId: null,
  });
  devices.push(pill, plug);
  await checkAt(app, clock, 0, 31);
  assert.equal(pill.warning, 'device.waitingForStatus');
  assert.equal(plug.warning, 'device.waitingForStatusDevice');
}));

test('while no status can be read at all, the password warning stays on the later devices, not "no contact"', () => withClock(async (clock) => {
  const { app, devices: [pill, plug, thermostat] } = await homeOf();
  await checkAt(app, clock, 0);
  app.statusUnreadable();
  await tick();
  await checkAt(app, clock, 31);
  assert.deepEqual([pill.warning, plug.warning, thermostat.warning], ['device.passwordWrong', 'device.passwordWrong', 'device.passwordWrong']);
}));
