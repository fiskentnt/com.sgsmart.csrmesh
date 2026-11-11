'use strict';

// A request that wants an answer (FF10 in a search, FFFF) goes on a link that
// is subscribed from the start and stays to hear the answer, also when the
// link is not held. Commands go as before, without a subscription. Run with:
// node --test test/*.test.js

const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const fake = require('./helpers/fake-homey');

fake.install();

const MeshBridge = require('../lib/MeshBridge');
const { deriveNetworkKey, makePacket } = require('../lib/csrmesh');

const KEY = deriveNetworkKey('test-only-pass');
// A frame from another node, src, that came with this TTL: seq(3) source(2),
// the payload encrypted, the MAC (8) and the TTL. The payload is a made-up
// FF05 to this app.
function frameFrom(src, ttl) {
  const seqBuf = Buffer.alloc(3);
  seqBuf.writeUIntLE(0x700 + ttl, 0, 3);
  const srcBuf = Buffer.from([src & 0xff, src >> 8]);
  const iv = Buffer.alloc(16);
  seqBuf.copy(iv, 0);
  srcBuf.copy(iv, 4);
  const cipher = crypto.createCipheriv('aes-128-ofb', KEY, iv);
  const plain = Buffer.from([0x00, 0x80, 0xff, 0x05, 0x5a, 0x3c, 1, 40, 7]);
  const payload = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = Buffer.from(crypto.createHmac('sha256', KEY).update(Buffer.concat([Buffer.alloc(8), seqBuf, srcBuf, payload])).digest())
    .reverse().subarray(0, 8);
  return Buffer.concat([seqBuf, srcBuf, payload, mac, Buffer.from([ttl])]);
}
let seq = 0x200;
// A first generation status frame from mesh id 0x1a2b at this level, as the
// bridge hands it over (made-up location id).
const statusFrame = (level) => makePacket(KEY, (seq += 1), Buffer.from([
  0x00, 0x80, 0x73, 0xf7, 0x5a, 0x3c, 0x1a, 0x2b, 0x01, 0x00, 0x00, 0x03, level,
]));

// A bridge with a cached preferred node; connecting is recorded, not done.
function bridgeFor() {
  const app = {
    homey: fake.fakeHomey(null), log() {}, error() {}, _devices: () => [], dimmerCount: () => 1,
  };
  app.homey.app = app;
  const bridge = new MeshBridge(app);
  const connects = [];
  const reasons = [];
  bridge._preferredUuid = 'u1';
  bridge._cacheAdv('u1', { uuid: 'u1', localName: '@ND1A2B', rssi: -60 });
  bridge._preemptStatusForTx = async () => {};
  bridge._ensureConnected = async (options) => {
    connects.push(options);
    bridge._peripheral = {};
    bridge._char8003 = {};
    bridge._char8004 = {};
    bridge._notifySubscribed = options.needNotifications === true;
    // A new link, just up.
    bridge._connNo += 1;
    bridge._connStartedAt = Date.now();
  };
  bridge._disconnect = async (reason) => {
    reasons.push(reason);
    bridge._peripheral = null;
    bridge._char8003 = null;
    bridge._char8004 = null;
    bridge._notifySubscribed = false;
  };
  bridge.log = () => {};
  bridge.error = () => {};
  bridge._status = () => {};
  return { bridge, connects, reasons };
}

test('a request that wants an answer connects subscribed; a command does not, as before', async () => {
  const request = bridgeFor();
  await request.bridge._ensureTxConnected({ listen: true });
  assert.equal(request.connects.length, 1);
  assert.equal(request.connects[0].needNotifications, true);

  const command = bridgeFor();
  await command.bridge._ensureTxConnected();
  assert.equal(command.connects[0].needNotifications, false);
});

test('a link opened for commands is let go before a request that wants an answer; a subscribed one is used', async () => {
  const { bridge, connects, reasons } = bridgeFor();
  await bridge._ensureTxConnected();
  await bridge._ensureTxConnected({ listen: true });
  assert.deepEqual(reasons, ['tx-needs-notifications']);
  assert.deepEqual(connects.map((options) => options.needNotifications), [false, true]);

  await bridge._ensureTxConnected({ listen: true });
  await bridge._ensureTxConnected();
  assert.deepEqual(reasons, ['tx-needs-notifications'], 'the listening link is kept, also for a command');
  assert.equal(connects.length, 2);
});

