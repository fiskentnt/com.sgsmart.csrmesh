'use strict';

// Known-answer tests from the Mesh Profile 1.0.1 sample data, §8.3, as
// transcribed in shejnowicz/homey-ble-mesh
// (lib/mesh/packet/__tests__/vectors.ts). Message #1 is also in
// frekarlsen/ha-sg-smart-mesh (tests/test_network.py). The proxy nonce has no
// sample in the specification, so it is tested by layout and round trip.

const test = require('node:test');
const assert = require('node:assert/strict');

const { k2 } = require('../../lib/sigmesh/crypto');
const {
  applicationNonce, decodeNetworkPdu, deviceNonce, encodeNetworkPdu, networkNonce, proxyNonce,
} = require('../../lib/sigmesh/network');

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const NET_KEY = hex('7dd7364cd842ad18c17c2b820c84c3d6');

test('network nonce, messages #1 and #2 (§8.3.1, §8.3.2)', () => {
  assert.equal(
    networkNonce({ ctl: true, ttl: 0, seq: 0x000001, src: 0x1201, ivIndex: 0x12345678 }).toString('hex'),
    '00800000011201000012345678',
  );
  assert.equal(
    networkNonce({ ctl: true, ttl: 0, seq: 0x014820, src: 0x2345, ivIndex: 0x12345678 }).toString('hex'),
    '00800148202345000012345678',
  );
});

test('application nonce, messages #18 and #24 (§8.3.18, §8.3.24)', () => {
  assert.equal(
    applicationNonce({ aszmic: false, seq: 0x000007, src: 0x1201, dst: 0xffff, ivIndex: 0x12345678 }).toString('hex'),
    '01000000071201ffff12345678',
  );
  assert.equal(
    applicationNonce({ aszmic: true, seq: 0x07080d, src: 0x1234, dst: 0x9736, ivIndex: 0x12345677 }).toString('hex'),
    '018007080d1234973612345677',
  );
});

test('device nonce, messages #6 and #16 (§8.3.6, §8.3.16)', () => {
  assert.equal(
    deviceNonce({ aszmic: false, seq: 0x3129ab, src: 0x0003, dst: 0x1201, ivIndex: 0x12345678 }).toString('hex'),
    '02003129ab0003120112345678',
  );
  assert.equal(
    deviceNonce({ aszmic: false, seq: 0x000006, src: 0x1201, dst: 0x0003, ivIndex: 0x12345678 }).toString('hex'),
    '02000000061201000312345678',
  );
});

test('proxy nonce: 03 | 00 | SEQ | SRC | 0000 | IV Index (§3.8.5.4)', () => {
  assert.equal(
    proxyNonce({ seq: 0x070809, src: 0x7fff, ivIndex: 0x12345678 }).toString('hex'),
    '03000708097fff000012345678',
  );
});

const SAMPLES = [
  {
    name: 'message #1, a control message (§8.3.1)',
    input: { ivIndex: 0x12345678, ctl: true, ttl: 0, seq: 0x000001, src: 0x1201, dst: 0xfffd, transportPdu: '034b50057e400000010000' },
    expected: '68eca487516765b5e5bfdacbaf6cb7fb6bff871f035444ce83a670df',
  },
  {
    name: 'message #2, a control message (§8.3.2)',
    input: { ivIndex: 0x12345678, ctl: true, ttl: 0, seq: 0x014820, src: 0x2345, dst: 0x1201, transportPdu: '04320308ba072f' },
    expected: '68d4c826296d7979d7dbc0c9b4d43eebec129d20a620d01e',
  },
  {
    name: 'message #18, an access message (§8.3.18)',
    input: { ivIndex: 0x12345678, ctl: false, ttl: 3, seq: 0x000007, src: 0x1201, dst: 0xffff, transportPdu: '665a8bde6d9106ea078a' },
    expected: '6848cba437860e5673728a627fb938535508e21a6baf57',
  },
  {
    name: 'message #20, odd IV Index (§8.3.20)',
    input: { ivIndex: 0x12345677, ctl: false, ttl: 3, seq: 0x070809, src: 0x1234, dst: 0xffff, transportPdu: '669c9803e110fea929e9542d' },
    expected: 'e85cca51e2e8998c3dc87344a16c787f6b08cc897c941a5368',
  },
];

