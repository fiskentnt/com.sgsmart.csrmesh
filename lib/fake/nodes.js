'use strict';

const {
  ADDR_BROADCAST, OP_EXT_LEVEL, OP_EXT_NAME, OP_EXT_NAME_GET, OP_EXT_STATUS, OP_EXT_STATUS_GET,
  OP_EXT_THERMOSTAT_GET, OP_EXT_THERMOSTAT_POWER, OP_EXT_THERMOSTAT_PRESETS, OP_EXT_THERMOSTAT_SET_POINT,
  OP_EXT_THERMOSTAT_SETTINGS, OP_EXT_THERMOSTAT_TEMPERATURES, opcodeValue,
} = require('../sgProtocol');
const { csrProductForName } = require('../sgProducts');

// The fake devices themselves (lib/fake/index.js): their state, and what
// they answer. An answer is built in the format lib/sgProtocol.js reads, so
// it goes through the same reading as a real device's. Those formats are
// this app's own and assumed: a fake answer shows that the app reads what it
// expects, not that a real device sends it.

const LEVEL = opcodeValue(OP_EXT_LEVEL);
const STATUS_GET = opcodeValue(OP_EXT_STATUS_GET);
const STATUS = opcodeValue(OP_EXT_STATUS);
const NAME_GET = opcodeValue(OP_EXT_NAME_GET);
const NAME = opcodeValue(OP_EXT_NAME);
const THERMOSTAT_GET = opcodeValue(OP_EXT_THERMOSTAT_GET);
const TEMPERATURES = opcodeValue(OP_EXT_THERMOSTAT_TEMPERATURES);
const SETTINGS = opcodeValue(OP_EXT_THERMOSTAT_SETTINGS);
const PRESETS = opcodeValue(OP_EXT_THERMOSTAT_PRESETS);
const SET_POINT = opcodeValue(OP_EXT_THERMOSTAT_SET_POINT);
const POWER = opcodeValue(OP_EXT_THERMOSTAT_POWER);
// A fake device's firmware, in FF05.
const FIRMWARE = [0x01, 0x00];
// An FF03 whose tid is not newer than the last one taken within this many
// whole seconds is dropped, as a real device is assumed to (lib/SGCsrDevice.js).
const TID_RESET_S = 10;

const hex4 = (value) => `0x${value.toString(16).padStart(4, '0')}`;
const locationBytes = (location) => [(location >> 8) & 0xff, location & 0xff];
const temperatureBytes = (t) => [Math.floor(Math.round(t * 10) / 10), Math.round(t * 10) % 10];
const temperatureOf = (whole, tenths) => (whole * 10 + tenths) / 10;

// A device in a home, as it is assumed to be (none after the first
// generation has been tried): its home's location id and a mesh id of its
// own, and a message is taken only with that location id. Its name is the
// product's prefix and the last four characters of its Bluetooth address
// (address, 12 hex characters), which have nothing to do with its mesh id.
// drop: the first that many answers it would give are lost on the way.
class FakeNode {
  constructor({
    prefix, meshId, location, address, drop = 0, now = () => Date.now(),
  }) {
    if (!/^[0-9a-f]{12}$/i.test(String(address || ''))) throw new Error('a fake device needs a Bluetooth address (12 hex characters)');
    this.meshId = meshId;
    this.location = location;
    this.address = String(address).toLowerCase();
    this.name = `${prefix}${this.address.slice(-4).toUpperCase()}`;
    this.product = csrProductForName(this.name);
    this.now = now;
    this.drop = drop;
    // Ordered with "silent": it answers nothing until "answer".
    this.silent = false;
    // What it did not take, for the log (lib/fake/bridge.js takes them).
    this.notes = [];
  }

  toString() {
    return `${this.name} (${hex4(this.meshId)})`;
  }

  // A message on the fake radio ({ dst, opcode, data }): the answers, as
  // [{ opcode, data }], or none. Only with its location id: FF10 to
  // everyone or to its mesh id gets FF11, anything else must be to its mesh
  // id. 00 00 or another location id gets nothing.
  receive({ dst, opcode, data }) {
    if (this.silent) return [];
    if (data.length < 2 || data.readUInt16BE(0) !== this.location) return [];
    let answers;
    if (opcode === NAME_GET && (dst === ADDR_BROADCAST || dst === this.meshId)) answers = [this.nameMessage()];
    else if (dst === this.meshId) answers = this.command(opcode, data);
    else return [];
    if (answers.length && this.drop > 0) {
      this.drop -= 1;
      this.notes.push(`answer to ${opcode.toString(16).toUpperCase()} lost on the way (${this.drop} more to lose)`);
      return [];
    }
    return answers;
  }

