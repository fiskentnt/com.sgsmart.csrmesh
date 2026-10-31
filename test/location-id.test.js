'use strict';

// The home's location id (2.4.1): read from each dimmer's status, kept per
// dimmer, used in every A0, and a command waits until it is known. Made-up
// keys, ids and location ids only. Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const fake = require('./helpers/fake-homey');

fake.install();

const { decryptPayload, deriveNetworkKey, makePacket } = require('../lib/csrmesh');
const { learnLocation } = require('../lib/location');
const { gen1LevelData, parseGen1Status } = require('../lib/sgProtocol');
const SGMeshDevice = require('../lib/SGDeviceBase');
const MeshBridge = require('../lib/MeshBridge');
const SGSmartApp = require('../app');
const SGGroupDevice = require('../drivers/sg_group/device');
const SGMeshDriver = require('../drivers/sg_mesh/driver');

const PASSPHRASE = 'test-only-pass';
const KEY = deriveNetworkKey(PASSPHRASE);
const WRONG_KEY = deriveNetworkKey('another-pass');

const tick = () => new Promise((resolve) => setImmediate(resolve));

// A dimmer's status as the mesh carries it: destination first.
function statusPlain({ location, id, level, middle = [0x0a, 0x0b, 0x0c, 0x0d] }) {
  return Buffer.from([0x00, 0x80, 0x73, 0xf7, location >> 8, location & 0xff, id >> 8, id & 0xff, ...middle, level]);
}

function statusFrame(key, seq, fields) {
  return makePacket(key, seq, statusPlain(fields));
}

function plainOf(packet) {
  return decryptPayload(KEY, packet.subarray(0, 3), packet.subarray(3, 5), packet.subarray(5, packet.length - 9));
}

// What a dimmer needs from the app, with sends recorded.
function deviceApp(locations = new Map()) {
  const app = {
    sent: [],
    statusRequests: 0,
    seq: 0x800000,
    shared: null, // what the other dimmers report, for sharedLocation
    nextSeq() { app.seq += 1; return app.seq; },
    sendOk: true,
    bridge: { send: async (packet, meta) => { app.sent.push({ packet, meta }); return { ok: app.sendOk }; } },
    bridgeMeshId: () => null,
    dimmersChanged() {},
    locationFor: (id) => (locations.has(id) ? locations.get(id) : null),
    sharedLocation: () => app.shared,
    requestStatus() { app.statusRequests += 1; },
    statusUnreadableText: () => null,
  };
  return app;
}

async function dimmer(app, name, store = {}, passphrase = PASSPHRASE) {
  const device = new SGMeshDevice({
    homey: fake.fakeHomey(app), store: { localName: name, ...store }, settings: { passphrase }, name,
  });
  await device.onInit();
  return device;
}

// The real app, with these dimmers paired and no bridge.
function realApp(dimmers) {
  const app = new SGSmartApp();
  app.homey = fake.fakeHomey(app, { drivers: { getDrivers: () => ({ sg_mesh: { getDevices: () => dimmers } }) } });
  app._locations = new Map();
  app._statusUnreadable = false;
  app._heardAt = new Map();
  app._firstSeen = new WeakMap();
  app._warned = new WeakMap();
  return app;
}

test('status: any location id, and the four middle bytes are not checked', () => {
  assert.deepEqual(parseGen1Status(statusPlain({ location: 0x1234, id: 0x1a2b, level: 30 })),
    { location: 0x1234, id: 0x1a2b, level: 30 });
  assert.deepEqual(parseGen1Status(statusPlain({ location: 0xbeef, id: 0x3c4d, level: 0, middle: [2, 5, 7, 9] })),
    { location: 0xbeef, id: 0x3c4d, level: 0 });
  assert.equal(parseGen1Status(statusPlain({ location: 0x1234, id: 1, level: 101 })), null);
  const heartbeat = Buffer.from([0x01, 0x80, 0x73, 0xcc, 0x40, 0x4e, 0x44, 0x1a, 0x2b, 0, 0, 0, 0]);
  assert.equal(parseGen1Status(heartbeat), null);
  assert.equal(parseGen1Status(Buffer.alloc(5)), null);
});

