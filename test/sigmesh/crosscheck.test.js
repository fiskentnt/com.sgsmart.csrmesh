'use strict';

// Byte-for-byte comparison with frekarlsen/ha-sg-smart-mesh (commit c00c73a).
// ha-crosscheck.json was made by that project's Python code through
// ha_crosscheck.py in this folder; the JS port must give the same bytes for
// the same inputs, and must read back what the Python side sent.

const test = require('node:test');
const assert = require('node:assert/strict');

const reference = require('./ha-crosscheck.json');
const { buildSecureNetworkBeacon, parseSecureNetworkBeacon } = require('../../lib/sigmesh/beacon');
const { acceptAccessPdu, encodeMeshMessage } = require('../../lib/sigmesh/message');
const { decodeNetworkPdu, encodeNetworkPdu } = require('../../lib/sigmesh/network');
const proxy = require('../../lib/sigmesh/proxy');
const { SEGMENT_ACK_OPCODE, encodeSegmentAck, encodeUnsegmentedControl } = require('../../lib/sigmesh/transport');
const sg = require('../../lib/sg3/protocol');

const hex = (s) => Buffer.from(s, 'hex');
const toHex = (buffers) => buffers.map((b) => b.toString('hex'));
const NET_KEY = hex(reference.netKey);
const APP_KEY = hex(reference.appKey);
const NODE = 0x0003;

// The same calls ha_crosscheck.py makes, in the same order.
const JS_COMMANDS = [
  sg.sgPowerLevelSet(NODE, 50, { tid: 1, seq: 1 }),
  sg.sgPowerLevelSet(NODE, 0, { tid: 4, seq: 1 }),
  sg.sgPowerLevelSet(NODE, 101, { tid: 5, seq: 1 }),
  sg.sgStatusGet(NODE, { tid: 2, seq: 2 }),
  sg.sgPowerLevelSet(NODE, 30, { tid: 7, seq: 7 }),
];

function encode(c, accessPayload) {
  let seq = c.firstSeq;
  return encodeMeshMessage({
    accessPayload, key: APP_KEY, keyKind: 'application', src: c.src, dst: c.dst,
    netKey: NET_KEY, ivIndex: c.ivIndex, ttl: c.ttl, allocateSeq: () => seq++,
  });
}

// Runs network PDUs through decode and reassembly the way a receiver would.
function receive(c) {
  let state;
  const results = [];
  for (const pdu of c.networkPdus) {
    const net = decodeNetworkPdu({ networkKey: NET_KEY, ivIndex: c.ivIndex, pdu: hex(pdu) });
    assert.ok(net, 'network PDU decodes');
    const result = acceptAccessPdu(state, net, { appKey: APP_KEY });
    state = result.state;
    results.push(result);
  }
  return results;
}

test('the reference was made from the expected source and keys', () => {
  assert.match(reference.source, /c00c73a/);
  assert.equal(reference.commands.length, JS_COMMANDS.length);
  assert.equal(reference.mtu, proxy.MAX_PROXY_PDU_LENGTH);
});

reference.commands.forEach((c, i) => {
  test(`command "${c.name}": access payload, network PDUs and proxy PDUs match`, () => {
    assert.equal(JS_COMMANDS[i].toString('hex'), c.accessPayload);
    const pdus = encode(c, JS_COMMANDS[i]);
    assert.deepEqual(toHex(pdus), c.networkPdus);
    assert.deepEqual(pdus.map((p) => toHex(proxy.encodeProxyPdus(proxy.TYPE_NETWORK_PDU, p))), c.proxyPdus);
  });

  test(`command "${c.name}": a receiver gets the access payload back`, () => {
    const results = receive(c);
    const last = results[results.length - 1];
    assert.equal(last.kind, 'complete');
    assert.equal(last.seqAuth, c.firstSeq);
    assert.equal(last.message.opcode, sg.OP_SG_COMMAND);
    assert.equal(Buffer.concat([hex('e0e80e'), last.message.parameters]).toString('hex'), c.accessPayload);
  });
});

reference.received.forEach((c) => {
  test(`from a node, "${c.name}": the JS side would send the same bytes`, () => {
    // The broadcast is 11 bytes, the most an unsegmented message can carry.
    assert.deepEqual(toHex(encode(c, hex(c.accessPayload))), c.networkPdus);
  });

  test(`from a node, "${c.name}": decoded, parsed and acknowledged like the Python side`, () => {
    const results = receive(c);
    const last = results[results.length - 1];
    assert.equal(last.kind, 'complete');
    assert.equal(last.message.opcode, sg.OP_SG_STATUS);
    assert.deepEqual(sg.parseSgStatus(last.message.parameters), c.status);

    if (c.ack) {
      assert.deepEqual(last.ack, { seqZero: c.ack.seqZero, blockAck: 2 ** c.networkPdus.length - 1 });
      const ackPdu = encodeNetworkPdu({
        networkKey: NET_KEY, ivIndex: c.ivIndex, ctl: true, ttl: c.ttl, seq: c.ack.seq, src: c.dst, dst: c.src,
        transportPdu: encodeUnsegmentedControl({ opcode: SEGMENT_ACK_OPCODE, parameters: encodeSegmentAck(last.ack) }),
      });
      assert.equal(ackPdu.toString('hex'), c.ack.networkPdu);
    } else {
      assert.equal(last.ack, undefined);
    }
  });

  test(`from a node, "${c.name}": proxy PDUs reassemble into the network PDUs`, () => {
    c.proxyPdus.forEach((frames, i) => {
      let state;
      let result;
      for (const frame of frames) {
        result = proxy.acceptProxyPdu(state, hex(frame), 0);
        state = result.state;
      }
      assert.equal(result.kind, 'complete');
      assert.equal(result.messageType, proxy.TYPE_NETWORK_PDU);
      assert.equal(result.message.toString('hex'), c.networkPdus[i]);
    });
  });
});

test('proxy filter: messages, sealed network PDUs and proxy PDUs match', () => {
  const f = reference.proxyFilter;
  const messages = [proxy.setFilterType(proxy.FILTER_ACCEPT_LIST), proxy.addAddresses([0x7fff, 0xcee8])];
  assert.deepEqual(toHex(messages), f.messages);
  const pdus = messages.map((message, i) => proxy.encodeProxyConfigPdu({
    networkKey: NET_KEY, ivIndex: f.ivIndex, seq: f.firstSeq + i, src: f.src, message,
  }));
  assert.deepEqual(toHex(pdus), f.networkPdus);
  assert.deepEqual(pdus.map((p) => toHex(proxy.encodeProxyPdus(proxy.TYPE_PROXY_CONFIG, p))), f.proxyPdus);
  f.networkPdus.forEach((pdu, i) => {
    assert.equal(proxy.decodeProxyConfigPdu({ networkKey: NET_KEY, ivIndex: f.ivIndex, pdu: hex(pdu) }).toString('hex'), f.messages[i]);
  });
});

test('secure network beacons match, and parse back', () => {
  for (const b of reference.beacons) {
    assert.equal(buildSecureNetworkBeacon(NET_KEY, { ivIndex: b.ivIndex, ivUpdate: b.ivUpdate }).toString('hex'), b.beacon);
    const parsed = parseSecureNetworkBeacon(hex(b.beacon), NET_KEY);
    assert.equal(parsed.ivIndex, b.ivIndex);
    assert.equal(parsed.ivUpdate, b.ivUpdate);
  }
});
