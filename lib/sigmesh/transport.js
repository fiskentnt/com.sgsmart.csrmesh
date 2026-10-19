'use strict';

// Upper and lower transport (Mesh Profile 1.0.1 §3.5, §3.6).
//
// Upper transport encrypts the access payload with the AppKey (application
// nonce) or a device key (device nonce) and appends a TransMIC. Lower
// transport carries the result whole when it fits in 15 bytes, otherwise in
// 12-byte segments, each in its own network PDU with its own SEQ. The
// receiver answers segments with a Segment Acknowledgment control message.
//
//   unsegmented access  SEG=0 AKF AID (1) | upper transport PDU (5-15)
//   segmented access    SEG=1 AKF AID (1) | SZMIC SeqZero(13) SegO(5) SegN(5) (3) | segment (1-12)
//   segment ack         SEG=0 opcode 0x00 (1) | OBO SeqZero(13) RFU(2) (2) | BlockAck (4)
//
// Translated from shejnowicz/homey-ble-mesh, commit 2aff983,
// lib/mesh/packet/{lowerTransport,upperTransport,reassembly}.ts. seqAuth()
// follows frekarlsen/ha-sg-smart-mesh, commit c00c73a, src/btmesh/node.py.
// Both MIT, see LICENSE-MIT. Virtual addresses (Label UUIDs) are left out:
// nothing in this app sends to one.

const { ccmDecrypt, ccmEncrypt } = require('./crypto');
const { MAX_ADDRESS, MAX_IV_INDEX, MAX_SEQ, applicationNonce, assertRange, deviceNonce } = require('./network');

const SEG_BIT = 0x80;
const AKF_BIT = 0x40;
const MAX_AID = 0x3f;
const MAX_CONTROL_OPCODE = 0x7f;
const SZMIC_BIT = 0x800000;
const MAX_SEQ_ZERO = 0x1fff;
const MAX_SEG = 0x1f;

const SEGMENT_SIZE = 12;
const MIN_UNSEGMENTED_UPPER = 5;
const MAX_UNSEGMENTED_UPPER = 15;
const MAX_SEGMENTED_UPPER = (MAX_SEG + 1) * SEGMENT_SIZE;
const MAX_CONTROL_PARAMETERS = 11;
const TRANS_MIC_SHORT = 4;
const TRANS_MIC_LONG = 8;
const SEGMENT_ACK_OPCODE = 0x00;

// ---------------------------------------------------------------- upper

function upperNonce({ keyKind, szmic, seq, src, dst, ivIndex }) {
  const input = { aszmic: szmic, seq, src, dst, ivIndex };
  if (keyKind === 'application') return applicationNonce(input);
  if (keyKind === 'device') return deviceNonce(input);
  throw new Error(`keyKind must be "application" or "device", got ${keyKind}`);
}

function assertUpperFields({ key, seq, src, dst, ivIndex }) {
  if (!Buffer.isBuffer(key) || key.length !== 16) throw new Error(`key must be 16 bytes, got ${key && key.length}`);
  assertRange('seq', seq, MAX_SEQ);
  assertRange('src', src, MAX_ADDRESS);
  assertRange('dst', dst, MAX_ADDRESS);
  assertRange('ivIndex', ivIndex, MAX_IV_INDEX);
}

// `seq` is SeqAuth: the SEQ of the first (or only) network PDU of the message.
function encryptUpperTransport({ accessPayload, key, keyKind, seq, src, dst, ivIndex, szmic = false }) {
  assertUpperFields({ key, seq, src, dst, ivIndex });
  const micLength = szmic ? TRANS_MIC_LONG : TRANS_MIC_SHORT;
  if (!accessPayload || accessPayload.length < 1 || accessPayload.length > MAX_SEGMENTED_UPPER - micLength) {
    throw new Error(`accessPayload must be 1-${MAX_SEGMENTED_UPPER - micLength} bytes, got ${accessPayload && accessPayload.length}`);
  }
  const nonce = upperNonce({ keyKind, szmic, seq, src, dst, ivIndex });
  const { ciphertext, tag } = ccmEncrypt(key, nonce, accessPayload, micLength);
  return Buffer.concat([ciphertext, tag]);
}

