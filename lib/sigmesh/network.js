'use strict';

// Network layer (Mesh Profile 1.0.1 §3.4.4 to §3.4.6) and the nonces of
// §3.8.5. A network PDU is the destination and transport PDU encrypted with
// the NetKey's EncryptionKey, behind a header obfuscated with its PrivacyKey:
//
//   [IVI|NID (1)] [obfuscated CTL|TTL, SEQ, SRC (6)] [encrypted DST + transport PDU] [NetMIC 4 or 8]
//
// Translated from shejnowicz/homey-ble-mesh, commit 2aff983,
// lib/mesh/packet/{nonce,network,ranges}.ts. The proxy nonce and the IVI
// handling on receive follow frekarlsen/ha-sg-smart-mesh, commit c00c73a,
// src/btmesh/network.py. Both MIT, see LICENSE-MIT.

const { ccmDecrypt, ccmEncrypt, e, k2 } = require('./crypto');

const MAX_TTL = 0x7f;
const MAX_SEQ = 0xffffff;
const MAX_ADDRESS = 0xffff;
const MAX_IV_INDEX = 0xffffffff;

const NONCE_LENGTH = 13;
const NONCE_NETWORK = 0x00;
const NONCE_APPLICATION = 0x01;
const NONCE_DEVICE = 0x02;
const NONCE_PROXY = 0x03;

// k2's P for the master (flooding) security credentials.
const MASTER_P = Buffer.from([0x00]);
const NET_MIC_ACCESS = 4;
const NET_MIC_CONTROL = 8;
const MAX_TRANSPORT_ACCESS = 16;
const MAX_TRANSPORT_CONTROL = 12;
const HEADER_LENGTH = 7;
const MIN_PDU_LENGTH = HEADER_LENGTH + 2 + 1 + NET_MIC_ACCESS;

