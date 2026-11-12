'use strict';

// A scan may give a node without its name, or without its services (only
// its address and signal). Without an @ND node in the scan, a node this app
// knows as a bridge by its uuid (the stored one, the one the commands go to
// now, or one a link went through since the start) is kept as a bridge all
// the same, and the log says so once per node. A node not known by its uuid
// is not. A home with an @ND node in the scan is unchanged, and so is a home
// with a first generation dimmer in Homey.
// Made-up values: the names, uuids, location id and mesh id.
// Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const fake = require('./helpers/fake-homey');

fake.install();

const { deriveNetworkKey, makePacket } = require('../lib/csrmesh');
const { csrLevelData } = require('../lib/sgProtocol');
const MeshBridge = require('../lib/MeshBridge');

const KEY = deriveNetworkKey('1234');
const HOME = 0x4c2e;
const FEF1 = 'fef1';
const command = (level) => makePacket(KEY, 0x10, csrLevelData({
  meshId: 0x9a31, location: HOME, level, tid: 1,
}));

// The stored bridge B, a later node, as a scan may give it: no name and no
// services; C, a later node with both; N, a node not known, also without.
const nodes = {
  B: {
    uuid: 'bbbb00002222', localName: '', rssi: -60, connectable: true,
  },
  C: {
    uuid: 'cccc00003333', localName: '@GD3C4D', rssi: -55, serviceUuids: [FEF1], connectable: true,
  },
  N: {
    uuid: 'dddd00004444', localName: '', rssi: -40, connectable: true,
  },
  ND: {
    uuid: 'eeee00005555', localName: '@ND5E6F', rssi: -70, serviceUuids: [FEF1], connectable: true,
  },
};

function laterHome({ discover = () => [nodes.B, nodes.C, nodes.N], dimmers = 0 } = {}) {
  const vt = fake.virtualTimers();
  const lines = [];
  const connects = [];
  const app = {
    log: (...args) => lines.push(args.join(' ')),
    error: (...args) => lines.push(args.join(' ')),
    getNetworkKey: () => KEY,
    nextSeq: () => 1,
    _devices: () => [],
    dimmerCount: () => dimmers,
    laterCount: () => 3,
    reportSignal() {},
    bridgeChanged() {},
  };
  const write = async () => {};
  const chars = [{ uuid: 'c4edc0009daf11e3800300025b000b00', write }, { uuid: 'c4edc0009daf11e3800400025b000b00', write }];
  const wait = (ms) => new Promise((resolve) => {
    app.homey.setTimeout(resolve, ms);
  });
  const withConnect = (adv, label) => ({
    ...adv,
    connect: async () => {
      connects.push(label);
      await wait(3000);
      return {
        once() {}, removeListener() {}, disconnect: async () => {}, getService: async () => ({ discoverCharacteristics: async () => chars }),
      };
    },
  });
  const live = Object.fromEntries(Object.entries(nodes).map(([label, adv]) => [label, withConnect(adv, label)]));
  const ble = {
    find: async () => null,
    discover: async () => {
      await wait(10000);
      return discover().map((adv) => live[Object.keys(nodes).find((k) => nodes[k].uuid === adv.uuid)]);
    },
  };
  app.homey = fake.fakeHomey(app, { ...vt, ble });
  app.homey.settings.set('bridgeUuid', nodes.B.uuid);
  const bridge = new MeshBridge(app);
  return {
    bridge, app, vt, lines, connects,
  };
}

async function at(t, run) {
  const realNow = Date.now;
  Date.now = t.vt.now;
  try {
    return await run();
  } finally {
    Date.now = realNow;
  }
}

const kept = (lines) => lines.filter((line) => /kept as a bridge by its uuid/.test(line));

test('without @ND in the scan: the stored bridge given without name or services is a bridge by its uuid, said once; '
  + 'a node not known by its uuid is not', () => {
  const t = laterHome();
  const { bridge, lines } = t;
  const sg = bridge._bridgeNodes([nodes.B, nodes.C, nodes.N]);
  assert.deepEqual(sg.map((a) => a.uuid), [nodes.C.uuid, nodes.B.uuid], 'C by its name, B by its uuid, not N');
  bridge._bridgeNodes([nodes.B, nodes.C]);
  assert.equal(kept(lines).length, 1, 'said once');
  assert.match(kept(lines)[0], /scan: …2222 kept as a bridge by its uuid/);
  // One a link went through since the start, also when it is not stored.
  bridge._knownAdvs.set(nodes.N.uuid, nodes.N);
  assert.deepEqual(bridge._bridgeNodes([nodes.N]).map((a) => a.uuid), [nodes.N.uuid]);
});

test('the stored bridge given without its name is seen in the scan, with another node 5 dB stronger: no bridge changed, nothing counted as out of reach', async () => {
  const t = laterHome();
  await at(t, () => {
    const sg = t.bridge._bridgeNodes([nodes.B, nodes.C]);
    t.bridge._pickBridge(sg);
  });
  assert.equal(t.bridge._preferredUuid, nodes.B.uuid);
  assert.equal(t.bridge._storedGone, null);
  assert.equal(t.app.homey.settings.get('bridgeUuid'), nodes.B.uuid);
});

test('a command after a restart, find() missing the stored bridge and the scan giving it without a name: '
  + 'it goes through the stored bridge, not the other node', async () => {
  const t = laterHome();
  const result = await at(t, async () => {
    let r = null;
    const done = t.bridge.send(command(40), { key: 'csr:a', level: 40 }).then((x) => {
      r = x;
    });
    for (let i = 0; i < 200 && r === null; i += 1) await t.vt.advance(500);
    await done;
    return r;
  });
  assert.equal(result.ok, true, t.lines.join('\n'));
  assert.deepEqual(t.connects, ['B']);
  assert.ok(!t.lines.some((line) => /fallback to strongest reachable/.test(line)));
});

test('a home with an @ND node in the scan is unchanged: only @ND, also with the stored bridge given without its name', () => {
  const t = laterHome();
  const sg = t.bridge._bridgeNodes([nodes.B, nodes.C, nodes.ND]);
  assert.deepEqual(sg.map((a) => a.uuid), [nodes.ND.uuid]);
  assert.equal(kept(t.lines).length, 0);
});

test('a home with a first generation dimmer in Homey is unchanged: without @ND in the scan, '
  + 'the stored bridge given without its name is not kept by its uuid', () => {
  const t = laterHome({ dimmers: 1 });
  const sg = t.bridge._bridgeNodes([nodes.B, nodes.C, nodes.N]);
  assert.deepEqual(sg.map((a) => a.uuid), [nodes.C.uuid]);
  assert.equal(kept(t.lines).length, 0);
});
