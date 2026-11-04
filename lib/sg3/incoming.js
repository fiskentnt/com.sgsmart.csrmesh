'use strict';

// Counts what comes in on an SG Smart 3.0 link, for the first tests with a
// real device: per destination address and per opcode, never the source,
// the parameters or a key. The counts show where a node's status goes:
// Homey's address, 0xFFFF or another one. The first time a destination and
// an opcode come together on a link, add() gives a line for the log; after
// FIRST_LINES of those it gives none, and the counts go on.

const { encodeAccessMessage } = require('../sigmesh/access');

const FIRST_LINES = 16;
const SHOWN = 6;

const hex4 = (address) => `0x${address.toString(16).padStart(4, '0')}`;

// What came in, as the log names it: the opcode as it is on air ("op
// f0e80e"), a control opcode ("control 0x00"), or "unreadable".
function labelOf({ kind, opcode }) {
  if (kind === 'access') return `op ${encodeAccessMessage({ opcode }).toString('hex')}`;
  if (kind === 'control') return opcode === null ? 'control segmented' : `control 0x${opcode.toString(16).padStart(2, '0')}`;
  return 'unreadable';
}

class IncomingCounts {
  constructor(ownAddress) {
    this.ownAddress = ownAddress;
    this.reset();
  }

  reset() {
    this.total = 0;
    this.byDst = new Map();
    this.byLabel = new Map();
    this.pairs = new Set();
  }

  address(dst) {
    return dst === this.ownAddress ? `${hex4(dst)} (Homey)` : hex4(dst);
  }

  // One message in. Gives the line for the log when this destination and
  // opcode are new on the link, else null.
  add(dst, what) {
    const label = labelOf(what);
    this.total += 1;
    this.byDst.set(dst, (this.byDst.get(dst) || 0) + 1);
    this.byLabel.set(label, (this.byLabel.get(label) || 0) + 1);
    const pair = `${dst}:${label}`;
    if (this.pairs.has(pair)) return null;
    this.pairs.add(pair);
    if (this.pairs.size > FIRST_LINES) return null;
    return `in: first ${label} to ${this.address(dst)}`;
  }

  // "in 17: to 0xffff 12, 0x7f9a (Homey) 3, 0x0001 2; op f0e80e 14, control
  // 0x00 3", the most first, at most SHOWN of each and how many more.
  summary() {
    if (this.total === 0) return 'in 0';
    const list = (map, name) => {
      const sorted = [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
      const shown = sorted.slice(0, SHOWN).map(([key, count]) => `${name(key)} ${count}`);
      if (sorted.length > SHOWN) shown.push(`${sorted.length - SHOWN} more`);
      return shown.join(', ');
    };
    return `in ${this.total}: to ${list(this.byDst, (dst) => this.address(dst))}; ${list(this.byLabel, (label) => label)}`;
  }
}

module.exports = {
  FIRST_LINES,
  IncomingCounts,
  labelOf,
};