  // FF11: location id, the six characters after @, the number of resets.
  nameMessage() {
    return { opcode: NAME, data: Buffer.from([...locationBytes(this.location), ...Buffer.from(this.name.slice(1), 'latin1'), 0]) };
  }

  command() {
    return [];
  }

  // An order (lib/fake/index.js): what it sends by itself now, as
  // [{ opcode, data }], or null when this node does not know the order.
  order(event) {
    if (event === 'silent') {
      this.silent = true;
      return [];
    }
    if (event === 'answer') {
      this.silent = false;
      return [];
    }
    if (event === 'name') return [this.nameMessage()];
    // Its status as it is, as when someone else in the home asked for it.
    if (event === 'status' && typeof this.status === 'function') return [this.status()];
    return null;
  }
}

// A Pill, a rotary dimmer after the first generation, a Smart Plug or a
// Smart Socket: with dimming or with on and off alone, and with a white value
// when the product has one.
class FakeLight extends FakeNode {
  constructor(options) {
    super(options);
    this.on = false;
    this.level = 50;
    this.white = 0;
    this.number = 0;
    this._tid = null;
    this._tidAt = 0;
  }

  get dimmable() {
    return this.product.kind === 'dimmable';
  }

  command(opcode, data) {
    if (opcode === STATUS_GET) return [this.status()];
    if (opcode !== LEVEL || data.length < 6) return [];
    const tid = data.readUInt16LE(4);
    const seconds = Math.floor((this.now() - this._tidAt) / 1000);
    if (this._tid !== null && seconds <= TID_RESET_S && tid <= this._tid) {
      this.notes.push(`FF03 tid=${tid} dropped: not newer than ${this._tid} within ${TID_RESET_S} s`);
      return [];
    }
    this._tid = tid;
    this._tidAt = this.now();
    this.on = data[2] !== 0;
    if (this.on && this.dimmable && data[3] >= 1 && data[3] <= 100) this.level = data[3];
    // White 0 means none set.
    if (this.product.tunableWhite && data.length >= 7 && data[6] > 0) this.white = data[6];
    return [this.status()];
  }

  // FF05: location id, power, level, a number one up each time, firmware,
  // and the white value and flags for a product that has white.
  status() {
    this.number = (this.number + 1) & 0xff;
    const bytes = [...locationBytes(this.location), this.on ? 1 : 0, this.on && this.dimmable ? this.level : 0,
      this.number, ...FIRMWARE];
    if (this.product.tunableWhite) bytes.push(this.white, 0);
    return { opcode: STATUS, data: Buffer.from(bytes) };
  }

  // Changed on the device itself: "on", "off", "level <1..100>", "white
  // <1..255>". Its status goes out by itself.
  order(event, value) {
    const known = super.order(event);
    if (known) return known;
    const number = Number(value);
    if (event === 'on' || event === 'off') {
      this.on = event === 'on';
    } else if (event === 'level' && this.dimmable && Number.isInteger(number) && number >= 1 && number <= 100) {
      this.on = true;
      this.level = number;
    } else if (event === 'white' && this.product.tunableWhite && Number.isInteger(number) && number >= 1 && number <= 255) {
      this.white = number;
    } else {
      return null;
    }
    return [this.status()];
  }
}

// A HeatReg Smart: on and off, its set point, the relay, its open window
// function (the heating paused after a sudden fall in temperature), the room
// and floor temperatures, its presets, and faults on order. It heats while
// on, not paused, and the room below the set point.
// The fault orders set FF05 byte 8 as lib/SGThermostatDevice.js reads it.
const FAULTS = { none: 0x00, FFF: 0x04, E1: 0x08, E2: 0x10, EEE: 0x40, limit: 0x80 };

class FakeThermostat extends FakeNode {
  constructor(options) {
    super(options);
    this.on = true;
    this.setPoint = 21;
    this.window = false;
    this.paused = false;
    this.errors = 0;
    this.room = 20.5;
    this.floor = 24;
    this.floorLimit = 28;
    this.presets = { comfort: 21, eco: 16, min: 5 };
    this.heatingOrdered = null;
    this._tid = null;
    this._tidAt = 0;
  }

  get heating() {
    if (this.heatingOrdered !== null) return this.heatingOrdered;
    return this.on && !this.window && this.room < this.setPoint;
  }

