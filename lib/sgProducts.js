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
  '@SS': { name: "Smart Rotary Switch", generation: 'Gen3', kind: 'switch', form: 'switch', tunableWhite: false },
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
  '@GS': { name: "Smart Rotary Switch", generation: 'Gen4', kind: 'switch', form: 'switch', tunableWhite: false },
  '@GX': { name: "Smart Switch", generation: 'Gen4', kind: 'switch', form: 'switch', tunableWhite: false },
  '@GA': { name: "LEDDim Smart Master", generation: 'Gen4', kind: 'dimmable', form: 'rotary', tunableWhite: false },
  '@GJ': { name: "TW LEDDim Smart Pill", generation: 'Gen4', kind: 'dimmable', form: 'pill', tunableWhite: true },
  '@GF': { name: "LEDDim Smart Floor", generation: 'Gen4', kind: 'dimmable', form: 'floor', tunableWhite: false },
  '@GQ': { name: "LEDDim Smart Ceiling", generation: 'Gen4', kind: 'dimmable', form: 'ceiling', tunableWhite: true },
  '@GH': { name: "LEDDim Smart DIN 1000 (TW)", generation: 'Gen4', kind: 'dimmable', form: 'din', tunableWhite: true },
  // No @GG: a gateway's own node may have that name too (assumed), so a
  // node named @GG is not taken for a Color Controller.
  '@GU': { name: "LEDDim Smart Color Controller", generation: 'Gen4', kind: 'dimmable', form: 'colour', tunableWhite: true },
  '@GD': { name: "LEDDim Smart", generation: 'Gen4', kind: 'dimmable', form: 'rotary', tunableWhite: false },
  '@GL': { name: "LEDDim Smart 400 2-pole", generation: 'Gen4', kind: 'dimmable', form: 'rotary', tunableWhite: false },
};

// Lights and plugs, which are set with FF03.
const CONTROLLED_KINDS = ['dimmable', 'onoff'];

// What can be added: the LEDDim Smart rotary dimmers (also TW, 2-pole and
// Master), with sg_mesh next to the first generation, the Pill family, with
// sg_pill, Smart Plug and Smart Socket, with sg_plug, and HeatReg Smart, with
// sg_thermostat. LEDDim Smart Pill DALI (@GY), Smart DIN 3600 (@GM) and the
// other products are found, but cannot be added yet.
const ROTARY_PREFIXES = ['@MD', '@SD', '@GD', '@SL', '@GL', '@MW', '@SW', '@GW', '@MB', '@SB', '@SA', '@GA'];
const PILL_PREFIXES = [
  '@MC', '@SC', '@GC', '@MO', '@SO', '@GO', '@MJ', '@SJ', '@GJ', '@ME', '@SE', '@GE', '@MN', '@SN', '@GN',
];
const PLUG_PREFIXES = ['@MP', '@SP', '@GP', '@GB'];
const THERMOSTAT_PREFIXES = ['@MT', '@ST'];

// Smart Plug @MP and @SP are recalled by SG (risk of electric shock and
// fire), told by the Bluetooth name alone. No driver offers them when a
// device is added; one added before keeps sg_plug, shows a warning, and can
// still be turned on and off, so it can be turned off from Homey.
const RECALLED_PREFIXES = ['@MP', '@SP'];

// The driver that adds a product, or null when none does in this version.
function csrDriverFor(product) {
  if (product && ROTARY_PREFIXES.includes(product.prefix)) return 'sg_mesh';
  if (product && PILL_PREFIXES.includes(product.prefix)) return 'sg_pill';
  if (product && PLUG_PREFIXES.includes(product.prefix)) return 'sg_plug';
  if (product && THERMOSTAT_PREFIXES.includes(product.prefix)) return 'sg_thermostat';
  return null;
}

// The icon of a product in the device list and on the device, by its form:
// drivers/<driver>/assets/icons/<icon>.svg in the driver that adds it. The
// Pill has one in sg_pill, Smart Plug and Smart Socket theirs in sg_plug;
// sg_mesh and sg_thermostat list theirs with the driver icon. Switches and
// sensors have none.
const ICONS = { pill: 'pill', plug: 'plug', socket: 'socket' };
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

