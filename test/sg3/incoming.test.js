'use strict';

// What the log counts of what comes in on a 3.0 link (lib/sg3/incoming.js):
// destinations and opcodes, never a source or the parameters.

const test = require('node:test');
const assert = require('node:assert/strict');

const { FIRST_LINES, IncomingCounts, labelOf } = require('../../lib/sg3/incoming');

const HOMEY = 0x7f9a;
const SG_STATUS = 0xf00ee8; // F0 E8 0E on air

test('the labels: the opcode as on air, a control opcode, a segmented control message, unreadable', () => {
  assert.equal(labelOf({ kind: 'access', opcode: SG_STATUS }), 'op f0e80e');
  assert.equal(labelOf({ kind: 'access', opcode: 0x8204 }), 'op 8204');
  assert.equal(labelOf({ kind: 'control', opcode: 0x00 }), 'control 0x00');
  assert.equal(labelOf({ kind: 'control', opcode: 0x0a }), 'control 0x0a');
  assert.equal(labelOf({ kind: 'control', opcode: null }), 'control segmented');
  assert.equal(labelOf({ kind: 'unreadable' }), 'unreadable');
});

test('the first of each destination and opcode is a line, a repeat is not; the summary counts both, the most first', () => {
  const counts = new IncomingCounts(HOMEY);
  assert.equal(counts.summary(), 'in 0');
  assert.equal(counts.add(0xffff, { kind: 'access', opcode: SG_STATUS }), 'in: first op f0e80e to 0xffff');
  assert.equal(counts.add(0xffff, { kind: 'access', opcode: SG_STATUS }), null);
  assert.equal(counts.add(HOMEY, { kind: 'control', opcode: 0x00 }), 'in: first control 0x00 to 0x7f9a (Homey)');
  assert.equal(counts.add(0x0001, { kind: 'access', opcode: SG_STATUS }), 'in: first op f0e80e to 0x0001');
  assert.equal(counts.add(0xffff, { kind: 'unreadable' }), 'in: first unreadable to 0xffff');
  assert.equal(counts.summary(), 'in 5: to 0xffff 3, 0x0001 1, 0x7f9a (Homey) 1; op f0e80e 3, control 0x00 1, unreadable 1');
});

test('after FIRST_LINES first lines no more, and the summary shows six of each and how many more', () => {
  const counts = new IncomingCounts(HOMEY);
  const lines = [];
  for (let dst = 0xc000; dst < 0xc000 + FIRST_LINES + 4; dst += 1) {
    const line = counts.add(dst, { kind: 'access', opcode: SG_STATUS });
    if (line) lines.push(line);
  }
  assert.equal(lines.length, FIRST_LINES);
  assert.match(counts.summary(), /^in 20: to (0xc0[0-9a-f]{2} 1, ){6}14 more; op f0e80e 20$/);
});

test('reset starts the counts and the first lines again', () => {
  const counts = new IncomingCounts(HOMEY);
  counts.add(0xffff, { kind: 'access', opcode: SG_STATUS });
  counts.reset();
  assert.equal(counts.summary(), 'in 0');
  assert.equal(counts.add(0xffff, { kind: 'access', opcode: SG_STATUS }), 'in: first op f0e80e to 0xffff');
});
