'use strict';

// The DIN products after the first generation, one driver per product as the
// user sees it: LEDDim Smart DIN and DIN 1000 (also TW), dimmers, with their
// own driver sg_din, "LEDDim Smart DIN", and its icon; Smart DIN 3600, on
// and off only, with sg_plug, as it has the countdown cards there, listed
// with icons/din.svg. They are assumed to be set and read as a dimmable Pill
// and as Smart Plug Gen4: none of them has been tried with a device.
// Made-up values: the location id 0x5a3c and the mesh ids.
// Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fake = require('./helpers/fake-homey');

fake.install();

const { csrDriverFor, csrProductForName, driverForType } = require('../lib/sgProducts');
const {
  foundNote, laterFindings, withStates,
} = require('../lib/csrPairing');
const SGCsrDevice = require('../lib/SGCsrDevice');
const SGDinDevice = require('../drivers/sg_din/device');
const SGDinDriver = require('../drivers/sg_din/driver');
const SGPlugDriver = require('../drivers/sg_plug/driver');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const LOC = 0x5a3c;
const DIN_DIMMERS = ['@MR', '@SR', '@GR', '@MM', '@SM', '@SH', '@GH'];
const node = (meshId, name) => ({
  meshId, name, product: csrProductForName(name), location: LOC,
});

test('the DIN dimmers (DIN, DIN 1000, also TW) are added with sg_din, Smart DIN 3600 with sg_plug', () => {
  for (const prefix of DIN_DIMMERS) {
    const product = csrProductForName(`${prefix}1A2B`);
    assert.equal(product.kind, 'dimmable', prefix);
    assert.equal(product.form, 'din', prefix);
    assert.equal(csrDriverFor(product), 'sg_din', prefix);
  }
  const din3600 = csrProductForName('@GM1A2B');
  assert.deepEqual([din3600.kind, din3600.icon, csrDriverFor(din3600)], ['onoff', 'din', 'sg_plug']);
  // By their type in the SG account, as a device that did not answer is named.
  for (const type of [5, 1005, 2005, 51, 1051, 1060, 2060]) assert.equal(driverForType(type), 'sg_din', `type ${type}`);
  assert.equal(driverForType(2008), 'sg_plug');
  // Still not added: Pill DALI, Push, Floor, Ceiling, a Color Controller.
  for (const prefix of ['@GY', '@SK', '@SF', '@SQ', '@SG']) assert.equal(csrDriverFor(csrProductForName(`${prefix}1A2B`)), null, prefix);
});

test('sg_din: "LEDDim Smart DIN", a light with on/off and dim, the pairing of sg_pill, the network settings, the Pill\'s device class', () => {
  const compose = JSON.parse(read('drivers/sg_din/driver.compose.json'));
  const pill = JSON.parse(read('drivers/sg_pill/driver.compose.json'));
  assert.deepEqual(compose.name, { en: 'LEDDim Smart DIN', no: 'LEDDim Smart DIN' });
  assert.equal(compose.class, 'light');
  assert.deepEqual(compose.capabilities, ['onoff', 'dim']);
  assert.deepEqual(compose.pair, pill.pair, 'the same pairing views as sg_pill');
  assert.deepEqual(compose.images, pill.images, 'its own images, at the same paths in its assets');
  assert.deepEqual(JSON.parse(read('drivers/sg_din/driver.settings.compose.json')), [{ $extends: 'network' }]);
  assert.equal(read('drivers/sg_din/pair/guide.html'), read('drivers/sg_pill/pair/guide.html'), 'the shared guide');
  assert.equal(SGDinDevice, SGCsrDevice);
});

