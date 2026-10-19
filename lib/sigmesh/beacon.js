'use strict';

// Secure Network Beacon (Mesh Profile 1.0.1 §3.9.3). A proxy node sends one
// as soon as the link is up. It carries the network's current IV Index, which
// is how we learn it, and it is only believed when its authentication value
// verifies: a forged IV Index would silently mute everything we send.
//
//   01 | flags (1) | Network ID (8) | IV Index (4) | authentication (8)
//
// After frekarlsen/ha-sg-smart-mesh, commit c00c73a, src/btmesh/beacon.py
// (MIT, see LICENSE-MIT).

const { aesCmac, k1, k3, s1 } = require('./crypto');
const { MAX_IV_INDEX, assertRange } = require('./network');

const BEACON_SECURE_NETWORK = 0x01;
const BEACON_LENGTH = 22;
const AUTH_LENGTH = 8;
const FLAG_KEY_REFRESH = 0x01;
const FLAG_IV_UPDATE = 0x02;

// BeaconKey = k1(NetKey, s1("nkbk"), "id128" | 0x01) (§3.8.6.3.4).
function beaconKey(netKey) {
  return k1(netKey, s1(Buffer.from('nkbk')), Buffer.from('id128\x01', 'latin1'));
}

function authentication(netKey, body) {
  return aesCmac(beaconKey(netKey), body).subarray(0, AUTH_LENGTH);
}

// Returns { keyRefresh, ivUpdate, networkId, ivIndex }, or null when the
// payload is not a secure network beacon for this NetKey or fails
// authentication.
function parseSecureNetworkBeacon(payload, netKey) {
  if (!payload || payload.length !== BEACON_LENGTH || payload[0] !== BEACON_SECURE_NETWORK) return null;
  const networkId = payload.subarray(2, 10);
  if (!networkId.equals(k3(netKey))) return null;
  if (!authentication(netKey, payload.subarray(1, 14)).equals(payload.subarray(14))) return null;
  return {
    keyRefresh: (payload[1] & FLAG_KEY_REFRESH) !== 0,
    ivUpdate: (payload[1] & FLAG_IV_UPDATE) !== 0,
    networkId: Buffer.from(networkId),
    ivIndex: payload.readUInt32BE(10),
  };
}

// The node's side. Used by the tests and by a simulated node.
function buildSecureNetworkBeacon(netKey, { ivIndex, keyRefresh = false, ivUpdate = false }) {
  assertRange('ivIndex', ivIndex, MAX_IV_INDEX);
  const body = Buffer.alloc(13);
  body[0] = (keyRefresh ? FLAG_KEY_REFRESH : 0) | (ivUpdate ? FLAG_IV_UPDATE : 0);
  k3(netKey).copy(body, 1);
  body.writeUInt32BE(ivIndex, 9);
  return Buffer.concat([Buffer.from([BEACON_SECURE_NETWORK]), body, authentication(netKey, body)]);
}

module.exports = {
  BEACON_SECURE_NETWORK,
  beaconKey,
  buildSecureNetworkBeacon,
  parseSecureNetworkBeacon,
};
