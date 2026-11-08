'use strict';

// HeatReg Smart (sg_thermostat): what it adds, how it reads a thermostat, and
// how it sets one, only with "Control from Homey" on. The formats are
// assumed: no thermostat has been tried with Homey yet. 0x5a3c and 0x0201 are
// a made-up location id and mesh id. Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fake = require('./helpers/fake-homey');

fake.install();

const { decryptPayload, deriveNetworkKey } = require('../lib/csrmesh');
const proto = require('../lib/sgProtocol');
const { CSR_PRODUCTS, THERMOSTAT_PREFIXES, csrDriverFor, csrProductForName } = require('../lib/sgProducts');
const { foundNote, laterFindings, withStates } = require('../lib/csrPairing');
const { CsrNetwork, THERMOSTAT_LISTEN_MS } = require('../lib/CsrNetwork');
const SGThermostatDevice = require('../lib/SGThermostatDevice');
const SGThermostatDriver = require('../drivers/sg_thermostat/driver');

const { faultsOf, setPointFor } = SGThermostatDevice;
const ROOT = path.join(__dirname, '..');
const KEY = deriveNetworkKey('test-only-pass');
const LOC = 0x5a3c;
const MESH_ID = 0x0201;
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const plainOf = (packet) => decryptPayload(KEY, packet.subarray(0, 3), packet.subarray(3, 5), packet.subarray(5, packet.length - 9));
const hexOf = (plain) => plain.toString('hex');

// A clock the device reads (Date.now), moved by the test.
function withClock(fn) {
  const realNow = Date.now;
  const clock = { t: 1_800_000_000_000 };
  Date.now = () => clock.t;
  return Promise.resolve(fn(clock)).finally(() => { Date.now = realNow; });
}

// An FF05 from the thermostat, read: on, set point, heating, window, paused
// and faults as given.
const status = (fields = {}) => ({
  location: LOC, on: true, window: false, heating: false, childLock: false, clockSet: true, setPoint: 21,
  firmware: '1.0', paused: false, schedule: false, errors: 0, ...fields,
});

// ---- the messages

test('FF3E, FF42 and a thermostat\'s FF03: the bytes, to the thermostat\'s own mesh id; what is heard from another is read', () => {
  assert.equal(hexOf(proto.thermostatSetPointData({ meshId: MESH_ID, location: LOC, temperature: 21.5, tid: 3 })), '0102ff3e5a3c15050103');
  assert.equal(hexOf(proto.thermostatSetPointData({ meshId: MESH_ID, location: LOC, temperature: 5, tid: 0x101 })), '0102ff3e5a3c05000101');
  assert.equal(hexOf(proto.thermostatPowerData({ meshId: MESH_ID, location: LOC, on: true, tid: 4 })), '0102ff425a3c010004');
  assert.equal(hexOf(proto.thermostatPowerData({ meshId: MESH_ID, location: LOC, on: false, tid: 5 })), '0102ff425a3c000005');
  assert.deepEqual(['comfort', 'eco', 'min'].map((preset) => hexOf(proto.thermostatPresetData({ meshId: MESH_ID, location: LOC, preset, tid: 6 }))),
    ['0102ff035a3c01000601', '0102ff035a3c00000601', '0102ff035a3c02000601']);
  assert.throws(() => proto.thermostatPresetData({ meshId: MESH_ID, location: LOC, preset: 'away', tid: 1 }), /no such preset/);
  assert.deepEqual(proto.parseThermostatSetPoint(Buffer.from([0x5a, 0x3c, 22, 5, 1, 9])), { location: LOC, setPoint: 22.5, tid: 9 });
  assert.equal(proto.parseThermostatSetPoint(Buffer.from([0x5a, 0x3c, 22, 5, 1])), null);
  assert.deepEqual([1, 0, 2, 7].map((code) => proto.parseThermostatPresetChoice(Buffer.from([0x5a, 0x3c, code, 0, 8, 1])).preset),
    ['comfort', 'eco', 'min', 'eco']);
  assert.equal(proto.parseThermostatPresetChoice(Buffer.from([0x5a, 0x3c, 1, 0])), null);
  assert.deepEqual([setPointFor(21.3), setPointFor(4), setPointFor(36), setPointFor(20.75)], [21.5, 5, 35, 21]);
});

// ---- the driver

test('sg_thermostat adds HeatReg Smart (@MT, @ST) as a thermostat, with what other floor thermostats in Homey have', () => {
  assert.deepEqual(THERMOSTAT_PREFIXES, ['@MT', '@ST']);
  for (const prefix of Object.keys(CSR_PRODUCTS)) {
    assert.equal(csrDriverFor(csrProductForName(`${prefix}1A2B`)) === 'sg_thermostat', THERMOSTAT_PREFIXES.includes(prefix), prefix);
  }
  const compose = JSON.parse(read('drivers/sg_thermostat/driver.compose.json'));
  assert.equal(compose.class, 'thermostat');
  assert.deepEqual(compose.capabilities, ['target_temperature', 'measure_temperature', 'measure_temperature.floor', 'onoff',
    'thermostat_mode', 'sg_heat_preset', 'sg_heating', 'measure_power', 'alarm_problem', 'sg_window_open', 'sg_floor_limit']);
  const options = compose.capabilitiesOptions;
  assert.deepEqual([options.target_temperature.min, options.target_temperature.max, options.target_temperature.step], [5, 35, 0.5]);
  assert.deepEqual(options.thermostat_mode.values.map((v) => v.id), ['heat', 'off']);
  // Hidden in the Homey app, where onoff does the same, but still there for
  // what reads the capabilities, such as a Matter bridge.
  assert.equal(options.thermostat_mode.uiComponent, null);
  assert.ok(compose.capabilities.includes('thermostat_mode'));
  assert.equal(options.measure_power.approximated, true);
  assert.deepEqual(options['measure_temperature.floor'].title, { en: 'Floor temperature', no: 'Gulvtemperatur' });
  assert.deepEqual(compose.pair, JSON.parse(read('drivers/sg_pill/driver.compose.json')).pair, 'the same pairing as sg_pill');
  for (const file of ['icon.svg', 'guide/guide.png', 'images/small.png', 'images/large.png', 'images/xlarge.png']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'drivers', 'sg_thermostat', 'assets', file)), file);
  }
  for (const id of ['sg_heat_preset', 'sg_heating', 'sg_window_open', 'sg_floor_limit']) {
    const capability = JSON.parse(read(`.homeycompose/capabilities/${id}.json`));
    assert.deepEqual(Object.keys(capability.title).sort(), ['en', 'no'], id);
    assert.equal(capability.setable, id === 'sg_heat_preset', id);
  }
});

test('the settings: "Control from Homey (untested)" on, the sensor Floor, no cable power, all by default; the texts as Trond worded them (2026-11-08)', () => {
  const [network, group] = JSON.parse(read('drivers/sg_thermostat/driver.settings.compose.json'));
  assert.deepEqual(network, { $extends: 'network' });
  const byId = Object.fromEntries(group.children.map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(byId), ['control_from_homey', 'sensor', 'heating_cable_power']);
  assert.deepEqual([byId.control_from_homey.type, byId.control_from_homey.value], ['checkbox', true]);
  assert.deepEqual(byId.control_from_homey.label, { en: 'Control from Homey (untested)', no: 'Styr fra Homey (ikke testet)' });
  assert.deepEqual(byId.control_from_homey.hint, {
    en: 'On (default): Homey sends the target temperature, on and off and the preset to the thermostat. Control from Homey has not been tested with a real HeatReg Smart. Turn it off if something does not work. Homey then only reads the thermostat, and changes from Homey are rejected.',
    no: 'På (standard): Homey sender ønsket temperatur, av og på og forhåndsinnstilling til termostaten. Styring fra Homey er ikke testet med en ekte HeatReg Smart. Slå av hvis noe ikke virker. Da leser Homey bare termostaten, og endringer fra Homey avvises.',
  });
  assert.deepEqual([byId.sensor.value, byId.sensor.values.map((v) => v.id)], ['floor', ['floor', 'room', 'roomFloor']]);
  assert.deepEqual(byId.sensor.label, { en: 'Sensor used by the thermostat', no: 'Føler termostaten bruker' });
  assert.deepEqual(byId.sensor.values.map((v) => v.label), [
    { en: 'Floor', no: 'Gulv' }, { en: 'Room', no: 'Rom' }, { en: 'Room with floor limit', no: 'Rom med gulvgrense' }]);
  assert.deepEqual(byId.sensor.hint, {
    en: 'Select the same sensor as in the SG app. The selection determines which faults are shown and whether the floor limit applies. Homey can\'t read the setting and doesn\'t change the thermostat.',
    no: 'Velg samme føler som i SG-appen. Valget avgjør hvilke feil som vises og om gulvgrensen gjelder. Homey kan ikke lese innstillingen og endrer ikke termostaten.',
  });
  assert.deepEqual([byId.heating_cable_power.value, byId.heating_cable_power.min, byId.heating_cable_power.max], [0, 0, 5000]);
  assert.deepEqual(byId.heating_cable_power.label, { en: 'Heating cable power (W)', no: 'Varmekabelens effekt (W)' });
  assert.deepEqual(byId.heating_cable_power.units, { en: 'W', no: 'W' });
  assert.deepEqual(byId.heating_cable_power.hint, {
    en: 'Enter the power from the cable label or installation papers. Homey shows it while the thermostat heats, but does not measure it. At 0, no power is shown.',
    no: 'Skriv effekten fra kabelmerket eller installasjonspapirene. Homey viser den mens termostaten varmer, men måler den ikke. Ved 0 vises ingen effekt.',
  });
});

