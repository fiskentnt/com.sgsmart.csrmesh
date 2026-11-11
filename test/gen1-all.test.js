'use strict';

// The flow card that sets all first generation dimmers of the home to a level
// (lib/gen1All.js): one A0 with device id 0 and the home's location id, 0 % off. Made-up keys,
// ids and location ids only. Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fake = require('./helpers/fake-homey');

fake.install();

const { decryptPayload, deriveNetworkKey } = require('../lib/csrmesh');
const { nearOf, nextTid } = require('../lib/gen1All');
const SGMeshDevice = require('../lib/SGDeviceBase');
const SGSmartApp = require('../app');

const ROOT = path.join(__dirname, '..');
const PASSPHRASE = 'test-only-pass';
const KEY = deriveNetworkKey(PASSPHRASE);
const LOC = 0x7f00;

const plainOf = (packet, key = KEY) => decryptPayload(key, packet.subarray(0, 3), packet.subarray(3, 5), packet.subarray(5, packet.length - 9));

// What a dimmer needs from the app, with its own sends recorded.
function dimmerApp() {
  const app = {
    sent: [],
    seq: 0x800000,
    nextSeq() { app.seq += 1; return app.seq; },
    bridge: { send: async (packet, meta) => { app.sent.push({ packet, meta }); return { ok: true }; } },
    bridgeMeshId: () => null,
    dimmersChanged() {},
    locationFor: () => null,
    sharedLocation: () => null,
    requestStatus() {},
    statusUnreadableText: () => null,
  };
  return app;
}

async function dimmer(name, store = {}, passphrase = PASSPHRASE) {
  const device = new SGMeshDevice({
    homey: fake.fakeHomey(dimmerApp()), store: { localName: name, locationId: LOC, ...store }, settings: { passphrase }, name,
  });
  await device.onInit();
  return device;
}

// The real app with these devices paired, its flow card registered, and a
// bridge that records what it is given. settings carries over a restart.
function appWith(devices, { settings = new Map(), result = { ok: true } } = {}) {
  const app = new SGSmartApp();
  const listeners = {};
  const card = (id) => ({ registerRunListener: (fn) => { listeners[id] = fn; } });
  app.homey = fake.fakeHomey(app, {
    drivers: { getDrivers: () => ({ sg_mesh: { getDevices: () => devices } }) },
    flow: { getActionCard: card },
    settings: { get: (key) => (settings.has(key) ? settings.get(key) : null), set: (key, value) => settings.set(key, value) },
  });
  app._seq = 0x123456;
  app.sent = [];
  app.polls = 0;
  app.bridge = {
    send: async (packet, meta) => { app.sent.push({ packet, meta }); return result; },
    pollSoon: () => { app.polls += 1; },
  };
  app._registerFlowCards();
  return { app, listeners, settings };
}

const hex = (buffer) => buffer.toString('hex').match(/../g).join(' ');
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('the level card: one A0 with id 0 and the home\'s location id to 0x8001, the bytes as a dimmer\'s A0 but the id', async () => {
  const devices = [await dimmer('@ND3B91', { gen1Tid: 40 }), await dimmer('@ND3B92', { gen1Tid: 44 })];
  const { app, listeners, settings } = appWith(devices);
  assert.deepEqual(Object.keys(listeners), ['gen1_all_level']);
  assert.equal(await listeners.gen1_all_level({ level: 0.3 }), true);
  assert.equal(app.sent.length, 1, 'one packet, once');
  const tid = plainOf(app.sent[0].packet)[4];
  assert.equal(hex(plainOf(app.sent[0].packet)), `01 80 73 a0 ${tid.toString(16).padStart(2, '0')} 7f 00 00 00 00 00 01 1e`);
  assert.deepEqual(app.sent[0].meta, { key: 'gen1:all', level: 30 });
  assert.equal(settings.get('gen1AllTid'), tid, 'its counter is stored');
  await tick();
  assert.equal(app.polls, 1, 'the statuses are asked for once, when it is written');
  assert.ok(app.logs.some((line) => line.startsWith(`[SG] all Gen1 dimmers in the home: level 30, id 0 to 0x8001, tid ${tid}, 2 dimmer(s) in Homey: 0x3b91, 0x3b92`)));
  // Off and a full level; nothing above 100.
  await listeners.gen1_all_level({ level: 0 });
  await listeners.gen1_all_level({ level: 1 });
  assert.deepEqual(app.sent.slice(1).map(({ packet }) => plainOf(packet)[12]), [0, 100]);
});

