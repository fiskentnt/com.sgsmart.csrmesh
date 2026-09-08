'use strict';

// The protocol in this file is not our discovery. SG's dimmers turned out to
// speak Qualcomm's stock CSR Bluetooth mesh rather than anything SG-specific,
// and that is the only reason they can be addressed without the gateway:
//
//   nkaminski  csrmesh — the reverse-engineered bearer, key derivation and
//              crypto that this file follows.
//              https://github.com/nkaminski/csrmesh  (LGPL-3.0 / GPL-3.0)
//   fromm1990  Identified SG's dimmers as ordinary CSRmesh, pointed at
//              csrmesh, and suggested 1234 as the network PIN.
//              hjemmeautomasjon.no, January 2022
//   einaros    Independently decoded the protocol in 2020, and reported that
//              these dimmers do not send change notifications — state has to
//              be polled, at the cost of Bluetooth noise. Still true.
//              hjemmeautomasjon.no, August 2020
//   erlwes     Brought the CSRmesh finding to the Home Assistant community.
//              community.home-assistant.io, January 2022

const crypto = require('crypto');

// CSRmesh network key derivation, as used by the SG app: the network passphrase
// is hashed with a trailing NUL + "MCP", and the digest is byte-reversed before
// the first 16 bytes are taken as the AES key.
const DEFAULT_PASSPHRASE = '1234';

// CSRmesh authenticated-bearer source constant used by the SG app.
const SOURCE = Buffer.from([0x00, 0x80]);

function deriveNetworkKey(passphrase) {
  const secret = String(passphrase ?? DEFAULT_PASSPHRASE).trim() || DEFAULT_PASSPHRASE;
  const digest = crypto.createHash('sha256')
    .update(Buffer.from(`${secret}\x00MCP`, 'utf8'))
    .digest();
  return Buffer.from(digest).reverse().subarray(0, 16);
}

// Device settings may carry a raw 16-byte key (advanced) or a passphrase.
function resolveKey(settings = {}) {
  const hex = String(settings.netkey_hex || '').replace(/[^0-9a-fA-F]/g, '');
  if (hex.length === 32) return Buffer.from(hex, 'hex');
  return deriveNetworkKey(settings.passphrase || DEFAULT_PASSPHRASE);
}

// Wrap an MCP payload in the CSRmesh authenticated bearer:
//   [seq(3)] [source(2)] [AES-128-OFB payload] [truncated HMAC(8)] [0xFF]
function makePacket(key, seq, data) {
  const seqBuf = Buffer.alloc(3);
  seqBuf.writeUIntLE(seq, 0, 3);

  const iv = Buffer.alloc(16);
  seqBuf.copy(iv, 0);
  SOURCE.copy(iv, 4);

  const cipher = crypto.createCipheriv('aes-128-ofb', key, iv);
  cipher.setAutoPadding(false);
  const payload = Buffer.concat([cipher.update(data), cipher.final()]);

  const preHmac = Buffer.concat([Buffer.alloc(8), seqBuf, SOURCE, payload]);
  const mac = crypto.createHmac('sha256', key).update(preHmac).digest();
  const shortMac = Buffer.from(mac).reverse().subarray(0, 8);

  return Buffer.concat([seqBuf, SOURCE, payload, shortMac, Buffer.from([0xff])]);
}

// Decrypt an inbound bearer frame body with the same scheme.
function decryptPayload(key, seq, source, payload) {
  const iv = Buffer.alloc(16);
  seq.copy(iv, 0);
  source.copy(iv, 4);
  const decipher = crypto.createDecipheriv('aes-128-ofb', key, iv);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(payload), decipher.final()]);
}

// Mesh node ids are advertised as "@NDxxxx" where xxxx is the id in hex.
const NODE_NAME = /^@ND[0-9A-F]{4,}$/i;

function meshIdFromName(localName) {
  const match = String(localName || '').match(/@ND([0-9A-Fa-f]{4})/);
  return match ? parseInt(match[1], 16) : null;
}

module.exports = {
  DEFAULT_PASSPHRASE,
  NODE_NAME,
  decryptPayload,
  deriveNetworkKey,
  makePacket,
  meshIdFromName,
  resolveKey,
};