test('pairing: a thermostat with a mesh id is listed with the driver\'s capabilities; none found says where the others go', async () => {
  const app = { logs: [], errors: [], log() {}, error() {} };
  app.csr = fake.fakeCsr([{ meshId: MESH_ID, name: '@MT1A2B', product: csrProductForName('@MT1A2B'), location: LOC },
    { meshId: 0x0300, name: '@SC3C4D', product: csrProductForName('@SC3C4D'), location: LOC }]);
  const driver = new SGThermostatDriver({ homey: fake.listenAtOnce(fake.fakeHomey(app, { ble: { discover: async () => [] } })) });
  driver.getDevices = () => [];
  const { devices } = await driver._search();
  assert.deepEqual(devices, [{
    name: 'HeatReg Smart 1A2B', data: { id: '@MT1A2B' }, store: { meshId: MESH_ID, prefix: '@MT', kind: 'thermostat', locationId: LOC },
  }]);
  const __ = (key, tokens) => (tokens ? `${key} ${JSON.stringify(tokens)}` : key);
  const found = withStates(laterFindings([], [{ meshId: 0x0300, name: '@SC3C4D', product: csrProductForName('@SC3C4D'), location: LOC }]),
    'sg_thermostat', new Set());
  assert.equal(foundNote(found, __, 'sg_thermostat'), 'pair.found.noThermostat pair.found.goToPill {"products":"LEDDim Smart Pill"}');
});

test('the Flow cards: in the manifest with both languages, and the driver answers the conditions and sends the preset through its listener', async () => {
  const cards = JSON.parse(read('drivers/sg_thermostat/driver.flow.compose.json'));
  assert.deepEqual(Object.fromEntries(Object.entries(cards).map(([kind, list]) => [kind, list.map((c) => c.id)])), {
    triggers: ['measure_temperature.floor_changed', 'sg_heat_preset_changed', 'sg_heating_true', 'sg_heating_false',
      'sg_window_open_true', 'sg_window_open_false', 'sg_floor_limit_true', 'sg_floor_limit_false'],
    conditions: ['sg_heating_is', 'sg_window_open_is', 'sg_heat_preset_is'],
    actions: ['sg_heat_preset_set'],
  });
  for (const c of Object.values(cards).flat()) {
    for (const field of ['title', 'titleFormatted', 'hint']) {
      if (c[field]) assert.deepEqual(Object.keys(c[field]).sort(), ['en', 'no'], `${c.id} ${field}`);
    }
  }
  const listeners = {};
  const card = (id) => ({ registerRunListener: (fn) => { listeners[id] = fn; } });
  const driver = new SGThermostatDriver({ homey: fake.fakeHomey(null, { flow: { getActionCard: card, getConditionCard: card } }) });
  await driver.onInit();
  const values = { sg_heating: true, sg_window_open: false, sg_heat_preset: 'eco' };
  const triggered = [];
  const device = { getCapabilityValue: (id) => values[id], triggerCapabilityListener: async (...args) => triggered.push(args) };
  assert.equal(await listeners.sg_heating_is({ device }), true);
  assert.equal(await listeners.sg_window_open_is({ device }), false);
  assert.equal(await listeners.sg_heat_preset_is({ device, preset: 'eco' }), true);
  assert.equal(await listeners.sg_heat_preset_is({ device, preset: 'comfort' }), false);
  await listeners.sg_heat_preset_set({ device, preset: 'min' });
  assert.deepEqual(triggered, [['sg_heat_preset', 'min']]);
});

// ---- the device

// A thermostat device with an app that records what is sent and asked. With
// capabilities (a Set), it has those and adds and removes in it; without, it
// has them all. With options (an object), its capability options are read
// from and set in it. Its listeners are kept in listeners, called as Homey
// calls them. It starts as one that has had control turned on once already
// (controlOnByDefault), so the settings given count as they are.
async function thermostat({ settings = {}, store = {}, capabilities = null, options = null } = {}) {
  const listeners = {};
  const sent = [];
  const asked = [];
  const watched = [];
  const app = {
    logs: [], errors: [], seq: 0x800000, log() {}, error() {},
    nextSeq() { app.seq += 1; return app.seq; },
    bridge: { send: async (packet) => { sent.push(plainOf(packet)); return { ok: true }; } },
    csr: {
      watchThermostat: (meshId, info) => watched.push([meshId, info]),
      unwatchThermostat: (meshId) => watched.push(['unwatched', meshId]),
      requestStatus: async (meshId, location, listenMs) => { asked.push(['FF04', meshId, location, listenMs]); return true; },
      requestNames: async () => { asked.push(['FF10']); return true; },
    },
    sharedLocation: () => null,
    statusUnreadableText: () => null,
  };
  const homey = fake.fakeHomey(app);
  const device = new SGThermostatDevice({
    homey, store: { meshId: MESH_ID, prefix: '@MT', kind: 'thermostat', locationId: LOC, controlOnByDefault: true, ...store },
    settings: { passphrase: 'test-only-pass', control_from_homey: false, sensor: 'floor', heating_cable_power: 0, ...settings },
    data: { id: '@MT1A2B' }, name: 'thermostat',
  });
  if (capabilities) {
    device.hasCapability = (id) => capabilities.has(id);
    device.addCapability = async (id) => { capabilities.add(id); };
    device.removeCapability = async (id) => { capabilities.delete(id); };
  } else {
    device.hasCapability = () => true;
  }
  if (options) {
    device.getCapabilityOptions = (id) => options[id] || {};
    device.setCapabilityOptions = async (id, value) => { options[id] = value; };
  }
  device.registerCapabilityListener = (id, listener) => { listeners[id] = listener; };
  device.registerMultipleCapabilityListener = (ids, listener) => {
    for (const id of ids) listeners[id] = (value) => listener({ [id]: value });
  };
  await device.onInit();
  return { device, sent, asked, watched, homey, app, listeners };
}

const value = (device, capability) => device.getCapabilityValue(capability);

test('at start: watched by the network with its name and location id; control from Homey as set', async () => {
  const { device, watched } = await thermostat();
  assert.deepEqual(watched, [[MESH_ID, { name: '@MT1A2B', location: LOC }]]);
  assert.ok(device.logs.includes('thermostat ready (@MT, mesh id 0x0201, loc 0x5a3c, control from Homey off)'));
  await device.onDeleted();
  assert.deepEqual(watched.at(-1), ['unwatched', MESH_ID]);
});

test('control from Homey off: every change is refused with the message, and nothing is sent', async () => {
  const { device, sent } = await thermostat();
  for (const change of [() => device._setPoint(22), () => device._power(false, 'onoff'), () => device._power(true, 'thermostat_mode'),
    () => device._preset('eco')]) {
    await assert.rejects(change(), { message: 'thermostat.controlOff' });
  }
  assert.deepEqual(sent, []);
  assert.ok(device.logs.includes('set point 22.0 refused: control from Homey is off, nothing sent'));
  assert.ok(device.logs.includes('preset eco refused: control from Homey is off, nothing sent'));
});

test('control on: the set point is FF3E, rounded to 0.5 and kept within 5 to 35, nothing when the thermostat has it', async () => {
  await withClock(async (clock) => {
    const { device, sent } = await thermostat({ settings: { control_from_homey: true } });
    device.applyThermostat('FF05', status({ setPoint: 21 }));
    await device._setPoint(22.3);
    assert.deepEqual(sent.map(hexOf), ['0102ff3e5a3c16050101']);
    clock.t += 20_000;
    device.applyThermostat('FF05', status({ setPoint: 22.5 }));
    await device._setPoint(22.5);
    await device._setPoint(40);
    assert.deepEqual(sent.map(hexOf), ['0102ff3e5a3c16050101', '0102ff3e5a3c23000101'], '35.0, tid 1 again after 10 s');
    assert.ok(device.logs.includes('set point 22.5: the thermostat has it already, nothing sent'));
  });
});

