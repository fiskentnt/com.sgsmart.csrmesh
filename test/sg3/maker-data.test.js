'use strict';

// The manufacturer data line in the 3.0 scan, and for the advertisement
// from find or the kept one a link is opened with (lib/sg3/controller.js,
// makerLine and logMakers): one line per node per app start, with how many
// bytes the data for company 0x0EE8 has, whether bytes 8 and 9 (low byte
// first, the company being bytes 0 and 1) equal the address of a 3.0 device
// in Homey, and the value of byte 18. No other bytes, and no addresses or ids
// in it. Against the fake Homey and a simulated node; the specification's
// sample keys and made-up data.

const test = require('node:test');
const assert = require('node:assert/strict');

const { MAKER_COMPANY, Sg3Controller, makerLine } = require('../../lib/sg3/controller');
const { SimulatedSgNode } = require('./simulated-node');
const { advert, fakeHomey } = require('./fake-homey');

const hex = (s) => Buffer.from(s, 'hex');
const NET_KEY = '7dd7364cd842ad18c17c2b820c84c3d6';
const APP_KEY = '63964771734fbd76e3b40519d1d94a48';
const NETWORK = { netKey: NET_KEY, appKey: APP_KEY, addresses: [0x0003] };

// Made-up manufacturer data: the company low byte first, then the filler
// 0x5a, with the two bytes compared at 8 (low byte first) and byte 18.
const maker = (address, length = 20, byte18 = 0xc1) => {
  const data = Buffer.alloc(length, 0x5a);
  data.writeUInt16LE(MAKER_COMPANY, 0);
  if (length >= 10) data.writeUInt16LE(address, 8);
  if (length >= 19) data[18] = byte18;
  return data;
};
const MAKER_LINE = /^(scan|find|kept), a node (with|without) this network's ID: /;
const WITH = "scan, a node with this network's ID: ";

test('the line: how many bytes, bytes 8 and 9 the same as or different from a 3.0 device in Homey, and byte 18', () => {
  assert.equal(MAKER_COMPANY, 0x0ee8);
  assert.equal(makerLine({ manufacturerData: maker(0x0003) }, [0x0003], true),
    `${WITH}manufacturer data for 0x0EE8, 20 bytes, bytes 8 and 9 same as the address of a 3.0 device in Homey, byte 18 0xc1`);
  assert.equal(makerLine({ manufacturerData: maker(0x0300, 20, 0x07) }, [0x0003], true),
    `${WITH}manufacturer data for 0x0EE8, 20 bytes, bytes 8 and 9 different from the address of a 3.0 device in Homey, byte 18 0x07`,
    'low byte first: 0x0300 is not 0x0003');
  assert.equal(makerLine({ manufacturerData: maker(0x0004, 19, 0x00) }, [0x0003, 0x0004], false),
    "scan, a node without this network's ID: manufacturer data for 0x0EE8, 19 bytes, bytes 8 and 9 same as the address of a 3.0 device in Homey, byte 18 0x00");
  assert.equal(makerLine({ manufacturerData: maker(0x0003, 18) }, [0x0003], true),
    `${WITH}manufacturer data for 0x0EE8, 18 bytes, bytes 8 and 9 same as the address of a 3.0 device in Homey, no byte 18`);
  assert.equal(makerLine({ manufacturerData: maker(0x0003, 9) }, [0x0003], true),
    `${WITH}manufacturer data for 0x0EE8, 9 bytes, too short for bytes 8 and 9`);
  assert.equal(makerLine({ manufacturerData: maker(0x0003) }, [], true),
    `${WITH}manufacturer data for 0x0EE8, 20 bytes, bytes 8 and 9 different from the address of a 3.0 device in Homey, byte 18 0xc1`,
    'no 3.0 device in Homey: different');
});

test('no data for 0x0EE8: none, another company, too short for the company, or data Homey did not give as bytes', () => {
  const another = maker(0x0003);
  another.writeUInt16LE(0x004c, 0);
  for (const manufacturerData of [undefined, null, Buffer.alloc(0), Buffer.from([0xe8]), another, 'e80e5a5a', { length: 20 }, 42]) {
    assert.equal(makerLine({ manufacturerData }, [0x0003], true), `${WITH}no manufacturer data for 0x0EE8`, String(manufacturerData));
  }
  // A list of bytes, a Uint8Array and a Buffer in JSON form are read as the bytes.
  const same = `${WITH}manufacturer data for 0x0EE8, 20 bytes, bytes 8 and 9 same as the address of a 3.0 device in Homey, byte 18 0xc1`;
  assert.equal(makerLine({ manufacturerData: [...maker(0x0003)] }, [0x0003], true), same);
  assert.equal(makerLine({ manufacturerData: maker(0x0003).toJSON() }, [0x0003], true), same);
  assert.equal(makerLine({ manufacturerData: new Uint8Array(maker(0x0003)) }, [0x0003], true), same);
});

