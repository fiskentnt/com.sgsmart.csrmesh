'use strict';

// SG Smart 3.0 commands over a MeshSession: set the level of a node, ask for
// its status, and hear the status nodes send by themselves.
//
// Every command carries a TID, and a node drops a repeat of the TID it just
// handled. The TID counts 1 to 255 and starts at a random value, so a restart
// of the app is unlikely to begin with the TID a node handled last. The SEQ
// byte in the payload is given the same value, as HA found to work.
//
// Events: 'status' { node, on, level, kind }, kind 0x09 for a reply and 0x03
// for a status the node sent after a local change (wheel, wall switch).

const crypto = require('crypto');
const { EventEmitter } = require('events');

const sg = require('./protocol');

class SgClient extends EventEmitter {
  constructor(session, { tid = crypto.randomInt(1, 256) } = {}) {
    super();
    this.session = session;
    this.tid = tid;
    this.onMessage = (message) => {
      if (message.opcode !== sg.OP_SG_STATUS) return;
      const status = sg.parseSgStatus(message.parameters);
      if (status) this.emit('status', { node: message.src, ...status });
    };
    session.on('message', this.onMessage);
  }

  nextTid() {
    this.tid = (this.tid % 255) + 1;
    return this.tid;
  }

  // Level 0 is off, 1-100 percent, sg.LEVEL_LAST on at the previous level.
  // Resolves with { acked }: whether the node acknowledged both segments.
  async setLevel(node, level) {
    const tid = this.nextTid();
    const { acked } = await this.session.sendAccess(node, sg.sgPowerLevelSet(node, level, { tid, seq: tid }));
    return { acked };
  }

  // Resolves with { on, level } from the node's 0x09 reply, matched on the
  // node and the TID it echoes.
  async getStatus(node, { timeoutMs = 3000 } = {}) {
    const tid = this.nextTid();
    const reply = this.session.waitFor((message) => (
      message.src === node
      && message.opcode === sg.OP_SG_STATUS
      && message.parameters[0] === sg.KIND_STATUS_RESPONSE
      && message.parameters[2] === tid
    ), timeoutMs);
    try {
      await this.session.sendAccess(node, sg.sgStatusGet(node, { tid, seq: tid }));
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
  SgClient,
};