test('control on: on and off are one FF42 from either onoff or the mode, and the other follows; a preset is FF03 in the thermostat\'s format', async () => {
  const { device, sent } = await thermostat({ settings: { control_from_homey: true } });
  device.applyThermostat('FF05', status({ on: true }));
  await device._power(false, 'onoff');
  assert.equal(value(device, 'thermostat_mode'), 'off');
  await device._power(true, 'thermostat_mode');
  assert.equal(value(device, 'onoff'), true);
  await device._preset('comfort');
  assert.deepEqual(sent.map(hexOf), ['0102ff425a3c000001', '0102ff425a3c010002', '0102ff035a3c01000301']);
  await assert.rejects(device._preset('away'), /no such preset/);
});

test('control on, but no location id yet: refused, and the mesh is asked for names', async () => {
  const { device, sent, asked } = await thermostat({ settings: { control_from_homey: true }, store: { locationId: undefined } });
  await assert.rejects(device._setPoint(22), { message: 'thermostat.waitingForStatus' });
  assert.deepEqual(sent, []);
  assert.deepEqual(asked, [['FF10']]);
});

test('after a setting: no status about it is taken for 8 s, one FF04 9 s after the last, and a set point that did not stick is logged, never sent again', async () => {
  await withClock(async (clock) => {
    const { device, sent, asked, homey } = await thermostat({ settings: { control_from_homey: true } });
    device.applyThermostat('FF05', status({ setPoint: 21 }));
    await device._setPoint(23);
    assert.equal([...homey.pending.values()].filter((t) => t.ms === 9000).length, 1);
    // An old status within 8 s: the set point stays, the relay is taken.
    clock.t += 2000;
    device.applyThermostat('FF05', status({ setPoint: 21, heating: true }));
    assert.equal(value(device, 'target_temperature'), 21, 'from the first status, not 21 again from the old one'); // unchanged
    assert.equal(value(device, 'sg_heating'), true);
    // The same again within the quiet time is not sent twice.
    await device._setPoint(23);
    assert.equal(sent.length, 1);
    homey.runMs(9000);
    assert.deepEqual(asked, [['FF04', MESH_ID, LOC, THERMOSTAT_LISTEN_MS]]);
    // After 8 s: what the thermostat has is shown, and the difference logged.
    clock.t += 7000;
    device.applyThermostat('FF05', status({ setPoint: 21 }));
    assert.equal(value(device, 'target_temperature'), 21);
    assert.ok(device.logs.includes('set point 23.0 was sent, the thermostat has 21.0: shown as it is'));
    assert.equal(sent.length, 1);
  });
});

test('a status: on, mode, set point, heating, window, and the preset whose temperature it is (min when paused, none when off or none matches)', async () => {
  const { device } = await thermostat();
  device.applyThermostat('FF5D', { location: LOC, presets: [21, 16, 5] });
  device.applyThermostat('FF05', status({ setPoint: 16, heating: true, window: true }));
  assert.deepEqual(['onoff', 'thermostat_mode', 'target_temperature', 'sg_heating', 'sg_window_open', 'sg_heat_preset']
    .map((c) => value(device, c)), [true, 'heat', 16, true, true, 'eco']);
  device.applyThermostat('FF05', status({ setPoint: 21 }));
  assert.equal(value(device, 'sg_heat_preset'), 'comfort');
  device.applyThermostat('FF05', status({ setPoint: 5, paused: true }));
  assert.equal(value(device, 'sg_heat_preset'), 'min');
  device.applyThermostat('FF05', status({ setPoint: 19.5 }));
  assert.equal(value(device, 'sg_heat_preset'), null);
  device.applyThermostat('FF05', status({ on: false, setPoint: 21 }));
  assert.deepEqual([value(device, 'onoff'), value(device, 'thermostat_mode'), value(device, 'sg_heat_preset')], [false, 'off', null]);
});

test('temperatures: the room\'s when there is one, otherwise the floor\'s; the floor\'s on its own, empty with a floor sensor fault', async () => {
  const { device } = await thermostat();
  device.applyThermostat('FF05', status());
  device.applyThermostat('FF3D', { location: LOC, room: 21.5, floor: 24, floorLimit: 28 });
  assert.deepEqual([value(device, 'measure_temperature'), value(device, 'measure_temperature.floor')], [21.5, 24]);
  device.applyThermostat('FF05', status({ errors: 0x10 })); // room sensor fault
  device.applyThermostat('FF3D', { location: LOC, room: 21.5, floor: 24, floorLimit: 28 });
  assert.deepEqual([value(device, 'measure_temperature'), value(device, 'measure_temperature.floor')], [24, 24]);
  device.applyThermostat('FF05', status({ errors: 0x04 })); // floor sensor fault
  device.applyThermostat('FF3D', { location: LOC, room: 21.5, floor: 24, floorLimit: 28 });
  assert.deepEqual([value(device, 'measure_temperature'), value(device, 'measure_temperature.floor')], [21.5, null]);
});

test('faults: which count follows the sensor setting; a problem alarm and a warning, L0 a warning only; the floor limit on its own', async () => {
  const temps = { room: 21, floor: 24 };
  assert.deepEqual(faultsOf(0x04, temps, 'floor'), ['FFF']);
  assert.deepEqual(faultsOf(0x04, temps, 'room'), []);
  assert.deepEqual(faultsOf(0x10, temps, 'floor'), []);
  assert.deepEqual(faultsOf(0x10, temps, 'room'), ['E2']);
  assert.deepEqual(faultsOf(0x08, { room: 21, floor: 0 }, 'roomFloor'), ['E1', 'L0']);
  assert.deepEqual(faultsOf(0x08, temps, 'floor'), [], 'E1 only when the floor reads 0');
  assert.deepEqual(faultsOf(0x54, temps, 'roomFloor'), ['EEE', 'FFF', 'E2']);

  const { device } = await thermostat();
  device.applyThermostat('FF3D', { location: LOC, room: 21, floor: 24, floorLimit: 28 });
  device.applyThermostat('FF05', status({ errors: 0x44 }));
  await tick();
  assert.equal(value(device, 'alarm_problem'), true);
  assert.equal(device.warning, 'thermostat.fault.EEE');
  device.applyThermostat('FF05', status({ errors: 0x80 }));
  await tick();
  assert.deepEqual([value(device, 'alarm_problem'), value(device, 'sg_floor_limit'), device.warning], [false, true, null]);
  device.applyThermostat('FF3D', { location: LOC, room: 21, floor: 0, floorLimit: 28 });
  await tick();
  assert.deepEqual([value(device, 'alarm_problem'), device.warning], [false, 'thermostat.fault.L0']);
  // With the room sensor, the floor limit does not count.
  device._settings.sensor = 'room';
  await device.onSettings({ newSettings: device._settings, changedKeys: ['sensor'] });
  assert.equal(value(device, 'sg_floor_limit'), false);
});

test('power: the cable\'s watts while it heats, 0 when not, empty without the setting, and a new setting counts at once', async () => {
  const { device } = await thermostat();
  device.applyThermostat('FF05', status({ heating: true }));
  assert.equal(value(device, 'measure_power'), null);
  device._settings.heating_cable_power = 1200;
  await device.onSettings({ newSettings: device._settings, changedKeys: ['heating_cable_power'] });
  assert.equal(value(device, 'measure_power'), 1200);
  device.applyThermostat('FF05', status({ heating: false }));
  assert.equal(value(device, 'measure_power'), 0);
});