test('without a cached node, recovery connects subscribed for a request that wants an answer', async () => {
  const { bridge } = bridgeFor();
  bridge._advCache.clear();
  const asked = [];
  bridge._recoverPreferredTxConnection = async (options) => { asked.push(options); };
  await bridge._ensureTxConnected({ listen: true });
  await bridge._ensureTxConnected();
  assert.deepEqual(asked, [{ listen: true }, { listen: false }]);
});

test('the queue gives a request its listenMs, and a command none', async () => {
  const { bridge } = bridgeFor();
  const sent = [];
  bridge._sendNow = async (packet, tx) => { sent.push(tx.listenMs); };
  await bridge.send(Buffer.from([1, 2, 3]), { key: 'csr:names', listenMs: 9000 });
  await bridge.send(Buffer.from([1, 2, 3]), { key: 'device:1a2b', level: 50 });
  assert.deepEqual(sent, [9000, 0]);
});

test('after the write, a link that sent a request stays until the answer can have come; no heartbeat is started for it', async () => {
  const { bridge } = bridgeFor();
  const listens = [];
  bridge._ensureTxConnected = async (options) => {
    listens.push(options.listen);
    bridge._peripheral = {};
    bridge._char8004 = { async write() {} };
    bridge._char8003 = { async write() {} };
  };
  const before = Date.now();
  await bridge._sendNow(Buffer.alloc(10), { listenMs: 9000 });
  assert.deepEqual(listens, [true]);
  assert.ok(bridge._listenUntil >= before + 9000);
  await bridge._sendNow(Buffer.alloc(10), {});
  assert.deepEqual(listens, [true, false]);

  let heartbeats = 0;
  bridge._startHeartbeat = () => { heartbeats += 1; };
  bridge._keepAliveLeftMs = () => 0;
  bridge._scheduleIdleDisconnect('tx-queue-empty');
  const lingers = [...bridge.homey.pending.values()].map((timer) => timer.ms);
  assert.equal(lingers.length, 1);
  assert.ok(lingers[0] > 8000 && lingers[0] <= 9000, `${lingers[0]} ms`);
  assert.equal(heartbeats, 0);

  bridge.homey.runAll();
  bridge._listenUntil = 0;
  bridge._scheduleIdleDisconnect('tx-queue-empty');
  assert.deepEqual([...bridge.homey.pending.values()].map((timer) => timer.ms), [400], 'a command lingers as before');
});

// A bridge that polls: the poll's link comes up, hears one status, and goes.
function pollingBridge() {
  const { bridge, reasons } = bridgeFor();
  bridge.app.getPairedMeshIds = () => ['1a2b'];
  bridge.app.getNetworkKey = () => KEY;
  const heard = [];
  bridge._onStatus = (id, level) => heard.push([id, level]);
  bridge._sleep = async () => {};
  bridge._ensureConnected = async () => {
    bridge._peripheral = {};
    bridge._char8003 = {};
    bridge._char8004 = {};
    bridge._notifySubscribed = true;
    bridge._rxDecodeFrame(statusFrame(20));
  };
  return { bridge, reasons, heard };
}

test('what a poll waited for is gone when it ends', async () => {
  const { bridge, heard } = pollingBridge();
  await bridge._statusPollTick();
  assert.deepEqual(heard, [['1a2b', 20]]);
  assert.equal(bridge._statusWanted, null);
  assert.equal(bridge._statusSeen, null);
});

test('after a poll, a status after FF10 on a listening link is used, and does not end the link', async () => {
  const { bridge, reasons, heard } = pollingBridge();
  await bridge._statusPollTick();
  bridge.homey.runMs(0); // the poll's own "paired status complete"; the next poll waits
  reasons.length = 0;

  // The search's link: subscribed, FF10 written, listening.
  bridge._peripheral = {};
  bridge._char8003 = {};
  bridge._char8004 = {};
  bridge._notifySubscribed = true;
  bridge._listenUntil = Date.now() + 9000;
  bridge._rxDecodeFrame(statusFrame(33));
  bridge._rxDecodeFrame(statusFrame(41));
  assert.deepEqual(heard, [['1a2b', 20], ['1a2b', 33], ['1a2b', 41]], 'the same dimmer again is not a duplicate');
  bridge.homey.runMs(0);
  assert.deepEqual(reasons, [], 'no paired-status-complete outside a poll');
  assert.ok(bridge._peripheral);
});

