'use strict';

// From an access payload to the network PDUs that carry it, and back.
//
// Sending is translated from shejnowicz/homey-ble-mesh, commit 2aff983,
// lib/mesh/packet/message.ts (MIT, see LICENSE-MIT). Receiving is reworked
// for a proxy link that hears many nodes: segments may come in any order
// (SeqAuth from any segment, as frekarlsen/ha-sg-smart-mesh does), a newer
// message from the same source replaces an unfinished one, and every segment
// reports what to acknowledge. Timers, replay protection and whether to send
// the ack at all belong to the session above this.

const { k4 } = require('./crypto');
const { decodeAccessMessage } = require('./access');
const { encodeNetworkPdu } = require('./network');
const {
  acceptSegment, blockAckFrom, decodeSegmentedAccess, decodeUnsegmentedAccess, decryptUpperTransport,
  encodeUnsegmentedAccess, encryptUpperTransport, segmentAccessMessage, seqAuth,
} = require('./transport');

const MAX_SEQ_ZERO = 0x1fff;
const MAX_UNSEGMENTED_UPPER = 15;

// Returns the network PDUs in sending order. `allocateSeq` is called once per
// PDU and must hand out consecutive numbers: segment n is SeqAuth + n.
// `keyKind` is 'application' (AKF=1, AID from the AppKey) or 'device'.
function encodeMeshMessage({ accessPayload, key, keyKind, src, dst, netKey, ivIndex, ttl, allocateSeq }) {
  const akf = keyKind === 'application';
  const aid = akf ? k4(key) : 0;
  const firstSeq = allocateSeq();
  const upperTransportPdu = encryptUpperTransport({ accessPayload, key, keyKind, seq: firstSeq, src, dst, ivIndex });
  const networkPdu = (seq, transportPdu) => encodeNetworkPdu({
    networkKey: netKey, ivIndex, ctl: false, ttl, seq, src, dst, transportPdu,
  });

  if (upperTransportPdu.length <= MAX_UNSEGMENTED_UPPER) {
    return [networkPdu(firstSeq, encodeUnsegmentedAccess({ akf, aid, upperTransportPdu }))];
  }
  const segments = segmentAccessMessage({ akf, aid, seqZero: firstSeq & MAX_SEQ_ZERO, upperTransportPdu });
  return segments.map((segment, segO) => {
    const seq = segO === 0 ? firstSeq : allocateSeq();
    if (seq !== firstSeq + segO) {
      throw new Error(`allocateSeq gave ${seq} for segment ${segO}, expected ${firstSeq + segO}`);
    }
    return networkPdu(seq, segment);
  });
}

function keyFor(akf, aid, src, keys) {
  if (akf) {
    if (!keys.appKey || aid !== k4(keys.appKey)) return null;
    return { key: keys.appKey, keyKind: 'application' };
  }
  const deviceKey = keys.deviceKeyFor ? keys.deviceKeyFor(src) : null;
  return deviceKey ? { key: deviceKey, keyKind: 'device' } : null;
}

function decrypt(net, akf, aid, seq, upperTransportPdu, keys) {
  const found = keyFor(akf, aid, net.src, keys);
  if (!found) return { reason: akf ? 'AID does not match our AppKey' : 'no device key for this source' };
  const accessPayload = decryptUpperTransport({
    upperTransportPdu, ...found, seq, src: net.src, dst: net.dst, ivIndex: net.ivIndex,
  });
  if (accessPayload === null) return { reason: 'TransMIC does not verify' };
  const message = decodeAccessMessage(accessPayload);
  if (message === null) return { reason: 'access payload too short for its opcode' };
  return { message, keyKind: found.keyKind };
}

// `net` is a decoded network PDU with ctl=false (see decodeNetworkPdu).
// `state` is this source's reassembly state from the previous call, or
// undefined. `keys` is { appKey, deviceKeyFor(src) }.
//
// Returns { kind, state, ... }:
//   'complete'   message ({ opcode, parameters }), keyKind, seqAuth
//   'incomplete' a segment was stored
//   'duplicate'  a segment of a message already completed
//   'ignored'    reason
// Every result from a segment also carries `ack` ({ seqZero, blockAck }) for
// the session to send when the message was addressed to us.
function acceptAccessPdu(state, net, keys) {
  const unsegmented = decodeUnsegmentedAccess(net.transportPdu);
  if (unsegmented !== null) {
    const out = decrypt(net, unsegmented.akf, unsegmented.aid, net.seq, unsegmented.upperTransportPdu, keys);
    if (!out.message) return { kind: 'ignored', state, reason: out.reason };
    return { kind: 'complete', state, message: out.message, keyKind: out.keyKind, seqAuth: net.seq };
  }

  const segment = decodeSegmentedAccess(net.transportPdu);
  if (segment === null) return { kind: 'ignored', state, reason: 'neither an unsegmented nor a segmented access PDU' };
  if (segment.szmic) return { kind: 'ignored', state, reason: 'SZMIC=1 (64-bit TransMIC) is not supported' };
  const auth = seqAuth(net.seq, segment.seqZero);
  const fullAck = 2 ** (segment.segN + 1) - 1;

  if (state && state.seqAuth === auth && state.done) {
    return { kind: 'duplicate', state, ack: { seqZero: segment.seqZero, blockAck: fullAck } };
  }
  if (state && state.seqAuth > auth) {
    return { kind: 'ignored', state, reason: 'segment of an older message' };
  }
  const previous = state && state.seqAuth === auth ? state.reassembly : undefined;
  const accepted = acceptSegment(previous, net.src, net.transportPdu);
  if (accepted.kind === 'ignored') {
    const ack = previous ? { seqZero: segment.seqZero, blockAck: blockAckFrom(previous) } : undefined;
    return { kind: 'ignored', state, reason: accepted.reason, ack };
  }
  const next = { seqAuth: auth, reassembly: accepted.state, done: accepted.kind === 'complete' };
  const ack = { seqZero: segment.seqZero, blockAck: blockAckFrom(accepted.state) };
  if (accepted.kind === 'incomplete') return { kind: 'incomplete', state: next, ack };

  const out = decrypt(net, accepted.akf, accepted.aid, auth, accepted.upperTransportPdu, keys);
  if (!out.message) return { kind: 'ignored', state: next, reason: out.reason, ack };
  return { kind: 'complete', state: next, message: out.message, keyKind: out.keyKind, seqAuth: auth, ack };
}

module.exports = {
  acceptAccessPdu,
  encodeMeshMessage,
};