test('a set point or preset another sends: shown, never answered; the same tid again, our own coming back, or within 4 s of our own, is not taken', async () => {
  await withClock(async (clock) => {
    const { device, sent } = await thermostat({ settings: { control_from_homey: true } });
    device.applyThermostat('FF5D', { location: LOC, presets: [21, 16, 5] });
    device.applyThermostatCommand('FF3E', { location: LOC, setPoint: 23.5, tid: 7 }, 0x8000);
    assert.equal(value(device, 'target_temperature'), 23.5);
    device.applyThermostatCommand('FF3E', { location: LOC, setPoint: 19, tid: 7 }, 0x8000);
    assert.equal(value(device, 'target_temperature'), 23.5, 'the same tid through another node');
    device.applyThermostatCommand('FF03', { location: LOC, preset: 'eco', tid: 8 }, 0x8000);
    assert.deepEqual([value(device, 'sg_heat_preset'), value(device, 'target_temperature')], ['eco', 16]);
    device.applyThermostatCommand('FF3E', { location: 0x1111, setPoint: 30, tid: 9 }, 0x8000);
    assert.equal(value(device, 'target_temperature'), 16, 'another home');
    // Ours goes with the next tid, and coming back it is not taken.
    clock.t += 1000;
    await device._setPoint(24);
    assert.equal(sent.at(-1)[9], 9, 'the tid after the one heard');
    clock.t += 5000;
    device.applyThermostatCommand('FF3E', { location: LOC, setPoint: 24, tid: 9 }, 0x8000);
    assert.ok(!device.logs.some((line) => /set point 24.0 shown/.test(line)));
    // Within 4 s of a setting from here, another's is not taken.
    await device._setPoint(25);
    clock.t += 1000;
    device.applyThermostatCommand('FF3E', { location: LOC, setPoint: 18, tid: 50 }, 0x0042);
    assert.ok(device.logs.includes('FF3E from 0x0042 not taken: within 4 s of a setting from here'));
    assert.equal(sent.length, 2, 'nothing sent for what was heard');
  });
});

// ---- the network: reads only added thermostats, hands their answers over

test('the network reads a thermostat only when it is added, hands its answers and what others send it to the device, never to a light', async () => {
  await withClock(async () => {
    const sentPlains = [];
    const app = {
      logs: [], errors: [], seq: 0x800000,
      log(...args) { app.logs.push(args.join(' ')); },
      error() {},
      getNetworkKey: () => KEY,
      nextSeq() { app.seq += 1; return app.seq; },
      knownLocations: () => [LOC],
      sharedLocation: () => null,
      statusUnreadableText: () => null,
      bridge: { _scanPauses: 0, listenLeftMs: () => 0, send: async (p) => { sentPlains.push(plainOf(p)); return { ok: true }; } },
      _devices: () => [],
    };
    app.homey = fake.fakeHomey(app);
    app.csr = new CsrNetwork(app);
    const name = (src, n) => ({ src, plain: Buffer.from([0x00, 0x80, 0xff, 0x11, LOC >> 8, LOC & 0xff, ...Buffer.from(n.slice(1), 'latin1'), 0]) });
    // Not added: known, not read.
    app.csr.handleFrame(name(MESH_ID, '@MT1A2B'));
    for (let i = 0; i < 5; i += 1) await tick();
    assert.equal(app.csr.isThermostat(MESH_ID), true);
    assert.deepEqual(sentPlains, []);
    // Added: read.
    const device = new SGThermostatDevice({
      homey: app.homey, store: { meshId: MESH_ID, prefix: '@MT', kind: 'thermostat', locationId: LOC },
      settings: { passphrase: 'test-only-pass' }, data: { id: '@MT1A2B' }, name: 'thermostat',
    });
    device.hasCapability = () => true;
    const light = { getCsrMeshId: () => MESH_ID, applyCsrStatus: () => { throw new Error('a light got it'); }, applyCsrName() {} };
    app._devices = () => [device, light];
    await device.onInit();
    for (let i = 0; i < 5; i += 1) await tick();
    assert.equal(hexOf(sentPlains[0]), '0102ff045a3c');
    // Its FF05 goes to the thermostat device, not to the light.
    app.csr.handleFrame({ src: MESH_ID, plain: Buffer.from([0x00, 0x80, 0xff, 0x05, 0x5a, 0x3c, 0xa1, 22, 0, 1, 0, 0x80, 0]) });
    assert.equal(value(device, 'target_temperature'), 22);
    // A set point another sends it, from our own address too, goes to it.
    app.csr.handleFrame({ src: 0x8000, plain: Buffer.from([0x01, 0x02, 0xff, 0x3e, 0x5a, 0x3c, 19, 5, 1, 40]) });
    assert.equal(value(device, 'target_temperature'), 19.5);
    assert.ok(app.logs.some((line) => /EXT src=0x8000 dst=0x0201 op=FF3E .* to a thermostat: set point 19.5 tid=40 loc=0x5a3c/.test(line)));
    // Its FF08 goes to the device: a set point from here is sent no more.
    await device._setPoint(24);
    const sentBefore = sentPlains.length;
    app.csr.handleFrame({ src: MESH_ID, plain: Buffer.from([0x00, 0x80, 0xff, 0x08, 0x5a, 0x3c, 0x3e]) });
    app.homey.runMs(1000);
    for (let i = 0; i < 5; i += 1) await tick();
    assert.equal(sentPlains.length, sentBefore);
    assert.ok(device.logs.includes('FF3E set point 24.0: acknowledged (FF08) after 1 of 3, no more sent'));
    assert.ok(app.logs.some((line) => /op=FF08 .*thermostat acknowledged FF3E loc=0x5a3c/.test(line)));
    app.csr.stop();
  });
});

// ---- the send queue, delivery and the mesh id guard

test('with the real send queue and a slow link: on/off and a set point both go out; a newer set point replaces one not yet sent, and that is logged', async () => {
  const MeshBridge = require('../lib/MeshBridge');
  const app = {
    logs: [], errors: [], seq: 0x800000,
    log(...args) { app.logs.push(args.join(' ')); },
    error(...args) { app.errors.push(args.join(' ')); },
    getNetworkKey: () => KEY,
    nextSeq() { app.seq += 1; return app.seq; },
    _devices: () => [],
    sharedLocation: () => null,
    statusUnreadableText: () => null,
    csr: { watchThermostat() {}, requestStatus: async () => true, requestNames: async () => true },
  };
  app.homey = fake.fakeHomey(app);
  const bridge = new MeshBridge(app);
  // The link comes up when the test says so; what is written is kept.
  let linkUp;
  const slowLink = new Promise((resolve) => { linkUp = resolve; });
  const parts = [];
  Object.assign(bridge, {
    _ensureTxConnected: () => slowLink,
    _writeFragment: async (name, characteristic, data) => { parts.push(Buffer.from(data)); },
    _sleep: async () => {},
  });
  app.bridge = bridge;
  const device = new SGThermostatDevice({
    homey: app.homey, store: { meshId: MESH_ID, prefix: '@MT', kind: 'thermostat', locationId: LOC },
    settings: { passphrase: 'test-only-pass', control_from_homey: true }, data: { id: '@MT1A2B' }, name: 'thermostat',
  });
  device.hasCapability = () => true;
  await device.onInit();
  device.applyThermostat('FF05', status({ on: false, setPoint: 21 }));
  const sends = [device._power(true, 'onoff'), device._setPoint(22), device._setPoint(23)];
  for (let i = 0; i < 5; i += 1) await tick();
  linkUp();
  await Promise.all(sends);
  // Each packet goes as 20 bytes and the rest.
  const packets = [];
  for (let i = 0; i < parts.length; i += 2) packets.push(Buffer.concat([parts[i], parts[i + 1]]));
  assert.deepEqual(packets.map((p) => hexOf(plainOf(p)).slice(0, 14)), ['0102ff425a3c01', '0102ff3e5a3c17']);
  assert.ok(device.logs.includes('FF3E set point 22.0 (1 of 3) not sent: replaced by a newer one'));
  assert.ok(device.logs.includes('FF3E set point 22.0: the last 2 of 3 not sent, replaced by a newer setting'));
  assert.ok(!device.logs.some((line) => /^FF42 on not sent/.test(line)));
});

test('a setting that is not delivered is logged', async () => {
  const { device, app } = await thermostat({ settings: { control_from_homey: true } });
  app.bridge.send = async () => ({ failed: true });
  await device._power(false, 'onoff');
  assert.ok(device.logs.includes('FF42 off not sent: not delivered'));
});

// ---- a set point or preset: up to three times, until FF08

// A thermostat with control on and its status in; gap() lets the send in
// flight finish and runs the timer for the next one.
async function repeating() {
  const made = await thermostat({ settings: { control_from_homey: true } });
  made.device.applyThermostat('FF05', status({ on: true, setPoint: 21 }));
  const gap = async () => {
    for (let i = 0; i < 5; i += 1) await tick();
    made.homey.runMs(1000);
    for (let i = 0; i < 5; i += 1) await tick();
  };
  return { ...made, gap };
}
const ack = (opcode) => ({ location: LOC, opcode });