test('the DIN icons are where Homey looks for them: the driver icon of sg_din, and icons/din.svg in sg_plug', () => {
  const icon = read('drivers/sg_din/assets/icon.svg');
  assert.match(icon, /^<svg [^>]*viewBox="0 0 960 960"/, 'a 960 x 960 canvas');
  assert.doesNotMatch(icon, /<image|<script|base64|href="http/i, 'lines only');
  assert.equal(read('drivers/sg_plug/assets/icons/din.svg'), icon, 'the same icon for Smart DIN 3600');
  for (const file of ['drivers/sg_din/assets/icon.svg', 'drivers/sg_plug/assets/icons/din.svg']) {
    assert.equal(fs.statSync(path.join(ROOT, file)).mode & 0o777, 0o644, file);
  }
  assert.ok(!fs.existsSync(path.join(ROOT, 'drivers/sg_mesh/assets/icons')), 'none in sg_mesh');
  assert.ok(!fs.existsSync(path.join(ROOT, 'drivers/sg_din/assets/icons')), 'sg_din lists its devices with the driver icon');
  assert.ok(!fs.existsSync(path.join(ROOT, 'drivers/sg_din/assets/guide')), 'no picture in the guide: its room goes');
  for (const size of ['small', 'large', 'xlarge']) {
    assert.ok(fs.existsSync(path.join(ROOT, `drivers/sg_din/assets/images/${size}.png`)), `the ${size} driver image`);
  }
});

// A driver's pairing search with a scan that saw these names and FF11
// answers from these nodes.
async function search(Driver, names, nodes) {
  const app = {
    logs: [],
    errors: [],
    seq: 0x800000,
    log(...args) { app.logs.push(args.join(' ')); },
    error(...args) { app.errors.push(args.join(' ')); },
    getNetworkKey: () => Buffer.alloc(16),
    nextSeq() { app.seq += 1; return app.seq; },
    bridge: { send: async () => ({ ok: true }) },
    _devices: () => [],
    locationFor: () => null,
  };
  app.csr = fake.fakeCsr(nodes);
  const advertisements = names.map((name, i) => ({ uuid: `02000000000${i}`, localName: name, rssi: -60 }));
  const driver = new Driver({ homey: fake.listenAtOnce(fake.fakeHomey(app, { ble: { discover: async () => advertisements } })) });
  driver.getDevices = () => [];
  return driver._search();
}

test('pairing: sg_din lists a DIN dimmer with on/off and dim and the driver\'s icon', async () => {
  const { devices } = await search(SGDinDriver, ['@SR1A2B', '@GH3C4D'], [node(0x0123, '@SR1A2B'), node(0x0124, '@GH3C4D')]);
  assert.deepEqual(devices.map((d) => d.data.id).sort(), ['@GH3C4D', '@SR1A2B']);
  const din = devices.find((d) => d.data.id === '@SR1A2B');
  assert.equal(din.name, 'LEDDim Smart DIN 1A2B');
  assert.equal(din.icon, undefined);
  assert.deepEqual(din.capabilities, ['onoff', 'dim']);
  assert.deepEqual(din.store, {
    meshId: 0x0123, prefix: '@SR', kind: 'dimmable', tunableWhite: true, locationId: LOC,
  });
});

test('pairing: sg_plug lists Smart DIN 3600 with on/off and the DIN icon, next to a Smart Plug with its own', async () => {
  const { devices } = await search(SGPlugDriver, ['@GM5E6F', '@GP7A8B'], [node(0x0125, '@GM5E6F'), node(0x0126, '@GP7A8B')]);
  const din3600 = devices.find((d) => d.data.id === '@GM5E6F');
  assert.equal(din3600.name, 'Smart DIN 3600 5E6F');
  assert.equal(din3600.icon, '/icons/din.svg');
  assert.deepEqual(din3600.capabilities, ['onoff']);
  assert.equal(devices.find((d) => d.data.id === '@GP7A8B').icon, '/icons/plug.svg');
});

// What a driver's list says when it found these and nothing of its own.
const note = (driverId, ...names) => foundNote(withStates(laterFindings([], names.map((name, i) => node(0x0130 + i, name))), driverId, new Set()),
  (key, tokens) => `${key}${tokens ? ` ${JSON.stringify(tokens)}` : ''}`, driverId);

test('the references in the pairing: a DIN dimmer found elsewhere goes to "LEDDim Smart DIN", Smart DIN 3600 to the plug driver', () => {
  const din = 'pair.found.goToDin {"products":"LEDDim Smart DIN"}';
  assert.equal(note('sg_mesh', '@SR1A2B'), `pair.found.noDimmer ${din}`);
  assert.equal(note('sg_pill', '@GH1A2B'), 'pair.found.noPill pair.found.goToDin {"products":"LEDDim Smart DIN 1000 (TW)"}');
  assert.equal(note('sg_din', '@GD1A2B'), 'pair.found.noDin pair.found.goToDimmer {"products":"LEDDim Smart"}');
  assert.equal(note('sg_din', '@SC1A2B'), 'pair.found.noDin pair.found.goToPill {"products":"LEDDim Smart Pill"}');
  for (const driverId of ['sg_mesh', 'sg_pill', 'sg_din']) {
    assert.match(note(driverId, '@GM1A2B'), /pair\.found\.goToPlug \{"products":"Smart DIN 3600"\}$/, driverId);
  }
  assert.equal(note('sg_plug', '@SR1A2B'), `pair.found.noPlug ${din}`);
});
