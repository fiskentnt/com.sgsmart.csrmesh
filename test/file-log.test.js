'use strict';

// "Show log" (2.5.0): the file log, the masking before the log leaves the app,
// the app's log view and the api.js route. Made-up addresses, UUIDs and names
// only. Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fake = require('./helpers/fake-homey');

fake.install();

const { FileLog, maskLog } = require('../lib/FileLog');
const SGSmartApp = require('../app');
const api = require('../api');

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sg-filelog-')), 'app.log');

test('lines get a timestamp unless the SDK already put one, RX fragments are left out', async () => {
  const file = tempFile();
  const log = new FileLog(fake.fakeHomey(null), file);
  log._take('out', '2026-01-02T03:04:05.678Z [log] [SGSmartApp] ready\nno stamp ');
  log._take('out', 'here\n');
  log._take('out', '2026-01-02T03:04:06.000Z [log] [SGSmartApp] [MeshBridge] RX 8004 #1 0011\n');
  log._take('err', 'boom\n');
  await log.flush();
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '2026-01-02T03:04:05.678Z [log] [SGSmartApp] ready');
  assert.match(lines[1], /^\d{4}-\d\d-\d\dT[\d:.]+Z \[out\] no stamp here$/);
  assert.match(lines[2], /^\d{4}-\d\d-\d\dT[\d:.]+Z \[err\] boom$/);
});

test('a flush is scheduled once, 5 s after the first line', () => {
  const homey = fake.fakeHomey(null);
  const log = new FileLog(homey, tempFile());
  log._take('out', 'one\n');
  log._take('out', 'two\n');
  assert.deepEqual([...homey.pending.values()].map((timer) => timer.ms), [5000]);
});

test('over 2 MB the file is cut to the newest 1.5 MB, on a whole line', async () => {
  const file = tempFile();
  const log = new FileLog(fake.fakeHomey(null), file);
  const line = (n) => `2026-01-02T03:04:05.678Z [log] line ${String(n).padStart(7, '0')} ${'x'.repeat(60)}\n`;
  let n = 0;
  let text = '';
  while (text.length <= 2 * 1024 * 1024) text += line(n++);
  fs.writeFileSync(file, text);
  log.lines.push(line(n++));
  await log.flush();
  const kept = fs.readFileSync(file, 'utf8');
  assert.ok(kept.length <= 1.5 * 1024 * 1024);
  assert.ok(kept.length > 1.4 * 1024 * 1024);
  assert.match(kept, /^2026-01-02T03:04:05\.678Z \[log\] line \d{7} x+\n/);
  assert.ok(kept.endsWith(line(n - 1)));
});