test('a first generation bridge that listens is kept alive until then, also with the keep-alive used up; a Pill bridge is not', () => {
  const { bridge } = bridgeFor();
  bridge._peripheral = {};
  bridge._bridgeLocalName = '@ND1A2B';
  bridge._bridgeNodeId = 0x1a2b;
  bridge._lastUserTxAt = Date.now() - 58000;
  bridge._listenUntil = 0;
  const left = bridge._keepAliveLeftMs();
  assert.ok(left > 1000 && left <= 2000, `${left} ms of keep-alive`);
  bridge._listenUntil = Date.now() + 9000;
  assert.ok(bridge._keepAliveLeftMs() > 8000, 'the listening counts');
  bridge._lastUserTxAt = Date.now() - 70000;
  assert.ok(bridge._keepAliveLeftMs() > 8000, 'also when the keep-alive is over');

  let heartbeats = 0;
  bridge._startHeartbeat = () => { heartbeats += 1; };
  bridge._scheduleIdleDisconnect('tx-queue-empty');
  assert.equal(heartbeats, 1, 'the heartbeat goes while it listens');

  bridge._bridgeLocalName = '@SC1A2B';
  bridge._bridgeNodeId = null;
  assert.equal(bridge._keepAliveLeftMs(), 0, 'no heartbeat for a Pill bridge, as before');
});

// A link via a bridge without a heartbeat (a Pill), set up so long ago
// (ageMs) that Guard 1 would roll it before the next packet.
function oldPillLink({ subscribed, listenMs, ageMs = 7500 }) {
  const { bridge, connects, reasons } = bridgeFor();
  bridge._peripheral = {};
  bridge._char8003 = {};
  bridge._char8004 = {};
  bridge._notifySubscribed = subscribed;
  bridge._bridgeLocalName = '';
  bridge._bridgeNodeId = null;
  bridge._connStartedAt = Date.now() - ageMs;
  bridge._listenUntil = Date.now() + listenMs;
  return { bridge, connects, reasons };
}

test('Guard 1 rolls an old link without the heartbeat before the next packet; one still listening first listens until MAX_LISTEN_CONN_AGE_MS at most', async () => {
  const noWait = async (ms) => {
    throw new Error(`no wait expected, ${ms} ms`);
  };

  // 7.5 s old, 2 s of listening left: it waits only until the link is 8 s old.
  const listening = oldPillLink({ subscribed: true, listenMs: 2000 });
  const slept = [];
  listening.bridge._sleep = async (ms) => {
    slept.push(ms);
  };
  await listening.bridge._ensureTxConnected();
  assert.equal(slept.length, 1, 'one wait');
  assert.ok(slept[0] > 400 && slept[0] <= 500, `until 8 s, ${slept[0]} ms`);
  assert.deepEqual(listening.reasons, ['tx-aged-before-next-packet'], 'then rolled');
  assert.equal(listening.connects.length, 1, 'the packet goes on a new link');

  // 7.5 s old, 200 ms of listening left: that listening, not until 8 s.
  const shortly = oldPillLink({ subscribed: true, listenMs: 200 });
  const shortWait = [];
  shortly.bridge._sleep = async (ms) => {
    shortWait.push(ms);
  };
  await shortly.bridge._ensureTxConnected();
  assert.ok(shortWait[0] > 100 && shortWait[0] <= 200, `the listening left, ${shortWait[0]} ms`);
  assert.deepEqual(shortly.reasons, ['tx-aged-before-next-packet']);

  const past = oldPillLink({ subscribed: true, listenMs: 6000, ageMs: 8500 });
  past.bridge._sleep = noWait;
  await past.bridge._ensureTxConnected();
  assert.deepEqual(past.reasons, ['tx-aged-before-next-packet'], 'past 8 s it is rolled at once, still listening or not');

  const done = oldPillLink({ subscribed: true, listenMs: -1 });
  done.bridge._sleep = noWait;
  await done.bridge._ensureTxConnected();
  assert.deepEqual(done.reasons, ['tx-aged-before-next-packet'], 'one done listening is rolled at once, as before');

  const notSubscribed = oldPillLink({ subscribed: false, listenMs: 6000 });
  notSubscribed.bridge._sleep = noWait;
  await notSubscribed.bridge._ensureTxConnected();
  assert.deepEqual(notSubscribed.reasons, ['tx-aged-before-next-packet'], 'a link that cannot hear is rolled at once, as before');

  const request = oldPillLink({ subscribed: true, listenMs: 2000 });
  request.bridge._sleep = async () => {};
  await request.bridge._ensureTxConnected({ listen: true });
  assert.deepEqual(request.reasons, ['tx-aged-before-next-packet'], 'also before a request that wants an answer');
  assert.equal(request.connects[0].needNotifications, true, 'its new link listens');

  const held = oldPillLink({ subscribed: true, listenMs: 2000 });
  held.bridge._bridgeLocalName = '@ND1A2B';
  held.bridge._bridgeNodeId = 0x1a2b;
  held.bridge._sleep = noWait;
  await held.bridge._ensureTxConnected();
  assert.deepEqual(held.reasons, [], 'a link with the heartbeat is not rolled for its age, as before');
  assert.equal(held.connects.length, 0);
});