test('A0: destination, 0x73, A0, tid, location id, id, 00 00 01, level', () => {
  assert.equal(gen1LevelData({ location: 0x1234, id: 0x1a2b, level: 30, tid: 0x105 }).toString('hex'),
    '018073a00512341a2b0000011e');
});

test('a location id from a status goes into the A0, from the bridge on', async () => {
  const app = deviceApp();
  const device = await dimmer(app, '@ND1A2B');
  const bridgeApp = {
    homey: fake.fakeHomey(null), log() {}, error() {}, getNetworkKey: () => KEY,
  };
  const bridge = new MeshBridge(bridgeApp);
  bridge._onStatus = (idHex, level, location) => device.applyMeshStatus(idHex, level, location);
  bridge._rxDecodeFrame(statusFrame(KEY, 0x000101, { location: 0x1234, id: 0x1a2b, level: 30 }));

  assert.equal(device.getLocationId(), 0x1234);
  assert.equal(device._store.locationId, 0x1234);
  assert.equal(device.available, true);
  assert.equal(await device._sendOnce(55), true);
  const plain = plainOf(app.sent[0].packet);
  assert.equal(plain.readUInt16BE(5), 0x1234);
  assert.equal(plain.readUInt16BE(7), 0x1a2b);
  assert.equal(plain[12], 55);
});

test('two dimmers with different location ids each use their own', async () => {
  const app = deviceApp();
  const a = await dimmer(app, '@ND1A2B');
  const b = await dimmer(app, '@ND3C4D');
  // The app hands every status to every dimmer; each takes only its own.
  for (const [idHex, location] of [['1a2b', 0x1111], ['3c4d', 0x2222]]) {
    a.applyMeshStatus(idHex, 10, location);
    b.applyMeshStatus(idHex, 10, location);
  }
  assert.equal(a.getLocationId(), 0x1111);
  assert.equal(b.getLocationId(), 0x2222);
  await a._sendOnce(20);
  await b._sendOnce(20);
  assert.equal(plainOf(app.sent[0].packet).readUInt16BE(5), 0x1111);
  assert.equal(plainOf(app.sent[1].packet).readUInt16BE(5), 0x2222);
});

test('location rule: the first is taken at once, another only after three in a row', () => {
  let state = null;
  const step = (location) => {
    const result = learnLocation(state, location);
    state = result.state;
    return result.outcome;
  };
  assert.deepEqual([0x1111, 0x1111, 0x2222, 0x3333, 0x3333, 0x3333, 0x3333].map(step),
    ['learned', 'same', 'other', 'other', 'other', 'changed', 'same']);
  assert.equal(state.value, 0x3333);
  assert.equal(step(undefined), 'invalid');
  assert.equal(step(0x10000), 'invalid');
  assert.equal(state.value, 0x3333);
});

test('a learned location id changes after another one three times in a row, and is stored and used', async () => {
  const app = deviceApp();
  const device = await dimmer(app, '@ND1A2B', { locationId: 0x1111 });
  device._lastAppliedLevel = 10;
  device.applyMeshStatus('1a2b', 60, 0x2222);
  device.applyMeshStatus('1a2b', 60, 0x2222);
  assert.equal(device.getLocationId(), 0x1111);
  assert.equal(device._store.locationId, 0x1111);
  assert.equal(device._lastAppliedLevel, 10); // not this dimmer's level, not yet
  assert.equal(device.logs.filter((line) => line.includes('another location id, 0x2222')).length, 1);

  device.applyMeshStatus('1a2b', 60, 0x2222);
  assert.equal(device.getLocationId(), 0x2222);
  assert.equal(device._store.locationId, 0x2222);
  assert.ok(device.logs.some((line) => line.includes('location id changed: 0x1111 to 0x2222 (heard 3 times in a row)')));
  assert.equal(device._lastAppliedLevel, 60);
  await device._sendOnce(40);
  assert.equal(plainOf(app.sent[0].packet).readUInt16BE(5), 0x2222);
});

