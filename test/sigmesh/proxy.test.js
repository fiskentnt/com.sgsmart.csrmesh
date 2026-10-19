'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const proxy = require('../../lib/sigmesh/proxy');
const { encodeNetworkPdu } = require('../../lib/sigmesh/network');

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const NET_KEY = hex('7dd7364cd842ad18c17c2b820c84c3d6');

function feed(frames, nowMs = () => 0) {
  let state;
  const results = [];
  for (const frame of frames) {
    const result = proxy.acceptProxyPdu(state, frame, nowMs());
    state = result.state;
    results.push(result);
  }
  return results;
}

test('a message that fits is one complete Proxy PDU', () => {
  const pdus = proxy.encodeProxyPdus(proxy.TYPE_NETWORK_PDU, Buffer.alloc(19, 0xaa));
  assert.equal(pdus.length, 1);
  assert.equal(pdus[0].length, 20);
  assert.equal(pdus[0][0], 0x00);
});

test('a 29-byte network PDU is split into 20 + 11 at the default size', () => {
  const pdus = proxy.encodeProxyPdus(proxy.TYPE_NETWORK_PDU, Buffer.alloc(29, 0xaa));
  assert.deepEqual(pdus.map((p) => p.length), [20, 11]);
  assert.deepEqual(pdus.map((p) => p[0]), [0x40, 0xc0]); // SAR first, SAR last
});

test('first, continuation and last at a small size, and back', () => {
  const message = Buffer.from([...Array(10).keys()]);
  const pdus = proxy.encodeProxyPdus(proxy.TYPE_PROXY_CONFIG, message, 5);
  assert.deepEqual(pdus.map((p) => p[0]), [0x42, 0x82, 0xc2]);
  const results = feed(pdus);
  assert.deepEqual(results.map((r) => r.kind), ['incomplete', 'incomplete', 'complete']);
  assert.equal(results[2].messageType, proxy.TYPE_PROXY_CONFIG);
  assert.deepEqual(results[2].message, message);
});

test('beacons and proxy configuration are accepted, reserved types ignored', () => {
  assert.equal(feed([hex('01 01003ecaff672f673370')])[0].messageType, proxy.TYPE_MESH_BEACON);
  assert.equal(feed([hex('02 0000')])[0].messageType, proxy.TYPE_PROXY_CONFIG);
  assert.equal(feed([hex('04 00')])[0].kind, 'ignored');
  assert.equal(feed([hex('00')])[0].kind, 'ignored');
});

test('a provisioning PDU may be up to 65 bytes, a network PDU only 29', () => {
  const big = Buffer.alloc(40, 0x11);
  const provisioning = feed(proxy.encodeProxyPdus(proxy.TYPE_PROVISIONING_PDU, big));
  assert.equal(provisioning[provisioning.length - 1].kind, 'complete');
  assert.equal(provisioning[provisioning.length - 1].messageType, proxy.TYPE_PROVISIONING_PDU);
  const network = feed(proxy.encodeProxyPdus(proxy.TYPE_NETWORK_PDU, big));
  assert.equal(network[network.length - 1].kind, 'disconnect');
});

test('SAR errors mean disconnect', () => {
  assert.equal(feed([hex('c0 01')])[0].kind, 'disconnect'); // last without first
  assert.equal(feed([hex('40 01'), hex('40 02')])[1].kind, 'disconnect'); // first twice
  assert.equal(feed([hex('40 01'), hex('00 02')])[1].kind, 'disconnect'); // complete mid-message
  assert.equal(feed([hex('40 01'), hex('c2 02')])[1].kind, 'disconnect'); // type changed
  assert.equal(feed([Buffer.concat([hex('40'), Buffer.alloc(19)]), Buffer.concat([hex('c0'), Buffer.alloc(11)])])[1].kind, 'disconnect'); // 30 > 29
});

test('a SAR transfer older than 20 s means disconnect', () => {
  let now = 0;
  const results = feed([hex('40 01'), hex('c0 02')], () => { const t = now; now += 20000; return t; });
  assert.equal(results[1].kind, 'disconnect');
});

test('filter messages', () => {
  assert.equal(proxy.setFilterType(proxy.FILTER_ACCEPT_LIST).toString('hex'), '0000');
  assert.equal(proxy.setFilterType(proxy.FILTER_REJECT_LIST).toString('hex'), '0001');
  assert.equal(proxy.addAddresses([0x7fff, 0xcee8]).toString('hex'), '017fffcee8');
  assert.equal(proxy.removeAddresses([0x0003]).toString('hex'), '020003');
  assert.throws(() => proxy.setFilterType(2), /unknown filter type/);
  assert.throws(() => proxy.addAddresses([]), /1-5 addresses/);
  assert.throws(() => proxy.addAddresses([1, 2, 3, 4, 5, 6]), /1-5 addresses/);
  assert.throws(() => proxy.addAddresses([0x10000]), /address/);
});

test('filter status', () => {
  assert.deepEqual(proxy.parseFilterStatus(hex('03000002')), { filterType: 0, listSize: 2 });
  assert.equal(proxy.parseFilterStatus(hex('030000')), null);
  assert.equal(proxy.parseFilterStatus(hex('01000002')), null);
});

test('five addresses still fit in one sealed proxy configuration PDU', () => {
  const message = proxy.addAddresses([1, 2, 3, 4, 5]);
  const pdu = proxy.encodeProxyConfigPdu({ networkKey: NET_KEY, ivIndex: 0, seq: 1, src: 0x7fff, message });
  assert.deepEqual(proxy.decodeProxyConfigPdu({ networkKey: NET_KEY, ivIndex: 0, pdu }), message);
});

test('a configuration message sealed with the network nonce is not accepted', () => {
  const pdu = encodeNetworkPdu({
    networkKey: NET_KEY, ivIndex: 0, ctl: true, ttl: 0, seq: 1, src: 0x0003, dst: 0, transportPdu: hex('03000002'),
  });
  assert.equal(proxy.decodeProxyConfigPdu({ networkKey: NET_KEY, ivIndex: 0, pdu }), null);
});
