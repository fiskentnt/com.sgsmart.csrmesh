'use strict';

// The mesh frames in a pairing scan's advertisements (lib/meshAdverts.js),
// for the log only: a node is assumed to send the mesh packets it sends and
// passes on as advertisements too, each a whole frame in FEF1 service data,
// from an address of its own per packet. Not tried: whether Homey's scan
// gives that service data. The line has counts only, never a mesh id, a
// location id or an address. Made-up values: the keys, the location id
// 0x4c2e and the mesh ids. Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const fake = require('./helpers/fake-homey');

fake.install();

const { deriveNetworkKey } = require('../lib/csrmesh');
const { MAX_CHECKED, meshAdvertsLine } = require('../lib/meshAdverts');
const SGMeshDriver = require('../drivers/sg_mesh/driver');
const SGPillDriver = require('../drivers/sg_pill/driver');
const SGPlugDriver = require('../drivers/sg_plug/driver');
const SGThermostatDriver = require('../drivers/sg_thermostat/driver');

const KEY = deriveNetworkKey('test-only-pass');
const WRONG_KEY = deriveNetworkKey('another-pass');
const HOME = 0x4c2e;
const FEF1 = '0000fef1-0000-1000-8000-00805f9b34fb';
const tick = () => new Promise((resolve) => setImmediate(resolve));

// A frame as a node sends it: seq(3) source(2), the payload encrypted with
// AES-128-OFB, the MAC (8) and the TTL.
function frame(key, seq, src, plain, ttl = 0x32) {
  const seqBuf = Buffer.alloc(3);
  seqBuf.writeUIntLE(seq, 0, 3);
  const srcBuf = Buffer.from([src & 0xff, src >> 8]);
  const iv = Buffer.alloc(16);
  seqBuf.copy(iv, 0);
  srcBuf.copy(iv, 4);
  const cipher = crypto.createCipheriv('aes-128-ofb', key, iv);
  const payload = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = Buffer.from(crypto.createHmac('sha256', key).update(Buffer.concat([Buffer.alloc(8), seqBuf, srcBuf, payload])).digest())
    .reverse().subarray(0, 8);
  return Buffer.concat([seqBuf, srcBuf, payload, mac, Buffer.from([ttl])]);
}

// The plain payloads: destination first, then the opcode and its data.
const ext = (opcode, data, dst = 0x8000) => Buffer.from([dst & 0xff, dst >> 8, opcode >> 8, opcode & 0xff, ...data]);
const loc = [HOME >> 8, HOME & 0xff];
const statusFF05 = ext(0xff05, [...loc, 1, 40, 7]);
const temperaturesFF3D = ext(0xff3d, [...loc, 21, 5, 24, 0, 28, 0]);
const gen1Status = Buffer.from([0x00, 0x80, 0x73, 0xf7, ...loc, 0x1a, 0x2b, 0x0a, 0x0b, 0x0c, 0x0d, 60]);
const nameRequest = ext(0xff10, [0, 0], 0x0000);

let uuid = 0;
const advert = (data, form = 'array') => {
  uuid += 1;
  const id = `0200000000${uuid.toString(16).padStart(2, '0')}`;
  if (form === 'object') return { uuid: id, serviceData: { fef1: data } };
  if (form === 'hex') return { uuid: id, serviceData: [{ uuid: 'fef1', data: data.toString('hex') }] };
  return { uuid: id, serviceData: [{ uuid: FEF1, data }] };
};

test('frames read with the network key: how many, from how many senders, with how many location ids, by kind; nothing else in the line', () => {
  const pill = frame(KEY, 11, 0x9a31, statusFF05);
  const adverts = [
    advert(pill),
    // The same packet passed on by another node: one lower TTL.
    advert(Buffer.concat([pill.subarray(0, pill.length - 1), Buffer.from([0x31])]), 'object'),
    advert(frame(KEY, 12, 0xb7e2, statusFF05), 'hex'),
    advert(frame(KEY, 13, 0xc05d, temperaturesFF3D)),
    advert(frame(KEY, 14, 0x8001, gen1Status)),
    // Our own address: read, but not a sender.
    advert(frame(KEY, 15, 0x8000, nameRequest)),
    advert(frame(WRONG_KEY, 16, 0x9a31, statusFF05)),
    advert(Buffer.from([1, 2, 3])),
    { uuid: 'x', localName: 'Speaker' },
  ];
  const line = meshAdvertsLine(adverts, KEY);
  assert.equal(line, 'pair: mesh frames in advertisements (log only): 8 with FEF1 data, 1 not a frame, 6 distinct, 6 checked, '
    + '5 read with the network key, 1 not; 4 sender(s), 1 location id(s); 73F7 1, FF05 2, FF10 1, FF3D 1');
  assert.doesNotMatch(line, /9a31|b7e2|c05d|8001|4c2e|0200000000/i);
});

test('no FEF1 data in the scan: a line that says so', () => {
  assert.equal(meshAdvertsLine([{ uuid: 'a', localName: '@SC1A2B' }, { uuid: 'b' }], KEY),
    'pair: mesh frames in advertisements (log only): none with FEF1 data');
  assert.equal(meshAdvertsLine([], KEY), 'pair: mesh frames in advertisements (log only): none with FEF1 data');
});

test('at most MAX_CHECKED frames are checked; the rest are counted, not checked', () => {
  const adverts = [];
  for (let i = 0; i < MAX_CHECKED + 5; i += 1) adverts.push(advert(frame(KEY, 100 + i, 0x9a31, statusFF05)));
  const line = meshAdvertsLine(adverts, KEY);
  assert.match(line, new RegExp(`${MAX_CHECKED + 5} distinct, ${MAX_CHECKED} checked \\(at most ${MAX_CHECKED}\\), ${MAX_CHECKED} read`));
  assert.equal(MAX_CHECKED, 300);
});

test('no key: the frames are counted, none checked', () => {
  assert.equal(meshAdvertsLine([advert(frame(KEY, 1, 0x9a31, statusFF05))], null),
    'pair: mesh frames in advertisements (log only): 1 with FEF1 data, 1 distinct, no key to check them with');
});

// Each CSRmesh driver logs the line after its scan, with the app's network key.
const DRIVERS = {
  sg_pill: SGPillDriver, sg_plug: SGPlugDriver, sg_thermostat: SGThermostatDriver, sg_mesh: SGMeshDriver,
};
for (const [id, Driver] of Object.entries(DRIVERS)) {
  test(`${id}: the pairing search logs the line after its scan`, async () => {
    const app = {
      logs: [],
      errors: [],
      seq: 0x800000,
      log(...args) { app.logs.push(args.join(' ')); },
      error(...args) { app.errors.push(args.join(' ')); },
      getNetworkKey: () => KEY,
      nextSeq() { app.seq += 1; return app.seq; },
      bridge: { send: async () => ({ ok: true }) },
      _devices: () => [],
      locationFor: () => null,
    };
    app.csr = fake.fakeCsr([]);
    const adverts = [advert(frame(KEY, 21, 0x9a31, statusFF05))];
    const homey = fake.listenAtOnce(fake.fakeHomey(app, { ble: { discover: async () => adverts } }));
    const driver = new Driver({ homey });
    driver.getDevices = () => [];
    await driver._search().catch(() => {});
    await tick();
    assert.ok(driver.logs.includes('pair: mesh frames in advertisements (log only): 1 with FEF1 data, 1 distinct, 1 checked, '
      + '1 read with the network key, 0 not; 1 sender(s), 1 location id(s); FF05 1'), driver.logs.join('\n'));
  });
}