test('a set point and a preset go up to three times, 1 s apart, the same message and tid each time; each send is logged; on/off goes once', async () => {
  await withClock(async () => {
    const { device, sent, gap, homey } = await repeating();
    await device._setPoint(22);
    assert.deepEqual(sent.map(hexOf), ['0102ff3e5a3c16000101']);
    await gap();
    await gap();
    assert.deepEqual(sent.map(hexOf), ['0102ff3e5a3c16000101', '0102ff3e5a3c16000101', '0102ff3e5a3c16000101']);
    await gap();
    await gap();
    assert.equal(sent.length, 3, 'never a fourth');
    assert.deepEqual([...homey.pending.values()].filter(({ ms }) => ms === 1000), []);
    for (const n of [1, 2, 3]) assert.ok(device.logs.some((line) => line.startsWith(`FF3E set point 22.0 (${n} of 3) to 0x0201 tid=1 `)), `${n}`);
    assert.ok(device.logs.includes('FF3E set point 22.0: no acknowledgement (FF08) after 3 of 3'));
    sent.length = 0;
    await device._preset('eco');
    await gap();
    await gap();
    await gap();
    assert.deepEqual(sent.map(hexOf), ['0102ff035a3c00000201', '0102ff035a3c00000201', '0102ff035a3c00000201']);
    sent.length = 0;
    await device._power(false, 'onoff');
    await gap();
    await gap();
    assert.deepEqual(sent.map(hexOf), ['0102ff425a3c000003']);
  });
});

test('FF08 from the thermostat with 3E (or 03) stops the sends left; one for the other opcode does not', async () => {
  await withClock(async () => {
    const { device, sent, gap } = await repeating();
    await device._setPoint(22);
    device.applyThermostat('FF08', ack(0xff3e));
    await gap();
    await gap();
    assert.equal(sent.length, 1);
    assert.ok(device.logs.includes('FF3E set point 22.0: acknowledged (FF08) after 1 of 3, no more sent'));
    sent.length = 0;
    await device._preset('eco');
    await gap();
    device.applyThermostat('FF08', ack(0xff3e));
    assert.ok(device.logs.includes('FF08 for FF3E: nothing from here waits for it'));
    device.applyThermostat('FF08', ack(0xff03));
    await gap();
    await gap();
    assert.equal(sent.length, 2);
    assert.ok(device.logs.includes('FF03 preset eco: acknowledged (FF08) after 2 of 3, no more sent'));
    // From another home: not taken.
    sent.length = 0;
    await device._setPoint(23);
    device.applyThermostat('FF08', { location: 0x1234, opcode: 0xff3e });
    await gap();
    await gap();
    assert.equal(sent.length, 3);
  });
});

test('a newer set point or preset replaces the sends left of the one before; on/off does not', async () => {
  await withClock(async () => {
    const { device, sent, gap } = await repeating();
    await device._setPoint(22);
    await gap();
    await device._setPoint(23);
    assert.ok(device.logs.includes('FF3E set point 22.0: the last 1 of 3 not sent, replaced by a newer setting'));
    await gap();
    await gap();
    await gap();
    assert.deepEqual(sent.map((p) => hexOf(p).slice(12, 14)), ['16', '16', '17', '17', '17'], '22 twice, then 23 three times');
    sent.length = 0;
    await device._setPoint(24);
    await device._preset('min');
    assert.ok(device.logs.includes('FF3E set point 24.0: the last 2 of 3 not sent, replaced by a newer setting'));
    await device._power(false, 'onoff');
    await gap();
    await gap();
    await gap();
    assert.deepEqual(sent.map((p) => hexOf(p).slice(4, 8)), ['ff3e', 'ff03', 'ff42', 'ff03', 'ff03'], 'on/off goes in between');
    assert.ok(!device.logs.some((line) => /^FF03 preset min: the last/.test(line)));
  });
});

