'use strict';

// The proxy protocol over GATT (Mesh Profile 1.0.1 §6). Every write to Mesh
// Proxy Data In (2ADD) and every notification from Data Out (2ADE) is one
// Proxy PDU:
//
//   SAR (2 bits) | message type (6 bits) | data
//
// A message longer than one write is split with SAR (first, continuation,
// last). Homey does not tell us the negotiated ATT MTU, so writes are kept to
// 20 bytes, what the smallest ATT MTU (23) allows.
//
// Proxy configuration (§6.5) sets the proxy's filter. A new proxy link starts
// with an empty accept list, which forwards nothing to us, so the first thing
// on a link is Set Filter Type and Add Addresses. They travel as network PDUs
// with CTL=1, TTL=0, DST=0x0000, sealed with the proxy nonce.
//
// SAR translated from shejnowicz/homey-ble-mesh, commit 2aff983,
// lib/mesh/packet/proxyPdu.ts, here accepting all four message types (theirs
// takes network and provisioning PDUs only). Proxy configuration after
// frekarlsen/ha-sg-smart-mesh, commit c00c73a,
// src/btmesh/{proxy_config,node}.py. Both MIT, see LICENSE-MIT.

const { MAX_ADDRESS, assertRange, decodeNetworkPdu, encodeNetworkPdu } = require('./network');

const SAR_COMPLETE = 0b00;
const SAR_FIRST = 0b01;
const SAR_CONTINUATION = 0b10;
const SAR_LAST = 0b11;

const TYPE_NETWORK_PDU = 0x00;
const TYPE_MESH_BEACON = 0x01;
const TYPE_PROXY_CONFIG = 0x02;
const TYPE_PROVISIONING_PDU = 0x03;

const MAX_PROXY_PDU_LENGTH = 20;
const SAR_TIMEOUT_MS = 20000;
// Network PDUs, beacons and proxy configuration fit in 29 bytes; a
// provisioning PDU can be 65 (the public key).
const MAX_MESSAGE_LENGTH = [29, 29, 29, 65];

const FILTER_ACCEPT_LIST = 0x00;
const FILTER_REJECT_LIST = 0x01;
const OP_SET_FILTER_TYPE = 0x00;
const OP_ADD_ADDRESSES = 0x01;
const OP_REMOVE_ADDRESSES = 0x02;
const OP_FILTER_STATUS = 0x03;
// A proxy configuration message is an unsegmented control PDU, at most 12
// bytes: the opcode and five addresses.
const MAX_FILTER_ADDRESSES = 5;

// ---------------------------------------------------------------- SAR

function encodeProxyPdus(messageType, message, maxPduLength = MAX_PROXY_PDU_LENGTH) {
  assertRange('messageType', messageType, 0x3f);
  if (!Number.isInteger(maxPduLength) || maxPduLength < 2) throw new Error(`maxPduLength must be >= 2, got ${maxPduLength}`);
  if (!message || message.length === 0) throw new Error('message is empty');
  const chunk = maxPduLength - 1;
  if (message.length <= chunk) return [Buffer.concat([Buffer.from([(SAR_COMPLETE << 6) | messageType]), message])];
  const pdus = [];
  for (let offset = 0; offset < message.length; offset += chunk) {
    const last = offset + chunk >= message.length;
    const sar = offset === 0 ? SAR_FIRST : (last ? SAR_LAST : SAR_CONTINUATION);
    pdus.push(Buffer.concat([Buffer.from([(sar << 6) | messageType]), message.subarray(offset, offset + chunk)]));
  }
  return pdus;
}