for (const { name, input, expected } of SAMPLES) {
  test(`encodeNetworkPdu, ${name}`, () => {
    const pdu = encodeNetworkPdu({ ...input, networkKey: NET_KEY, transportPdu: hex(input.transportPdu) });
    assert.equal(pdu.toString('hex'), expected);
  });

  test(`decodeNetworkPdu, ${name}`, () => {
    const out = decodeNetworkPdu({ networkKey: NET_KEY, ivIndex: input.ivIndex, pdu: hex(expected) });
    assert.deepEqual(
      { ...out, transportPdu: out.transportPdu.toString('hex') },
      { ...input },
    );
  });
}

test('decode uses the previous IV Index when the IVI bit says so', () => {
  // Message #20 was sent with 0x12345677. We are already on 0x12345678.
  const out = decodeNetworkPdu({ networkKey: NET_KEY, ivIndex: 0x12345678, pdu: hex(SAMPLES[3].expected) });
  assert.equal(out.ivIndex, 0x12345677);
  assert.equal(out.transportPdu.toString('hex'), SAMPLES[3].input.transportPdu);
});

test('decode returns null when the IVI bit points below IV Index 0', () => {
  const pdu = encodeNetworkPdu({ ...SAMPLES[2].input, ivIndex: 1, networkKey: NET_KEY, transportPdu: hex('665a8bde') });
  assert.equal(decodeNetworkPdu({ networkKey: NET_KEY, ivIndex: 0, pdu }), null);
});

test('decode returns null for another network with the same NID', () => {
  // From homey-ble-mesh's vectors: a key chosen so that its NID is also 0x68.
  const foreign = hex('00000000000000000000000000000033');
  assert.equal(k2(foreign, hex('00')).nid, k2(NET_KEY, hex('00')).nid);
  assert.equal(decodeNetworkPdu({ networkKey: foreign, ivIndex: 0x12345678, pdu: hex(SAMPLES[2].expected) }), null);
});

test('decode returns null for a changed byte, a short PDU or another NID', () => {
  const tampered = hex(SAMPLES[2].expected);
  tampered[10] ^= 0x01;
  assert.equal(decodeNetworkPdu({ networkKey: NET_KEY, ivIndex: 0x12345678, pdu: tampered }), null);
  assert.equal(decodeNetworkPdu({ networkKey: NET_KEY, ivIndex: 0x12345678, pdu: hex('68eca48751') }), null);
  const otherNid = hex(SAMPLES[2].expected);
  otherNid[0] ^= 0x01;
  assert.equal(decodeNetworkPdu({ networkKey: NET_KEY, ivIndex: 0x12345678, pdu: otherNid }), null);
});

test('a proxy configuration PDU only decodes with the proxy nonce', () => {
  // Set Filter Type (0x00), accept list (0x00): CTL=1, TTL=0, DST=0x0000 (§6.5).
  const input = { networkKey: NET_KEY, ivIndex: 0, ctl: true, ttl: 0, seq: 1, src: 0x7fff, dst: 0x0000, transportPdu: hex('0000') };
  const sealed = encodeNetworkPdu({ ...input, proxy: true });
  const out = decodeNetworkPdu({ networkKey: NET_KEY, ivIndex: 0, pdu: sealed, proxy: true });
  assert.equal(out.src, 0x7fff);
  assert.equal(out.transportPdu.toString('hex'), '0000');
  // The mistake SG nodes punish: sealed one way, opened the other.
  assert.equal(decodeNetworkPdu({ networkKey: NET_KEY, ivIndex: 0, pdu: sealed }), null);
  assert.equal(decodeNetworkPdu({ networkKey: NET_KEY, ivIndex: 0, pdu: encodeNetworkPdu(input), proxy: true }), null);
});

test('encode refuses fields out of range and transport PDUs of the wrong size', () => {
  const base = { ...SAMPLES[2].input, networkKey: NET_KEY, transportPdu: hex('00') };
  assert.throws(() => encodeNetworkPdu({ ...base, seq: 0x1000000 }), /seq/);
  assert.throws(() => encodeNetworkPdu({ ...base, ttl: 0x80 }), /ttl/);
  assert.throws(() => encodeNetworkPdu({ ...base, src: -1 }), /src/);
  assert.throws(() => encodeNetworkPdu({ ...base, transportPdu: Buffer.alloc(17) }), /transportPdu/);
  assert.throws(() => encodeNetworkPdu({ ...base, ctl: true, transportPdu: Buffer.alloc(13) }), /transportPdu/);
  assert.throws(() => encodeNetworkPdu({ ...base, networkKey: Buffer.alloc(8) }), /networkKey/);
});
