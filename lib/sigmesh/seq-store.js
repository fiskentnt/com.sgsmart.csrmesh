'use strict';

// Our own sequence numbers (SEQ, 24 bits). A SEQ must never be used twice
// with the same IV Index: a node drops, without a word, every message whose
// SEQ is not above the last one it saw from our address. So numbers are
// handed out from a block reserved in storage ahead of time, and the new,
// higher ceiling is stored BEFORE the first number past the old one is used.
// After a restart or a crash, counting resumes at the stored ceiling, which
// no earlier run can have reached.
//
// Translated from shejnowicz/homey-ble-mesh, commit 2aff983,
// lib/adapter/store.ts, allocateSequenceBlock (MIT, see LICENSE-MIT). Here
// the IV Index is stored with it: a higher IV Index starts SEQ again at 0.

const BLOCK_SIZE = 1000;
const MAX_SEQ = 0xffffff;
const MAX_IV_INDEX = 0xffffffff;

function isCount(value, max) {
  return Number.isInteger(value) && value >= 0 && value <= max;
}

class SeqStore {
  // `storage` has get(key) and set(key, value), like Homey's ManagerSettings.
  constructor(storage, key = 'sigmeshSeq') {
    this.storage = storage;
    this.key = key;
    const saved = storage.get(key);
    if (saved === null || saved === undefined) {
      this.ivIndex = 0;
      this.reservedUpTo = 0;
    } else if (saved && isCount(saved.ivIndex, MAX_IV_INDEX) && isCount(saved.reservedUpTo, MAX_SEQ + 1)) {
      this.ivIndex = saved.ivIndex;
      this.reservedUpTo = saved.reservedUpTo;
    } else {
      // Starting again at 0 would make every node ignore us. Better to stop.
      throw new Error(`stored SEQ state under "${key}" is unreadable`);
    }
    this.next = this.reservedUpTo;
  }

  // The next SEQ to send with `ivIndex`, our transmit IV Index.
  allocate(ivIndex) {
    if (!isCount(ivIndex, MAX_IV_INDEX)) throw new Error(`ivIndex must be a 32-bit count, got ${ivIndex}`);
    if (ivIndex < this.ivIndex) throw new Error(`IV Index ${ivIndex} is below the stored ${this.ivIndex}`);
    if (ivIndex > this.ivIndex) {
      this.ivIndex = ivIndex;
      this.next = 0;
      this.reservedUpTo = 0;
    }
    if (this.next >= this.reservedUpTo) {
      if (this.next > MAX_SEQ) throw new Error(`SEQ space used up for IV Index ${this.ivIndex}`);
      const ceiling = Math.min(this.reservedUpTo + BLOCK_SIZE, MAX_SEQ + 1);
      this.storage.set(this.key, { ivIndex: this.ivIndex, reservedUpTo: ceiling });
      this.reservedUpTo = ceiling;
    }
    const seq = this.next;
    this.next += 1;
    return seq;
  }
}

module.exports = {
  BLOCK_SIZE,
  SeqStore,
};
