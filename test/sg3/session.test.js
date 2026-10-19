'use strict';

// The mesh session and the SG client against a simulated SG Smart 3.0 node,
// with no Homey and no radio. Keys are the specification's sample keys.

const test = require('node:test');
const assert = require('node:assert/strict');

const { MeshSession } = require('../../lib/sigmesh/session');
const { SeqStore } = require('../../lib/sigmesh/seq-store');
const proxy = require('../../lib/sigmesh/proxy');
const { SgClient } = require('../../lib/sg3/client');
const { sgPowerLevelSet } = require('../../lib/sg3/protocol');
const { SimulatedSgNode } = require('./simulated-node');

const hex = (s) => Buffer.from(s, 'hex');
const NET_KEY = hex('7dd7364cd842ad18c17c2b820c84c3d6');
const APP_KEY = hex('63964771734fbd76e3b40519d1d94a48');
const HOMEY = 0x7f00;
const NODE = 0x0003;
const GROUP = 0xcee8;

function memoryStorage() {
  const map = new Map();
  return { get: (key) => map.get(key), set: (key, value) => map.set(key, { ...value }) };
}

function link({ node: nodeOptions = {}, session: sessionOptions = {}, storage = memoryStorage(), tid } = {}) {
  const node = new SimulatedSgNode({ netKey: NET_KEY, appKey: APP_KEY, address: NODE, ...nodeOptions });
  const session = new MeshSession({
    netKey: NET_KEY, appKey: APP_KEY, address: HOMEY, seqStore: new SeqStore(storage),
    write: (frame) => node.write(frame), ...sessionOptions,
  });
  const client = new SgClient(session, tid ? { tid } : {});
  node.connect((frame) => session.receive(frame));
  return { node, session, client, storage };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 10; i += 1) await tick(); };

test('start: the beacon gives the IV Index, and the filter is confirmed', async () => {
  const { node, session } = link({ node: { ivIndex: 5 } });
  const beacons = [];
  session.on('beacon', (b) => beacons.push(b));
  const started = await session.start({ listen: [GROUP] });
  assert.equal(started.ivIndex, 5);
  assert.equal(started.beacon, true);
  assert.deepEqual(started.filter, { filterType: proxy.FILTER_ACCEPT_LIST, listSize: 2 });
  assert.deepEqual([...node.filter], [HOMEY, GROUP]);
  session.close();
});

test('start without a beacon goes on with the IV Index it has', async () => {
  const { session } = link({ node: { beacon: false }, session: { ivIndex: 0 } });
  const logs = [];
  session.on('log', (line) => logs.push(line));
  const started = await session.start({ beaconTimeoutMs: 30 });
  assert.equal(started.beacon, false);
  assert.match(logs.join('\n'), /no beacon within 30 ms/);
  session.close();
});

test('a wrong IV Index without a beacon: the proxy drops the filter and start fails', async () => {
  const { node, session } = link({ node: { ivIndex: 9, beacon: false }, session: { ivIndex: 0 } });
  await assert.rejects(session.start({ beaconTimeoutMs: 10, filterTimeoutMs: 100 }), /proxy filter not confirmed/);
  assert.ok(node.events.includes('filter message dropped'));
  session.close();
});

test('without the filter, nothing the node sends reaches us', async () => {
  const { node, session, client } = link();
  const heard = [];
  client.on('status', (s) => heard.push(s));
  await settle();
  node.localChange({ on: true, level: 40 });
  await settle();
  assert.deepEqual(heard, []);
  assert.ok(node.events.includes('filtered 0xcee8'));
  session.close();
});

test('setLevel: two segments, four writes of at most 20 bytes, acknowledged, acted on', async () => {
  const { node, session, client } = link();
  await session.start({ listen: [GROUP] });
  const before = node.frames.length;
  const result = await client.setLevel(NODE, 50);
  assert.deepEqual(result, { acked: true });
  assert.deepEqual({ on: node.on, level: node.level }, { on: true, level: 50 });
  const frames = node.frames.slice(before);
  assert.equal(frames.length, 4);
  assert.ok(frames.every((f) => f.length <= 20));
  session.close();
});

test('getStatus: the segmented reply is matched, parsed and acknowledged', async () => {
  const { node, session, client } = link({ node: { on: true, level: 53 } });
  await session.start({ listen: [GROUP] });
  assert.deepEqual(await client.getStatus(NODE), { on: true, level: 53 });
  await settle();
  assert.equal(node.acksFromClient.length, 1);
  assert.equal(node.acksFromClient[0].blockAck, 0b11);
  session.close();
});

