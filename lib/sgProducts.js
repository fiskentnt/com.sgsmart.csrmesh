'use strict';

// SG's CSRmesh products after the first generation, by the prefix of their
// Bluetooth name. @M is taken as Gen2 (assumed), @S as Gen3 and @G as Gen4.
// The first generation dimmer (@ND) is not here: it has its own driver
// (sg_mesh).
//
// kind: dimmable, onoff, switch, sensor or thermostat. form: our word for
// what the product is (pill, rotary, din, plug, socket, push, floor, ceiling,
// colour, switch, sensor, thermostat), for the icon and the drivers.
// tunableWhite: the product can be set to tunable white, so FF03 carries a
// white value.
const CSR_PRODUCTS = {
  '@MD': { name: "LEDDim Smart", generation: 'Gen2', kind: 'dimmable', form: 'rotary', tunableWhite: false },
  '@MP': { name: "Smart Plug", generation: 'Gen2', kind: 'onoff', form: 'plug', tunableWhite: false },
  '@MC': { name: "LEDDim Smart Pill", generation: 'Gen2', kind: 'dimmable', form: 'pill', tunableWhite: false },
  '@MR': { name: "LEDDim Smart DIN", generation: 'Gen2', kind: 'dimmable', form: 'din', tunableWhite: false },
  '@MI': { name: "Smart PIRLux Sensor", generation: 'Gen2', kind: 'sensor', form: 'sensor', tunableWhite: false },
  '@MO': { name: "LEDDim Smart Pill Micro", generation: 'Gen2', kind: 'dimmable', form: 'pill', tunableWhite: false },
  '@MS': { name: "Smart Switch", generation: 'Gen2', kind: 'switch', form: 'switch', tunableWhite: false },
  '@MK': { name: "LEDDim Smart Push", generation: 'Gen2', kind: 'dimmable', form: 'push', tunableWhite: false },
  '@MW': { name: "TW LEDDim Smart", generation: 'Gen2', kind: 'dimmable', form: 'rotary', tunableWhite: true },
  '@ME': { name: "Smart Pill ON-OFF", generation: 'Gen2', kind: 'onoff', form: 'pill', tunableWhite: false },
  '@MN': { name: "Smart Pill ON-OFF Micro", generation: 'Gen2', kind: 'onoff', form: 'pill', tunableWhite: false },
  '@MX': { name: "Smart Switch", generation: 'Gen2', kind: 'switch', form: 'switch', tunableWhite: false },
  '@MT': { name: "HeatReg Smart", generation: 'Gen2', kind: 'thermostat', form: 'thermostat', tunableWhite: false },
  '@MB': { name: "LEDDim Smart Master", generation: 'Gen2', kind: 'dimmable', form: 'rotary', tunableWhite: false },
  '@MU': { name: "TW LEDDim Smart Push", generation: 'Gen2', kind: 'dimmable', form: 'push', tunableWhite: true },
  '@MJ': { name: "TW LEDDim Smart Pill", generation: 'Gen2', kind: 'dimmable', form: 'pill', tunableWhite: true },
  '@MF': { name: "LEDDim Smart Floor", generation: 'Gen2', kind: 'dimmable', form: 'floor', tunableWhite: false },
  '@MM': { name: "LEDDim Smart DIN 1000", generation: 'Gen2', kind: 'dimmable', form: 'din', tunableWhite: true },
  '@SP': { name: "Smart Plug", generation: 'Gen3', kind: 'onoff', form: 'plug', tunableWhite: false },
  '@SC': { name: "LEDDim Smart Pill", generation: 'Gen3', kind: 'dimmable', form: 'pill', tunableWhite: false },
  '@SR': { name: "LEDDim Smart DIN", generation: 'Gen3', kind: 'dimmable', form: 'din', tunableWhite: true },
  '@SI': { name: "Smart PIRLux Sensor", generation: 'Gen3', kind: 'sensor', form: 'sensor', tunableWhite: false },
  '@SO': { name: "LEDDim Smart Pill Micro", generation: 'Gen3', kind: 'dimmable', form: 'pill', tunableWhite: false },
  '@SK': { name: "LEDDim Smart Push", generation: 'Gen3', kind: 'dimmable', form: 'push', tunableWhite: true },
  '@SW': { name: "TW LEDDim Smart", generation: 'Gen3', kind: 'dimmable', form: 'rotary', tunableWhite: true },
  '@SE': { name: "Smart Pill ON-OFF", generation: 'Gen3', kind: 'onoff', form: 'pill', tunableWhite: false },
  '@SN': { name: "Smart Pill ON-OFF Micro", generation: 'Gen3', kind: 'onoff', form: 'pill', tunableWhite: false },
  '@SS': { name: "Smart Wireless", generation: 'Gen3', kind: 'switch', form: 'switch', tunableWhite: false },
  '@SX': { name: "Smart Switch", generation: 'Gen3', kind: 'switch', form: 'switch', tunableWhite: false },
  '@ST': { name: "HeatReg Smart", generation: 'Gen3', kind: 'thermostat', form: 'thermostat', tunableWhite: false },
  '@SB': { name: "LEDDim Smart Master", generation: 'Gen3', kind: 'dimmable', form: 'rotary', tunableWhite: false },
  '@SA': { name: "LEDDim Smart Master", generation: 'Gen3', kind: 'dimmable', form: 'rotary', tunableWhite: false },
  '@SJ': { name: "TW LEDDim Smart Pill", generation: 'Gen3', kind: 'dimmable', form: 'pill', tunableWhite: true },
  '@SF': { name: "LEDDim Smart Floor", generation: 'Gen3', kind: 'dimmable', form: 'floor', tunableWhite: false },
  '@SQ': { name: "LEDDim Smart Ceiling", generation: 'Gen3', kind: 'dimmable', form: 'ceiling', tunableWhite: true },
  '@SM': { name: "LEDDim Smart DIN 1000", generation: 'Gen3', kind: 'dimmable', form: 'din', tunableWhite: true },
  '@SH': { name: "LEDDim Smart DIN 1000 (TW)", generation: 'Gen3', kind: 'dimmable', form: 'din', tunableWhite: true },
  '@SG': { name: "LEDDim Smart Color Controller", generation: 'Gen3', kind: 'dimmable', form: 'colour', tunableWhite: true },
  '@SU': { name: "LEDDim Smart Color Controller", generation: 'Gen3', kind: 'dimmable', form: 'colour', tunableWhite: true },
  '@SD': { name: "LEDDim Smart", generation: 'Gen3', kind: 'dimmable', form: 'rotary', tunableWhite: false },
  '@SL': { name: "LEDDim Smart 400 2-pole", generation: 'Gen3', kind: 'dimmable', form: 'rotary', tunableWhite: false },
  '@GP': { name: "Smart Plug", generation: 'Gen4', kind: 'onoff', form: 'plug', tunableWhite: false },
  '@GB': { name: "Smart Socket", generation: 'Gen4', kind: 'onoff', form: 'socket', tunableWhite: false },
  '@GC': { name: "LEDDim Smart Pill", generation: 'Gen4', kind: 'dimmable', form: 'pill', tunableWhite: false },
  '@GR': { name: "LEDDim Smart DIN", generation: 'Gen4', kind: 'dimmable', form: 'din', tunableWhite: true },
  '@GI': { name: "Smart PIRLux Sensor", generation: 'Gen4', kind: 'sensor', form: 'sensor', tunableWhite: false },
  '@GO': { name: "LEDDim Smart Pill Micro", generation: 'Gen4', kind: 'dimmable', form: 'pill', tunableWhite: false },
  '@GM': { name: "Smart DIN 3600", generation: 'Gen4', kind: 'onoff', form: 'din', tunableWhite: false },
  '@GK': { name: "LEDDim Smart Push", generation: 'Gen4', kind: 'dimmable', form: 'push', tunableWhite: true },
  '@GW': { name: "TW LEDDim Smart", generation: 'Gen4', kind: 'dimmable', form: 'rotary', tunableWhite: true },
  '@GE': { name: "Smart Pill ON-OFF", generation: 'Gen4', kind: 'onoff', form: 'pill', tunableWhite: false },
  '@GN': { name: "Smart Pill ON-OFF Micro", generation: 'Gen4', kind: 'onoff', form: 'pill', tunableWhite: false },
  '@GY': { name: "LEDDim Smart Pill DALI", generation: 'Gen4', kind: 'dimmable', form: 'pill', tunableWhite: false },
  '@GS': { name: "Smart Wireless", generation: 'Gen4', kind: 'switch', form: 'switch', tunableWhite: false },
  '@GX': { name: "Smart Switch", generation: 'Gen4', kind: 'switch', form: 'switch', tunableWhite: false },
  '@GA': { name: "LEDDim Smart Master", generation: 'Gen4', kind: 'dimmable', form: 'rotary', tunableWhite: false },
  '@GJ': { name: "TW LEDDim Smart Pill", generation: 'Gen4', kind: 'dimmable', form: 'pill', tunableWhite: true },
  '@GF': { name: "LEDDim Smart Floor", generation: 'Gen4', kind: 'dimmable', form: 'floor', tunableWhite: false },
  '@GQ': { name: "LEDDim Smart Ceiling", generation: 'Gen4', kind: 'dimmable', form: 'ceiling', tunableWhite: true },
  '@GH': { name: "LEDDim Smart DIN 1000 (TW)", generation: 'Gen4', kind: 'dimmable', form: 'din', tunableWhite: true },
  '@GG': { name: "LEDDim Smart Color Controller", generation: 'Gen4', kind: 'dimmable', form: 'colour', tunableWhite: true },
  '@GU': { name: "LEDDim Smart Color Controller", generation: 'Gen4', kind: 'dimmable', form: 'colour', tunableWhite: true },
  '@GD': { name: "LEDDim Smart", generation: 'Gen4', kind: 'dimmable', form: 'rotary', tunableWhite: false },
  '@GL': { name: "LEDDim Smart 400 2-pole", generation: 'Gen4', kind: 'dimmable', form: 'rotary', tunableWhite: false },
};