test('Guard 1, during the wait: a link that went, another link, a link that became held, or a shutdown: nothing let go twice', async () => {
  const hungUp = oldPillLink({ subscribed: true, listenMs: 2000 });
  hungUp.bridge._sleep = async () => {
    hungUp.bridge._peripheral = null;
  };
  await hungUp.bridge._ensureTxConnected();
  assert.deepEqual(hungUp.reasons, [], 'a link that went is not let go again');
  assert.equal(hungUp.connects.length, 1, 'the packet goes on a new link');

  const other = oldPillLink({ subscribed: true, listenMs: 2000 });
  other.bridge._sleep = async () => {
    other.bridge._connNo += 1;
    other.bridge._connStartedAt = Date.now();
  };
  await other.bridge._ensureTxConnected();
  assert.deepEqual(other.reasons, [], 'another link that came up meanwhile is not let go');

  const nowHeld = oldPillLink({ subscribed: true, listenMs: 2000 });
  nowHeld.bridge._sleep = async () => {
    nowHeld.bridge._bridgeLocalName = '@ND1A2B';
    nowHeld.bridge._bridgeNodeId = 0x1a2b;
  };
  await nowHeld.bridge._ensureTxConnected();
  assert.deepEqual(nowHeld.reasons, [], 'one that can be held now is not rolled for its age');

  const stopping = oldPillLink({ subscribed: true, listenMs: 2000 });
  stopping.bridge._sleep = async () => {
    stopping.bridge._shuttingDown = true;
    stopping.bridge._peripheral = null;
  };
  await assert.rejects(stopping.bridge._ensureTxConnected(), /shutting down/);
  assert.deepEqual(stopping.reasons, []);
  assert.equal(stopping.connects.length, 0, 'no connect while the app shuts down');
});

test('Guard 1, a pairing pause during the wait: the link the pause let go is not let go again, and the packet connects after it as a command does in a pause', async () => {
  const { bridge, connects, reasons } = oldPillLink({ subscribed: true, listenMs: 2000 });
  bridge._status = () => {};
  bridge._sleep = async () => {
    await bridge.pauseForScan('pairing scan');
  };
  await bridge._ensureTxConnected();
  assert.equal(bridge._scanPauses, 1, 'the pause goes on');
  assert.deepEqual(reasons, ['before-pairing scan'], 'only the pause let the link go');
  assert.equal(connects.length, 1, 'a new link, as for any command in a pause');
});

// A link via a bridge without the heartbeat that only becomes ready readyMs
// after the connect; the recovery's link becomes ready recoveredMs after its
// connect.
function lateLink({ readyMs, recoveredMs, heartbeat = false }) {
  const { bridge, connects, reasons } = bridgeFor();
  const recoveries = [];
  const up = (ms) => {
    bridge._peripheral = {};
    bridge._char8003 = {};
    bridge._char8004 = {};
    bridge._connNo += 1;
    bridge._connStartedAt = Date.now() - ms;
    bridge._readyAgeMs = ms;
    bridge._bridgeLocalName = heartbeat ? '@ND1A2B' : '';
    bridge._bridgeNodeId = heartbeat ? 0x1a2b : null;
  };
  bridge._ensureConnected = async (options) => {
    connects.push(options);
    up(readyMs);
  };
  bridge._recoverPreferredTxConnection = async () => {
    recoveries.push(recoveredMs);
    up(recoveredMs);
  };
  return {
    bridge, connects, reasons, recoveries,
  };
}

test('Guard 2: a new link without the heartbeat ready at 9 s gets nothing; the recovery gives one ready at 3 s, and the packet may go on it', async () => {
  const { bridge, reasons, recoveries } = lateLink({ readyMs: 9000, recoveredMs: 3000 });
  await bridge._ensureTxConnected();
  assert.deepEqual(reasons, ['tx-ready-too-old']);
  assert.deepEqual(recoveries, [3000], 'one recovery');
  assert.ok(bridge._peripheral, 'the recovered link is up for the packet');
});