// The type of a device in the SG account's device list (lib/account.js), a number,
// by the prefix of the product it is assumed to be. Only 101, the first
// generation dimmer, is tried; the rest is assumed. 3000 to 3999 is SG Smart
// 3.0. The prefix of a device's Bluetooth name always decides what it is
// when there is one; the type decides only for a device whose prefix is
// unknown here, names a device in the account that did not answer, and a
// type that disagrees with the prefix is logged.
const FIRST_GENERATION_TYPE = 101;
const TYPE_PREFIXES = {
  // Gen2
  1: '@MD', 2: '@MP', 4: '@MC', 5: '@MR', 6: '@MI', 7: '@MO', 11: '@MS', 12: '@MK', 13: '@MW', 14: '@ME', 16: '@MN',
  19: '@MX', 21: '@MT', 22: '@MB', 25: '@MU', 26: '@MJ', 31: '@MF', 51: '@MM',
  // Gen3
  1002: '@SP', 1004: '@SC', 1005: '@SR', 1006: '@SI', 1007: '@SO', 1012: '@SK', 1013: '@SW', 1014: '@SE', 1016: '@SN',
  1018: '@SS', 1019: '@SX', 1021: '@ST', 1022: '@SB', 1023: '@SA', 1026: '@SJ', 1031: '@SF', 1035: '@SQ', 1051: '@SM',
  1060: '@SH', 1070: '@SG', 1071: '@SU', 1080: '@SD', 1081: '@SL',
  // Gen4
  2002: '@GP', 2003: '@GB', 2004: '@GC', 2005: '@GR', 2006: '@GI', 2007: '@GO', 2008: '@GM', 2012: '@GK', 2013: '@GW',
  2014: '@GE', 2016: '@GN', 2017: '@GY', 2018: '@GS', 2019: '@GX', 2023: '@GA', 2026: '@GJ', 2031: '@GF', 2035: '@GQ',
  2060: '@GH', 2070: '@GU', 2071: '@GU', 2080: '@GD', 2081: '@GL',
};

// The SG Smart 3.0 products this build adds, by their type in the account:
// the two dimmers, in LEDDim Smart 3.0 (sg3_dimmer). The other 3.0 types
// wait for a later build.
// bridge says whether Homey's link may go through the product: yes for one
// on mains power, as a dimmer; no for a battery switch or a gateway, when
// such a type is added.
const SG3_PRODUCTS = Object.freeze({
  3080: Object.freeze({ name: 'LEDDim Smart 3.0', driver: 'sg3_dimmer', bridge: true }),
  3081: Object.freeze({ name: 'LEDDim Smart 2-pole 3.0', driver: 'sg3_dimmer', bridge: true }),
});

// Whether a 3.0 type may carry Homey's link (SG3_PRODUCTS, bridge); a type
// not known here may not.
function sg3CanBeBridge(type) {
  const product = Object.prototype.hasOwnProperty.call(SG3_PRODUCTS, type) ? SG3_PRODUCTS[type] : null;
  return Boolean(product && product.bridge === true);
}

// What a type in the account is: 'gen1', 'csr' (a later CSRmesh product,
// known here or not), or 'sg3'.
function familyForType(type) {
  if (type === FIRST_GENERATION_TYPE) return 'gen1';
  if (Number.isInteger(type) && type >= 3000 && type <= 3999) return 'sg3';
  return 'csr';
}

// The product of a type in the account, as csrProductForName gives one, or
// null when the type is not known here (the first generation and 3.0 have
// none).
function csrProductForType(type) {
  const prefix = TYPE_PREFIXES[type];
  return prefix ? csrProductForName(prefix) : null;
}

// The driver a type in the account is assumed to belong to, or null.
function driverForType(type) {
  if (familyForType(type) === 'gen1') return 'sg_mesh';
  return csrDriverFor(csrProductForType(type));
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
  CONTROLLED_KINDS, CSR_PRODUCTS, FIRST_GENERATION_TYPE, ICON_NAMES, PILL_PREFIXES, PLUG_PREFIXES, RECALLED_PREFIXES, SG3_PRODUCTS,
  ROTARY_PREFIXES, THERMOSTAT_PREFIXES, TYPE_PREFIXES, canBeBridge, csrDriverFor, csrProductForName, csrProductForType,
  sg3CanBeBridge,
  driverForType, familyForType, isCsrmeshAdvertisement, shortUuid,
};