test('a status after a local change arrives through the group', async () => {
  const { node, session, client } = link();
  await session.start({ listen: [GROUP] });
  const heard = new Promise((resolve) => client.once('status', resolve));
  node.localChange({ on: false, level: 30 });
  assert.deepEqual(await heard, { node: NODE, kind: 0x03, on: false, level: 30 });
  session.close();
});

test('commands in parallel do not mix their writes', async () => {
  const { node, session, client } = link();
  await session.start({ listen: [GROUP] });
  const [set, status] = await Promise.all([client.setLevel(NODE, 70), client.getStatus(NODE)]);
  assert.equal(set.acked, true);
  assert.deepEqual(status, { on: true, level: 70 });
  assert.ok(!node.events.some((e) => e.startsWith('replay')));
  session.close();
});

test('a missing ack is reported, and nothing is sent again', async () => {
  const { node, session, client } = link({ node: { ackSegments: false } });
  await session.start({ listen: [GROUP] });
  const before = node.frames.length;
  const result = await session.sendAccess(NODE, sgPowerLevelSet(NODE, 20, { tid: 9, seq: 9 }), { ackTimeoutMs: 50 });
  assert.equal(result.acked, false);
  await settle();
  assert.equal(node.frames.length - before, 4);
  assert.equal(node.level, 20);
  session.close();
  client.close();
});

test('a restart with the same storage goes on above the old SEQs', async () => {
  const storage = memoryStorage();
  const first = link({ storage });
  await first.session.start({ listen: [GROUP] });
  await first.client.setLevel(NODE, 10);
  first.session.close();

  // Same node, same storage, a new session (the app restarted).
  const node = first.node;
  const session = new MeshSession({ netKey: NET_KEY, appKey: APP_KEY, address: HOMEY, seqStore: new SeqStore(storage), write: (f) => node.write(f) });
  const client = new SgClient(session);
  node.connect((frame) => session.receive(frame));
  await session.start({ listen: [GROUP] });
  assert.equal((await client.setLevel(NODE, 60)).acked, true);
  assert.equal(node.level, 60);
  assert.ok(!node.events.some((e) => e.startsWith('replay')));
  session.close();
});

test('lost SEQ storage: the node drops our commands as replays (why SeqStore exists)', async () => {
  const first = link();
  await first.session.start({ listen: [GROUP] });
  await first.client.setLevel(NODE, 10);
  first.session.close();

  // The app restarts with empty storage, so SEQ starts at 0 again.
  const node = first.node;
  const session = new MeshSession({ netKey: NET_KEY, appKey: APP_KEY, address: HOMEY, seqStore: new SeqStore(memoryStorage()), write: (f) => node.write(f) });
  node.connect((frame) => session.receive(frame));
  // The proxy filter is not replay-checked, so the link itself looks fine.
  await session.start({ listen: [GROUP] });
  const result = await session.sendAccess(NODE, sgPowerLevelSet(NODE, 60, { tid: 20, seq: 20 }), { ackTimeoutMs: 50 });
  assert.equal(result.acked, false);
  assert.equal(node.level, 10);
  assert.ok(node.events.some((e) => e.startsWith('replay from 0x7f00')));
  session.close();
});

test('during an IV Update we send with the old IV Index, and the node takes it', async () => {
  const { node, session, client } = link({ node: { ivIndex: 6, ivUpdate: true }, session: { ivIndex: 5 } });
  await session.start({ listen: [GROUP] });
  assert.equal(session.ivIndex, 6);
  assert.equal(session.txIvIndex, 5);
  assert.equal((await client.setLevel(NODE, 33)).acked, true);
  assert.equal(node.level, 33);
  session.close();
});

test('an unknown IV Index takes the first beacon, a known one only within 42 steps', async () => {
  const unknown = link({ node: { ivIndex: 1000 } });
  await unknown.session.start();
  assert.equal(unknown.session.ivIndex, 1000);
  unknown.session.close();

  const known = link({ node: { ivIndex: 1000 }, session: { ivIndex: 3 } });
  await assert.rejects(known.session.start({ beaconTimeoutMs: 30, filterTimeoutMs: 100 }));
  assert.equal(known.session.ivIndex, 3);
  known.session.close();
});

