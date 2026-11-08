'use strict';

// SG Smart 3.0 commands over a MeshSession: set the level of a node, ask for
// its status, and hear the status nodes send by themselves.
//
// Bytes 1 and 2 of every command are a TID and a SEQ of the commands (not
// the mesh SEQ), counted by CommandIds. A node drops a command that repeats
// the TID and SEQ it just handled.
//
// Events: 'status' { node, on, level, kind }, kind 0x09 for a reply and 0x03
// for a status the node sent after a local change (wheel, wall switch).

const crypto = require('crypto');
const { EventEmitter } = require('events');

const sg = require('./protocol');

// After this long without a command, the next one gets a new TID.
const NEW_TID_AFTER_MS = 2000;

// The TID and SEQ in bytes 1 and 2: a new TID from 1 to 255, drawn at random,
// when more than NEW_TID_AFTER_MS have passed since the last command (also
// the first after a start), with SEQ 0; else the same TID and SEQ one
// higher. A new TID is never the last one, so a node does not take the first
// command after a pause for a repeat. randomInt(n) gives 0 to n - 1.
class CommandIds {
  constructor({ randomInt = crypto.randomInt, now = Date.now } = {}) {
    this.randomInt = randomInt;
    this.now = now;
    this.tid = null;
    this.seq = 0;
    this.at = null;
  }

  next() {
    const now = this.now();
    if (this.tid === null || now - this.at > NEW_TID_AFTER_MS) {
      if (this.tid === null) {
        this.tid = 1 + this.randomInt(255);
      } else {
        const tid = 1 + this.randomInt(254);
        this.tid = tid >= this.tid ? tid + 1 : tid;
      }
      this.seq = 0;
    } else {
      this.seq = (this.seq + 1) & 0xff;
    }
    this.at = now;
    return { tid: this.tid, seq: this.seq };
  }
}

class SgClient extends EventEmitter {
  // ids: the CommandIds to count with; the controller keeps one for all its
  // links, so a new link goes on with the same counters.
  constructor(session, { ids = new CommandIds() } = {}) {
    super();
    this.session = session;
    this.ids = ids;
    // The TIDs of the status questions whose answer goes to the asker alone
    // (getStatus with quiet), by node.
    this.quiet = new Map();
    this.onMessage = (message) => {
      if (message.opcode !== sg.OP_SG_STATUS) return;
      const status = sg.parseSgStatus(message.parameters);
      if (!status) return;
      const asked = this.quiet.get(message.src);
      if (asked && message.parameters[0] === sg.KIND_STATUS_RESPONSE && asked.has(message.parameters[2])) return;
      this.emit('status', { node: message.src, ...status });
    };
    session.on('message', this.onMessage);
  }

  // Level 0 is off, 1-100 percent, sg.LEVEL_LAST on at the previous level.
  // The node is in the payload; the message goes to dst, the node itself
  // unless the caller says otherwise (0xFFFF). Resolves with { acked,
  // segments }: whether the node acknowledged every segment (undefined when
  // nothing was to be acknowledged), and how many there were; and with what
  // the session says of the writing (ackMissing, writes, writeMs, queuedMs).
  async setLevel(node, level, { dst = node } = {}) {
    const ids = this.ids.next();
    const { seqAuth, ...result } = await this.session.sendAccess(dst, sg.sgPowerLevelSet(node, level, ids));
    return result;
  }

  // Resolves with { on, level } from the node's 0x09 reply, matched on the
  // node and the TID it echoes in byte 2. With quiet, the reply goes to the
  // asker alone, not out as 'status'.
  async getStatus(node, { timeoutMs = 3000, dst = node, quiet = false } = {}) {
    const ids = this.ids.next();
    if (quiet) {
      if (!this.quiet.has(node)) this.quiet.set(node, new Set());
      this.quiet.get(node).add(ids.tid);
    }
    const reply = this.session.waitFor((message) => (
      message.src === node
      && message.opcode === sg.OP_SG_STATUS
      && message.parameters[0] === sg.KIND_STATUS_RESPONSE
      && message.parameters[2] === ids.tid
    ), timeoutMs);
    reply.catch(() => {}).finally(() => {
      const asked = this.quiet.get(node);
      if (!asked) return;
      asked.delete(ids.tid);
      if (asked.size === 0) this.quiet.delete(node);
    });
    try {
      await this.session.sendAccess(dst, sg.sgStatusGet(node, ids));
    } catch (err) {
      reply.catch(() => {});
      throw err;
    }
    const message = await reply;
    const status = sg.parseSgStatus(message.parameters);
    if (!status) throw new Error(`status from 0x${node.toString(16)} did not parse`);
    return { on: status.on, level: status.level };
  }

  close() {
    this.session.off('message', this.onMessage);
  }
}

module.exports = {
  CommandIds,
  NEW_TID_AFTER_MS,
  SgClient,
};
