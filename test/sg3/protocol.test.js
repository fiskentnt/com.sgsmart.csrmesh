'use strict';

// Examples from frekarlsen/ha-sg-smart-mesh, docs/sg-smart-3-protocol.md
// (verified there on a LEDDim Smart Pill Micro 3.0, 2026-09-27).

const test = require('node:test');
const assert = require('node:assert/strict');

const sg = require('../../lib/sg3/protocol');
const { decodeAccessMessage } = require('../../lib/sigmesh/access');

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

test('the opcodes are E0 E8 0E and F0 E8 0E on air', () => {
  assert.equal(sg.sgStatusGet(3, { tid: 1, seq: 1 }).subarray(0, 3).toString('hex'), 'e0e80e');
  assert.equal(decodeAccessMessage(hex('f0e80e09')).opcode, sg.OP_SG_STATUS);
});

test('power and level for node 0x0003, as in the protocol notes', () => {
  assert.equal(sg.sgPowerLevelSet(3, 50, { tid: 1, seq: 1 }).toString('hex'), 'e0e80e' + '070101000332ffffffffff');
  assert.equal(sg.sgPowerLevelSet(3, 0, { tid: 4, seq: 1 }).toString('hex'), 'e0e80e' + '070401000300ffffffffff');
  assert.equal(sg.sgPowerLevelSet(3, sg.LEVEL_LAST, { tid: 5, seq: 1 }).toString('hex'), 'e0e80e' + '070501000365ffffffffff');
});

test('status request', () => {
  assert.equal(sg.sgStatusGet(0x0008, { tid: 0x21, seq: 0x21 }).toString('hex'), 'e0e80e' + '0921210008');
});

test('TID and SEQ are kept to one byte each', () => {
  assert.equal(sg.sgStatusGet(3, { tid: 0x101, seq: 0x1ff }).toString('hex'), 'e0e80e' + '0901ff0003');
});

test('bad level or node address throws', () => {
  assert.throws(() => sg.sgPowerLevelSet(3, 102, { tid: 1, seq: 1 }), /0-101/);
  assert.throws(() => sg.sgPowerLevelSet(3, 1.5, { tid: 1, seq: 1 }), /0-101/);
  assert.throws(() => sg.sgStatusGet(0, { tid: 1, seq: 1 }), /node address/);
  assert.throws(() => sg.sgStatusGet(0x10000, { tid: 1, seq: 1 }), /node address/);
});

test('status reply (kind 0x09): power and level', () => {
  assert.deepEqual(sg.parseSgStatus(hex('09 01 73 73 7f ff 01 35 19 00')), { kind: 0x09, on: true, level: 53 });
  // Off at level 100: the level is kept while off.
  assert.deepEqual(sg.parseSgStatus(hex('09 01 00 00 7f ff 00 64 19')), { kind: 0x09, on: false, level: 100 });
  // Power on but level 0 is shown as off, as HA does.
  assert.deepEqual(sg.parseSgStatus(hex('09 01 00 00 7f ff 01 00 19')), { kind: 0x09, on: false, level: 0 });
});

test('status broadcast (kind 0x03), after a local change', () => {
  assert.deepEqual(sg.parseSgStatus(hex('03 a6 84 ff ff 01 1e 19')), { kind: 0x03, on: true, level: 30 });
  assert.deepEqual(sg.parseSgStatus(hex('03 a6 84 ff ff 00 1e 19')), { kind: 0x03, on: false, level: 30 });
});

test('other kinds, short payloads and impossible levels are not a status', () => {
  assert.equal(sg.parseSgStatus(hex('2a 0a 01 00 04 1d 04 01 01 00 00 00 00')), null); // button event
  assert.equal(sg.parseSgStatus(hex('06 01 21 21 7f ff 14 3c 64')), null); // trim reply
  assert.equal(sg.parseSgStatus(hex('09 01 73 73 7f ff 01')), null);
  assert.equal(sg.parseSgStatus(hex('03 a6 84 ff ff 01 65')), null);
  assert.equal(sg.parseSgStatus(Buffer.alloc(0)), null);
});