// Lights and plugs, which are set with FF03. Switches, sensors and thermostats
// send by themselves and are not planned as devices.
const CONTROLLED_KINDS = ['dimmable', 'onoff'];

// What can be added in 2.5.0: the LEDDim Smart rotary dimmers (also TW, 2-pole
// and Master), with sg_mesh next to the first generation, and the Pill family,
// with sg_pill. LEDDim Smart Pill DALI (@GY) and the other products are found,
// but cannot be added yet.
const ROTARY_PREFIXES = ['@MD', '@SD', '@GD', '@SL', '@GL', '@MW', '@SW', '@GW', '@MB', '@SB', '@SA', '@GA'];
const PILL_PREFIXES = [
  '@MC', '@SC', '@GC', '@MO', '@SO', '@GO', '@MJ', '@SJ', '@GJ', '@ME', '@SE', '@GE', '@MN', '@SN', '@GN',
];

// The driver that adds a product, or null when none does in this version.
function csrDriverFor(product) {
  if (product && ROTARY_PREFIXES.includes(product.prefix)) return 'sg_mesh';
  if (product && PILL_PREFIXES.includes(product.prefix)) return 'sg_pill';
  return null;
}

// The icon of a product in the device list and on the device, by its form:
// drivers/sg_pill/assets/icons/<icon>.svg. Only the Pill has one: sg_pill
// lists each Pill with it, and sg_mesh lists its dimmers with the driver
// icon. Switches, sensors and thermostats are not added, so they have none.
const ICONS = { pill: 'pill' };
const ICON_NAMES = [...new Set(Object.values(ICONS))];

