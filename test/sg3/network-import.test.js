'use strict';

// Most cases are ported from frekarlsen/ha-sg-smart-mesh (commit c00c73a),
// tests/test_network_model.py, and fixtures/sample.connect.json is that
// project's fabricated test export (MIT). The rest covers what is added here.

const test = require('node:test');
const assert = require('node:assert/strict');

const imp = require('../../lib/sg3/network-import');
const fixture = require('./fixtures/sample.connect.json');

const hex = (s) => Buffer.from(s, 'hex');
const copy = (value) => JSON.parse(JSON.stringify(value));
const NET_KEY = hex('00112233445566778899aabbccddeeff');
const APP_KEY = hex('0f0e0d0c0b0a09080706050403020100');
const DEVICE_KEY = hex('112233445566778899aabbccddeeff00');

function doc(nodes, extra = {}) {
  return {
    meshName: 'T',
    meshUUID: 'u',
    netKeys: [{ key: '7dd7364cd842ad18c17c2b820c84c3d6', index: 0 }],
    appKeys: [{ key: '63964771734fbd76e3b40519d1d94a48', index: 0 }],
    nodes,
    ...extra,
  };
}

const GOOD_NODE = {
  UUID: 'n1',
  unicastAddress: '000C',
  deviceKey: '9d6dd0e96eb25dc19a40ed9914f8f03f',
  cid: '07E9',
  elements: [{ index: 0, models: [{ modelId: '1000', bind: [0] }] }],
};

function node(unicast, elements, extra = {}) {
  return {
    UUID: `n${unicast}`,
    unicastAddress: unicast.toString(16).padStart(4, '0').toUpperCase(),
    deviceKey: '9d6dd0e96eb25dc19a40ed9914f8f03f',
    cid: '0EE8',
    elements,
    ...extra,
  };
}

function rejects(fn, code, pattern) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof imp.ImportError, `ImportError, got ${err}`);
    assert.equal(err.code, code);
    if (pattern) assert.match(err.detail, pattern);
    return true;
  });
}

// ------------------------------------------------------------ HA's cases

test('the fixture: keys and network metadata', () => {
  const net = imp.networkFromObject(copy(fixture));
  assert.equal(net.name, 'Fabricated Test Mesh');
  assert.equal(net.uuid, '0F0E0D0C-0B0A-0908-0706-050403020100');
  assert.deepEqual(net.netKey, NET_KEY);
  assert.equal(net.netKeyIndex, 0);
  assert.deepEqual(net.appKeys[0].key, APP_KEY);
  assert.equal(net.appKeyIndex, 0);
});

test('the fixture: one node, its fields and element addresses', () => {
  const net = imp.networkFromObject(copy(fixture));
  assert.equal(net.nodes.length, 1);
  const [n] = net.nodes;
  assert.equal(n.unicast, 0x000c);
  assert.deepEqual(n.deviceKey, DEVICE_KEY);
  assert.equal(n.cid, 0x07e9);
  assert.equal(n.name, 'Test Lamp');
  assert.equal(n.uuid, 'AABBCCDD-EEFF-0011-2233-445566778899');
  assert.deepEqual(n.elements.map((e) => e.unicast), [0x000c, 0x000d, 0x000e]);
  // An 8-digit modelId is a vendor model: company << 16 | model.
  assert.ok(n.elements[0].models.some((m) => m.modelId === 0x07e91000));
});

test('an empty object, bad hex in a key, and no nodes list are refused', () => {
  rejects(() => imp.networkFromObject({}), 'invalid_export', /netKeys/);
  const badHex = copy(fixture);
  badHex.netKeys[0].key = 'not-hex-zz';
  rejects(() => imp.networkFromObject(badHex), 'invalid_export', /not valid hex/);
  const noNodes = copy(fixture);
  delete noNodes.nodes;
  rejects(() => imp.networkFromObject(noNodes), 'invalid_export', /'nodes' list/);
});

test('the name falls back to tos_node.type', () => {
  const data = copy(fixture);
  data.nodes[0].tos_devices = [];
  assert.equal(imp.networkFromObject(data).nodes[0].name, 'com.example.fabricated.testlamp.v1');
});

test('one broken node is skipped, the rest is imported', () => {
  const net = imp.networkFromObject(doc([GOOD_NODE, { UUID: 'broken' }]));
  assert.equal(net.nodes.length, 1);
  assert.equal(net.nodes[0].unicast, 0x000c);
  assert.equal(net.skipped.length, 1);
  assert.match(net.skipped[0], /^broken: /);
});

