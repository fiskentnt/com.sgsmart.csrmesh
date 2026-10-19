'use strict';

// The secure network beacon sample is from the Mesh Profile 1.0.1
// specification, §8.4.3. The other tests follow
// frekarlsen/ha-sg-smart-mesh (tests/test_beacon.py).

const test = require('node:test');
const assert = require('node:assert/strict');

const { k3 } = require('../../lib/sigmesh/crypto');
const { beaconKey, buildSecureNetworkBeacon, parseSecureNetworkBeacon } = require('../../lib/sigmesh/beacon');

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const NET_KEY = hex('7dd7364cd842ad18c17c2b820c84c3d6');
const OTHER_KEY = hex('63964771734fbd76e3b40519d1d94a48');
const SAMPLE = hex('01 00 3ecaff672f673370 12345678 8ea261582f364f6f');

test('Network ID and BeaconKey of the sample NetKey (§8.2)', () => {
  assert.equal(k3(NET_KEY).toString('hex'), '3ecaff672f673370');
  assert.equal(beaconKey(NET_KEY).toString('hex'), '5423d967da639a99cb02231a83f7d254');
});

test('builds the secure network beacon sample (§8.4.3)', () => {
  assert.deepEqual(buildSecureNetworkBeacon(NET_KEY, { ivIndex: 0x12345678 }), SAMPLE);
});

test('parses the sample and reports its IV Index', () => {
  assert.deepEqual(parseSecureNetworkBeacon(SAMPLE, NET_KEY), {
    keyRefresh: false,
    ivUpdate: false,
    networkId: hex('3ecaff672f673370'),
    ivIndex: 0x12345678,
  });
});

test('the flags round trip', () => {
  const beacon = buildSecureNetworkBeacon(NET_KEY, { ivIndex: 7, keyRefresh: true, ivUpdate: true });
  const out = parseSecureNetworkBeacon(beacon, NET_KEY);
  assert.equal(out.keyRefresh, true);
  assert.equal(out.ivUpdate, true);
  assert.equal(out.ivIndex, 7);
});

test('a changed IV Index is refused', () => {
  const forged = Buffer.from(SAMPLE);
  forged.writeUInt32BE(0x12345679, 10);
  assert.equal(parseSecureNetworkBeacon(forged, NET_KEY), null);
});

test('a beacon from another network is refused', () => {
  assert.equal(parseSecureNetworkBeacon(buildSecureNetworkBeacon(OTHER_KEY, { ivIndex: 1 }), NET_KEY), null);
});

test('wrong length or another beacon type is refused', () => {
  assert.equal(parseSecureNetworkBeacon(SAMPLE.subarray(0, 21), NET_KEY), null);
  const unprovisioned = Buffer.from(SAMPLE);
  unprovisioned[0] = 0x00;
  assert.equal(parseSecureNetworkBeacon(unprovisioned, NET_KEY), null);
  assert.equal(parseSecureNetworkBeacon(undefined, NET_KEY), null);
});