function csrIcon(product) {
  if (!CONTROLLED_KINDS.includes(product.kind)) return null;
  return ICONS[product.form] || null;
}

// The product for a Bluetooth name such as @SC1A2B, or null.
function csrProductForName(name) {
  const match = /^(@[A-Z][A-Z0-9])/.exec(String(name || '').trim().toUpperCase());
  if (!match || !CSR_PRODUCTS[match[1]]) return null;
  const product = CSR_PRODUCTS[match[1]];
  return { prefix: match[1], ...product, icon: csrIcon(product) };
}

// 16-bit form of a service UUID as Homey gives it (with or without dashes).
function shortUuid(uuid) {
  const s = String(uuid || '').toLowerCase().replace(/-/g, '');
  const base = /^0000([0-9a-f]{4})00001000800000805f9b34fb$/.exec(s);
  return base ? base[1] : s;
}

// A node that advertises the CSRmesh service (FEF1).
function isCsrmeshAdvertisement(adv) {
  return ((adv && adv.serviceUuids) || []).some((uuid) => shortUuid(uuid) === 'fef1');
}

// A Bluetooth name Homey may connect to as a bridge: one that starts with
// @N, @M, @S or @G, but not a switch (@MS, @MX, @SS, @SX, @GS, @GX), @MG or
// @GG, which are assumed not to serve as a bridge (not tried).
const BRIDGE_PREFIX = /^@[NMSG]/;
const NOT_BRIDGE = ['@MS', '@MX', '@SS', '@SX', '@GS', '@GX', '@MG', '@GG'];

function canBeBridge(name) {
  const upper = String(name || '').trim().toUpperCase();
  return BRIDGE_PREFIX.test(upper) && !NOT_BRIDGE.includes(upper.slice(0, 3));
}

module.exports = {
  CONTROLLED_KINDS, CSR_PRODUCTS, ICON_NAMES, PILL_PREFIXES, ROTARY_PREFIXES,
  canBeBridge, csrDriverFor, csrProductForName, isCsrmeshAdvertisement, shortUuid,
};

