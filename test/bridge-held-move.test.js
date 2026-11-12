'use strict';

// The hourly scan of the held link moves the link when it is not through the
// bridge chosen now: the node the link is through (_linkedUuid) is what
// counts, not the bridge in memory before the scan. It moves only to a node
// this scan found, so a scan that says nothing about the bridge (a link to it
// just ended) leaves the link as it is. Made-up values: the names and uuids.
// Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const fake = require('./helpers/fake-homey');

fake.install();

const MeshBridge = require('../lib/MeshBridge');

// The stored bridge A and a weaker node B, both first generation. The held
// link is through linkedTo; the hourly scan gives scan.
function heldLink({ linkedTo, scan }) {
  const lines = [];
  const reasons = [];
  const app = {
    log: (...args) => lines.push(args.join(' ')),
    error: (...args) => lines.push(args.join(' ')),
    getNetworkKey: () => null,
    nextSeq: () => 1,
    _devices: () => [],
    dimmerCount: () => 2,
    reportSignal() {},
    bridgeChanged() {},
  };
  const nodes = {
    A: {
      uuid: 'aaaa00001111', localName: '@ND1A2B', rssi: -60, serviceUuids: ['fef1'], connectable: true,
    },
    B: {
      uuid: 'bbbb00002222', localName: '@ND3C4D', rssi: -85, serviceUuids: ['fef1'], connectable: true,
    },
  };
  app.homey = fake.fakeHomey(app, {});
  app.homey.settings.set('bridgeUuid', nodes.A.uuid);
  const bridge = new MeshBridge(app);
  bridge._held = true;
  bridge._peripheral = {};
  bridge._char8003 = {};
  bridge._char8004 = {};
  bridge._linkedUuid = nodes[linkedTo].uuid;
  bridge._discover = async () => scan.map((label) => nodes[label]);
  bridge._disconnect = async (reason) => {
    reasons.push(reason);
  };
  return {
    bridge, app, nodes, lines, reasons,
  };
}

const rescan = async (t) => {
  await t.bridge._heldRescan();
  if (t.bridge._heldRescanTimer) t.bridge.homey.clearTimeout(t.bridge._heldRescanTimer);
  t.bridge._held = false;
};

test('the held link through the weaker B, and the scan keeps A as the bridge: the link moves to A', async () => {
  const t = heldLink({ linkedTo: 'B', scan: ['A', 'B'] });
  await rescan(t);
  assert.equal(t.bridge._preferredUuid, t.nodes.A.uuid);
  assert.deepEqual(t.reasons, ['held-link-better-bridge']);
  assert.ok(t.lines.some((line) => /held link: moving to @ND1A2B/.test(line)), t.lines.join('\n'));
});

test('the held link through A, the bridge, and A in the scan: the link stays, as before', async () => {
  const t = heldLink({ linkedTo: 'A', scan: ['A', 'B'] });
  await rescan(t);
  assert.equal(t.bridge._preferredUuid, t.nodes.A.uuid);
  assert.deepEqual(t.reasons, []);
});

test('the held link through B, and the scan finds only B, the bridge now: the link stays, not let go to connect to B again', async () => {
  const t = heldLink({ linkedTo: 'B', scan: ['B'] });
  await rescan(t);
  assert.equal(t.bridge._preferredUuid, t.nodes.B.uuid);
  assert.deepEqual(t.reasons, []);
});

test('the held link through B right after a link to A ended, A not in the scan: the scan says nothing about A, and the link stays', async () => {
  const t = heldLink({ linkedTo: 'B', scan: ['B'] });
  t.bridge._linkEndedAt.set(t.nodes.A.uuid, Date.now());
  await rescan(t);
  assert.equal(t.bridge._preferredUuid, t.nodes.A.uuid);
  assert.deepEqual(t.reasons, []);
});