test('Guard 2: both links without the heartbeat ready too late: nothing written, the shared cool-down (SG_RECOVERY_FAILED)', async () => {
  const { bridge, reasons, recoveries } = lateLink({ readyMs: 9000, recoveredMs: 9000 });
  await assert.rejects(bridge._ensureTxConnected(), (err) => err.code === 'SG_RECOVERY_FAILED' && /ready too late/.test(err.message));
  assert.deepEqual(reasons, ['tx-ready-too-old', 'tx-recovery-ready-too-old']);
  assert.deepEqual(recoveries, [9000]);
});

test('Guard 2 with the heartbeat (@ND) is as before: ready at 9 s is used, past 14 s recycled, and a late recovery fails without the cool-down', async () => {
  const nine = lateLink({ readyMs: 9000, recoveredMs: 3000, heartbeat: true });
  await nine.bridge._ensureTxConnected();
  assert.deepEqual(nine.reasons, [], 'ready at 9 s is used');
  assert.deepEqual(nine.recoveries, []);

  const late = lateLink({ readyMs: 15000, recoveredMs: 15000, heartbeat: true });
  await assert.rejects(late.bridge._ensureTxConnected(), (err) => err.code === undefined && /ready too late/.test(err.message));
  assert.deepEqual(late.reasons, ['tx-ready-too-old', 'tx-recovery-ready-too-old']);
});

test('listenLeftMs: how long a link still listens for an answer, 0 when it does not', () => {
  const { bridge } = bridgeFor();
  bridge._listenUntil = 0;
  assert.equal(bridge.listenLeftMs(), 0);
  bridge._listenUntil = Date.now() + 5000;
  assert.ok(bridge.listenLeftMs() > 4000 && bridge.listenLeftMs() <= 5000);
  bridge._listenUntil = Date.now() - 1000;
  assert.equal(bridge.listenLeftMs(), 0);
});

// A bridge whose cached node connects through fakes that record what is
// done, in order: the connect, the service, the characteristics, each write
// (with its length) and each subscription.
function recordingBridge(localName) {
  let nextSeq = 0x300;
  const app = {
    homey: fake.fakeHomey(null), log() {}, error() {}, _devices: () => [], dimmerCount: () => 1,
    getNetworkKey: () => KEY, nextSeq: () => (nextSeq += 1),
  };
  app.homey.app = app;
  const bridge = new MeshBridge(app);
  const steps = [];
  const characteristic = (name, uuid) => ({
    uuid,
    async write(data) { steps.push(`write ${name} ${data.length}`); },
    async subscribeToNotifications() { steps.push(`subscribe ${name}`); },
    async unsubscribeFromNotifications() {},
  });
  const chars = [
    characteristic('8003', 'c4edc0009daf11e3800300025b000b00'),
    characteristic('8004', 'c4edc0009daf11e3800400025b000b00'),
  ];
  const service = { async discoverCharacteristics() { steps.push('chars'); return chars; } };
  const peripheral = {
    async getService() { steps.push('service'); return service; }, once() {}, off() {}, async disconnect() {},
  };
  const adv = {
    uuid: 'u1', localName, rssi: -60, connectable: true, async connect() { steps.push('connect'); return peripheral; },
  };
  bridge._preferredUuid = 'u1';
  bridge._cacheAdv('u1', adv);
  bridge._sleep = async () => {};
  bridge.log = () => {};
  bridge.error = () => {};
  bridge._status = () => {};
  bridge._lastUserTxAt = Date.now(); // as bridge.send sets it
  return { bridge, steps };
}

const opening = (options) => ({ fastPreferred: true, pinPreferred: true, singleRound: true, ...options });

test('a request that listens through a first generation bridge: the first heartbeat goes before the subscription', async () => {
  const { bridge, steps } = recordingBridge('@ND1A2B');
  await bridge._ensureConnected(opening({ needNotifications: true, purpose: 'tx' }));
  assert.deepEqual(steps, ['connect', 'service', 'chars', 'write 8003 20', 'write 8004 7', 'subscribe 8004', 'subscribe 8003']);
  assert.equal(bridge._heartbeatConnNo, bridge._connNo);

  // The request itself: no second heartbeat in front of it.
  bridge._ensureTxConnected = async () => {};
  steps.length = 0;
  await bridge._sendNow(Buffer.alloc(20), { listenMs: 9000 });
  assert.deepEqual(steps, ['write 8004 20']);
});

