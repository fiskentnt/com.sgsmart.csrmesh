'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { acceptAccessPdu, encodeMeshMessage } = require('../../lib/sigmesh/message');
const { decodeNetworkPdu } = require('../../lib/sigmesh/network');
const { sgPowerLevelSet, sgStatusGet } = require('../../lib/sg3/protocol');

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const NET_KEY = hex('7dd7364cd842ad18c17c2b820c84c3d6');
const APP_KEY = hex('63964771734fbd76e3b40519d1d94a48');
const DEVICE_KEY = hex('9d6dd0e96eb25dc19a40ed9914f8f03f');
const HOMEY = 0x7fff;
const NODE = 0x0003;

function send(accessPayload, { firstSeq = 0x100, keyKind = 'application', key = APP_KEY, src = HOMEY, dst = NODE } = {}) {
  let seq = firstSeq;
  const pdus = encodeMeshMessage({
    accessPayload, key, keyKind, src, dst, netKey: NET_KEY, ivIndex: 0, ttl: 7, allocateSeq: () => seq++,
  });
  return pdus.map((pdu) => decodeNetworkPdu({ networkKey: NET_KEY, ivIndex: 0, pdu }));
}

const KEYS = { appKey: APP_KEY, deviceKeyFor: (src) => (src === HOMEY ? DEVICE_KEY : null) };
const LEVEL = sgPowerLevelSet(NODE, 50, { tid: 1, seq: 1 });

test('a short message goes in one network PDU, a long one in segments with consecutive SEQ', () => {
  const short = send(sgStatusGet(NODE, { tid: 2, seq: 2 }));
  assert.equal(short.length, 1);
  const long = send(LEVEL, { firstSeq: 0x200 });
  assert.deepEqual(long.map((n) => n.seq), [0x200, 0x201]);
  assert.ok(long.every((n) => !n.ctl && n.ttl === 7 && n.src === HOMEY && n.dst === NODE));
});

test('segments must get consecutive SEQs', () => {
  let seq = 0x10;
  assert.throws(() => encodeMeshMessage({
    accessPayload: LEVEL, key: APP_KEY, keyKind: 'application', src: HOMEY, dst: NODE,
    netKey: NET_KEY, ivIndex: 0, ttl: 7, allocateSeq: () => (seq += 2),
  }), /expected/);
});

test('an unsegmented message completes at once, with no ack', () => {
  const [net] = send(sgStatusGet(NODE, { tid: 2, seq: 2 }));
  const result = acceptAccessPdu(undefined, net, KEYS);
  assert.equal(result.kind, 'complete');
  assert.equal(result.keyKind, 'application');
  assert.equal(result.ack, undefined);
});

test('segments in reverse order complete the message, and each reports the ack', () => {
  const [first, second] = send(LEVEL, { firstSeq: 0x300 });
  const r1 = acceptAccessPdu(undefined, second, KEYS);
  assert.equal(r1.kind, 'incomplete');
  assert.deepEqual(r1.ack, { seqZero: 0x300, blockAck: 0b10 });
  const r2 = acceptAccessPdu(r1.state, first, KEYS);
  assert.equal(r2.kind, 'complete');
  assert.equal(r2.seqAuth, 0x300);
  assert.deepEqual(r2.ack, { seqZero: 0x300, blockAck: 0b11 });
  assert.equal(r2.message.parameters.toString('hex'), LEVEL.subarray(3).toString('hex'));
});

test('a segment repeated after completion is a duplicate, acknowledged in full again', () => {
  const [first, second] = send(LEVEL, { firstSeq: 0x400 });
  const done = acceptAccessPdu(acceptAccessPdu(undefined, first, KEYS).state, second, KEYS);
  const again = acceptAccessPdu(done.state, second, KEYS);
  assert.equal(again.kind, 'duplicate');
  assert.deepEqual(again.ack, { seqZero: 0x400, blockAck: 0b11 });
});

test('a newer message replaces an unfinished one, an older one is ignored', () => {
  const [oldFirst] = send(LEVEL, { firstSeq: 0x500 });
  const [newFirst, newSecond] = send(LEVEL, { firstSeq: 0x510 });
  let r = acceptAccessPdu(undefined, oldFirst, KEYS);
  r = acceptAccessPdu(r.state, newFirst, KEYS);
  assert.equal(r.kind, 'incomplete');
  assert.equal(r.state.seqAuth, 0x510);
  assert.equal(acceptAccessPdu(r.state, oldFirst, KEYS).kind, 'ignored');
  assert.equal(acceptAccessPdu(r.state, newSecond, KEYS).kind, 'complete');
});

test('another AppKey (other AID) or an unknown device key is ignored', () => {
  const [net] = send(sgStatusGet(NODE, { tid: 2, seq: 2 }));
  const otherApp = acceptAccessPdu(undefined, net, { appKey: hex('00112233445566778899aabbccddeeff') });
  assert.equal(otherApp.kind, 'ignored');
  assert.match(otherApp.reason, /AID/);
  const [devNet] = send(hex('8008'), { keyKind: 'device', key: DEVICE_KEY, src: NODE, dst: HOMEY });
  assert.equal(acceptAccessPdu(undefined, devNet, KEYS).kind, 'ignored');
});

test('a device key message from a known source decodes with that key', () => {
  // The node answers with its own device key, so the key is looked up by source.
  const [net] = send(hex('8008'), { keyKind: 'device', key: DEVICE_KEY, src: HOMEY, dst: NODE });
  const result = acceptAccessPdu(undefined, net, KEYS);
  assert.equal(result.kind, 'complete');
  assert.equal(result.keyKind, 'device');
  assert.equal(result.message.opcode, 0x8008);
});
