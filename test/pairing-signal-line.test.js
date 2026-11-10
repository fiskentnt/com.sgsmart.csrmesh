'use strict';

// After a search, one log line with the signal of the names the scan saw:
// those that answered FF11 against those that did not, as median and range
// in dBm, numbers only. Made-up names, mesh ids and values. Run with:
// node --test test/*.test.js

const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const fake = require('./helpers/fake-homey');

fake.install();

const { laterFindings, signalLine } = require('../lib/csrPairing');

const adv = (localName, rssi) => ({ localName, rssi, uuid: `made-up-${localName}` });
const answer = (name, meshId) => ({ name, meshId, product: { prefix: name.slice(0, 3), name: 'LEDDim Pill', generation: 'Gen2' } });

test('the line: median and range for those that answered and those that did not, and how many had no signal', () => {
  const advertisements = [adv('@MC0001', -50), adv('@MC0002', -60), adv('@MC0003', -70), adv('@MC0004', -80), adv('@MC0005', -90), adv('@MC0006', 0)];
  const nodes = [answer('@MC0001', 0x9c01), answer('@MC0003', 0x9c03), answer('@MC0007', 0x9c07)];
  const found = laterFindings(advertisements, nodes);
  assert.equal(signalLine(found), 'pair: signal: answered 3, median -60 dBm (-70 to -50), 1 without a signal; '
    + 'no answer 4, median -80 dBm (-90 to -60), 1 without a signal');
  assert.doesNotMatch(signalLine(found), /@MC|0x9c|made-up/);
});

test('an even count takes the middle two, rounded; none in a group says so', () => {
  const found = laterFindings([adv('@MC0001', -51), adv('@MC0002', -62)], [answer('@MC0001', 0x9c01), answer('@MC0002', 0x9c02)]);
  assert.equal(signalLine(found), 'pair: signal: answered 2, median -56 dBm (-62 to -51); no answer 0, no signal');
  assert.equal(signalLine([]), 'pair: signal: answered 0, no signal; no answer 0, no signal');
});

test('every driver that searches logs the line after its count line', () => {
  for (const driver of ['sg_pill', 'sg_plug', 'sg_din', 'sg_thermostat', 'sg_mesh']) {
    const source = fs.readFileSync(`${__dirname}/../drivers/${driver}/driver.js`, 'utf8');
    assert.match(source, /this\.log\(ff11CountLine\(found\)\);\n\s*this\.log\(signalLine\(found\)\);/, driver);
  }
});