test('the same network PDU twice is one message', async () => {
  const { node, session } = link();
  await session.start({ listen: [GROUP] });
  const messages = [];
  session.on('message', (m) => messages.push(m));
  // Every message the node sends arrives twice, as a relayed copy would.
  const realSend = node.send.bind(node);
  node.send = (type, message) => { realSend(type, message); realSend(type, message); };
  node.localChange({ on: true, level: 80 });
  await settle();
  assert.equal(messages.length, 1);
  session.close();
});

test('a broken SAR sequence asks for a disconnect', async () => {
  const { session } = link({ node: { beacon: false } });
  const reasons = [];
  session.on('disconnect', (reason) => reasons.push(reason));
  session.receive(hex('c001'));
  assert.equal(reasons.length, 1);
  session.close();
});

test('close rejects whoever is waiting, and later sends', async () => {
  const { session, client } = link({ node: { beacon: false } });
  const waiting = client.getStatus(NODE, { timeoutMs: 5000 });
  await tick();
  session.close('link lost');
  await assert.rejects(waiting, /session link lost|session is closed/);
  await assert.rejects(client.setLevel(NODE, 10), /closed/);
});

test('a status request nobody answers times out', async () => {
  const { session, client } = link({ node: { address: 0x0004 } });
  await session.start({ listen: [GROUP] });
  await assert.rejects(client.getStatus(NODE, { timeoutMs: 100 }), /no answer within 100 ms/);
  session.close();
});

test('TIDs count 1 to 255 and skip 0', () => {
  const { session, client } = link({ tid: 254 });
  assert.deepEqual([client.nextTid(), client.nextTid(), client.nextTid()], [255, 1, 2]);
  session.close();
});

test('our own messages coming back are not taken as messages', async () => {
  const { node, session } = link();
  await session.start({ listen: [GROUP] });
  const messages = [];
  session.on('message', (m) => messages.push(m));
  const before = node.frames.length;
  await session.sendAccess(GROUP, sgPowerLevelSet(NODE, 5, { tid: 30, seq: 30 }));
  for (const frame of node.frames.slice(before)) session.receive(frame);
  assert.deepEqual(messages, []);
  session.close();
});

test('a 0x09 reply with another TID is not taken as the answer', async () => {
  const { node, session, client } = link({ node: { on: true, level: 44 } });
  await session.start({ listen: [GROUP] });
  const onCommand = node.onCommand.bind(node);
  node.onCommand = (src, message) => {
    // An old reply to some earlier request comes first.
    node.publish(src, Buffer.from([0x09, 0x01, 0x00, 0x00, src >>> 8, src & 0xff, 0, 99, 0x19, 0x00]));
    onCommand(src, message);
  };
  assert.deepEqual(await client.getStatus(NODE), { on: true, level: 44 });
  session.close();
});

test('an ack for only some of the segments is not taken as delivered', async () => {
  const { node, session } = link({ node: { ackSegments: 'partial' } });
  await session.start({ listen: [GROUP] });
  const result = await session.sendAccess(NODE, sgPowerLevelSet(NODE, 15, { tid: 40, seq: 40 }), { ackTimeoutMs: 50 });
  assert.equal(result.acked, false);
  assert.ok(node.events.includes('level 15'));
  session.close();
});

test('segments sent to a group are not acknowledged', async () => {
  const { node, session } = link();
  await session.start({ listen: [GROUP] });
  const messages = [];
  session.on('message', (m) => messages.push(m));
  node.publish(GROUP, Buffer.from([0x09, 0x01, 0x05, 0x05, 0x7f, 0x00, 1, 50, 0x19, 0x00]));
  await settle();
  assert.equal(messages.length, 1);
  assert.deepEqual(node.acksFromClient, []);
  session.close();
});

test('BlockAck 0 from the node ends the wait at once, as not delivered', async () => {
  const { session } = link({ node: { ackSegments: 'busy' } });
  await session.start({ listen: [GROUP] });
  const started = Date.now();
  const result = await session.sendAccess(NODE, sgPowerLevelSet(NODE, 25, { tid: 50, seq: 50 }), { ackTimeoutMs: 5000 });
  assert.equal(result.acked, false);
  assert.ok(Date.now() - started < 1000);
  session.close();
});

test('the ack goes out with TTL 0 to a message that came with TTL 0, else with our TTL', async () => {
  for (const ttl of [0, 7]) {
    const { node, session, client } = link({ node: { ttl } });
    await session.start({ listen: [GROUP] });
    await client.getStatus(NODE);
    await settle();
    assert.equal(node.acksFromClient[0].ttl, ttl);
    session.close();
  }
});
