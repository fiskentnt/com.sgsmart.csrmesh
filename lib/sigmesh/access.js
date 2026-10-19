'use strict';

// Access layer opcodes (Mesh Profile 1.0.1 §3.7.3.1): one octet 0x00-0x7E,
// two octets 0x8000-0xBFFF (big-endian on air), and three-octet vendor
// opcodes, whose 16-bit company ID goes on air little-endian. SG's command
// opcode 0xE0 for company 0x0EE8 is E0 E8 0E on air.
//
// Translated from shejnowicz/homey-ble-mesh, commit 2aff983,
// lib/mesh/packet/access.ts (MIT, see LICENSE-MIT).

const { assertRange } = require('./network');

const MAX_1_OCTET = 0x7e;
const RESERVED = 0x7f;
const MIN_2_OCTET = 0x8000;
const MAX_2_OCTET = 0xbfff;
const VENDOR_MARKER = 0xc0;
const MAX_VENDOR_SUB_OPCODE = 0x3f;
const MAX_COMPANY_ID = 0xffff;
const MIN_VENDOR = VENDOR_MARKER << 16;
const MAX_VENDOR = 0xffffff;

// A vendor opcode as one number: first octet (0xC0 | sub-opcode), then the
// company ID. makeVendorOpcode(0x20, 0x0EE8) is SG's command, 0xE00EE8.
function makeVendorOpcode(subOpcode, companyId) {
  assertRange('subOpcode', subOpcode, MAX_VENDOR_SUB_OPCODE);
  assertRange('companyId', companyId, MAX_COMPANY_ID);
  return ((VENDOR_MARKER | subOpcode) << 16) | companyId;
}

function encodeOpcode(opcode) {
  if (opcode <= MAX_1_OCTET) return Buffer.from([opcode]);
  if (opcode >= MIN_2_OCTET && opcode <= MAX_2_OCTET) return Buffer.from([opcode >>> 8, opcode & 0xff]);
  if (opcode >= MIN_VENDOR && opcode <= MAX_VENDOR) {
    const companyId = opcode & MAX_COMPANY_ID;
    return Buffer.from([opcode >>> 16, companyId & 0xff, companyId >>> 8]);
  }
  throw new Error(`opcode 0x${opcode.toString(16)} is not a valid 1-, 2- or 3-octet opcode`);
}

// { opcode, parameters } to the access payload: opcode octets, then parameters.
function encodeAccessMessage({ opcode, parameters = Buffer.alloc(0) }) {
  assertRange('opcode', opcode, MAX_VENDOR);
  if (opcode === RESERVED) throw new Error('opcode 0x7f is reserved');
  return Buffer.concat([encodeOpcode(opcode), parameters]);
}

// The reverse, or null when the payload is too short for its opcode form.
function decodeAccessMessage(pdu) {
  if (!pdu || pdu.length < 1 || pdu[0] === RESERVED) return null;
  const first = pdu[0];
  if ((first & 0x80) === 0) return { opcode: first, parameters: Buffer.from(pdu.subarray(1)) };
  if ((first & 0xc0) === 0x80) {
    if (pdu.length < 2) return null;
    return { opcode: (first << 8) | pdu[1], parameters: Buffer.from(pdu.subarray(2)) };
  }
  if (pdu.length < 3) return null;
  return {
    opcode: makeVendorOpcode(first & MAX_VENDOR_SUB_OPCODE, pdu[1] | (pdu[2] << 8)),
    parameters: Buffer.from(pdu.subarray(3)),
  };
}

module.exports = {
  decodeAccessMessage,
  encodeAccessMessage,
  makeVendorOpcode,
};