// The access payload, or null when the TransMIC does not verify.
function decryptUpperTransport({ upperTransportPdu, key, keyKind, seq, src, dst, ivIndex, szmic = false }) {
  assertUpperFields({ key, seq, src, dst, ivIndex });
  const micLength = szmic ? TRANS_MIC_LONG : TRANS_MIC_SHORT;
  if (!upperTransportPdu || upperTransportPdu.length <= micLength) return null;
  const nonce = upperNonce({ keyKind, szmic, seq, src, dst, ivIndex });
  const split = upperTransportPdu.length - micLength;
  return ccmDecrypt(key, nonce, upperTransportPdu.subarray(0, split), upperTransportPdu.subarray(split));
}

// ---------------------------------------------------------------- lower, access

function encodeUnsegmentedAccess({ akf, aid, upperTransportPdu }) {
  assertRange('aid', aid, MAX_AID);
  if (upperTransportPdu.length < MIN_UNSEGMENTED_UPPER || upperTransportPdu.length > MAX_UNSEGMENTED_UPPER) {
    throw new Error(`upperTransportPdu must be ${MIN_UNSEGMENTED_UPPER}-${MAX_UNSEGMENTED_UPPER} bytes, got ${upperTransportPdu.length}`);
  }
  return Buffer.concat([Buffer.from([(akf ? AKF_BIT : 0) | aid]), upperTransportPdu]);
}

function decodeUnsegmentedAccess(pdu) {
  if (!pdu || pdu.length < 1 || (pdu[0] & SEG_BIT) !== 0) return null;
  const length = pdu.length - 1;
  if (length < MIN_UNSEGMENTED_UPPER || length > MAX_UNSEGMENTED_UPPER) return null;
  return { akf: (pdu[0] & AKF_BIT) !== 0, aid: pdu[0] & MAX_AID, upperTransportPdu: Buffer.from(pdu.subarray(1)) };
}

function segmentHeader({ akf, aid, szmic, seqZero, segO, segN }) {
  const rest = (szmic ? SZMIC_BIT : 0) | ((seqZero & MAX_SEQ_ZERO) << 10) | ((segO & MAX_SEG) << 5) | (segN & MAX_SEG);
  return Buffer.from([SEG_BIT | (akf ? AKF_BIT : 0) | (aid & MAX_AID), (rest >>> 16) & 0xff, (rest >>> 8) & 0xff, rest & 0xff]);
}

// One lower transport PDU per segment. Segment n goes out with SEQ
// SeqAuth + n; SeqZero is the 13 low bits of SeqAuth.
function segmentAccessMessage({ akf, aid, szmic = false, seqZero, upperTransportPdu }) {
  assertRange('aid', aid, MAX_AID);
  assertRange('seqZero', seqZero, MAX_SEQ_ZERO);
  if (!upperTransportPdu || upperTransportPdu.length < 1 || upperTransportPdu.length > MAX_SEGMENTED_UPPER) {
    throw new Error(`upperTransportPdu must be 1-${MAX_SEGMENTED_UPPER} bytes, got ${upperTransportPdu && upperTransportPdu.length}`);
  }
  const segN = Math.ceil(upperTransportPdu.length / SEGMENT_SIZE) - 1;
  const segments = [];
  for (let segO = 0; segO <= segN; segO += 1) {
    const chunk = upperTransportPdu.subarray(segO * SEGMENT_SIZE, (segO + 1) * SEGMENT_SIZE);
    segments.push(Buffer.concat([segmentHeader({ akf, aid, szmic, seqZero, segO, segN }), chunk]));
  }
  return segments;
}

// Null unless a well-formed segment: SegO <= SegN, and every segment but the
// last exactly 12 bytes.
function decodeSegmentedAccess(pdu) {
  if (!pdu || pdu.length <= 4 || (pdu[0] & SEG_BIT) === 0) return null;
  const length = pdu.length - 4;
  if (length > SEGMENT_SIZE) return null;
  const rest = (pdu[1] << 16) | (pdu[2] << 8) | pdu[3];
  const segO = (rest >>> 5) & MAX_SEG;
  const segN = rest & MAX_SEG;
  if (segO > segN || (segO !== segN && length !== SEGMENT_SIZE)) return null;
  return {
    akf: (pdu[0] & AKF_BIT) !== 0,
    aid: pdu[0] & MAX_AID,
    szmic: (rest & SZMIC_BIT) !== 0,
    seqZero: (rest >>> 10) & MAX_SEQ_ZERO,
    segO,
    segN,
    segment: Buffer.from(pdu.subarray(4)),
  };
}

