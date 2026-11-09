'use strict';

// The fake devices (lib/fake/nodes.js) do what a device in a home is assumed
// to do: it has its home's location id and a mesh id of its own, and takes a
// message only with that location id: FF10 to everyone or to its own mesh
// id, FF04 and commands. One with 00 00 or another home's location id gets
// nothing. Its name is the product's prefix and the last four characters of
// its Bluetooth address, which have nothing to do with its mesh id. None of
// this has been tried with a real device after the first generation.
// Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  csrLevelData, csrNameRequestData, csrStatusRequestData, opcodeValue, OP_EXT_NAME, OP_EXT_STATUS, parseCsrName, parseExt,
  thermostatRequestData, THERMOSTAT_ASK_TEMPERATURES,
} = require('../lib/sgProtocol');
const { FakeLight, FakeThermostat } = require('../lib/fake/nodes');

// Made-up values: a home, another home, two mesh ids and Bluetooth
// addresses whose last four characters are not the mesh id.
const HOME = 0x4c2e;
const OTHER_HOME = 0x19b7;
const PILL_ID = 0x9a31;
const THERMOSTAT_ID = 0xc05d;
const PILL_ADDRESS = '02c4a17be35f';
const THERMOSTAT_ADDRESS = '02c4a17b08d6';
const NAME = opcodeValue(OP_EXT_NAME);
const STATUS = opcodeValue(OP_EXT_STATUS);

const pill = (options = {}) => new FakeLight({
  prefix: '@SC', meshId: PILL_ID, location: HOME, address: PILL_ADDRESS, ...options,
});
const thermostat = (options = {}) => new FakeThermostat({
  prefix: '@ST', meshId: THERMOSTAT_ID, location: HOME, address: THERMOSTAT_ADDRESS, ...options,
});
// What a node answers to a message as this app builds it.
const answers = (node, plain) => node.receive(parseExt(plain));

test('a device in a home answers FF10 to everyone only with its home\'s location id: 00 00 and another home\'s get nothing (assumed)', () => {
  const node = pill();
  assert.deepEqual(answers(node, csrNameRequestData(0)), [], '00 00');
  assert.deepEqual(answers(node, csrNameRequestData(OTHER_HOME)), [], 'another home');
  const [answer, ...more] = answers(node, csrNameRequestData(HOME));
  assert.equal(more.length, 0);
  assert.equal(answer.opcode, NAME);
  assert.deepEqual(parseCsrName(answer.data), { location: HOME, name: '@SCE35F', resets: 0 });
});

test('a device answers FF10 sent to its own mesh id with its location id; to another mesh id, or with 00 00, nothing (assumed)', () => {
  const node = pill();
  assert.deepEqual(answers(node, csrNameRequestData(0, PILL_ID)), [], '00 00 to its mesh id');
  assert.deepEqual(answers(node, csrNameRequestData(OTHER_HOME, PILL_ID)), [], 'another home to its mesh id');
  assert.deepEqual(answers(node, csrNameRequestData(HOME, THERMOSTAT_ID)), [], 'its home, to another mesh id');
  const [answer] = answers(node, csrNameRequestData(HOME, PILL_ID));
  assert.equal(answer.opcode, NAME);
  assert.equal(parseCsrName(answer.data).name, '@SCE35F');
  const [fromThermostat] = answers(thermostat(), csrNameRequestData(HOME, THERMOSTAT_ID));
  assert.equal(parseCsrName(fromThermostat.data).name, '@ST08D6');
});

test('a device takes FF04 and FF03 only with its location id, and only to its mesh id', () => {
  const node = pill();
  assert.deepEqual(answers(node, csrStatusRequestData({ meshId: PILL_ID, location: 0 })), []);
  assert.deepEqual(answers(node, csrStatusRequestData({ meshId: PILL_ID, location: OTHER_HOME })), []);
  assert.deepEqual(answers(node, csrLevelData({
    meshId: PILL_ID, location: OTHER_HOME, level: 40, tid: 1,
  })), []);
  assert.equal(node.on, false, 'a command with another location id changes nothing');
  assert.deepEqual(answers(node, csrLevelData({
    meshId: THERMOSTAT_ID, location: HOME, level: 40, tid: 1,
  })), []);
  assert.equal(node.on, false, 'a command to another mesh id changes nothing');
  assert.equal(answers(node, csrStatusRequestData({ meshId: PILL_ID, location: HOME }))[0].opcode, STATUS);
  assert.equal(answers(node, csrLevelData({
    meshId: PILL_ID, location: HOME, level: 40, tid: 1,
  }))[0].opcode, STATUS);
  assert.equal(node.on, true);
  assert.equal(node.level, 40);
  const heat = thermostat();
  assert.deepEqual(answers(heat, thermostatRequestData({ meshId: THERMOSTAT_ID, location: 0, what: THERMOSTAT_ASK_TEMPERATURES })), []);
  assert.equal(answers(heat, thermostatRequestData({ meshId: THERMOSTAT_ID, location: HOME, what: THERMOSTAT_ASK_TEMPERATURES })).length, 1);
});

test('a device\'s name is its prefix and the last four characters of its Bluetooth address, not its mesh id', () => {
  const node = pill();
  assert.equal(node.name, '@SCE35F');
  assert.equal(node.address, PILL_ADDRESS);
  assert.notEqual(node.name.slice(3), PILL_ID.toString(16).toUpperCase());
  assert.equal(thermostat().name, '@ST08D6');
  assert.throws(() => new FakeLight({ prefix: '@SC', meshId: PILL_ID, location: HOME }), /Bluetooth address/);
});

test('a device that loses its first n answers (drop) answers the one after them', () => {
  const node = pill({ drop: 2 });
  assert.deepEqual(answers(node, csrNameRequestData(HOME)), []);
  assert.deepEqual(answers(node, csrNameRequestData(HOME, PILL_ID)), []);
  assert.equal(answers(node, csrNameRequestData(HOME)).length, 1);
  assert.equal(answers(node, csrStatusRequestData({ meshId: PILL_ID, location: HOME })).length, 1);
  // A message it would not have answered does not count.
  const other = pill({ drop: 1 });
  assert.deepEqual(answers(other, csrNameRequestData(0)), []);
  assert.deepEqual(answers(other, csrNameRequestData(HOME)), [], 'the first it would answer is lost');
  assert.equal(answers(other, csrNameRequestData(HOME)).length, 1);
});