test('tail gives the last lines, read from the end of a large file, without a cut line', async () => {
  const file = tempFile();
  const log = new FileLog(fake.fakeHomey(null), file);
  const lines = Array.from({ length: 20000 }, (_, i) => `2026-01-02T03:04:05.678Z [log] line ${i}`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const tail = await log.tail(500);
  assert.equal(tail.length, 500);
  assert.equal(tail[0], 'line 19500'.replace(/^/, '2026-01-02T03:04:05.678Z [log] '));
  assert.equal(tail[499], '2026-01-02T03:04:05.678Z [log] line 19999');
  assert.deepEqual(await new FileLog(fake.fakeHomey(null), tempFile()).tail(500), []);
});

test('tail with long lines: only whole lines from the last 256 KB, fewer than asked for', async () => {
  const file = tempFile();
  const log = new FileLog(fake.fakeHomey(null), file);
  const lines = Array.from({ length: 1000 }, (_, i) => `2026-01-02T03:04:05.678Z [log] line ${String(i).padStart(4, '0')} ${'y'.repeat(970)}`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const tail = await log.tail(500);
  assert.ok(tail.length > 200 && tail.length < 300, String(tail.length));
  for (const line of tail) assert.match(line, /^2026-01-02T03:04:05\.678Z \[log\] line \d{4} y{970}$/);
  assert.equal(tail[tail.length - 1], lines[999]);
});

test('masking: Bluetooth addresses, UUIDs, 32-digit hex and device names are hidden; mesh ids, @ND and location ids stay', () => {
  const text = [
    '[ManagerBLE] [BlePeripheral] [0a1b2c3d4e5f] Peripheral 0a1b2c3d4e5f: connected',
    'CONN begin via @ND1A2B (0A:1B:2C:3D:4E:5F) rssi=-70',
    'other node f0e1d2c3b4a5',
    '[Device:11111111-2222-3333-4444-555555555555] command id=0x1a2b level=30 loc=0x1234',
    'key 00112233445566778899aabbccddeeff in a line',
    'applying status to Kitchen Spot failed; Spot is fine; Spotlight is another word',
  ].join('\n');
  const out = maskLog(text, ['Spot', 'X', 'Kitchen Spot']); // shortest first on purpose
  assert.doesNotMatch(out, /0a1b2c3d4e5f|0A:1B|f0e1d2c3b4a5|11111111-2222|00112233445566778899aabbccddeeff/i);
  assert.match(out, /\[ble-1\] Peripheral ble-1: connected/);
  assert.match(out, /@ND1A2B \(ble-1\)/);
  assert.match(out, /other node ble-2/);
  assert.match(out, /\[Device:dev-1\] command id=0x1a2b level=30 loc=0x1234/);
  assert.match(out, /key \[hidden\] in a line/);
  assert.match(out, /applying status to device-1 failed; device-2 is fine; Spotlight is another word/);
});

function appWith(devices, lines) {
  const app = new SGSmartApp();
  app.homey = fake.fakeHomey(app, {
    drivers: { getDrivers: () => ({ sg_mesh: { getDevices: () => devices } }) },
    manifest: { version: '9.9.9' },
    version: '13.5.2',
  });
  app.homey.settings.set('debugLogging', false);
  app.bridge = { _keepConnected: () => true };
  app.fileLog = { tail: async (count) => lines.slice(-count) };
  return app;
}

test('masking: the data of FF05, FF50 and FF11 stays, whatever its length; the rest of the line is masked as before', () => {
  const text = [
    '[CSR] EXT src=0x0123 dst=0x8000 op=FF05 len=6 data=5a3c0132070a on=1 level=50 loc=0x5a3c',
    '[CSR] EXT src=0x0123 dst=0x8000 op=FF11 len=16 data=5a3c5343314132420001020304050607 name=@SC1A2B',
    '[CSR] EXT src=0x0123 dst=0x8000 op=FF50 len=6 data=5a3c01320700 on=1 via 0A:1B:2C:3D:4E:5F',
    '[Device:11111111-2222-3333-4444-555555555555] [CSR] EXT src=0x0123 dst=0x8000 op=FF05 len=6 data=5a3c0132070b key 00112233445566778899aabbccddeeff',
    '[CSR] EXT src=0x0123 dst=0x8000 op=FF07 len=6 data=5a3c0132070c',
    'other 5a3c0132070a',
    'Kitchen Spot: [CSR] EXT src=0x0123 dst=0x8000 op=FF05 len=6 data=5a3c0132070d',
  ].join('\n');
  const out = maskLog(text, ['Kitchen Spot']).split('\n');
  assert.match(out[0], /data=5a3c0132070a on=1/);
  assert.match(out[1], /data=5a3c5343314132420001020304050607 name=@SC1A2B/);
  assert.match(out[2], /data=5a3c01320700 on=1 via ble-1$/, 'an address after the data is still hidden');
  assert.match(out[3], /^\[Device:dev-1\] .* data=5a3c0132070b key \[hidden\]$/, 'a key and a UUID in the same line are still hidden');
  assert.match(out[4], /data=ble-\d/, 'another opcode is masked as before');
  assert.match(out[5], /^other ble-\d$/, 'the same hex outside such a line is masked as before');
  assert.match(out[6], /^device-1: .* data=5a3c0132070d$/);
});

test('the log view: a short summary, then the latest lines, masked', async () => {
  const devices = [
    { getName: () => 'Kitchen Spot', getMeshId: () => 0x1a2b },
    { getName: () => 'Hall', getMeshId: () => 0x3c4d },
    { getName: () => 'All lights' },
  ];
  const lines = [
    '2026-01-02T03:04:05.678Z [log] [SGSmartApp] SG LEDDim v9.9.9 initialized',
    '2026-01-02T04:05:06.789Z [log] [Device:11111111-2222-3333-4444-555555555555] status from Kitchen Spot via 0a1b2c3d4e5f loc=0x1234',
  ];
  const view = await appWith(devices, lines).logView();
  assert.equal(view.count, 2);
  assert.equal(view.from, '2026-01-02T03:04:05.678Z');
  assert.equal(view.to, '2026-01-02T04:05:06.789Z');
  const text = view.text.split('\n');
  assert.equal(text[0], 'SG LEDDim 9.9.9, Homey 13.5.2, keep connected: on, detailed logging: off');
  assert.equal(text[1], 'Dimmers: 2, later generations: 0, groups: 1');
  assert.equal(text[2], 'Log from 2026-01-02T03:04:05.678Z to 2026-01-02T04:05:06.789Z, 2 lines');
  assert.match(text[4], /\[Device:dev-1\] status from device-1 via ble-1 loc=0x1234$/);
});

test('the log view has at most 500 lines, and an empty log gives none', async () => {
  const lines = Array.from({ length: 800 }, (_, i) => `2026-01-02T03:04:05.678Z [log] line ${i}`);
  const view = await appWith([], lines).logView();
  assert.equal(view.count, 500);
  assert.match(view.text, /line 300\n/);
  assert.doesNotMatch(view.text, /line 299\n/);
  const empty = await appWith([], []).logView();
  assert.equal(empty.count, 0);
  assert.equal(empty.from, null);
});

test('GET /log-view returns the log view, and an error as { error }', async () => {
  const homey = { app: { logView: async () => ({ count: 1, text: 'x' }) } };
  assert.deepEqual(await api.getLogView({ homey }), { count: 1, text: 'x' });
  const failing = { app: { logView: async () => { throw new Error('no file'); } } };
  assert.deepEqual(await api.getLogView({ homey: failing }), { error: 'no file' });
});
