'use strict';

// Sample data from the Mesh Profile 1.0.1 specification, §8.3, as transcribed
// in shejnowicz/homey-ble-mesh (lib/mesh/packet/__tests__/vectors.ts).

const test = require('node:test');
const assert = require('node:assert/strict');

const t = require('../../lib/sigmesh/transport');
const { decodeAccessMessage, encodeAccessMessage, makeVendorOpcode } = require('../../lib/sigmesh/access');

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

// Message #18: Health Current Status, AppKey (§8.3.18).
const APP_SAMPLE = {
  keyKind: 'application', key: hex('63964771734fbd76e3b40519d1d94a48'),
  seq: 0x000007, src: 0x1201, dst: 0xffff, ivIndex: 0x12345678,
  accessPayload: hex('0400000000'), upper: '5a8bde6d9106ea078a', lower: '665a8bde6d9106ea078a',
};

// Message #6: Config AppKey Add, device key, two segments (§8.3.6).
const DEVICE_SAMPLE = {
  keyKind: 'device', key: hex('9d6dd0e96eb25dc19a40ed9914f8f03f'),
  seq: 0x3129ab, src: 0x0003, dst: 0x1201, ivIndex: 0x12345678,
  accessPayload: hex('0056341263964771734fbd76e3b40519d1d94a48'),
  upper: 'ee9dddfd2169326d23f3afdfcfdc18c52fdef772e0e17308',
  segments: ['8026ac01ee9dddfd2169326d23f3afdf', '8026ac21cfdc18c52fdef772e0e17308'],
};

test('upper transport with the AppKey, message #18', () => {
  const upper = t.encryptUpperTransport(APP_SAMPLE);
  assert.equal(upper.toString('hex'), APP_SAMPLE.upper);
  assert.deepEqual(t.decryptUpperTransport({ ...APP_SAMPLE, upperTransportPdu: upper }), APP_SAMPLE.accessPayload);
});

test('upper transport with a device key, message #6', () => {
  const upper = t.encryptUpperTransport(DEVICE_SAMPLE);
  assert.equal(upper.toString('hex'), DEVICE_SAMPLE.upper);
  assert.deepEqual(t.decryptUpperTransport({ ...DEVICE_SAMPLE, upperTransportPdu: upper }), DEVICE_SAMPLE.accessPayload);
});

test('upper transport decrypt returns null for the wrong key kind or a changed byte', () => {
  const upper = hex(APP_SAMPLE.upper);
  assert.equal(t.decryptUpperTransport({ ...APP_SAMPLE, keyKind: 'device', upperTransportPdu: upper }), null);
  upper[0] ^= 0x01;
  assert.equal(t.decryptUpperTransport({ ...APP_SAMPLE, upperTransportPdu: upper }), null);
  assert.equal(t.decryptUpperTransport({ ...APP_SAMPLE, upperTransportPdu: hex('01020304') }), null);
});

test('unsegmented access, message #18 (AKF=1, AID=0x26)', () => {
  const lower = t.encodeUnsegmentedAccess({ akf: true, aid: 0x26, upperTransportPdu: hex(APP_SAMPLE.upper) });
  assert.equal(lower.toString('hex'), APP_SAMPLE.lower);
  assert.deepEqual(t.decodeUnsegmentedAccess(lower), { akf: true, aid: 0x26, upperTransportPdu: hex(APP_SAMPLE.upper) });
});

test('segmented access, message #6 (device key, SeqZero 0x9ab)', () => {
  const segments = t.segmentAccessMessage({ akf: false, aid: 0, seqZero: DEVICE_SAMPLE.seq & 0x1fff, upperTransportPdu: hex(DEVICE_SAMPLE.upper) });
  assert.deepEqual(segments.map((s) => s.toString('hex')), DEVICE_SAMPLE.segments);
  assert.deepEqual(t.decodeSegmentedAccess(segments[1]), {
    akf: false, aid: 0, szmic: false, seqZero: 0x9ab, segO: 1, segN: 1, segment: hex('cfdc18c52fdef772e0e17308'),
  });
});

test('segment header with SZMIC=1, message #24 (§8.3.24)', () => {
  const segments = t.segmentAccessMessage({
    akf: true, aid: 0x26, szmic: true, seqZero: 0x80d, upperTransportPdu: hex('c3c51d8e476b28e3aa5001f31c01cea6'),
  });
  assert.deepEqual(segments.map((s) => s.toString('hex')), ['e6a03401c3c51d8e476b28e3aa5001f3', 'e6a034211c01cea6']);
});