test('the counter: clear of every dimmer\'s own, on by one from the last, also after a restart of the app', async () => {
  const devices = [await dimmer('@ND3B91'), await dimmer('@ND3B92')];
  devices[0]._gen1Seq = 63;
  devices[1]._gen1Seq = 59;
  const settings = new Map();
  const first = appWith(devices, { settings });
  await first.listeners.gen1_all_level({ level: 0.3 });
  const tid = plainOf(first.app.sent[0].packet)[4];
  assert.equal(tid, 63 + 128, '128 over the highest, with none before');
  await first.listeners.gen1_all_level({ level: 0.31 });
  assert.equal(plainOf(first.app.sent[1].packet)[4], tid + 1);
  // A restart: the same settings, a new app.
  const again = appWith(devices, { settings });
  await again.listeners.gen1_all_level({ level: 0.32 });
  assert.equal(plainOf(again.app.sent[0].packet)[4], tid + 2, 'on from the stored one');
  // A dimmer whose counter came close: past its counters, sent and to come.
  devices[1]._gen1Seq = tid + 2;
  await again.listeners.gen1_all_level({ level: 0.33 });
  assert.equal(plainOf(again.app.sent[1].packet)[4], (tid + 2 + 21) & 0xff);
});

test('a dimmer with only a stored counter: clear of those it sent since and of where it goes on after a restart', async () => {
  const stored = 100;
  const near = nearOf({ getStoreValue: (key) => (key === 'gen1Tid' ? stored : null) });
  assert.deepEqual(nextTid(stored - 25, [near]), { tid: stored - 25 + 1, near: 0 });
  assert.deepEqual(nextTid(stored - 21, [near]), { tid: stored + 17 + 21, near: 0 }, 'not in 80 to 137');
  // The real dimmer: its next counter after a restart is in that stretch.
  const device = await dimmer('@ND3B91', { gen1Tid: stored });
  await device._sendOnce(30);
  const sent = plainOf(device.homey.app.sent[0].packet)[4];
  assert.ok(((sent - near.from) & 0xff) <= near.span, `${sent} within ${near.from} + ${near.span}`);
  assert.equal(nearOf(device).at, sent);
  // Round past 255, and none known.
  assert.deepEqual(nextTid(250, [{ at: 0, from: 236, span: 40 }]), { tid: 21, near: 0 });
  assert.deepEqual(nextTid(null, []), { tid: 1, near: 0 });
  // No counter free: the one near the fewest is taken.
  const all = [0, 41, 82, 123, 164, 205, 246].map((c) => ({ at: c, from: (c - 20) & 0xff, span: 40 }));
  const full = [...all, { at: 30, from: 10, span: 40 }];
  const best = nextTid(0, full);
  assert.equal(best.near, 1);
});

test('the counter is stored before the A0 goes out', async () => {
  const devices = [await dimmer('@ND3B91', { gen1Tid: 40 })];
  const settings = new Map();
  const { app, listeners } = appWith(devices, { settings });
  let storedWhenSent = null;
  app.bridge.send = async (packet) => { storedWhenSent = settings.get('gen1AllTid'); app.sent.push({ packet }); return { ok: true }; };
  await listeners.gen1_all_level({ level: 0.5 });
  assert.equal(storedWhenSent, plainOf(app.sent[0].packet)[4]);
});