// Feeds one received Proxy PDU. Returns { kind, state, ... }:
//   'complete'    messageType, message
//   'incomplete'  waiting for more
//   'ignored'     an unknown message type or an empty PDU, reason
//   'disconnect'  a SAR error; §6.3.2.2 says the client shall then drop the link
function acceptProxyPdu(state, pdu, nowMs) {
  if (!pdu || pdu.length < 2) return { kind: 'ignored', state, reason: 'Proxy PDU without data' };
  const sar = pdu[0] >> 6;
  const messageType = pdu[0] & 0x3f;
  const data = Buffer.from(pdu.subarray(1));
  if (messageType > TYPE_PROVISIONING_PDU) return { kind: 'ignored', state, reason: `message type 0x${messageType.toString(16)} is reserved` };
  if (state && nowMs - state.startedAtMs >= SAR_TIMEOUT_MS) {
    return { kind: 'disconnect', state: undefined, reason: `SAR transfer timed out after ${nowMs - state.startedAtMs} ms` };
  }
  const tooLong = (length) => length > MAX_MESSAGE_LENGTH[messageType];

  if (sar === SAR_COMPLETE || sar === SAR_FIRST) {
    if (state) return { kind: 'disconnect', state: undefined, reason: 'new message while another was being reassembled' };
    if (tooLong(data.length)) return { kind: 'disconnect', state: undefined, reason: 'message too long' };
    if (sar === SAR_COMPLETE) return { kind: 'complete', state: undefined, messageType, message: data };
    return { kind: 'incomplete', state: { messageType, segments: [data], startedAtMs: nowMs } };
  }
  if (!state) return { kind: 'disconnect', state: undefined, reason: 'continuation without a first segment' };
  if (messageType !== state.messageType) return { kind: 'disconnect', state: undefined, reason: 'message type changed mid-message' };
  const segments = [...state.segments, data];
  const message = Buffer.concat(segments);
  if (tooLong(message.length)) return { kind: 'disconnect', state: undefined, reason: 'message too long' };
  if (sar === SAR_CONTINUATION) return { kind: 'incomplete', state: { ...state, segments } };
  return { kind: 'complete', state: undefined, messageType, message };
}

// ---------------------------------------------------------------- filter

// Set Filter Type also clears the filter's address list.
function setFilterType(filterType) {
  if (filterType !== FILTER_ACCEPT_LIST && filterType !== FILTER_REJECT_LIST) {
    throw new Error(`unknown filter type 0x${Number(filterType).toString(16)}`);
  }
  return Buffer.from([OP_SET_FILTER_TYPE, filterType]);
}

function addressList(opcode, addresses) {
  if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > MAX_FILTER_ADDRESSES) {
    throw new Error(`1-${MAX_FILTER_ADDRESSES} addresses per message, got ${addresses && addresses.length}`);
  }
  const message = Buffer.alloc(1 + addresses.length * 2);
  message[0] = opcode;
  addresses.forEach((address, i) => {
    assertRange('address', address, MAX_ADDRESS);
    message.writeUInt16BE(address, 1 + i * 2);
  });
  return message;
}

function addAddresses(addresses) {
  return addressList(OP_ADD_ADDRESSES, addresses);
}

function removeAddresses(addresses) {
  return addressList(OP_REMOVE_ADDRESSES, addresses);
}

// The proxy's answer to every filter change: { filterType, listSize }, or null.
function parseFilterStatus(message) {
  if (!message || message.length !== 4 || message[0] !== OP_FILTER_STATUS) return null;
  return { filterType: message[1], listSize: message.readUInt16BE(2) };
}

// Seals a proxy configuration message as the network PDU that goes in a Proxy
// PDU of type TYPE_PROXY_CONFIG. It uses up a SEQ like any other network PDU.
function encodeProxyConfigPdu({ networkKey, ivIndex, seq, src, message }) {
  return encodeNetworkPdu({
    networkKey, ivIndex, ctl: true, ttl: 0, seq, src, dst: 0x0000, transportPdu: message, proxy: true,
  });
}

// The proxy configuration message inside, or null when it is not ours. The
// proxy answers from its own address, so the source is not checked.
function decodeProxyConfigPdu({ networkKey, ivIndex, pdu }) {
  const out = decodeNetworkPdu({ networkKey, ivIndex, pdu, proxy: true });
  if (out === null || !out.ctl) return null;
  return out.transportPdu;
}

module.exports = {
  FILTER_ACCEPT_LIST,
  FILTER_REJECT_LIST,
  MAX_PROXY_PDU_LENGTH,
  TYPE_MESH_BEACON,
  TYPE_NETWORK_PDU,
  TYPE_PROVISIONING_PDU,
  TYPE_PROXY_CONFIG,
  acceptProxyPdu,
  addAddresses,
  decodeProxyConfigPdu,
  encodeProxyConfigPdu,
  encodeProxyPdus,
  parseFilterStatus,
  removeAddresses,
  setFilterType,
};