test('missing keys are still refused', () => {
  const data = doc([GOOD_NODE]);
  delete data.netKeys;
  rejects(() => imp.networkFromObject(data), 'invalid_export', /netKeys/);
});

test('an export whose every node is broken is refused', () => {
  rejects(() => imp.networkFromObject(doc([{ UUID: 'broken' }, { UUID: 'also-broken' }])), 'invalid_export', /no usable node/);
});

test('an export with no nodes at all is accepted', () => {
  assert.deepEqual(imp.networkFromObject(doc([])).nodes, []);
});

test('every AppKey is listed, the first named as such', () => {
  const net = imp.networkFromObject(doc([], { appKeys: [
    { index: 0, key: '63964771734fbd76e3b40519d1d94a48' },
    { index: 1, key: '0a1b2c3d4e5f60718293a4b5c6d7e8f9', name: 'second' },
  ] }));
  assert.deepEqual(net.appKeys.map((k) => [k.index, k.name]), [[0, ''], [1, 'second']]);
  assert.equal(net.appKeyIndex, 0);
});

test('the AppKey follows what the SG model is bound to, and falls back to the first', () => {
  const appKeys = [
    { index: 0, key: '63964771734fbd76e3b40519d1d94a48' },
    { index: 1, key: '0a1b2c3d4e5f60718293a4b5c6d7e8f9' },
  ];
  const sg = (bind) => [{ index: 0, models: [{ modelId: '0EE80000', bind }, { modelId: '1000', bind: [0] }] }];
  const bound = imp.networkFromObject(doc([node(3, sg([1])), node(4, sg([1]))], { appKeys }));
  assert.equal(imp.appKeyForModels(bound, [imp.MODEL_SG_VENDOR]).index, 1);
  assert.deepEqual(imp.boundAppKeyIndexes(bound, [imp.MODEL_SG_VENDOR]), [1]);
  // Index 0 is bound only to Generic OnOff, which we do not use for this.
  const unbound = imp.networkFromObject(doc([node(3, sg([]))], { appKeys }));
  assert.equal(imp.appKeyForModels(unbound, [imp.MODEL_SG_VENDOR]).index, 0);
  const unknown = imp.networkFromObject(doc([node(3, sg([7]))], { appKeys }));
  assert.equal(imp.appKeyForModels(unknown, [imp.MODEL_SG_VENDOR]).index, 0);
});

test('the addresses cover every element, not just the node', () => {
  const net = imp.networkFromObject(copy(fixture));
  assert.deepEqual([...imp.unicastAddresses(net)].sort(), [0x000c, 0x000d, 0x000e]);
});

test('our own address: 0x7FFF when free, the next one down when taken, never outside unicast', () => {
  assert.equal(imp.freeUnicast(imp.networkFromObject(doc([GOOD_NODE]))), 0x7fff);
  const taken = imp.networkFromObject(doc([node(0x7ffe, [{ index: 0, models: [] }, { index: 1, models: [] }])]));
  assert.equal(imp.freeUnicast(taken), 0x7ffd);
  rejects(() => imp.freeUnicast(taken, 0x8000), 'invalid_export', /not a unicast address/);
  rejects(() => imp.freeUnicast(taken, 0), 'invalid_export', /not a unicast address/);
});

test('subscribe addresses are parsed, and default to none', () => {
  const net = imp.networkFromObject(doc([node(3, [{ index: 0, models: [{ modelId: '1000', subscribe: ['C002', 'C028'] }, { modelId: '1001' }] }])]));
  assert.deepEqual(net.nodes[0].elements[0].models.map((m) => m.subscribe), [[0xc002, 0xc028], []]);
});

// ------------------------------------------------------------ added here

test('text that is not JSON is invalid_json with the parser\'s words', () => {
  rejects(() => imp.parseNetworkExport('{"netKeys": ['), 'invalid_json');
  assert.equal(imp.parseNetworkExport(JSON.stringify(doc([]))).name, 'T');
});