// A controller that does not hold the link, with one 3.0 dimmer (0x0003),
// and three nodes in each scan: ours, one of another network, and one
// without manufacturer data.
function setUp() {
  const node = new SimulatedSgNode({ netKey: hex(NET_KEY), appKey: hex(APP_KEY), address: 0x0003, on: true, level: 40, statusGroup: 0xffff });
  const homey = fakeHomey({
    adverts: (calls) => [
      { ...advert(node, { uuid: 'made-up-node-a1b2', rssi: -55, calls }), manufacturerData: maker(0x0003) },
      { ...advert(node, { uuid: 'made-up-node-c3d4', rssi: -70, networkId: '0011223344556677', calls }), manufacturerData: maker(0x0009, 12) },
      advert(node, { uuid: 'made-up-node-e5f6', rssi: -80, networkId: '0011223344556677', calls }),
    ],
  });
  homey.devices.push(0x0003);
  const logs = [];
  const controller = new Sg3Controller({
    homey,
    network: NETWORK,
    deviceAddresses: () => homey.devices,
    held: () => ({ held: false, why: 'by the test' }),
    log: (line) => logs.push(line),
    randomInt: () => 0,
    lingerMs: 20,
  });
  return { homey, node, logs, controller };
}

test('in the 3.0 scan: one line per node, once per app start, before the scan line, and the link as before', async () => {
  const t = setUp();
  await t.controller.pollStatus();
  await t.controller.pollStatus();
  assert.equal(t.homey.calls.discover, 2, 'two scans');
  const lines = t.logs.filter((line) => MAKER_LINE.test(line));
  assert.deepEqual(lines, [
    `${WITH}manufacturer data for 0x0EE8, 20 bytes, bytes 8 and 9 same as the address of a 3.0 device in Homey, byte 18 0xc1`,
    "scan, a node without this network's ID: manufacturer data for 0x0EE8, 12 bytes, bytes 8 and 9 different from the address of a 3.0 device in Homey, no byte 18",
    "scan, a node without this network's ID: no manufacturer data for 0x0EE8",
  ], t.logs.join('\n'));
  const first = t.logs.findIndex((line) => MAKER_LINE.test(line));
  const scanLine = t.logs.findIndex((line) => /^scan \d+\.\d s: /.test(line));
  assert.ok(first >= 0 && first < scanLine, 'before the scan line');
  assert.equal(t.logs.filter((line) => /^0x0003 status: on 40 after/.test(line)).length, 2, 'both rounds read the status');
  await t.controller.stop();
});

test('the line has no other bytes, addresses or ids: not the peripheral id or its last four, not the address, only the company and byte 18', async () => {
  const t = setUp();
  await t.controller.pollStatus();
  const lines = t.logs.filter((line) => MAKER_LINE.test(line));
  assert.equal(lines.length, 3);
  for (const line of lines) {
    for (const id of ['made-up-node-a1b2', 'made-up-node-c3d4', 'made-up-node-e5f6']) {
      assert.ok(!line.includes(id) && !line.includes(id.slice(-4)), line);
    }
    const hexes = line.match(/0x[0-9a-f]+/gi) || [];
    assert.ok(hexes.every((value) => value === '0x0EE8' || /^0x[0-9a-f]{2}$/.test(value)), `${line}: only the company and one byte`);
    assert.ok(hexes.filter((value) => value !== '0x0EE8').length <= 1, line);
    assert.doesNotMatch(line, /5a|0003|0009/i, 'no other bytes, no address');
  }
  await t.controller.stop();
});