test('the learned location id heard in between: no change, and the count starts again', async () => {
  const app = deviceApp();
  const device = await dimmer(app, '@ND1A2B', { locationId: 0x1111 });
  for (const location of [0x2222, 0x2222, 0x1111, 0x2222, 0x2222]) device.applyMeshStatus('1a2b', 30, location);
  assert.equal(device.getLocationId(), 0x1111);
  assert.equal(device.logs.filter((line) => line.includes('another location id, 0x2222')).length, 1);
  await device._sendOnce(40);
  assert.equal(plainOf(app.sent[0].packet).readUInt16BE(5), 0x1111);
});

test('the app learns each mesh id\'s location id by the same rule, for pairing', () => {
  const app = realApp([]);
  app._dispatchStatus('1a2b', 20, 0x1111);
  app._dispatchStatus('1a2b', 20, 0x2222);
  app._dispatchStatus('1a2b', 20, 0x2222);
  assert.equal(app.locationFor(0x1a2b), 0x1111);
  app._dispatchStatus('1a2b', 20, 0x2222);
  assert.equal(app.locationFor(0x1a2b), 0x2222);
  assert.equal(app.locationFor(0x3c4d), null);
});

test('before the location id is learned: available with a warning, and nothing sent', async () => {
  const app = deviceApp();
  const device = await dimmer(app, '@ND1A2B');
  assert.equal(device.getLocationId(), null);
  assert.equal(device.available, true);
  assert.equal(device.warning, 'device.waitingForStatus');
  assert.equal(app.statusRequests, 1);
  assert.equal(await device._sendOnce(30), 'kept');
  assert.equal(app.sent.length, 0);
  device.applyMeshStatus('1a2b', 5, 0xabcd);
  await tick();
  assert.equal(device.available, true);
  assert.equal(device.warning, null);
});

test('a command before the location id is kept, asks for status, and goes out with the first status', async () => {
  const app = deviceApp();
  const device = await dimmer(app, '@ND1A2B');
  const before = app.statusRequests;
  assert.equal(device.available, true); // a tap reaches the dimmer while it waits
  device._request(40);
  await tick();
  device._request(45); // the newest level is the one that is kept
  await tick();
  assert.equal(app.sent.length, 0);
  assert.equal(app.statusRequests, before + 2);
  assert.ok(device.logs.some((line) => line.includes('level=45 kept: location id not learned yet')));

  device.applyMeshStatus('1a2b', 5, 0x1234);
  await tick();
  assert.equal(app.sent.length, 1);
  const plain = plainOf(app.sent[0].packet);
  assert.equal(plain.readUInt16BE(5), 0x1234);
  assert.equal(plain[12], 45);
  assert.ok(device.logs.some((line) => line.includes('sending the kept level 45')));
  assert.equal(device.homey.pending.size, 0); // no borrowing, no dropping
});

test('no status from the dimmer in 10 s: the kept level goes out with the other dimmers\' location id', async () => {
  const app = deviceApp();
  app.shared = 0x1234;
  const device = await dimmer(app, '@ND1A2B');
  device._request(40);
  await tick();
  assert.equal(app.sent.length, 0);
  assert.deepEqual([...device.homey.pending.values()].map((timer) => timer.ms), [10000]);

  device.homey.runAll();
  await tick();
  assert.equal(app.sent.length, 1);
  const plain = plainOf(app.sent[0].packet);
  assert.equal(plain.readUInt16BE(5), 0x1234);
  assert.equal(plain[12], 40);
  assert.ok(device.logs.some((line) => line.includes('sending the kept level 40 with the other dimmers\' location id 0x1234')));
  assert.ok(device.logs.some((line) => line.includes('loc=0x1234 (from the other dimmers)')));

  // From then on a command goes out at once, and its own status still wins.
  device._request(60);
  await tick();
  assert.equal(app.sent.length, 2);
  assert.equal(plainOf(app.sent[1].packet).readUInt16BE(5), 0x1234);
  device.applyMeshStatus('1a2b', 60, 0x5678);
  device._request(70);
  await tick();
  assert.equal(plainOf(app.sent[2].packet).readUInt16BE(5), 0x5678);
});