test('the same through recovery, and on a held link as before; a command and a Pill bridge get none here', async () => {
  const recovery = recordingBridge('@ND1A2B');
  await recovery.bridge._ensureConnected(opening({ needNotifications: true, purpose: 'tx-recovery' }));
  assert.deepEqual(recovery.steps.slice(3), ['write 8003 20', 'write 8004 7', 'subscribe 8004', 'subscribe 8003']);

  const held = recordingBridge('@ND1A2B');
  held.bridge._held = true;
  await held.bridge._ensureConnected(opening({ needNotifications: true, purpose: 'held' }));
  assert.deepEqual(held.steps.slice(3), ['write 8003 20', 'write 8004 7', 'subscribe 8004', 'subscribe 8003']);

  const command = recordingBridge('@ND1A2B');
  await command.bridge._ensureConnected(opening({ needNotifications: false, purpose: 'tx' }));
  assert.deepEqual(command.steps, ['connect', 'service', 'chars'], 'its heartbeat comes from _sendNow, as before');

  const pill = recordingBridge('@SC1A2B');
  await pill.bridge._ensureConnected(opening({ needNotifications: true, purpose: 'tx' }));
  assert.deepEqual(pill.steps, ['connect', 'service', 'chars', 'subscribe 8004', 'subscribe 8003'], 'no heartbeat for a Pill bridge');
});

test('a poll that has heard every dimmer does not end a link that still listens for an answer; one that is done, it does', () => {
  for (const [listenMs, reasons] of [[5000, []], [-1, ['paired-status-complete']]]) {
    const { bridge, reasons: seen } = bridgeFor();
    bridge.app.getNetworkKey = () => KEY;
    bridge._onStatus = () => {};
    // A poll is under way, waiting for 0x1a2b, on a subscribed link that an
    // FF04 or FF10 also uses: written, so nothing is pending, and listening.
    bridge._statusWanted = new Set(['1a2b']);
    bridge._statusSeen = new Set();
    bridge._statusCompleteDisconnect = false;
    bridge._peripheral = {};
    bridge._char8003 = {};
    bridge._char8004 = {};
    bridge._notifySubscribed = true;
    bridge._txPending = 0;
    bridge._listenUntil = Date.now() + listenMs;
    bridge._rxDecodeFrame(statusFrame(20));
    bridge.homey.runMs(0);
    assert.deepEqual(seen, reasons, `listening ${listenMs} ms`);
  }
});

test('a status poll through a first generation bridge: one heartbeat before the subscription, and no chain', async () => {
  const { bridge, steps } = recordingBridge('@ND1A2B');
  let chains = 0;
  bridge._startHeartbeat = () => { chains += 1; };
  await bridge._ensureConnected(opening({ needNotifications: true, purpose: 'status' }));
  assert.deepEqual(steps, ['connect', 'service', 'chars', 'write 8003 20', 'write 8004 7', 'subscribe 8004', 'subscribe 8003']);
  assert.equal(chains, 0, 'the poll lets the link go after a few seconds');
  assert.notEqual(bridge._heartbeatConnNo, bridge._connNo, 'a command on this link writes its own first heartbeat');

  const pill = recordingBridge('@SC1A2B');
  await pill.bridge._ensureConnected(opening({ needNotifications: true, purpose: 'status' }));
  assert.deepEqual(pill.steps, ['connect', 'service', 'chars', 'subscribe 8004', 'subscribe 8003'], 'no heartbeat for a Pill bridge');
});

test('a pairing pause: the held link is let go and comes back when it ends, not before, and the log says when and why', async () => {
  const { bridge, connects, reasons } = bridgeFor();
  const lines = [];
  bridge._status = (line) => lines.push(line);
  bridge._held = true;
  bridge._peripheral = {};
  bridge._char8003 = {};
  bridge._char8004 = {};
  bridge._notifySubscribed = true;
  const end = await bridge.pauseForScan();
  assert.deepEqual(reasons, ['before-pairing scan']);
  assert.deepEqual(lines, ['pairing pause: held link let go; the held link waits until the pairing is done']);
  assert.deepEqual([...bridge.homey.pending.values()].map((timer) => timer.ms), [180000], 'its limit');
  await bridge._heldTick();
  assert.equal(connects.length, 0, 'no new link while the pairing runs');
  end('list answered');
  end('pairing closed'); // once is enough
  assert.match(lines[lines.length - 1], /^pairing pause over after \d+s \(list answered\): the held link comes back$/);
  assert.equal(lines.filter((line) => line.includes('over after')).length, 1);
  assert.deepEqual([...bridge.homey.pending.values()].map((timer) => timer.ms), [1000], 'the limit is cleared');
  bridge.homey.runMs(1000);
  await new Promise(setImmediate);
  assert.equal(connects.length, 1, 'the held link is opened again');
  assert.equal(connects[0].purpose, 'held');
});

