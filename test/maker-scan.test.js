'use strict';

// The manufacturer data of an advertisement for company 0x0EE8, read without
// lib/sg3 (lib/makerData.js), and the 3.0 pairing's one line per scan: how
// many nodes with data for 0x0EE8 there are per length of the data and value
// of byte 18, with at most MAKER_LINE_MAX of those shown, and that whether
// they are in this home is not known. No addresses, no other bytes, no ids.
// Made-up advertisements.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { MAKER_COMPANY, MAKER_LINE_MAX, MAKER_TYPE_AT, companyData, makerData, scanMakerLine } = require('../lib/makerData');

const UNKNOWN = 'SG Smart 3.0 nodes in the scan (whether they are in this home is not known)';

let uuids = 0;
// An advertisement with made-up manufacturer data: the company, filler, the
// bytes 8 and 9 0x34 0x12, and byte 18 typeByte when the data is that long.
function advert({ typeByte = 0xa5, length = 29, company = MAKER_COMPANY, uuid = `made-up-${(uuids += 1)}` } = {}) {
  const data = Buffer.alloc(length, 0x5a);
  if (length >= 2) data.writeUInt16LE(company, 0);
  if (length >= 10) data.writeUInt16LE(0x1234, 8);
  if (length > MAKER_TYPE_AT) data[MAKER_TYPE_AT] = typeByte;
  return { uuid, manufacturerData: data };
}

test('the company 0x0EE8 in bytes 0 and 1 (low byte first), byte 18 for the type', () => {
  assert.equal(MAKER_COMPANY, 0x0ee8);
  assert.equal(MAKER_TYPE_AT, 18);
  assert.ok(Number.isInteger(MAKER_LINE_MAX) && MAKER_LINE_MAX >= 4, String(MAKER_LINE_MAX));
});

test('the data for 0x0EE8 as Homey gives it, or as a list of bytes or a Buffer in JSON form; null otherwise', () => {
  const one = advert();
  for (const manufacturerData of [one.manufacturerData, [...one.manufacturerData], one.manufacturerData.toJSON(), new Uint8Array(one.manufacturerData)]) {
    assert.deepEqual(companyData({ manufacturerData }), one.manufacturerData);
    assert.deepEqual(makerData({ manufacturerData }), one.manufacturerData);
  }
  assert.equal(companyData(advert({ company: 0x004c })), null, 'another company');
  assert.equal(makerData(advert({ company: 0x004c })).readUInt16LE(0), 0x004c, 'still manufacturer data');
  assert.equal(companyData({ manufacturerData: Buffer.from([0xe8]) }), null, 'too short for the company');
  for (const manufacturerData of [undefined, null, 'e80e', 42, {}]) {
    assert.equal(companyData({ manufacturerData }), null, String(manufacturerData));
    assert.equal(makerData({ manufacturerData }), null, String(manufacturerData));
  }
  assert.equal(companyData(null), null);
  assert.equal(makerData(undefined), null);
});

test('one line per scan: how many per length and byte 18, most first, then by length and byte', () => {
  const adverts = [
    advert(), advert(), advert({ typeByte: 0xa6 }),
    advert({ length: 31, typeByte: 0x3c }),
    advert({ length: 12 }), // too short for byte 18
    advert({ company: 0x004c }), // another company: not counted
    { uuid: 'made-up-none' }, // no manufacturer data
    null,
  ];
  assert.equal(scanMakerLine(adverts),
    `${UNKNOWN}: 2 with 29 bytes and byte 18 0xa5, 1 with 12 bytes and no byte 18, 1 with 29 bytes and byte 18 0xa6, `
    + '1 with 31 bytes and byte 18 0x3c');
});

test('none: no advertisement, none with data for 0x0EE8, or no list at all', () => {
  for (const adverts of [[], [advert({ company: 0x004c }), { uuid: 'made-up-none' }], null, undefined, 'not a list']) {
    assert.equal(scanMakerLine(adverts), 'SG Smart 3.0 nodes in the scan: none', String(adverts));
  }
});

test('a node is counted once per scan by its peripheral id, which is never logged; one without an id is counted each time', () => {
  const twice = advert({ uuid: 'made-up-twice' });
  const line = scanMakerLine([twice, twice, { ...twice }, advert({ uuid: undefined }), advert({ uuid: undefined })]);
  assert.equal(line, `${UNKNOWN}: 3 with 29 bytes and byte 18 0xa5`);
  assert.doesNotMatch(line, /made-up/);
});

test('at most MAKER_LINE_MAX combinations of length and byte 18; the rest in one count', () => {
  const adverts = [];
  for (let i = 0; i < MAKER_LINE_MAX + 3; i += 1) {
    for (let n = 0; n <= i; n += 1) adverts.push(advert({ typeByte: 0x10 + i }));
  }
  const line = scanMakerLine(adverts);
  const shown = line.slice(UNKNOWN.length + 2).split(', ');
  assert.equal(shown.length, MAKER_LINE_MAX + 1, line);
  assert.equal(shown[0], `${MAKER_LINE_MAX + 3} with 29 bytes and byte 18 0x${(0x10 + MAKER_LINE_MAX + 2).toString(16)}`);
  // The three with the fewest nodes are left out: 1, 2 and 3 nodes.
  assert.equal(shown[MAKER_LINE_MAX], 'and 6 more in 3 other combination(s)');
  assert.equal(scanMakerLine(adverts.slice(0, 1 + 2 + 3)), `${UNKNOWN}: 3 with 29 bytes and byte 18 0x12, 2 with 29 bytes and byte 18 0x11, `
    + '1 with 29 bytes and byte 18 0x10', 'up to MAKER_LINE_MAX, no rest');
});

test('no addresses or other bytes: only the company and byte 18, in hex', () => {
  const line = scanMakerLine([advert(), advert({ length: 40, typeByte: 0x07 }), advert({ length: 12 })]);
  assert.doesNotMatch(line, /0x12\b|0x34\b|1234|3412|5a/i, 'not bytes 8 and 9, nor the filler');
  for (const value of line.match(/0x[0-9a-f]+/gi)) assert.match(value, /^0x[0-9a-f]{2}$/, value);
});

test('the module is small and loads nothing, so lib/sg3 stays unloaded without a 3.0 network', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'makerData.js'), 'utf8');
  assert.doesNotMatch(source, /require\(/);
  assert.ok(source.split('\n').length < 120, 'small');
});

test('lib/sg3/advert.js reads the manufacturer data through this module, and keeps no copy of its own', () => {
  const advert = require('../lib/sg3/advert');
  const maker = require('../lib/makerData');
  for (const name of ['MAKER_COMPANY', 'MAKER_TYPE_AT', 'companyData', 'makerData']) assert.equal(advert[name], maker[name], name);
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sg3', 'advert.js'), 'utf8');
  assert.doesNotMatch(source, /function (?:makerData|companyData)\b|MAKER_COMPANY = |MAKER_TYPE_AT = /);
});