test('refused at once with the text, and nothing sent: no Gen1 dimmer, not one home, the location id not known, not one key; one not written is logged, with no error', async () => {
  const later = { getCsrMeshId: () => 0x0124, getData: () => ({ id: '@SD5E6F' }) };
  const cases = [
    [[later], 'flow.gen1All.none'],
    [[await dimmer('@ND3B91'), await dimmer('@ND3B92', { locationId: 0x7f01 })], 'flow.gen1All.homes'],
    [[await dimmer('@ND3B91'), await dimmer('@ND3B92', { locationId: undefined })], 'flow.gen1All.homes'],
    [[await dimmer('@ND3B91'), await dimmer('@ND3B92', {}, 'another-pass')], 'flow.gen1All.keys'],
  ];
  for (const [devices, message] of cases) {
    const { app, listeners } = appWith(devices);
    await assert.rejects(listeners.gen1_all_level({ level: 0.3 }), { message });
    assert.equal(app.sent.length, 0, message);
  }
  // A later generation dimmer beside them is not counted.
  const mixed = appWith([later, await dimmer('@ND3B91')]);
  await mixed.listeners.gen1_all_level({ level: 0.3 });
  assert.equal(mixed.app.sent.length, 1);
  assert.ok(mixed.app.logs.some((line) => line.includes('1 dimmer(s) in Homey: 0x3b91')));
  // Not written: the card is answered, and it is logged.
  const failed = appWith([await dimmer('@ND3B91')], { result: { ok: false } });
  assert.equal(await failed.listeners.gen1_all_level({ level: 0.3 }), true);
  await tick();
  assert.equal(failed.app.polls, 0);
  assert.ok(failed.app.logs.includes('[SG] all Gen1 dimmers in the home: level 30 not sent'));
  assert.deepEqual(failed.app.errors || [], []);
  // Replaced by a newer one before it was written: no error.
  const replaced = appWith([await dimmer('@ND3B91')], { result: { superseded: true } });
  assert.equal(await replaced.listeners.gen1_all_level({ level: 0.3 }), true);
  await tick();
  assert.ok(replaced.app.logs.includes('[SG] all Gen1 dimmers in the home: level 30 replaced by a newer one before it was written'));
});

test('the card answers at once, also when the bridge never answers; the A0 goes out after it, and one not written is logged later', async () => {
  const { app, listeners } = appWith([await dimmer('@ND3B91'), await dimmer('@ND3B92')]);
  let written;
  app.bridge.send = (packet, meta) => {
    app.sent.push({ packet, meta });
    return new Promise((resolve) => { written = resolve; });
  };
  let answered = false;
  listeners.gen1_all_level({ level: 0.4 }).then(() => { answered = true; });
  for (let i = 0; i < 3; i += 1) await tick();
  assert.equal(answered, true, 'answered before the bridge');
  assert.equal(app.sent.length, 1, 'the A0 on its way');
  assert.ok(!app.logs.some((line) => line.endsWith('not sent')));
  written({ failed: true });
  await tick();
  assert.ok(app.logs.includes('[SG] all Gen1 dimmers in the home: level 40 not sent'));
  assert.equal(app.polls, 0);
});

test('the card in the manifest: the level as 0 to 100 %, in English and Norwegian, and no other app card', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  const byId = Object.fromEntries(((manifest.flow || {}).actions || []).map((card) => [card.id, card]));
  for (const id of ['gen1_all_level']) {
    const compose = JSON.parse(fs.readFileSync(path.join(ROOT, '.homeycompose', 'flow', 'actions', `${id}.json`), 'utf8'));
    assert.deepEqual(byId[id], { id, ...compose }, `${id}: app.json as .homeycompose`);
    for (const part of ['title', 'titleFormatted', 'hint']) assert.deepEqual(Object.keys(byId[id][part]).sort(), ['en', 'no'], `${id} ${part}`);
  }
  const [level] = byId.gen1_all_level.args;
  assert.deepEqual([level.type, level.name, level.min, level.max, level.step, level.label, level.labelMultiplier, level.labelDecimals],
    ['range', 'level', 0, 1, 0.01, '%', 100, 0]);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, '.homeycompose', 'flow', 'actions')), ['gen1_all_level.json']);
  for (const lang of ['en', 'no']) {
    const texts = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', `${lang}.json`), 'utf8')).flow.gen1All;
    assert.deepEqual(Object.keys(texts).sort(), ['homes', 'keys', 'none'], lang);
  }
});