test('pairing pauses that overlap end with the last one, and one that is not ended ends at its limit', async () => {
  const { bridge, connects } = bridgeFor();
  const lines = [];
  bridge._status = (line) => lines.push(line);
  bridge._held = true;
  const older = await bridge.pauseForScan();
  const newer = await bridge.pauseForScan();
  older('a newer search');
  assert.ok(!lines.some((line) => line.includes('over after')), 'the newer search still pauses');
  await bridge._heldTick();
  assert.equal(connects.length, 0);
  bridge.homey.runMs(180000);
  assert.match(lines[lines.length - 1], /^pairing pause over after \d+s \(limit of 180s\): the held link comes back$/);
  newer('list answered'); // over already
  assert.equal(lines.filter((line) => line.includes('over after')).length, 1);
});

test('a pairing pause without a held link: a status poll waits, says so once, and runs 2 s after the pause', async () => {
  const { bridge } = bridgeFor();
  const lines = [];
  bridge._status = (line) => lines.push(line);
  bridge._held = false;
  const end = await bridge.pauseForScan();
  assert.deepEqual(lines, ['pairing pause: no link up; status polling waits until the pairing is done']);
  await bridge._statusPollTick();
  await bridge._statusPollTick();
  assert.ok(!bridge._statusRunning, 'the poll did not start');
  assert.equal(lines.filter((line) => line === 'poll deferred until the pairing is done').length, 1);
  end('pairing closed');
  assert.match(lines[lines.length - 1], /^pairing pause over after \d+s \(pairing closed\): status polling goes on$/);
  assert.deepEqual([...bridge.homey.pending.values()].map((timer) => timer.ms), [2000],
    'the poll that waited comes 2 s after, and the limit is cleared');
});

test('a command during a pairing pause: its link is let go as without the held link, and held if the pause ends first', async () => {
  for (const endsFirst of [false, true]) {
    const { bridge, connects, reasons } = bridgeFor();
    const logs = [];
    bridge.log = (line) => logs.push(line);
    bridge._held = true;
    bridge._bridgeLocalName = '@ND1A2B';
    bridge._bridgeNodeId = 0x1a2b;
    bridge._startHeartbeat = () => {};
    const end = await bridge.pauseForScan();
    Object.assign(bridge, {
      _peripheral: {}, _char8003: {}, _char8004: {}, _notifySubscribed: true, _lastUserTxAt: Date.now(),
    });
    await bridge._heldTick();
    assert.equal(bridge._heldUpAt, 0, 'not counted as the held link');
    bridge._scheduleIdleDisconnect('tx-queue-empty');
    assert.ok(bridge._disconnectTimer, 'let go after its keep-alive');
    const keep = bridge._keepAliveLeftMs();
    assert.ok(keep > 0 && keep <= 60000, `${keep} ms`);
    if (endsFirst) {
      end('list answered');
      assert.equal(bridge._disconnectTimer, null);
      assert.ok(logs.includes('TX idle disconnect cancelled as the link is held again'));
      assert.equal(bridge._keepAliveLeftMs(), 3600000, 'held from now on');
      bridge.homey.runMs(1000);
      await new Promise(setImmediate);
      assert.ok(bridge._heldUpAt > 0, 'counted as the held link');
      assert.equal(connects.length, 0, 'no new link');
      assert.deepEqual(reasons, []);
    } else {
      bridge.homey.runMs(bridge.homey.pending.get(bridge._disconnectTimer).ms);
      assert.deepEqual(reasons, ['tx-queue-empty']);
    }
  }
});

// A bridge that decodes frames with the test key.
function hearingBridge() {
  const app = {
    homey: fake.fakeHomey(null), log() {}, error() {}, _devices: () => [], getNetworkKey: () => KEY,
  };
  app.homey.app = app;
  const bridge = new MeshBridge(app);
  bridge._keyCheckDone = true;
  return bridge;
}

