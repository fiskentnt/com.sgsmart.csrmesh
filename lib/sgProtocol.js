'use strict';

// SG Smart mesh protocol, as observed in the SG phone app's own traffic log,
// its Android build, and its packets captured on the air. A reference: the
// drivers build their packets themselves and do not import this yet.
// Everything here holds for any SG Gen1 installation. Nothing that belongs to
// one home goes in this file: passphrases, device ids and group numbers come
// from pairing and settings.
//
// 16-bit addresses are written little-endian on the air: group 1 is 01 00,
// the device channel 0x8001 is 01 80.

// Destinations.
const ADDR_BROADCAST = 0x0000;
// Groups are addressed by their own mesh id, counted from 1.
const ADDR_GROUP_MIN = 0x0001;
// The app's own address. Also the destination of the status request.
const ADDR_APP = 0x8000;
// Every dimmer listens here; the payload carries the id of the one addressed.
const ADDR_DEVICES = 0x8001;

// Fixed prefix of every SG light payload.
const SG_VENDOR = [0xf2, 0xe7];

// Extension-model opcodes. A two-byte opcode goes on the air high byte first,
// straight after the destination, with the payload following.
//
// The SG app sends FF03 and FF0A to a group address, but never alone: every
// one is accompanied by an A0 to each dimmer, and sent from Homey on their own
// they had no effect. Treat them as something Gen1 dimmers do not act on.
//   FF03  level and on/off   F2 E7 <pwr> <level> <tid> 00 00
//   FF0A  recall scene       F2 E7 <sceneNumber> <tid> 00
//   FFFF  status request     00, sent to ADDR_APP; dimmers answer by advert
const OP_EXT_LEVEL = [0xff, 0x03];
const OP_EXT_SCENE = [0xff, 0x0a];
const OP_EXT_STATUS_REQUEST = [0xff, 0xff];

// Data-model messages, all sent to ADDR_DEVICES inside an MCP block (0x73).
//   A0  level and on/off   A0 <tid> F2 E7 <idHi idLo> 00 00 01 <level>
//   CC  heartbeat          CC 40 <name bytes> <idHi idLo> 00 00 00 00
//   F0  set clock          F0 <tid> <yy> <mm> <weekday> <dd> <hh> <mm> <ss> 00
const MCP_DATA_BLOCK = 0x73;
const OP_DATA_LEVEL = 0xa0;
const OP_DATA_HEARTBEAT = 0xcc;
const OP_DATA_SET_TIME = 0xf0;

// Status advert from a dimmer, the only source of state:
//   73 F7 F2 E7 <idHi idLo> 01 00 00 03 <level>
const STATUS_PREFIX = [0x73, 0xf7];

// Levels are plain percent. 0 is off; a lit lamp reports 1..100.
const LEVEL_MIN = 1;
const LEVEL_MAX = 100;

// FF03 power byte. Off is 00 with level 0. 01 with level 0 means "on, at the
// level you had". A0 has no such byte: there, off is 01 with level 0.
const EXT_PWR_OFF = 0x00;
const EXT_PWR_ON = 0x01;

// How the SG phone app repeats unacknowledged commands. Recorded as protocol
// knowledge only: this app sends each command once. The phone holds one steady
// link, while every write here rides a short-lived connection, and repeating
// has broken BLE on Homey before.
const SG_APP_REPEATS = {
  level: { count: 3, intervalMs: 300 },
  scene: { count: 4, intervalMs: 1000 },
};

// CSRmesh group model. A device holds one group id per model and group index
// (the SG database calls the index "slot").
//   0F  set group id   0F <model> <index> <instance> <gidLo gidHi> <tid>
//   10  get group id   10 <model> <index> <tid>
//   11  answer to both
const OP_GROUP_SET = 0x0f;
const OP_GROUP_GET = 0x10;
const OP_GROUP_ANSWER = 0x11;

// CSRmesh model numbers that can carry a group id for a light.
const MODEL_POWER = 19;
const MODEL_LIGHT = 20;
const MODEL_EXTENSION = 28;

// Address as it goes on the air.
function addrBytes(addr) {
  return [addr & 0xff, (addr >> 8) & 0xff];
}

module.exports = {
  ADDR_APP,
  ADDR_BROADCAST,
  ADDR_DEVICES,
  ADDR_GROUP_MIN,
  EXT_PWR_OFF,
  EXT_PWR_ON,
  LEVEL_MAX,
  LEVEL_MIN,
  MCP_DATA_BLOCK,
  MODEL_EXTENSION,
  MODEL_LIGHT,
  MODEL_POWER,
  OP_DATA_HEARTBEAT,
  OP_DATA_LEVEL,
  OP_DATA_SET_TIME,
  OP_EXT_LEVEL,
  OP_EXT_SCENE,
  OP_EXT_STATUS_REQUEST,
  OP_GROUP_ANSWER,
  OP_GROUP_GET,
  OP_GROUP_SET,
  SG_APP_REPEATS,
  SG_VENDOR,
  STATUS_PREFIX,
  addrBytes,
};
