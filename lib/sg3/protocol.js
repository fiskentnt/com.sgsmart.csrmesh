'use strict';

// SG Armaturen's vendor protocol for SG Smart 3.0 (Bluetooth SIG Mesh on a
// Telink stack, company ID 0x0EE8). The nodes have no Light Lightness server:
// power, level and status all go through one vendor opcode pair on vendor
// model 0x0EE8:0x0000, unacknowledged at the access layer.
//
//   command  E0 E8 0E | kind | TID | SEQ | NODE_HI | NODE_LO | ...
//   status   F0 E8 0E | kind | ...
//
// The target node is inside the payload, big-endian. A node drops a repeat
// of the TID it just handled, so every command needs a new one.
//
// After frekarlsen/ha-sg-smart-mesh, commit c00c73a, src/btmesh/sg_smart.py
// and docs/sg-smart-3-protocol.md (MIT, see ../sigmesh/LICENSE-MIT).

const { encodeAccessMessage, makeVendorOpcode } = require('../sigmesh/access');

const SG_COMPANY_ID = 0x0ee8;
const OP_SG_COMMAND = makeVendorOpcode(0x20, SG_COMPANY_ID); // E0 E8 0E
const OP_SG_STATUS = makeVendorOpcode(0x30, SG_COMPANY_ID); // F0 E8 0E

const KIND_POWER_LEVEL = 0x07;
const KIND_STATUS_REQUEST = 0x09;
const KIND_STATUS_RESPONSE = 0x09;
const KIND_STATUS_BROADCAST = 0x03;

const LEVEL_OFF = 0;
const LEVEL_MAX = 100;
// On, at whatever level the node had before.
const LEVEL_LAST = 101;
// CCT, hue (2), white, saturation: FF is "unchanged". A plain dimmer ignores them.
const COLOUR_UNCHANGED = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]);

// Where power and level sit in the status parameters, per kind (verified by
// HA on a LEDDim Smart Pill 3.0, 2026-09-27):
//   0x09 reply      09 01 TID SEQ ADDR_HI ADDR_LO POWER LEVEL ...   (ADDR is whoever asked)
//   0x03 broadcast  03 TID SEQ FF FF POWER LEVEL ...                 (after a local change)
// The node keeps its level while off, so power has its own byte.
const STATUS_OFFSETS = {
  [KIND_STATUS_RESPONSE]: { power: 6, level: 7 },
  [KIND_STATUS_BROADCAST]: { power: 5, level: 6 },
};

function header(kind, node, tid, seq) {
  if (!Number.isInteger(node) || node < 1 || node > 0xffff) throw new Error(`bad node address ${node}`);
  return Buffer.from([kind, tid & 0xff, seq & 0xff, node >>> 8, node & 0xff]);
}

// Access payload (opcode included) that sets power and level on `node`.
function sgPowerLevelSet(node, level, { tid, seq }) {
  if (!Number.isInteger(level) || level < LEVEL_OFF || level > LEVEL_LAST) {
    throw new Error(`SG level must be 0-101, got ${level}`);
  }
  return encodeAccessMessage({
    opcode: OP_SG_COMMAND,
    parameters: Buffer.concat([header(KIND_POWER_LEVEL, node, tid, seq), Buffer.from([level]), COLOUR_UNCHANGED]),
  });
}

// Access payload (opcode included) that asks `node` for its status.
function sgStatusGet(node, { tid, seq }) {
  return encodeAccessMessage({ opcode: OP_SG_COMMAND, parameters: header(KIND_STATUS_REQUEST, node, tid, seq) });
}

// The parameters of an OP_SG_STATUS message: { kind, on, level }, or null for
// a kind that is not a status (button events, setting replies) or that does
// not parse.
function parseSgStatus(parameters) {
  if (!parameters || parameters.length < 1) return null;
  const kind = parameters[0];
  const offsets = STATUS_OFFSETS[kind];
  if (!offsets || parameters.length <= offsets.level) return null;
  const level = parameters[offsets.level];
  if (level > LEVEL_MAX) return null;
  return { kind, on: parameters[offsets.power] > 0 && level > 0, level };
}

module.exports = {
  KIND_STATUS_BROADCAST,
  KIND_STATUS_RESPONSE,
  LEVEL_LAST,
  LEVEL_MAX,
  LEVEL_OFF,
  OP_SG_COMMAND,
  OP_SG_STATUS,
  SG_COMPANY_ID,
  parseSgStatus,
  sgPowerLevelSet,
  sgStatusGet,
};