test('no common location id from the other dimmers: the kept level is dropped after 30 s', async () => {
  const app = deviceApp();
  const device = await dimmer(app, '@ND1A2B');
  device._request(40);
  await tick();
  device.homey.runAll(); // 10 s
  await tick();
  assert.equal(app.sent.length, 0);
  assert.ok(device.logs.some((line) => line.includes('report no common location id: the kept level 40 waits at most 20 s more')));
  assert.deepEqual([...device.homey.pending.values()].map((timer) => timer.ms), [20000]);

  device.homey.runAll(); // 30 s
  assert.ok(device.logs.some((line) => line.includes('kept level 40 dropped: no location id in 30 s')));
  assert.equal(device._pendingLevel, null);
  device.applyMeshStatus('1a2b', 5, 0x1234); // too late for that tap
  await tick();
  assert.equal(app.sent.length, 0);
});

test('the other dimmers\' location id: only when every one that has one has the same', async () => {
  const dimmers = [];
  const app = realApp(dimmers);
  assert.equal(app.sharedLocation(0x3c4d), null);
  dimmers.push(await dimmer(app, '@ND1A2B', { locationId: 0x1234 }), await dimmer(app, '@ND3C4D'),
    await dimmer(app, '@ND5E6F', { locationId: 0x1234 }));
  assert.equal(app.sharedLocation(0x3c4d), 0x1234); // one still waiting does not count
  dimmers.push(await dimmer(app, '@ND7A8B', { locationId: 0x9999 }));
  assert.equal(app.sharedLocation(0x3c4d), null);
});

test('a kept command is neither a failed send nor a sent one', async () => {
  const app = deviceApp();
  const device = await dimmer(app, '@ND1A2B');
  assert.equal(await device._sendOnce(40), 'kept');
  // The same level asked for again while it is being handled.
  device._request(40);
  device._request(40);
  await tick();
  assert.ok(device.logs.some((line) => line.includes('same level was being sent (kept until the location id is known)')));
  assert.ok(!device.logs.some((line) => line.includes('not delivered')));
  assert.equal(device.errors.length, 0);
  assert.equal(device._sentLevel, null);
  assert.equal(device._pendingLevel, 40);
  assert.equal(app.sent.length, 0);
});

test('a failed send stays a failed send: not kept, not sent, not repeated by a status', async () => {
  const app = deviceApp();
  app.sendOk = false;
  const device = await dimmer(app, '@ND1A2B', { locationId: 0x1234 });
  assert.equal(await device._sendOnce(40), false);
  assert.equal(app.sent.length, 1);
  assert.equal(device._pendingLevel, null);
  assert.equal(device._sentLevel, null);
  device._request(40);
  device._request(40);
  await tick();
  assert.ok(device.logs.some((line) => line.includes('same level was being sent (not delivered)')));
  assert.equal(device.errors.length, 0);
  const attempts = app.sent.length;
  device.applyMeshStatus('1a2b', 5, 0x1234);
  await tick();
  assert.equal(app.sent.length, attempts);
});

test('a location id heard before the dimmer was added is used at once', async () => {
  const app = deviceApp(new Map([[0x1a2b, 0x0bad]]));
  const device = await dimmer(app, '@ND1A2B');
  assert.equal(device.getLocationId(), 0x0bad);
  assert.equal(device.available, true);
  assert.equal(device.warning, null);
  assert.equal(app.statusRequests, 0);
});

test('the group passes the level on to every dimmer, and logs one that waits for its location id', () => {
  const group = new SGGroupDevice({ homey: fake.fakeHomey(deviceApp()), name: 'group' });
  group._levels = new Map();
  group._lastDim = 1;
  const asked = [];
  const member = (id, location) => ({
    getMeshId: () => id, getLocationId: () => location, _lastAppliedLevel: 0, _lastDim: 1,
    _request: (level) => asked.push([id, level]),
  });
  group._members = () => [member(0x1a2b, 0x1234), member(0x3c4d, null)];
  group._fanOut(60);
  assert.deepEqual(asked, [[0x1a2b, 60], [0x3c4d, 60]]);
  assert.ok(group.logs.some((line) => line.includes('dimmer 0x3c4d waits: location id not learned yet')));
  assert.ok(!group.logs.some((line) => line.includes('dimmer 0x1a2b waits')));
});

function keyCheckBridge(key) {
  const app = {
    unreadable: 0, lines: [],
    log(...args) { app.lines.push(args.join(' ')); }, error() {},
    getNetworkKey: () => key,
    statusUnreadable() { app.unreadable += 1; },
  };
  app.homey = fake.fakeHomey(app);
  const bridge = new MeshBridge(app);
  bridge._onStatus = () => {};
  return { app, bridge };
}

