'use strict';

// A status poll's link through a first generation bridge (@ND) gets the
// heartbeat for as long as the poll listens on it, not one only, so the
// dimmer does not hang up a link that is subscribed: after such a hang-up,
// Homey was seen to hand over every notification once more, until it
// restarted. The dimmer here hangs up 10 s after the connect or after the
// start of its last heartbeat. The chain ends with the poll's link. The age
// rule for links without the heartbeat does not apply (@ND).
// Made-up values: the name, uuid and key. Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const fake = require('./helpers/fake-homey');

fake.install();

const { deriveNetworkKey } = require('../lib/csrmesh');
const MeshBridge = require('../lib/MeshBridge');

const KEY = deriveNetworkKey('test-only-pass');
const CHAR_8003 = 'c4edc0009daf11e3800300025b000b00';
const CHAR_8004 = 'c4edc0009daf11e3800400025b000b00';

// One @ND bridge on Homey's clock vt. getService takes serviceMs; the first
// heartbeat on the first link fails when failFirstHeartbeat. links: per
// connect, the heartbeats that got through, and whether the dimmer hung up.
function ndBridge({ serviceMs = 4000, failFirstHeartbeat = false } = {}) {
  const vt = fake.virtualTimers();
  const lines = [];
  const links = [];
  let seq = 0x100;
  const app = {
    log: (...args) => lines.push(args.join(' ')),
    error: (...args) => lines.push(args.join(' ')),
    getNetworkKey: () => KEY,
    nextSeq: () => {
      seq += 1;
      return seq;
    },
    _devices: () => [],
    dimmerCount: () => 2,
    reportSignal() {},
    bridgeChanged() {},
    getPairedMeshIds: () => [],
  };
  const wait = (ms) => new Promise((resolve) => {
    app.homey.setTimeout(resolve, ms);
  });
  const node = {
    uuid: 'aaaa00001111',
    localName: '@ND1A2B',
    rssi: -50,
    serviceUuids: ['fef1'],
    connectable: true,
    connect: async () => {
      await wait(1000);
      const link = {
        heartbeats: 0, hungUp: false, local: false, listener: null, timer: null, failNext: failFirstHeartbeat && links.length === 0,
      };
      links.push(link);
      const arm = () => {
        if (link.timer) app.homey.clearTimeout(link.timer);
        link.timer = app.homey.setTimeout(() => {
          if (link.local) return;
          link.hungUp = true;
          if (link.listener) link.listener();
        }, 10000);
      };
      arm();
      const char = (uuid) => ({
        uuid,
        async write(data) {
          if (link.hungUp) throw new Error('Operation failed with ATT error: 0x0e');
          // Only heartbeats go on a poll's link: 20 bytes to 8003 starts one.
          if (uuid === CHAR_8003 && data.length === 20) {
            if (link.failNext) {
              link.failNext = false;
              throw new Error('Operation failed with ATT error: 0x0e');
            }
            link.heartbeats += 1;
            arm();
          }
        },
        subscribeToNotifications: async () => {
          await wait(500);
        },
        unsubscribeFromNotifications: async () => {},
      });
      const chars = [char(CHAR_8003), char(CHAR_8004)];
      return {
        once(event, fn) {
          if (event === 'disconnect') link.listener = fn;
        },
        off() {
          link.listener = null;
        },
        disconnect: async () => {
          link.local = true;
          if (link.timer) app.homey.clearTimeout(link.timer);
        },
        getService: async () => {
          await wait(serviceMs);
          return { discoverCharacteristics: async () => chars };
        },
      };
    },
  };
  const ble = {
    find: async () => node,
    discover: async () => {
      await wait(1000);
      return [node];
    },
  };
  app.homey = fake.fakeHomey(app, { ...vt, ble });
  app.homey.settings.set('debugLogging', true);
  const bridge = new MeshBridge(app);
  return {
    bridge, vt, lines, links,
  };
}

// One status poll, run on Homey's clock until it is over, then 10 s more.
async function poll(t) {
  const realNow = Date.now;
  Date.now = t.vt.now;
  try {
    let done = false;
    const running = t.bridge._statusPollTick().then(() => {
      done = true;
    });
    for (let i = 0; i < 200 && !done; i += 1) await t.vt.advance(250);
    await running;
    const after = t.links.map((link) => link.heartbeats);
    await t.vt.advance(10000);
    return after;
  } finally {
    Date.now = realNow;
  }
}

const hangUps = (lines) => lines.filter((line) => /REMOTE DISCONNECT/.test(line));

test('a status poll through @ND: the heartbeat every 3 s while the poll listens, and none once its link is let go', async () => {
  const t = ndBridge();
  const after = await poll(t);
  assert.equal(t.links.length, 1);
  assert.ok(t.links[0].heartbeats >= 3, `heartbeats: ${t.links[0].heartbeats}`);
  assert.deepEqual(t.links.map((link) => link.heartbeats), after, 'no heartbeat after the poll');
  assert.ok(t.lines.some((line) => /LOCAL DISCONNECT request #1 .*reason=status-poll/.test(line)), t.lines.join('\n'));
  assert.deepEqual(hangUps(t.lines), []);
  assert.ok(!t.lines.some((line) => /keep-alive: holding link #1 for 0s/.test(line)), 'no line for a link held 0 s');
  assert.ok(!t.lines.some((line) => /rolling connection|ready too late/.test(line)), 'the age rule for links without the heartbeat does not apply');
});

test('a status poll through @ND whose first heartbeat fails: the next one keeps the link, and the dimmer does not hang up '
  + 'the subscribed link before the poll lets it go', async () => {
  const t = ndBridge({ failFirstHeartbeat: true });
  await poll(t);
  assert.ok(t.lines.some((line) => /first heartbeat failed #1/.test(line)), t.lines.join('\n'));
  assert.deepEqual(hangUps(t.lines), [], t.lines.join('\n'));
  assert.equal(t.links[0].hungUp, false);
  assert.ok(t.links[0].heartbeats >= 2);
});