  // A setting with a tid that is not newer than the last one within
  // TID_RESET_S is dropped.
  _newTid(tid) {
    const seconds = Math.floor((this.now() - this._tidAt) / 1000);
    if (this._tid !== null && seconds <= TID_RESET_S && tid <= this._tid) {
      this.notes.push(`setting with tid=${tid} dropped: not newer than ${this._tid} within ${TID_RESET_S} s`);
      return false;
    }
    this._tid = tid;
    this._tidAt = this.now();
    return true;
  }

  command(opcode, data) {
    if (opcode === STATUS_GET) return [this.status()];
    if (opcode === THERMOSTAT_GET && data.length >= 3) {
      return [[this.temperatures()], [this.settings()], [this.presetsMessage()]][data[2]] || [];
    }
    if (opcode === SET_POINT && data.length >= 6) {
      if (!this._newTid(data[5])) return [];
      this.setPoint = temperatureOf(data[2], data[3]);
      this.paused = false;
      return [this.status()];
    }
    if (opcode === POWER && data.length >= 5) {
      if (!this._newTid(data[4])) return [];
      this.on = data[2] !== 0;
      return [this.status()];
    }
    // FF03 to a thermostat chooses a preset: 1 comfort, 2 min, else eco.
    if (opcode === LEVEL && data.length >= 6) {
      if (!this._newTid(data[4])) return [];
      const preset = data[2] === 0x01 ? 'comfort' : data[2] === 0x02 ? 'min' : 'eco';
      this.setPoint = this.presets[preset];
      this.paused = preset === 'min';
      this.on = true;
      return [this.status()];
    }
    return [];
  }

  // FF05: location id, state (bit 0 on, bit 2 window, bit 5 heating, bit 7
  // clock set), set point, firmware, more (bit 0 paused, bit 7 schedule off),
  // faults.
  status() {
    const state = (this.on ? 0x01 : 0) | (this.window ? 0x04 : 0) | (this.heating ? 0x20 : 0) | 0x80;
    return {
      opcode: STATUS,
      data: Buffer.from([...locationBytes(this.location), state, ...temperatureBytes(this.setPoint), ...FIRMWARE,
        0x80 | (this.paused ? 0x01 : 0), this.errors]),
    };
  }

  temperatures() {
    return {
      opcode: TEMPERATURES,
      data: Buffer.from([...locationBytes(this.location), ...temperatureBytes(this.room), ...temperatureBytes(this.floor),
        ...temperatureBytes(this.floorLimit)]),
    };
  }

  settings() {
    return { opcode: SETTINGS, data: Buffer.from([...locationBytes(this.location), 0x40, 0x40, 0x00, 0x00, 0x02]) };
  }

  presetsMessage() {
    const { comfort, eco, min } = this.presets;
    return {
      opcode: PRESETS,
      data: Buffer.from([...locationBytes(this.location), ...temperatureBytes(comfort), ...temperatureBytes(eco), ...temperatureBytes(min)]),
    };
  }

  // Changed on the thermostat itself: "on", "off", "set <5..35>", "preset
  // <comfort|eco|min>", "room <t>", "floor <t>", "pause <on|off>" (the open
  // window function),
  // "heating <on|off|auto>", "error <FFF|E1|E2|EEE|limit|none>". Its status
  // goes out by itself, and its temperatures with a fault or a temperature.
  order(event, value) {
    const known = super.order(event);
    if (known) return known;
    const number = Number(value);
    if (event === 'on' || event === 'off') {
      this.on = event === 'on';
    } else if (event === 'set' && number >= 5 && number <= 35) {
      this.setPoint = Math.round(number * 2) / 2;
      this.paused = false;
    } else if (event === 'preset' && this.presets[value] !== undefined) {
      this.setPoint = this.presets[value];
      this.paused = value === 'min';
    } else if (event === 'pause' && ['on', 'off'].includes(value)) {
      this.window = value === 'on';
    } else if (event === 'heating' && ['on', 'off', 'auto'].includes(value)) {
      this.heatingOrdered = value === 'auto' ? null : value === 'on';
    } else if ((event === 'room' || event === 'floor') && Number.isFinite(number) && number >= 0 && number < 100) {
      this[event] = number;
      return [this.status(), this.temperatures()];
    } else if (event === 'error' && FAULTS[value] !== undefined) {
      this.errors = FAULTS[value];
      if (value === 'E1') this.floor = 0;
      if (value === 'none' && this.floor === 0) this.floor = 24;
      return [this.status(), this.temperatures()];
    } else {
      return null;
    }
    return [this.status()];
  }
}

module.exports = {
  FakeLight, FakeThermostat, TID_RESET_S,
};