const frame = (seq) => statusFrame(KEY, seq, { location: 0x1234, id: 0x1a2b, level: 5 });

test('one link with failed frames and no status: no warning yet', () => {
  const { app, bridge } = keyCheckBridge(WRONG_KEY);
  bridge._startKeyCheck();
  for (let seq = 1; seq <= 3; seq += 1) bridge._rxDecodeFrame(frame(seq));
  app.homey.runAll();
  assert.equal(app.unreadable, 0);
  assert.ok(app.lines.some((line) => line.includes('3 frame(s) failed the check (1 of 2 links, 3 of 3 frames')));
});

test('failed frames and no status on two links: the password is probably wrong', () => {
  const { app, bridge } = keyCheckBridge(WRONG_KEY);
  bridge._startKeyCheck();
  bridge._rxDecodeFrame(frame(1));
  bridge._rxDecodeFrame(frame(2));
  bridge._startKeyCheck(); // the next link, before the first one's 30 s were up
  assert.equal(app.unreadable, 0);
  bridge._rxDecodeFrame(frame(3));
  app.homey.runAll();
  assert.equal(app.unreadable, 1);
  assert.ok(app.lines.some((line) => line.includes('no status could be read on 2 links: 3 frame(s) failed the check')));
  bridge._startKeyCheck(); // decided: no further checks
  assert.equal(app.homey.pending.size, 0);
});

test('two links with only two failed frames in all: no warning until a third', () => {
  const { app, bridge } = keyCheckBridge(WRONG_KEY);
  for (let seq = 1; seq <= 2; seq += 1) {
    bridge._startKeyCheck();
    bridge._rxDecodeFrame(frame(seq));
    app.homey.runAll();
  }
  assert.equal(app.unreadable, 0);
  assert.ok(app.lines.some((line) => line.includes('(2 of 2 links, 2 of 3 frames before a warning)')));
  bridge._startKeyCheck();
  bridge._rxDecodeFrame(frame(3));
  app.homey.runAll();
  assert.equal(app.unreadable, 1);
});

test('a status read on the second link: no warning', () => {
  const { app, bridge } = keyCheckBridge(KEY);
  bridge._startKeyCheck();
  for (let seq = 1; seq <= 3; seq += 1) bridge._rxDecodeFrame(statusFrame(WRONG_KEY, seq, { location: 0x1234, id: 0x1a2b, level: 5 }));
  bridge._startKeyCheck();
  bridge._rxDecodeFrame(frame(4));
  app.homey.runAll();
  assert.equal(app.unreadable, 0);
  assert.equal(bridge._keyCheckDone, true);
});

test('a status read within 30 s: no warning, and no further checks', () => {
  const { app, bridge } = keyCheckBridge(KEY);
  bridge._startKeyCheck();
  bridge._rxDecodeFrame(statusFrame(KEY, 7, { location: 0x1234, id: 0x1a2b, level: 5 }));
  app.homey.runAll();
  assert.equal(app.unreadable, 0);
  assert.equal(bridge._keyCheckDone, true);
});

test('no frames at all is not a password problem: checked again on the next link', () => {
  const { app, bridge } = keyCheckBridge(KEY);
  bridge._startKeyCheck();
  app.homey.runAll();
  assert.equal(app.unreadable, 0);
  assert.equal(bridge._keyCheckDone, false);
  bridge._startKeyCheck();
  assert.equal(app.homey.pending.size, 1);
});

test('the app shows the password warning on every dimmer, which stays available, until a status is read', async () => {
  const dimmers = [];
  const app = realApp(dimmers);
  dimmers.push(await dimmer(app, '@ND1A2B'), await dimmer(app, '@ND3C4D'));

  app.statusUnreadable();
  await tick();
  for (const device of dimmers) {
    assert.equal(device.warning, 'device.passwordWrong');
    assert.equal(device.available, true);
  }

  app._dispatchStatus('1a2b', 20, 0x1234);
  await tick();
  assert.equal(app._statusUnreadable, false);
  assert.equal(dimmers[0].warning, null);
  assert.equal(dimmers[0].available, true);
  // The other dimmer has not reported yet: available, waiting for its status.
  assert.equal(dimmers[1].available, true);
  assert.equal(dimmers[1].warning, 'device.waitingForStatus');
  assert.equal(app.locationFor(0x1a2b), 0x1234);
});