test('never to mesh id 0, 0x8000, 0x8001 or 0xFFFF; a high mesh id of a device set up later (0x8002 to 0xFFFE) goes, to a light, a Pill, a plug and a thermostat', async () => {
  const SGCsrDevice = require('../lib/SGCsrDevice');
  const SGPlugDevice = require('../drivers/sg_plug/device');
  assert.deepEqual([0, 0x8000, 0x8001, 0xffff, 1.5, '1', -1, 0x10000].map(proto.isDeviceMeshId), Array(8).fill(false));
  assert.deepEqual([1, 0x7fff, 0x8002, 0x8123, 0xfffe].map(proto.isDeviceMeshId), Array(5).fill(true));
  // A light, a Pill or a plug with this mesh id: what one command sends.
  const lightSends = async (Class, prefix, kind, meshId) => {
    const sent = [];
    const app = {
      nextSeq: () => 1, sharedLocation: () => null, statusUnreadableText: () => null,
      bridge: { send: async (p) => { sent.push(plainOf(p)); return { ok: true }; } },
      csr: { isThermostat: () => false, requestNames: async () => true, requestStatus: async () => true },
    };
    const device = new Class({
      homey: fake.fakeHomey(app, { flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) } }),
      store: { meshId, prefix, kind, locationId: LOC }, settings: { passphrase: 'test-only-pass' }, data: { id: `${prefix}1A2B` }, name: prefix,
    });
    if (kind === 'onoff') device.hasCapability = (c) => c === 'onoff';
    await device.onInit();
    const ok = await device._send(40, { location: LOC, borrowed: false });
    return { ok, sent, device };
  };
  const products = [[SGCsrDevice, '@SD', 'dimmable'], [SGCsrDevice, '@SC', 'dimmable'], [SGPlugDevice, '@GP', 'onoff']];
  for (const [Class, prefix, kind] of products) {
    for (const meshId of [0x8002, 0x8123, 0xfffe]) {
      const { ok, sent } = await lightSends(Class, prefix, kind, meshId);
      assert.equal(ok, true, `${prefix} 0x${meshId.toString(16)}`);
      assert.deepEqual(sent.map((p) => p.readUInt16LE(0)), [meshId], `${prefix} 0x${meshId.toString(16)}`);
    }
    for (const meshId of [0, 0x8000, 0x8001, 0xffff]) {
      const { ok, sent, device } = await lightSends(Class, prefix, kind, meshId);
      assert.deepEqual([ok, sent], [false, []], `${prefix} 0x${meshId.toString(16)}`);
      assert.ok(device.logs.some((line) => /^command FF03 level=40 not sent: mesh id 0x[0-9a-f]{4} is not one device's$/.test(line)));
    }
  }
  // A thermostat.
  for (const meshId of [0x8002, 0x8123, 0xfffe]) {
    const { device, sent } = await thermostat({ settings: { control_from_homey: true }, store: { meshId } });
    await device._setPoint(22);
    assert.deepEqual(sent.map((p) => p.readUInt16LE(0)), [meshId], `0x${meshId.toString(16)}`);
  }
  for (const meshId of [0, 0x8000, 0x8001, 0xffff]) {
    const { device, sent } = await thermostat({ settings: { control_from_homey: true }, store: { meshId } });
    await assert.rejects(device._setPoint(22), { message: 'device.badMeshId' });
    await assert.rejects(device._preset('eco'), { message: 'device.badMeshId' });
    assert.deepEqual(sent, [], `0x${meshId.toString(16)}`);
    assert.ok(device.logs.some((line) => /refused: mesh id 0x[0-9a-f]{4} is not one device's, nothing sent$/.test(line)));
  }
});

test('no FF03 when the status shows the preset already; a set point that is not a number is refused', async () => {
  await withClock(async (clock) => {
    const { device, sent } = await thermostat({ settings: { control_from_homey: true } });
    device.applyThermostat('FF5D', { location: LOC, presets: [21, 16, 5] });
    device.applyThermostat('FF05', status({ setPoint: 16 }));
    await device._preset('eco');
    assert.deepEqual(sent, []);
    assert.ok(device.logs.includes('preset eco: the thermostat has it already, nothing sent'));
    await device._preset('comfort');
    assert.equal(sent.length, 1);
    // Within the quiet time the status is not known: the same is sent again.
    clock.t += 1000;
    await device._preset('comfort');
    assert.equal(sent.length, 2);
    await assert.rejects(device._setPoint('warm'), /not a temperature/);
  });
});

test('the sensor bits as in the format: the room sensor only for 01 and 10; the floor temperature hidden only with FFF and E1', async () => {
  const temps = { room: 21, floor: 24 };
  assert.deepEqual([0x10, 0x20, 0x30].map((errors) => faultsOf(errors, temps, 'room')), [['E2'], ['E2'], []]);
  const { device } = await thermostat();
  const shown = (errors, floor = 24) => {
    device.applyThermostat('FF05', status({ errors }));
    device.applyThermostat('FF3D', { location: LOC, room: 21, floor, floorLimit: 28 });
    return [value(device, 'measure_temperature'), value(device, 'measure_temperature.floor')];
  };
  assert.deepEqual(shown(0x04), [21, null], 'FFF');
  assert.deepEqual(shown(0x08, 0), [21, null], 'E1: the floor reads 0');
  assert.deepEqual(shown(0x08), [21, 24], '10 with a floor reading: no fault, shown');
  assert.deepEqual(shown(0x0c), [21, 24], '11: no fault, shown');
  assert.deepEqual(shown(0x30), [21, 24], 'room 11: no fault, the room is shown');
  assert.deepEqual(shown(0x20), [24, 24], 'room 10: E2, the floor is shown');
});

test('the open window function and the floor limit: their texts, and none says a window was opened or closed', () => {
  const window = JSON.parse(read('.homeycompose/capabilities/sg_window_open.json'));
  assert.deepEqual(window.title, { en: 'Open window function', no: 'Åpent vindu-funksjonen' });
  const compose = JSON.parse(read('drivers/sg_thermostat/driver.compose.json')).capabilitiesOptions;
  assert.deepEqual([compose.sg_window_open.titleTrue, compose.sg_window_open.titleFalse],
    [{ en: 'Active', no: 'Aktiv' }, { en: 'Not active', no: 'Ikke aktiv' }]);
  assert.deepEqual([compose.sg_floor_limit.titleTrue, compose.sg_floor_limit.titleFalse],
    [{ en: 'Reached', no: 'Nådd' }, { en: 'Not reached', no: 'Ikke nådd' }]);
  const cards = Object.fromEntries(Object.values(JSON.parse(read('drivers/sg_thermostat/driver.flow.compose.json'))).flat()
    .map((c) => [c.id, c.title]));
  assert.deepEqual(cards.sg_window_open_true, { en: 'The open window function started', no: 'Åpent vindu-funksjonen slo inn' });
  assert.deepEqual(cards.sg_window_open_false, { en: 'The open window function ended', no: 'Åpent vindu-funksjonen er ferdig' });
  assert.deepEqual(cards.sg_window_open_is, { en: 'The open window function !{{is|is not}} active', no: 'Åpent vindu-funksjonen !{{er|er ikke}} aktiv' });
  assert.deepEqual(cards.sg_floor_limit_false, { en: 'Floor limit no longer reached', no: 'Gulvgrensen er ikke lenger nådd' });
  const texts = [read('.homeycompose/capabilities/sg_window_open.json'), read('drivers/sg_thermostat/driver.compose.json'),
    read('drivers/sg_thermostat/driver.flow.compose.json'), read('locales/en.json'), read('locales/no.json')].join('\n');
  assert.doesNotMatch(texts, /window (?:was )?(?:opened|closed)|vinduet ble (?:åpnet|lukket)|\bÅpent\b"|"Lukket"|"Closed"/i);
});

// ---- after a try with the fake thermostats in the Homey app

test('heating, the open window function and the floor limit have icons: Tabler Icons drawn as filled shapes, plain SVG, in the build with their licence', async () => {
  const { buildFiles } = require('./helpers/build-files');
  const files = await buildFiles();
  const licence = read('LICENSE-tabler-icons.txt');
  assert.ok(files.includes('LICENSE-tabler-icons.txt'), 'the licence goes with the build');
  assert.match(licence, /^MIT License$/m);
  assert.match(licence, /^Copyright \(c\) 2020-2026 Paweł Kuna$/m);
  for (const [id, icon] of [['sg_heating', 'flame'], ['sg_window_open', 'window'], ['sg_floor_limit', 'arrow-bar-to-up']]) {
    const file = `assets/capabilities/${id}.svg`;
    assert.equal(JSON.parse(read(`.homeycompose/capabilities/${id}.json`)).icon, `/${file}`, id);
    assert.ok(files.includes(file), `${file} in the build`);
    const svg = read(file);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 960 960">/, id);
    assert.doesNotMatch(svg, /metadata|c2pa|class=|currentColor|<!--|<title|<desc/i, id);
    assert.match(licence, new RegExp(`^  ${file.replace(/\./g, '\\.')} +${icon}$`, 'm'), `${id} named in the licence`);
  }
});

test('heating and the floor limit: their titles and values; the Flow cards as before', () => {
  assert.deepEqual(JSON.parse(read('.homeycompose/capabilities/sg_heating.json')).title, { en: 'Heating', no: 'Varme' });
  assert.deepEqual(JSON.parse(read('.homeycompose/capabilities/sg_floor_limit.json')).title, { en: 'Floor limit', no: 'Gulvgrense' });
  const options = JSON.parse(read('drivers/sg_thermostat/driver.compose.json')).capabilitiesOptions;
  assert.deepEqual([options.sg_heating.titleTrue, options.sg_heating.titleFalse],
    [{ en: 'Heating', no: 'Varmer' }, { en: 'Not heating', no: 'Varmer ikke' }]);
  assert.deepEqual([options.sg_floor_limit.titleTrue, options.sg_floor_limit.titleFalse],
    [{ en: 'Reached', no: 'Nådd' }, { en: 'Not reached', no: 'Ikke nådd' }]);
  const cards = Object.fromEntries(Object.values(JSON.parse(read('drivers/sg_thermostat/driver.flow.compose.json'))).flat()
    .map((c) => [c.id, c.title]));
  assert.deepEqual([cards.sg_heating_true, cards.sg_heating_false],
    [{ en: 'Started heating', no: 'Begynte å varme' }, { en: 'Stopped heating', no: 'Sluttet å varme' }]);
  assert.deepEqual([cards.sg_floor_limit_true, cards.sg_floor_limit_false],
    [{ en: 'The floor limit was reached', no: 'Gulvgrensen ble nådd' }, { en: 'Floor limit no longer reached', no: 'Gulvgrensen er ikke lenger nådd' }]);
});

test('measure_power always, so Homey offers no power usage of its own for on and off: added to one that lacks it, marked as approximated, empty at 0 W', async () => {
  assert.ok(JSON.parse(read('drivers/sg_thermostat/driver.compose.json')).capabilities.includes('measure_power'));
  // One that lacks it (removed by an earlier build): added at start, and marked.
  const capabilities = new Set(['onoff', 'sg_heating']);
  const options = {};
  const { device } = await thermostat({ capabilities, options });
  assert.equal(capabilities.has('measure_power'), true);
  assert.deepEqual(options.measure_power, { approximated: true });
  assert.ok(device.logs.includes('measure_power added'));
  // Empty at 0 W; the cable's watts while it heats; never removed by a setting.
  device.applyThermostat('FF05', status({ heating: true }));
  assert.equal(value(device, 'measure_power'), null);
  device._settings.heating_cable_power = 800;
  await device.onSettings({ newSettings: device._settings, changedKeys: ['heating_cable_power'] });
  assert.equal(value(device, 'measure_power'), 800);
  device._settings.heating_cable_power = 0;
  await device.onSettings({ newSettings: device._settings, changedKeys: ['heating_cable_power'] });
  assert.equal(capabilities.has('measure_power'), true);
  assert.equal(value(device, 'measure_power'), null);
  // One that has it: nothing added or set.
  const has = new Set(['onoff', 'measure_power']);
  const untouched = {};
  const second = await thermostat({ capabilities: has, options: untouched });
  assert.equal(untouched.measure_power, undefined);
  assert.ok(!second.device.logs.includes('measure_power added'));
  // A failure is logged.
  const failing = new SGThermostatDevice({
    homey: fake.fakeHomey({ ...second.app }), store: { meshId: MESH_ID, prefix: '@MT', locationId: LOC, controlOnByDefault: true },
    settings: { passphrase: 'test-only-pass', sensor: 'floor', heating_cable_power: 0 }, data: { id: '@MT1A2B' }, name: 'thermostat',
  });
  failing.hasCapability = (id) => id === 'onoff';
  failing.addCapability = async () => { throw new Error('no room'); };
  await failing.onInit();
  assert.ok(failing.errors.includes('measure_power not added: no room'));
});

test('a preset after a set point: the read-back does not call the preset\'s set point a difference; a set point after a preset still counts', async () => {
  await withClock(async (clock) => {
    const { device } = await thermostat({ settings: { control_from_homey: true } });
    device.applyThermostat('FF5D', { location: LOC, presets: [21, 16, 5] });
    device.applyThermostat('FF05', status({ setPoint: 21 }));
    await device._setPoint(17);
    await device._preset('eco');
    clock.t += 9000;
    device.applyThermostat('FF05', status({ setPoint: 16 }));
    assert.ok(!device.logs.some((line) => /was sent, the thermostat has/.test(line)));
    assert.equal(value(device, 'sg_heat_preset'), 'eco');

    clock.t += 20_000;
    await device._preset('comfort');
    await device._setPoint(19);
    clock.t += 9000;
    device.applyThermostat('FF05', status({ setPoint: 21 }));
    assert.ok(device.logs.includes('set point 19.0 was sent, the thermostat has 21.0: shown as it is'));
  });
});

// An icon Homey would show wrong, as it fills an icon and leaves its strokes
// out: one drawn with strokes, with fill="none", or with no shape at all.
const drawnWithStrokes = (svg) => /\sstroke(?:-width)?="(?!none")/i.test(svg) || /\sfill="none"/i.test(svg)
  || !/<(?:path|circle|rect|ellipse|polygon)\b/i.test(svg);

test('every capability icon is filled shapes, not strokes, and each capability with an icon has its file', () => {
  assert.equal(drawnWithStrokes('<svg viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2"><path d="M4 4l16 0"/></svg>'), true);
  assert.equal(drawnWithStrokes('<svg viewBox="0 0 960 960"><g stroke="#000" stroke-width="54"><circle cx="1" cy="1" r="1"/></g></svg>'), true);
  assert.equal(drawnWithStrokes('<svg viewBox="0 0 960 960"><path fill="none" d="M0 0h1"/></svg>'), true);
  assert.equal(drawnWithStrokes('<svg viewBox="0 0 960 960"></svg>'), true);
  assert.equal(drawnWithStrokes('<svg viewBox="0 0 960 960"><path fill="#000" fill-rule="evenodd" d="M0 0h1v1z"/></svg>'), false);
  const icons = fs.readdirSync(path.join(ROOT, 'assets', 'capabilities')).filter((file) => file.endsWith('.svg'));
  assert.deepEqual(icons.sort(), ['sg_connection.svg', 'sg_floor_limit.svg', 'sg_heating.svg', 'sg_window_open.svg']);
  for (const file of icons) assert.equal(drawnWithStrokes(read(`assets/capabilities/${file}`)), false, file);
  const capabilities = fs.readdirSync(path.join(ROOT, '.homeycompose', 'capabilities')).filter((file) => file.endsWith('.json'));
  for (const file of capabilities) {
    const { icon } = JSON.parse(read(`.homeycompose/capabilities/${file}`));
    if (icon) assert.ok(fs.existsSync(path.join(ROOT, icon)), `${file}: ${icon}`);
  }
});

test('the on/off quick action on the tile only with control from Homey on: shown by default, hidden when it is set off, shown again', async () => {
  assert.equal(JSON.parse(read('drivers/sg_thermostat/driver.compose.json')).capabilitiesOptions.onoff, undefined, 'Homey shows it by default');
  // A thermostat just added, control on: shown, nothing set.
  const options = {};
  const { device } = await thermostat({ settings: { control_from_homey: true }, options });
  assert.deepEqual(options, {});
  device._settings.control_from_homey = false;
  await device.onSettings({ newSettings: device._settings, changedKeys: ['control_from_homey'] });
  assert.deepEqual(options.onoff, { uiQuickAction: false });
  assert.ok(device.logs.includes('on/off on the tile hidden: control from Homey off'));
  // Another setting changed: left as it is.
  await device.onSettings({ newSettings: device._settings, changedKeys: ['sensor'] });
  assert.equal(device.logs.filter((line) => line.startsWith('on/off on the tile')).length, 1);
  device._settings.control_from_homey = true;
  await device.onSettings({ newSettings: device._settings, changedKeys: ['control_from_homey'] });
  assert.deepEqual(options.onoff, { uiQuickAction: true });
  assert.ok(device.logs.includes('on/off on the tile shown: control from Homey on'));

  // At start: hidden with control off, shown with it on.
  const off = {};
  await thermostat({ options: off });
  assert.deepEqual(off.onoff, { uiQuickAction: false });
  const on = { onoff: { uiQuickAction: false } };
  await thermostat({ settings: { control_from_homey: true }, options: on });
  assert.deepEqual(on.onoff, { uiQuickAction: true });

  // A failure is logged, and the setting is saved all the same.
  const failing = await thermostat({ settings: { control_from_homey: true }, options: {} });
  failing.device.setCapabilityOptions = async () => { throw new Error('not now'); };
  failing.device._settings.control_from_homey = false;
  await failing.device.onSettings({ newSettings: failing.device._settings, changedKeys: ['control_from_homey'] });
  assert.ok(failing.device.errors.includes('on/off on the tile not hidden: not now'));
});

// ---- control on by default, settings at start, refused changes shown again

test('settings at start: the sensor Floor when it has no valid value; control turned on once for one added while it was off by default', async () => {
  for (const sensor of [undefined, null, '', 'xyz']) {
    const { device } = await thermostat({ settings: { sensor } });
    assert.equal(device._settings.sensor, 'floor', String(sensor));
    assert.ok(device.logs.includes('settings at start: sensor=floor'), String(sensor));
  }
  const room = await thermostat({ settings: { sensor: 'room' } });
  assert.equal(room.device._settings.sensor, 'room');
  assert.ok(!room.device.logs.some((line) => line.startsWith('settings at start')));
  // Added while control was off by default: on once, and so marked.
  const before = await thermostat({ store: { controlOnByDefault: undefined } });
  assert.equal(before.device._settings.control_from_homey, true);
  assert.equal(before.device.getStoreValue('controlOnByDefault'), true);
  assert.ok(before.device.logs.includes('settings at start: control_from_homey=true'));
  // Turned off after that: it stays off at the next start.
  const after = await thermostat({ settings: { control_from_homey: false } });
  assert.equal(after.device._settings.control_from_homey, false);
  // Without the setting at all, control counts as on.
  assert.equal(after.device._controlOn({}), true);
  assert.equal(after.device._controlOn({ control_from_homey: false }), false);
  // A failure is logged, and the flag waits for the next start.
  const failing = new SGThermostatDevice({
    homey: fake.fakeHomey({ ...after.app }), store: { meshId: MESH_ID, prefix: '@MT', locationId: LOC },
    settings: { passphrase: 'test-only-pass', control_from_homey: false, sensor: 'floor' }, data: { id: '@MT1A2B' }, name: 'thermostat',
  });
  failing.hasCapability = () => true;
  failing.setSettings = async () => { throw new Error('busy'); };
  await failing.onInit();
  assert.ok(failing.errors.includes('settings at start not saved: busy'));
  assert.equal(failing.getStoreValue('controlOnByDefault'), undefined);
  // An empty sensor counts as Floor in the faults as well.
  assert.deepEqual(faultsOf(0x04, { room: 21, floor: 24 }, ''), ['FFF']);
  assert.equal(after.device._sensor({ sensor: '' }), 'floor');
});

// The driver as Homey gives it to the device (its entry in app.json).
const driverManifest = () => JSON.parse(read('app.json')).drivers.find((d) => d.id === 'sg_thermostat');

// A thermostat with control off whose capability options and value writes
// are recorded, its status in, and its Flow action card answered as the
// driver answers it (triggerCapabilityListener, as Homey's SDK runs it).
async function refusing() {
  const modeOptions = { uiComponent: null, values: [{ id: 'heat' }, { id: 'off' }] };
  const options = { target_temperature: { min: 5, max: 35, step: 0.5, decimals: 1 }, thermostat_mode: modeOptions };
  const made = await thermostat({ options });
  const { device, listeners } = made;
  device.driver = { manifest: driverManifest() };
  device.applyThermostat('FF5D', { location: LOC, presets: [21, 16, 5] });
  device.applyThermostat('FF05', status({ setPoint: 21 }));
  const values = [];
  const optionsSet = [];
  const setValue = device.setCapabilityValue.bind(device);
  device.setCapabilityValue = async (id, v) => { values.push([id, v]); return setValue(id, v); };
  device.setCapabilityOptions = async (id, v) => { optionsSet.push([id, v]); options[id] = v; };
  device.triggerCapabilityListener = async (id, v) => { await listeners[id](v); await device.setCapabilityValue(id, v); };
  const flowListeners = {};
  const card = (id) => ({ registerRunListener: (fn) => { flowListeners[id] = fn; } });
  await new SGThermostatDriver({ homey: fake.fakeHomey(null, { flow: { getActionCard: card, getConditionCard: card } }) }).onInit();
  const of = (id) => values.filter(([capability]) => capability === id).map(([, v]) => v);
  const settle = async () => { made.homey.runMs(1000); for (let i = 0; i < 10; i += 1) await tick(); };
  return { ...made, options, values, optionsSet, flowListeners, of, settle };
}

test('a refused change is shown again by setting the options unchanged, never the value, so no "changed" card runs; on/off is left alone', async () => {
  await withClock(async () => {
    const { device, sent, listeners, options, values, optionsSet, settle } = await refusing();
    const before = JSON.parse(JSON.stringify(options));
    await assert.rejects(listeners.target_temperature(11), { message: 'thermostat.controlOff' });
    await assert.rejects(listeners.thermostat_mode('off'), { message: 'thermostat.controlOff' });
    await assert.rejects(listeners.sg_heat_preset('eco'), { message: 'thermostat.controlOff' });
    await assert.rejects(listeners.onoff(false), { message: 'thermostat.controlOff' });
    assert.deepEqual(optionsSet, [], 'not before the refusal is through');
    await settle();
    assert.deepEqual(values, [], 'no value set: no "changed" card can run');
    assert.deepEqual(optionsSet.map(([id]) => id), ['target_temperature', 'thermostat_mode', 'sg_heat_preset']);
    assert.deepEqual(optionsSet[0][1], before.target_temperature, 'the same options, so the range stays');
    assert.deepEqual(optionsSet[1][1], before.thermostat_mode);
    assert.deepEqual([value(device, 'target_temperature'), value(device, 'thermostat_mode'), value(device, 'sg_heat_preset')],
      [21, 'heat', 'comfort']);
    assert.ok(device.logs.includes('target_temperature shown again after a refused change'));
    assert.deepEqual(sent, []);
  });
});

test('a refused Flow card gives the preset no change, not even two', async () => {
  await withClock(async () => {
    const { device, flowListeners, values, of, settle } = await refusing();
    await assert.rejects(flowListeners.sg_heat_preset_set({ device, preset: 'eco' }), { message: 'thermostat.controlOff' });
    await settle();
    assert.deepEqual(of('sg_heat_preset'), []);
    assert.equal(value(device, 'sg_heat_preset'), 'comfort');
    assert.deepEqual(values, []);
  });
});

test('a status that comes while a refused change waits to be shown again stands: the old value is not written back', async () => {
  await withClock(async () => {
    const { device, listeners, of, optionsSet, settle } = await refusing();
    await assert.rejects(listeners.target_temperature(30), { message: 'thermostat.controlOff' });
    device.applyThermostat('FF05', status({ setPoint: 22 }));
    await settle();
    assert.deepEqual(of('target_temperature'), [22], 'only the status');
    assert.equal(value(device, 'target_temperature'), 22);
    assert.deepEqual(optionsSet.map(([id]) => id), ['target_temperature']);
  });
});

test('shown again with the driver\'s options under the device\'s own, so a set read empty or in part never drops the hidden mode or the range 5 to 35', async () => {
  const driver = driverManifest().capabilitiesOptions;
  const heatOnly = [{ id: 'heat' }];
  const cases = [
    ['empty', () => ({})],
    ['none', () => undefined],
    ['not read', () => { throw new Error('Invalid Capability'); }],
    ['in part', (id) => ({ target_temperature: { step: 1 }, thermostat_mode: { values: heatOnly } })[id]],
    ['in part, a key without a value', (id) => ({ target_temperature: { min: undefined }, thermostat_mode: { uiComponent: undefined } })[id]],
  ];
  for (const [what, own] of cases) {
    await withClock(async () => {
      const { device, listeners, optionsSet, settle } = await refusing();
      device.getCapabilityOptions = own;
      await assert.rejects(listeners.target_temperature(11), { message: 'thermostat.controlOff' });
      await assert.rejects(listeners.thermostat_mode('off'), { message: 'thermostat.controlOff' });
      await settle();
      const set = Object.fromEntries(optionsSet);
      assert.equal(set.target_temperature.min, 5, what);
      assert.equal(set.target_temperature.max, 35, what);
      assert.ok('uiComponent' in set.thermostat_mode, what);
      assert.equal(set.thermostat_mode.uiComponent, null, what);
      if (what === 'in part') {
        assert.equal(set.target_temperature.step, 1, 'the device\'s own wins');
        assert.deepEqual(set.thermostat_mode.values, heatOnly, 'the device\'s own wins');
      } else {
        assert.deepEqual(set.target_temperature, driver.target_temperature, what);
        assert.deepEqual(set.thermostat_mode, driver.thermostat_mode, what);
      }
    });
  }
});

test('a thermostat mode other than heat and off is refused, and nothing is sent, also with control on', async () => {
  const { device, sent, listeners } = await thermostat({ settings: { control_from_homey: true } });
  device.applyThermostat('FF05', status({ on: true }));
  for (const mode of ['cool', 'auto', undefined]) {
    await assert.rejects(listeners.thermostat_mode(mode), /no such mode/);
  }
  assert.deepEqual(sent, []);
  assert.ok(device.logs.includes('thermostat mode cool refused: only heat and off, nothing sent'));
  await listeners.thermostat_mode('off');
  assert.deepEqual(sent.map(hexOf), ['0102ff425a3c000001']);
});

test('with the real send queue and a slow link: the set point and the preset share a queue, so the last one chosen goes; on/off has its own', async () => {
  const MeshBridge = require('../lib/MeshBridge');
  const app = {
    logs: [], errors: [], seq: 0x800000, log() {}, error() {},
    nextSeq() { app.seq += 1; return app.seq; },
    _devices: () => [], sharedLocation: () => null, statusUnreadableText: () => null,
    csr: { watchThermostat() {}, requestStatus: async () => true, requestNames: async () => true },
  };
  app.homey = fake.fakeHomey(app);
  const bridge = new MeshBridge(app);
  let linkUp;
  const slowLink = new Promise((resolve) => { linkUp = resolve; });
  const parts = [];
  Object.assign(bridge, {
    _ensureTxConnected: () => slowLink,
    _writeFragment: async (name, characteristic, data) => { parts.push(Buffer.from(data)); },
    _sleep: async () => {},
  });
  app.bridge = bridge;
  const device = new SGThermostatDevice({
    homey: app.homey, store: { meshId: MESH_ID, prefix: '@MT', kind: 'thermostat', locationId: LOC, controlOnByDefault: true },
    settings: { passphrase: 'test-only-pass', control_from_homey: true }, data: { id: '@MT1A2B' }, name: 'thermostat',
  });
  device.hasCapability = () => true;
  await device.onInit();
  device.applyThermostat('FF05', status({ on: false, setPoint: 21 }));
  const sends = [device._preset('comfort'), device._setPoint(22), device._power(true, 'onoff'), device._preset('eco')];
  for (let i = 0; i < 5; i += 1) await tick();
  linkUp();
  await Promise.all(sends);
  const packets = [];
  for (let i = 0; i < parts.length; i += 2) packets.push(Buffer.concat([parts[i], parts[i + 1]]));
  assert.deepEqual(packets.map((p) => hexOf(plainOf(p)).slice(0, 14)), ['0102ff035a3c00', '0102ff425a3c01']);
  assert.ok(device.logs.includes('FF03 preset comfort (1 of 3) not sent: replaced by a newer one'));
  assert.ok(device.logs.includes('FF3E set point 22.0 (1 of 3) not sent: replaced by a newer one'));
});

test('a fault in a status counts for the temperatures at once; a pause does not keep min from being chosen; L0 says what the thermostat reads', async () => {
  const { device } = await thermostat();
  device.applyThermostat('FF05', status());
  device.applyThermostat('FF3D', { location: LOC, room: 21.5, floor: 24, floorLimit: 28 });
  assert.equal(value(device, 'measure_temperature.floor'), 24);
  device.applyThermostat('FF05', status({ errors: 0x04 }));
  assert.equal(value(device, 'measure_temperature.floor'), null, 'empty with FFF before the next FF3D');

  await withClock(async (clock) => {
    const on = await thermostat({ settings: { control_from_homey: true } });
    on.device.applyThermostat('FF5D', { location: LOC, presets: [21, 16, 5] });
    on.device.applyThermostat('FF05', status({ setPoint: 21, paused: true }));
    clock.t += 1;
    await on.device._preset('min');
    assert.deepEqual(on.sent.map(hexOf), ['0102ff035a3c02000101'], 'min goes while paused at another temperature');
  });
  const no = JSON.parse(read('locales/no.json'));
  const en = JSON.parse(read('locales/en.json'));
  assert.deepEqual([no.thermostat.fault.L0, en.thermostat.fault.L0], ['Termostaten måler 0 °C (L0).', 'The thermostat reads 0 °C (L0).']);
});