test('segment ack, messages #7 and #9 (OBO, SeqZero 0x9ab)', () => {
  for (const [blockAck, expected] of [[0x2, '00a6ac00000002'], [0x3, '00a6ac00000003']]) {
    const parameters = t.encodeSegmentAck({ obo: true, seqZero: 0x9ab, blockAck });
    const pdu = t.encodeUnsegmentedControl({ opcode: t.SEGMENT_ACK_OPCODE, parameters });
    assert.equal(pdu.toString('hex'), expected);
    const control = t.decodeUnsegmentedControl(pdu);
    assert.equal(control.opcode, t.SEGMENT_ACK_OPCODE);
    assert.deepEqual(t.decodeSegmentAck(control.parameters), { obo: true, seqZero: 0x9ab, blockAck });
  }
});

test('malformed lower transport PDUs decode to null', () => {
  const twelve = 'ee9dddfd2169326d23f3afdf';
  assert.equal(t.decodeUnsegmentedAccess(hex('66010203')), null); // upper transport PDU too short
  assert.equal(t.decodeUnsegmentedAccess(hex(DEVICE_SAMPLE.segments[0])), null); // SEG set
  assert.equal(t.decodeSegmentedAccess(hex(APP_SAMPLE.lower)), null); // SEG clear
  assert.equal(t.decodeSegmentedAccess(hex('8026ac01')), null); // header only
  assert.equal(t.decodeSegmentedAccess(hex(`8026ac41${twelve}`)), null); // SegO 2 > SegN 1
  assert.equal(t.decodeSegmentedAccess(hex('8026ac01ee9dddfd21')), null); // not last, shorter than 12
  assert.equal(t.decodeSegmentedAccess(hex(`8026ac21${twelve}ff`)), null); // 13 bytes
  assert.equal(t.decodeSegmentAck(hex('a6ac0000')), null);
});

test('seqAuth finds the first segment from any segment', () => {
  assert.equal(t.seqAuth(0x3129ab, 0x9ab), 0x3129ab);
  assert.equal(t.seqAuth(0x3129ac, 0x9ab), 0x3129ab);
  // SeqZero 0x1fff, the next segment's SEQ crosses into the next 0x2000 block.
  assert.equal(t.seqAuth(0x002000, 0x1fff), 0x001fff);
  assert.equal(t.seqAuth(0x001fff, 0x1fff), 0x001fff);
});

test('reassembly takes segments in any order and reports the block ack', () => {
  const [first, second] = DEVICE_SAMPLE.segments.map(hex);
  let r = t.acceptSegment(undefined, 0x0003, second);
  assert.equal(r.kind, 'incomplete');
  assert.equal(t.blockAckFrom(r.state), 0b10);
  assert.equal(t.acceptSegment(r.state, 0x0003, second).kind, 'ignored'); // duplicate
  assert.equal(t.acceptSegment(r.state, 0x0004, first).kind, 'ignored'); // other source
  r = t.acceptSegment(r.state, 0x0003, first);
  assert.equal(r.kind, 'complete');
  assert.equal(t.blockAckFrom(r.state), 0b11);
  assert.equal(r.upperTransportPdu.toString('hex'), DEVICE_SAMPLE.upper);
});

test('access opcodes: one, two and three octets', () => {
  assert.equal(encodeAccessMessage({ opcode: 0x00, parameters: hex('01') }).toString('hex'), '0001');
  assert.equal(encodeAccessMessage({ opcode: 0x8203, parameters: hex('0101') }).toString('hex'), '82030101');
  assert.equal(encodeAccessMessage({ opcode: makeVendorOpcode(0x20, 0x0ee8) }).toString('hex'), 'e0e80e');
  // Message #24's access payload: vendor opcode EA 0A 00, parameters "World".
  const vendor = decodeAccessMessage(hex('ea0a00576f726c64'));
  assert.equal(vendor.opcode, makeVendorOpcode(0x2a, 0x000a));
  assert.equal(vendor.parameters.toString(), 'World');
  assert.equal(encodeAccessMessage(vendor).toString('hex'), 'ea0a00576f726c64');
  assert.deepEqual(decodeAccessMessage(hex('8203')), { opcode: 0x8203, parameters: Buffer.alloc(0) });
});

test('access: reserved and impossible opcodes', () => {
  assert.throws(() => encodeAccessMessage({ opcode: 0x7f }), /reserved/);
  assert.throws(() => encodeAccessMessage({ opcode: 0x7fff }), /not a valid/);
  assert.equal(decodeAccessMessage(hex('7f00')), null);
  assert.equal(decodeAccessMessage(hex('82')), null);
  assert.equal(decodeAccessMessage(hex('e0e8')), null);
  assert.equal(decodeAccessMessage(Buffer.alloc(0)), null);
});