function assertRange(name, value, max) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${name} must be an integer in [0, ${max}], got ${value}`);
  }
}

function assertCommon({ seq, src, ivIndex }) {
  assertRange('seq', seq, MAX_SEQ);
  assertRange('src', src, MAX_ADDRESS);
  assertRange('ivIndex', ivIndex, MAX_IV_INDEX);
}

// Network nonce (§3.8.5.1): 00 | CTL+TTL | SEQ | SRC | 0000 | IV Index.
function networkNonce({ ctl, ttl, seq, src, ivIndex }) {
  assertRange('ttl', ttl, MAX_TTL);
  assertCommon({ seq, src, ivIndex });
  const nonce = Buffer.alloc(NONCE_LENGTH);
  nonce[0] = NONCE_NETWORK;
  nonce[1] = (ctl ? 0x80 : 0x00) | ttl;
  nonce.writeUIntBE(seq, 2, 3);
  nonce.writeUInt16BE(src, 5);
  nonce.writeUInt32BE(ivIndex, 9);
  return nonce;
}

// Application and device nonces (§3.8.5.2, §3.8.5.3):
// type | ASZMIC | SEQ | SRC | DST | IV Index.
function upperTransportNonce(type, { aszmic, seq, src, dst, ivIndex }) {
  assertCommon({ seq, src, ivIndex });
  assertRange('dst', dst, MAX_ADDRESS);
  const nonce = Buffer.alloc(NONCE_LENGTH);
  nonce[0] = type;
  nonce[1] = aszmic ? 0x80 : 0x00;
  nonce.writeUIntBE(seq, 2, 3);
  nonce.writeUInt16BE(src, 5);
  nonce.writeUInt16BE(dst, 7);
  nonce.writeUInt32BE(ivIndex, 9);
  return nonce;
}

function applicationNonce(input) {
  return upperTransportNonce(NONCE_APPLICATION, input);
}

function deviceNonce(input) {
  return upperTransportNonce(NONCE_DEVICE, input);
}

// Proxy nonce (§3.8.5.4): 03 | 00 | SEQ | SRC | 0000 | IV Index. Proxy
// configuration messages (the proxy filter) must be sealed with this one.
// SG's Telink nodes drop a filter message sealed with the network nonce, keep
// an empty accept list, and then forward nothing back to us.
function proxyNonce({ seq, src, ivIndex }) {
  assertCommon({ seq, src, ivIndex });
  const nonce = Buffer.alloc(NONCE_LENGTH);
  nonce[0] = NONCE_PROXY;
  nonce.writeUIntBE(seq, 2, 3);
  nonce.writeUInt16BE(src, 5);
  nonce.writeUInt32BE(ivIndex, 9);
  return nonce;
}

function assertNetworkKey(networkKey) {
  if (!Buffer.isBuffer(networkKey) || networkKey.length !== 16) {
    throw new Error(`networkKey must be 16 bytes, got ${networkKey && networkKey.length}`);
  }
}

// e(PrivacyKey, 0000000000 | IV Index | first 7 bytes of the encrypted part),
// of which the first 6 bytes are XORed onto the clear header (§3.8.7.3).
function pecb(privacyKey, ivIndex, encrypted) {
  const plain = Buffer.alloc(16);
  plain.writeUInt32BE(ivIndex, 5);
  encrypted.copy(plain, 9, 0, 7);
  return e(privacyKey, plain);
}

// `proxy: true` seals a proxy configuration message with the proxy nonce.
function encodeNetworkPdu({ networkKey, ivIndex, ctl, ttl, seq, src, dst, transportPdu, proxy = false }) {
  assertNetworkKey(networkKey);
  assertRange('ttl', ttl, MAX_TTL);
  assertCommon({ seq, src, ivIndex });
  assertRange('dst', dst, MAX_ADDRESS);
  const maxTransport = ctl ? MAX_TRANSPORT_CONTROL : MAX_TRANSPORT_ACCESS;
  if (!transportPdu || transportPdu.length < 1 || transportPdu.length > maxTransport) {
    throw new Error(`transportPdu must be 1-${maxTransport} bytes when ctl=${ctl}, got ${transportPdu && transportPdu.length}`);
  }

  const { nid, encryptionKey, privacyKey } = k2(networkKey, MASTER_P);
  const nonce = proxy ? proxyNonce({ seq, src, ivIndex }) : networkNonce({ ctl, ttl, seq, src, ivIndex });
  const dstBytes = Buffer.alloc(2);
  dstBytes.writeUInt16BE(dst, 0);
  const { ciphertext, tag } = ccmEncrypt(
    encryptionKey, nonce, Buffer.concat([dstBytes, transportPdu]), ctl ? NET_MIC_CONTROL : NET_MIC_ACCESS,
  );
  const encrypted = Buffer.concat([ciphertext, tag]);

  const header = Buffer.alloc(6);
  header[0] = (ctl ? 0x80 : 0x00) | ttl;
  header.writeUIntBE(seq, 1, 3);
  header.writeUInt16BE(src, 4);
  const mask = pecb(privacyKey, ivIndex, encrypted);
  for (let i = 0; i < 6; i += 1) header[i] ^= mask[i];

  return Buffer.concat([Buffer.from([((ivIndex & 0x01) << 7) | nid]), header, encrypted]);
}

// Returns the decoded PDU, or null when it is not ours (another NID, a NetMIC
// that does not verify, a malformed length). `ivIndex` is our current IV
// Index. When the PDU's IVI bit is the other one, it was sent with the
// previous IV Index (an IV Update in progress, §3.10.5), and that one is
// used instead. The IV Index actually used is returned, because the
// application nonce of the same message needs it too.
function decodeNetworkPdu({ networkKey, ivIndex, pdu, proxy = false }) {
  assertNetworkKey(networkKey);
  assertRange('ivIndex', ivIndex, MAX_IV_INDEX);
  const { nid, encryptionKey, privacyKey } = k2(networkKey, MASTER_P);
  if (!pdu || pdu.length < MIN_PDU_LENGTH || (pdu[0] & 0x7f) !== nid) return null;

  const ivi = pdu[0] >> 7;
  const usedIvIndex = ivi === (ivIndex & 0x01) ? ivIndex : ivIndex - 1;
  if (usedIvIndex < 0) return null;

  const encrypted = pdu.subarray(HEADER_LENGTH);
  const header = Buffer.from(pdu.subarray(1, HEADER_LENGTH));
  const mask = pecb(privacyKey, usedIvIndex, encrypted);
  for (let i = 0; i < 6; i += 1) header[i] ^= mask[i];

  const ctl = (header[0] & 0x80) !== 0;
  const ttl = header[0] & 0x7f;
  const seq = header.readUIntBE(1, 3);
  const src = header.readUInt16BE(4);

  const micLength = ctl ? NET_MIC_CONTROL : NET_MIC_ACCESS;
  const transportLength = encrypted.length - 2 - micLength;
  if (transportLength < 1 || transportLength > (ctl ? MAX_TRANSPORT_CONTROL : MAX_TRANSPORT_ACCESS)) return null;

  const nonce = proxy
    ? proxyNonce({ seq, src, ivIndex: usedIvIndex })
    : networkNonce({ ctl, ttl, seq, src, ivIndex: usedIvIndex });
  const plain = ccmDecrypt(
    encryptionKey, nonce, encrypted.subarray(0, 2 + transportLength), encrypted.subarray(2 + transportLength),
  );
  if (plain === null) return null;

  return {
    ivIndex: usedIvIndex,
    ctl,
    ttl,
    seq,
    src,
    dst: plain.readUInt16BE(0),
    transportPdu: plain.subarray(2),
  };
}

module.exports = {
  MAX_ADDRESS,
  MAX_IV_INDEX,
  MAX_SEQ,
  MAX_TTL,
  applicationNonce,
  assertRange,
  decodeNetworkPdu,
  deviceNonce,
  encodeNetworkPdu,
  networkNonce,
  proxyNonce,
};