test('pairing: SG nodes are counted whatever location id their 02FA data has, and a dimmer brings its own', async () => {
  const data02fa = (location) => [{ uuid: '02fa', data: Buffer.from([0x10, location >> 8, location & 0xff, 0x07, 0x08]) }];
  const advertisements = [
    { uuid: 'a', localName: '@ND1A2B', rssi: -60, connectable: true, serviceData: data02fa(0x5a6b) },
    { uuid: 'b', localName: '', rssi: -70, connectable: true, serviceData: data02fa(0x9c8d) },
  ];
  const app = { locationFor: (id) => (id === 0x1a2b ? 0x5a6b : null) };
  const driver = new SGMeshDriver({ homey: fake.fakeHomey(app, { ble: { discover: async () => advertisements } }) });
  driver.getDevices = () => [];

  const { devices, reason } = await driver._search();
  assert.equal(reason, null);
  assert.deepEqual(devices.map((d) => [d.name, d.store.locationId]), [['LEDDim Smart 1A2B', 0x5a6b]]);
  assert.ok(driver.logs.some((line) => line.includes('SG: 2 (1 with name, 1 without name, 0 not connectable)')));
  assert.ok(driver.logs.some((line) => line.includes('1: 02FA 105a6b0708') && line.includes('2: 02FA 109c8d0708')));
});

test('the password must be the same in every dimmer: the bridge reads all status with the first one\'s key', async () => {
  const dimmers = [];
  const app = realApp(dimmers);
  dimmers.push(await dimmer(app, '@ND1A2B', { locationId: 0x1234 }), await dimmer(app, '@ND3C4D', { locationId: 0x1234 }, 'another-pass'));
  // Entered in the second dimmer only: its commands use it, while status is
  // still read with the first one's.
  assert.deepEqual(dimmers[1].getNetworkKey(), WRONG_KEY);
  assert.deepEqual(app.getNetworkKey(), KEY);
  // The same in both: one key for everything.
  dimmers[0]._settings.passphrase = 'another-pass';
  assert.deepEqual(app.getNetworkKey(), WRONG_KEY);
});

test('the password warning also gives one timeline notification, at most once per start', async () => {
  const dimmers = [];
  const app = realApp(dimmers);
  const sent = [];
  app.homey.notifications = { createNotification: async (notification) => { sent.push(notification); } };
  dimmers.push(await dimmer(app, '@ND1A2B', { locationId: 0x1234 }));

  app.statusUnreadable();
  app.statusUnreadable();
  await tick();
  assert.deepEqual(sent, [{ excerpt: 'notification.passwordWrong' }]);
  assert.ok(app.logs.some((line) => line.includes('timeline notification sent')));
  assert.equal(dimmers[0].available, true);
  assert.equal(dimmers[0].warning, 'device.passwordWrong');
  assert.ok(dimmers[0].logs.some((line) => line.includes('warning shown: suspected wrong password')));

  // Readable, then unreadable again in the same start: the warning comes back,
  // the notification does not.
  app._dispatchStatus('1a2b', 20, 0x1234);
  await tick();
  assert.equal(dimmers[0].warning, null);
  assert.ok(dimmers[0].logs.some((line) => line.includes('warning cleared')));
  app.statusUnreadable();
  await tick();
  assert.equal(dimmers[0].warning, 'device.passwordWrong');
  assert.equal(sent.length, 1);
});

test('a timeline notification that fails is logged, and the warning still shows', async () => {
  const dimmers = [];
  const app = realApp(dimmers);
  app.homey.notifications = { createNotification: async () => { throw new Error('no timeline'); } };
  dimmers.push(await dimmer(app, '@ND1A2B', { locationId: 0x1234 }));
  app.statusUnreadable();
  await tick();
  await tick();
  assert.ok(app.errors.some((line) => line.includes('timeline notification failed: no timeline')));
  assert.equal(dimmers[0].warning, 'device.passwordWrong');
  assert.equal(dimmers[0].available, true);
});
