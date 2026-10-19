'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BLOCK_SIZE, SeqStore } = require('../../lib/sigmesh/seq-store');

// Like Homey's settings: get and set, values stored as JSON.
function memoryStorage(initial) {
  const map = new Map(initial ? [['sigmeshSeq', initial]] : []);
  const writes = [];
  return {
    writes,
    get: (key) => (map.has(key) ? JSON.parse(JSON.stringify(map.get(key))) : undefined),
    set: (key, value) => {
      writes.push(value);
      map.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
}

test('the first number is 0, and the ceiling is stored before it is handed out', () => {
  const storage = memoryStorage();
  const store = new SeqStore(storage);
  assert.equal(store.allocate(0), 0);
  assert.deepEqual(storage.writes, [{ ivIndex: 0, reservedUpTo: BLOCK_SIZE }]);
  assert.equal(store.allocate(0), 1);
  assert.equal(storage.writes.length, 1);
});

test('a new ceiling is stored when the block runs out', () => {
  const storage = memoryStorage();
  const store = new SeqStore(storage);
  for (let i = 0; i < BLOCK_SIZE; i += 1) store.allocate(0);
  assert.equal(storage.writes.length, 1);
  assert.equal(store.allocate(0), BLOCK_SIZE);
  assert.deepEqual(storage.writes[1], { ivIndex: 0, reservedUpTo: 2 * BLOCK_SIZE });
});

test('after a restart, counting resumes at the stored ceiling, above anything used', () => {
  const storage = memoryStorage();
  const first = new SeqStore(storage);
  let last;
  for (let i = 0; i < 1500; i += 1) last = first.allocate(0);
  const second = new SeqStore(storage);
  const next = second.allocate(0);
  assert.ok(next > last);
  assert.equal(next, 2 * BLOCK_SIZE);
});

test('a higher IV Index starts again at 0, and is stored', () => {
  const storage = memoryStorage({ ivIndex: 4, reservedUpTo: 5000 });
  const store = new SeqStore(storage);
  assert.equal(store.allocate(4), 5000);
  assert.equal(store.allocate(5), 0);
  assert.deepEqual(storage.writes[storage.writes.length - 1], { ivIndex: 5, reservedUpTo: BLOCK_SIZE });
  assert.throws(() => store.allocate(4), /below the stored/);
});

test('an unreadable stored state stops instead of starting at 0', () => {
  assert.throws(() => new SeqStore(memoryStorage({ ivIndex: -1, reservedUpTo: 10 })), /unreadable/);
  assert.throws(() => new SeqStore(memoryStorage('1000')), /unreadable/);
});

test('the 24-bit space runs out with an error, not a wrap', () => {
  const store = new SeqStore(memoryStorage({ ivIndex: 0, reservedUpTo: 0xffffff }));
  assert.equal(store.allocate(0), 0xffffff);
  assert.throws(() => store.allocate(0), /used up/);
});

test('if storing the ceiling fails, no number past the old ceiling is handed out', () => {
  const storage = memoryStorage();
  let fail = true;
  const failing = { get: storage.get, set: (key, value) => { if (fail) throw new Error('disk full'); storage.set(key, value); } };
  const store = new SeqStore(failing);
  assert.throws(() => store.allocate(0), /disk full/);
  fail = false;
  assert.equal(store.allocate(0), 0);
  assert.deepEqual(storage.writes, [{ ivIndex: 0, reservedUpTo: BLOCK_SIZE }]);
});