test('a new app start (a new controller) gives the lines again; a scan that fails gives none and fails as before', async () => {
  const t = setUp();
  await t.controller.pollStatus();
  await t.controller.stop();
  const again = new Sg3Controller({
    homey: t.homey, network: NETWORK, deviceAddresses: () => t.homey.devices, held: () => ({ held: false, why: 'by the test' }),
    log: (line) => t.logs.push(line), randomInt: () => 0, lingerMs: 20,
  });
  await again.pollStatus();
  assert.equal(t.logs.filter((line) => MAKER_LINE.test(line)).length, 6);
  await again.stop();

  const failing = setUp();
  failing.homey.ble.discover = async () => { throw new Error('made-up: Bluetooth busy'); };
  await assert.rejects(failing.controller.discover(), /Bluetooth busy/);
  assert.equal(failing.logs.filter((line) => MAKER_LINE.test(line)).length, 0);
  await failing.controller.stop();
});

// Find without a scan, and the kept advertisement: the node of the
// advertisement a link is opened with. The scan gives nothing here.
function findSetUp() {
  const t = setUp();
  const ours = { ...advert(t.node, { uuid: 'made-up-node-f7a8', rssi: -58, calls: t.homey.calls }), manufacturerData: maker(0x0003, 20, 0x2b) };
  t.homey.ble.discover = async () => [];
  t.homey.ble.find = async (uuid) => {
    if (uuid !== ours.uuid) throw new Error('made-up: not found');
    return ours;
  };
  t.homey.settings.set(`sg3Proxy:${t.controller.networkId}`, ours.uuid);
  return { ...t, ours };
}

test('from find: the line for the node a link is opened with, once per app start, and the status as before', async () => {
  const t = findSetUp();
  await t.controller.pollStatus();
  await t.controller.pollStatus();
  assert.deepEqual(t.logs.filter((line) => MAKER_LINE.test(line)), [
    "find, a node with this network's ID: manufacturer data for 0x0EE8, 20 bytes, bytes 8 and 9 same as the address of a 3.0 device in Homey, byte 18 0x2b",
  ], t.logs.join('\n'));
  assert.equal(t.logs.filter((line) => /without a scan \(find/.test(line)).length, 2, 'both rounds through find');
  assert.equal(t.logs.filter((line) => /^0x0003 status: on 40 after/.test(line)).length, 2);
  for (const line of t.logs.filter((l) => MAKER_LINE.test(l))) assert.ok(!line.includes('f7a8'), line);
  await t.controller.stop();
});

test('the kept advertisement: a node not seen before gets its line; one seen from find or a scan does not get it again', async () => {
  // A node first seen as the kept advertisement.
  const t = findSetUp();
  t.homey.ble.find = async () => { throw new Error('made-up: find not used'); };
  t.controller.bridge = t.controller.createBridge();
  t.controller.bridge.kept = { advertisement: t.ours, uuid: t.ours.uuid, fetchedAt: Date.now() };
  await t.controller.setLevel(0x0003, 30);
  assert.equal(t.node.level, 30);
  assert.ok(t.logs.some((line) => /^the proxy used last, .*from the kept advertisement/.test(line)), t.logs.join('\n'));
  assert.deepEqual(t.logs.filter((line) => MAKER_LINE.test(line)), [
    "kept, a node with this network's ID: manufacturer data for 0x0EE8, 20 bytes, bytes 8 and 9 same as the address of a 3.0 device in Homey, byte 18 0x2b",
  ], t.logs.join('\n'));
  await t.controller.stop();

  // Seen from find, then a command on the kept advertisement: no second line.
  const f = findSetUp();
  await f.controller.pollStatus();
  await f.controller.setLevel(0x0003, 45);
  assert.equal(f.node.level, 45);
  assert.ok(f.logs.some((line) => /from the kept advertisement/.test(line)), f.logs.join('\n'));
  assert.equal(f.logs.filter((line) => MAKER_LINE.test(line)).length, 1, 'only the line from find');
  await f.controller.stop();

  // Seen in a scan, then through find: no second line.
  const s = setUp();
  await s.controller.pollStatus();
  const seen = s.homey.store.get(`sg3Proxy:${s.controller.networkId}`);
  assert.equal(seen, 'made-up-node-a1b2');
  s.homey.ble.find = async () => ({ ...advert(s.node, { uuid: seen, rssi: -55, calls: s.homey.calls }), manufacturerData: maker(0x0003) });
  await s.controller.pollStatus();
  assert.ok(s.logs.some((line) => /without a scan \(find/.test(line)), s.logs.join('\n'));
  assert.equal(s.logs.filter((line) => /^find, /.test(line)).length, 0);
  assert.equal(s.logs.filter((line) => MAKER_LINE.test(line)).length, 3, 'the three from the scan');
  await s.controller.stop();
});