// SeqAuth (the first segment's SEQ) from any segment's SEQ and its SeqZero:
// the closest SEQ at or below `seq` whose 13 low bits are SeqZero (§3.5.3.1).
function seqAuth(seq, seqZero) {
  let value = (seq & ~MAX_SEQ_ZERO) | seqZero;
  if (value > seq) value -= MAX_SEQ_ZERO + 1;
  return value;
}

// ---------------------------------------------------------------- lower, control

function encodeUnsegmentedControl({ opcode, parameters }) {
  assertRange('opcode', opcode, MAX_CONTROL_OPCODE);
  if (parameters.length > MAX_CONTROL_PARAMETERS) {
    throw new Error(`control parameters must be 0-${MAX_CONTROL_PARAMETERS} bytes, got ${parameters.length}`);
  }
  return Buffer.concat([Buffer.from([opcode]), parameters]);
}

function decodeUnsegmentedControl(pdu) {
  if (!pdu || pdu.length < 1 || (pdu[0] & SEG_BIT) !== 0) return null;
  if (pdu.length - 1 > MAX_CONTROL_PARAMETERS) return null;
  return { opcode: pdu[0] & MAX_CONTROL_OPCODE, parameters: Buffer.from(pdu.subarray(1)) };
}

// The 6 parameter bytes of a Segment Acknowledgment. Bit n of BlockAck means
// segment n arrived.
function encodeSegmentAck({ obo = false, seqZero, blockAck }) {
  assertRange('seqZero', seqZero, MAX_SEQ_ZERO);
  assertRange('blockAck', blockAck, 0xffffffff);
  const parameters = Buffer.alloc(6);
  parameters[0] = (obo ? 0x80 : 0) | ((seqZero >>> 6) & 0x7f);
  parameters[1] = (seqZero & 0x3f) << 2;
  parameters.writeUInt32BE(blockAck, 2);
  return parameters;
}

function decodeSegmentAck(parameters) {
  if (!parameters || parameters.length !== 6) return null;
  return {
    obo: (parameters[0] & 0x80) !== 0,
    seqZero: ((parameters[0] & 0x7f) << 6) | ((parameters[1] >>> 2) & 0x3f),
    blockAck: parameters.readUInt32BE(2),
  };
}

// ---------------------------------------------------------------- reassembly

// Collects the segments of one message from one source. State is immutable:
// each call returns a new one. 'complete' carries the upper transport PDU.
function acceptSegment(state, src, pdu) {
  assertRange('src', src, MAX_ADDRESS);
  const decoded = decodeSegmentedAccess(pdu);
  if (decoded === null) return { kind: 'ignored', state, reason: 'not a well-formed segment' };
  const { akf, aid, szmic, seqZero, segO, segN, segment } = decoded;

  let segments;
  if (state === undefined) {
    segments = new Array(segN + 1).fill(undefined);
  } else {
    if (src !== state.src) return { kind: 'ignored', state, reason: `source 0x${src.toString(16)} is not 0x${state.src.toString(16)}` };
    if (seqZero !== state.seqZero || segN !== state.segN || akf !== state.akf || aid !== state.aid || szmic !== state.szmic) {
      return { kind: 'ignored', state, reason: 'segment belongs to another message' };
    }
    if (state.segments[segO] !== undefined) return { kind: 'ignored', state, reason: `segment ${segO} already received` };
    segments = state.segments.slice();
  }
  segments[segO] = segment;
  const next = { src, seqZero, segN, akf, aid, szmic, segments };
  if (segments.every((s) => s !== undefined)) {
    return { kind: 'complete', state: next, upperTransportPdu: Buffer.concat(segments), akf, aid, szmic };
  }
  return { kind: 'incomplete', state: next };
}

function blockAckFrom(state) {
  let ack = 0;
  state.segments.forEach((segment, segO) => {
    if (segment !== undefined) ack += 2 ** segO;
  });
  return ack;
}

module.exports = {
  SEGMENT_ACK_OPCODE,
  SEGMENT_SIZE,
  acceptSegment,
  blockAckFrom,
  decodeSegmentAck,
  decodeSegmentedAccess,
  decodeUnsegmentedAccess,
  decodeUnsegmentedControl,
  decryptUpperTransport,
  encodeSegmentAck,
  encodeUnsegmentedAccess,
  encodeUnsegmentedControl,
  encryptUpperTransport,
  segmentAccessMessage,
  seqAuth,
};
