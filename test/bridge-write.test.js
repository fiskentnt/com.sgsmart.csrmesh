'use strict';

// How MeshBridge writes a packet to the bridge (2.5.0), the way CSRmesh writes
// a packet over GATT: 20 bytes or less to 8004 alone, a longer packet as 20
// bytes to 8003 and the rest to 8004. A0 and the heartbeat (27 bytes) go as
// before. Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const fake = require('./helpers/fake-homey');

fake.install();

const { deriveNetworkKey, makePacket } = require('../lib/csrmesh');
const proto = require('../lib/sgProtocol');
const MeshBridge = require('../lib/MeshBridge');

const KEY = deriveNetworkKey('test-only-pass');

// A bridge on a link that is up, writing to two recording characteristics.
function writingBridge({ failFirst = null } = {}) {
  const writes = [];
  const lines = [];
  let seq = 0x100;
  const app = {
    homey: fake.fakeHomey(null), log() {}, error() {}, getNetworkKey: () => KEY, nextSeq: () => (seq += 1), _devices: () => [],
  };
  app.homey.app = app;
  const bridge = new MeshBridge(app);
  const characteristic = (name) => ({
    async write(data) {
      if (failFirst === name) {
        failFirst = null;
        throw new Error('write failed');
      }
      writes.push([name, Buffer.from(data)]);
    },
  });
  bridge._char8003 = characteristic('8003');
  bridge._char8004 = characteristic('8004');
  bridge._peripheral = {};
  bridge._connNo = 1;
  bridge._ensureTxConnected = async () => {};
  bridge._keepAliveMs = () => 0;
  bridge._sleep = async () => {};
  bridge._disconnect = async () => {};
  bridge.log = (...args) => lines.push(args.join(' '));
  bridge.error = (...args) => lines.push(args.join(' '));
  return { bridge, writes, lines };
}

const packet = (data) => makePacket(KEY, 0x123456, data);
const groupGet = Buffer.from([0x01, 0x80, proto.OP_GROUP_GET, proto.MODEL_LIGHT, 0, 0x41]);
const where = (writes) => writes.map(([name, data]) => [name, data.length]);

test('20 bytes or less (FF10, FF04, the group get, 19 bytes): to 8004 alone, the whole packet', async () => {
  const short = [
    proto.csrNameRequestData(),
    proto.csrStatusRequestData({ meshId: 0x0123, location: 0x5a3c }),
    groupGet,
    proto.extData(0x0123, proto.OP_EXT_NAME_GET, [0x00]),
  ];
  for (const data of short) {
    const { bridge, writes, lines } = writingBridge();
    const p = packet(data);
    assert.ok(p.length <= 20, `${p.length} bytes`);
    await bridge._sendNow(p);
    assert.deepEqual(where(writes), [['8004', p.length]]);
    assert.deepEqual(writes[0][1], p);
    assert.ok(lines.some((line) => line.includes(`len=${p.length} to=8004(${p.length})`)), lines.join('\n'));
  }
  assert.equal(packet(groupGet).length, 20);
});

test('longer than 20 bytes (21, FF03 at 25, A0 at 27): 20 to 8003, then the rest to 8004', async () => {
  const long = [
    proto.extData(0x0123, proto.OP_EXT_LEVEL, [0x5a, 0x3c, 0x01]),
    proto.csrLevelData({ meshId: 0x0123, location: 0x5a3c, level: 50, tid: 1 }),
    proto.gen1LevelData({ location: 0x5a3c, id: 0x1a2b, level: 30, tid: 7 }),
  ];
  for (const data of long) {
    const { bridge, writes, lines } = writingBridge();
    const p = packet(data);
    await bridge._sendNow(p);
    assert.deepEqual(where(writes), [['8003', 20], ['8004', p.length - 20]]);
    assert.deepEqual(Buffer.concat(writes.map(([, part]) => part)), p);
    assert.ok(lines.some((line) => line.includes(`len=${p.length} to=8003(20)+8004(${p.length - 20})`)), lines.join('\n'));
  }
  assert.deepEqual([21, 25, 27], long.map((data) => packet(data).length));
});

test('the heartbeat goes as before: 27 bytes, 20 to 8003 and 7 to 8004', async () => {
  const { bridge, writes } = writingBridge();
  bridge._bridgeLocalName = '@ND1A2B';
  bridge._bridgeNodeId = 0x1a2b;
  await bridge._writeHeartbeat();
  assert.deepEqual(where(writes), [['8003', 20], ['8004', 7]]);
});

test('a short packet whose write fails is written once more, whole, to 8004 alone', async () => {
  const { bridge, writes, lines } = writingBridge({ failFirst: '8004' });
  const p = packet(groupGet);
  await bridge._sendNow(p);
  assert.deepEqual(where(writes), [['8004', 20]]);
  assert.deepEqual(writes[0][1], p);
  assert.ok(lines.some((line) => line.includes('8004-retry OK')), lines.join('\n'));
  assert.ok(lines.some((line) => line.includes('ABORT attempt=1/2 firstWritten=false')), lines.join('\n'));
});