test('what a link heard, for the line when it is rolled for its age: the last frame below the highest TTL and the last at it, from the connect', () => {
  const bridge = hearingBridge();
  bridge._connNo = 6;
  const at = (ms, frame) => {
    bridge._connStartedAt = Date.now() - ms;
    bridge._rxDecodeFrame(frame);
  };
  assert.equal(bridge._heardText(), 'link #6 heard nothing');
  at(2000, frameFrom(0x0101, 48));
  assert.equal(bridge._heardText(), 'link #6 heard at ttl 48 until 2.0 s');
  at(3000, frameFrom(0x0202, 50));
  assert.equal(bridge._heardText(), 'link #6 heard below ttl 50 until 2.0 s, at ttl 50 until 3.0 s', 'a higher TTL makes the one before below');
  at(7600, frameFrom(0x0101, 49));
  at(7900, frameFrom(0x0202, 50));
  assert.equal(bridge._heardText(), 'link #6 heard below ttl 50 until 7.6 s, at ttl 50 until 7.9 s');
  at(9000, makePacket(KEY, (seq += 1), Buffer.from([0x00, 0x80, 0xff, 0x05, 0x5a, 0x3c, 1, 40, 7])));
  assert.equal(bridge._heardText(), 'link #6 heard below ttl 50 until 7.6 s, at ttl 50 until 7.9 s', 'our own frame coming back is not counted');
  bridge._connNo = 7;
  assert.equal(bridge._heardText(), 'link #7 heard nothing', 'a new link starts with nothing');
});

test('the lines for a link without the heartbeat rolled for its age say what it heard; a link with the heartbeat (@ND) has the line as before', async () => {
  const old = oldPillLink({ subscribed: true, listenMs: -1 });
  const lines = [];
  old.bridge._status = (line) => lines.push(line);
  old.bridge._connNo = 6;
  old.bridge._heard = {
    connNo: 6, top: 50, topAt: 7900, belowAt: 7600,
  };
  await old.bridge._ensureTxConnected();
  assert.ok(lines.some((line) => line.includes('rolling connection before next packet; link #6 heard below ttl 50 until 7.6 s, at ttl 50 until 7.9 s')), lines.join('\n'));

  const late = lateLink({ readyMs: 9000, recoveredMs: 3000 });
  const lateLines = [];
  late.bridge._status = (line) => lateLines.push(line);
  await late.bridge._ensureTxConnected();
  assert.ok(lateLines.some((line) => /recycling before payload; link #\d+ heard nothing/.test(line)), lateLines.join('\n'));

  const nd = lateLink({ readyMs: 15000, recoveredMs: 3000, heartbeat: true });
  const ndLines = [];
  nd.bridge._status = (line) => ndLines.push(line);
  await nd.bridge._ensureTxConnected();
  assert.ok(ndLines.some((line) => /recycling before payload$/.test(line)), ndLines.join('\n'));
});

test('links let go for their age are counted: at MAX_AGE_ROLLS_PER_MIN in a minute the status reads are to wait; a command never waits, and its roll counts', async () => {
  const old = oldPillLink({ subscribed: true, listenMs: -1 });
  const now = Date.now();
  old.bridge._ageRolls = [now - 50000, now - 40000, now - 30000, now - 20000, now - 10000];
  assert.equal(old.bridge.rollPauseMs(), 0, 'five in the last minute: no wait');
  old.bridge._sleep = async (ms) => {
    throw new Error(`no wait expected, ${ms} ms`);
  };
  await old.bridge._ensureTxConnected();
  assert.deepEqual(old.reasons, ['tx-aged-before-next-packet'], 'a command on a 7.5 s old link: rolled at once');
  assert.equal(old.bridge._ageRolls.length, 6, 'and counted');
  const pause = old.bridge.rollPauseMs();
  assert.ok(pause > 9000 && pause <= 10000, `the status reads wait until the oldest is a minute old, ${pause} ms`);
  old.bridge._ageRolls[0] = Date.now() - 61000;
  assert.equal(old.bridge.rollPauseMs(), 0, 'one older than a minute no longer counts');
});

test('Guard 2 counts its roll of a link without the heartbeat; a link with the heartbeat (@ND) is not counted', async () => {
  const late = lateLink({ readyMs: 9000, recoveredMs: 3000 });
  await late.bridge._ensureTxConnected();
  assert.equal(late.bridge._ageRolls.length, 1);

  const nd = lateLink({ readyMs: 15000, recoveredMs: 3000, heartbeat: true });
  await nd.bridge._ensureTxConnected();
  assert.equal(nd.bridge._ageRolls.length, 0);
});