test('keys must be 16 bytes', () => {
  const short = doc([]);
  short.netKeys[0].key = '0011';
  rejects(() => imp.networkFromObject(short), 'invalid_export', /netKeys\[0\]\.key' must be 16 bytes/);
  const second = doc([], { appKeys: [{ index: 0, key: '63964771734fbd76e3b40519d1d94a48' }, { index: 1, key: 'aabb' }] });
  rejects(() => imp.networkFromObject(second), 'invalid_export', /appKeys\[1\]\.key' must be 16 bytes/);
});

test('ivIndex: unknown when absent, a number when given, refused when not an integer', () => {
  assert.equal(imp.networkFromObject(doc([])).ivIndex, null);
  assert.equal(imp.networkFromObject(doc([], { ivIndex: 5 })).ivIndex, 5);
  rejects(() => imp.networkFromObject(doc([], { ivIndex: '5' })), 'invalid_export', /ivIndex/);
});

// The shape the SG app's Telink SDK keeps its network in, with made-up values
// and sample keys: the phone is a node with the provisioner's UUID, and the
// provisioner hands out addresses from a range of its own.
function telinkExport({ phone = '0A2C', low = '0A2C', high = '7F00', nodes = [] } = {}) {
  return doc([
    { UUID: '11111111-2222-3333-4444-555555555555', name: 'Phone', unicastAddress: phone, deviceKey: '00112233445566778899aabbccddeeff', cid: '0211', elements: [] },
    ...nodes,
  ], {
    provisioners: [{
      UUID: '11111111222233334444555555555555',
      allocatedUnicastRange: [{ lowAddress: low, highAddress: high }],
      allocatedGroupRange: [{ lowAddress: 'D200', highAddress: 'D2FF' }],
    }],
  });
}

test('the phone (provisioner node) is left out, but its address and range are avoided', () => {
  const net = imp.networkFromObject(telinkExport());
  assert.deepEqual(net.nodes, []);
  assert.deepEqual(net.reservedAddresses, [0x0a2c]);
  assert.deepEqual(net.reservedRanges, [[0x0a2c, 0x7f00]]);
  assert.equal(imp.freeUnicast(net), 0x7fff);
  // A range that reaches the top: Homey goes below it.
  assert.equal(imp.freeUnicast(imp.networkFromObject(telinkExport({ low: '7000', high: '7FFF' }))), 0x6fff);
  // A range over everything gives way, but the phone's own address never does.
  const all = imp.networkFromObject(telinkExport({ phone: '7FFF', low: '0001', high: '7FFF' }));
  assert.equal(imp.freeUnicast(all), 0x7ffe);
});

test('SG dimmers: nodes with the SG vendor model, buttons and wheels left out', () => {
  const sg = [{ index: 0, models: [{ modelId: '0EE80000', bind: [0] }] }];
  const net = imp.networkFromObject(doc([
    node(3, sg, { pid: '00A2' }), // Pill Micro 3.0
    node(4, sg, { pid: '00B1' }), // the wheel
    node(5, sg), // no PID: taken for a dimmer, as HA does
    node(6, [{ index: 0, models: [{ modelId: '1000' }] }]), // not SG
  ]));
  assert.deepEqual(imp.sgDimmerNodes(net).map((n) => n.unicast), [3, 5]);
});

test('identity: meshUUID, else the Network ID', () => {
  const net = imp.networkFromObject(doc([]));
  assert.equal(imp.identifier(net), 'u');
  assert.equal(imp.networkId(net), '3ecaff672f673370');
  assert.equal(imp.identifier(imp.networkFromObject(doc([], { meshUUID: undefined }))), '3ecaff672f673370');
});

test('the keys alone make an export the same import takes', () => {
  const text = imp.buildExportFromKeys({
    netKey: ' 7dd7364c d842ad18 c17c2b82 0c84c3d6 ',
    appKey: '63964771734FBD76E3B40519D1D94A48',
  });
  const net = imp.parseNetworkExport(text);
  assert.equal(imp.networkId(net), '3ecaff672f673370');
  assert.deepEqual(net.appKeys[0].key, hex('63964771734fbd76e3b40519d1d94a48'));
  assert.deepEqual(net.nodes, []);
  assert.equal(net.ivIndex, null);
});

test('the key fields say which key is wrong', () => {
  const good = '63964771734fbd76e3b40519d1d94a48';
  rejects(() => imp.buildExportFromKeys({ netKey: 'abc', appKey: good }), 'invalid_net_key');
  rejects(() => imp.buildExportFromKeys({ netKey: good, appKey: `${good}00` }), 'invalid_app_key');
  rejects(() => imp.buildExportFromKeys({ netKey: good.replace('6', 'g'), appKey: good }), 'invalid_net_key');
  rejects(() => imp.buildExportFromKeys({ netKey: undefined, appKey: good }), 'invalid_net_key');
});
