'use strict';

// A simulated SG Smart 3.0 dimmer that is also the proxy node we are
// connected to. It behaves as HA's notes and the specification describe the
// real one:
//
// - sends a Secure Network Beacon when the link comes up;
// - forwards nothing to the client until the filter is set, and drops filter
//   messages that are not sealed with the proxy nonce;
// - drops a network PDU whose SEQ is not above the last one from the same
//   source and IV Index (strict replay protection);
// - acknowledges our segments, acts on SG level (0x07) and status (0x09)
//   commands, and drops a command that repeats the TID it just handled;
// - answers a status request with a segmented 0x09 reply to the asker;
// - publishes a 0x03 status to its group after a local change;
// - answers Generic OnOff Get (0x8201) with Generic OnOff Status (0x8204).
//
// A node created with `via: proxyNode` sits behind that proxy: it hears what
// the client sends through it, and what it sends goes out through the
// proxy's filter.
//
// Built from the same lib/sigmesh codec as the session. The codec itself is
// pinned by the specification samples and the HA cross-check; this tests the
// session's behaviour.

const { buildSecureNetworkBeacon } = require('../../lib/sigmesh/beacon');
const { encodeAccessMessage } = require('../../lib/sigmesh/access');
const { acceptAccessPdu, encodeMeshMessage } = require('../../lib/sigmesh/message');
const { decodeNetworkPdu, encodeNetworkPdu } = require('../../lib/sigmesh/network');
const proxy = require('../../lib/sigmesh/proxy');
const t = require('../../lib/sigmesh/transport');
const sg = require('../../lib/sg3/protocol');

class SimulatedSgNode {
  constructor({
    netKey, appKey, address = 0x0003, ivIndex = 0, ivUpdate = false, level = 30, on = false,
    statusGroup = 0xcee8, beacon = true, ackSegments = true, ttl = 7, via = null,
  }) {
    Object.assign(this, { netKey, appKey, address, ivIndex, ivUpdate, level, on, statusGroup, beacon, ackSegments, ttl, via });
    this.peers = [];
    if (via) via.peers.push(this);
    this.seq = 0x10;
    this.filter = null;
    this.lastRx = new Map();
    this.reassembly = new Map();
    this.sar = undefined;
    this.lastTid = null;
    this.events = [];
    this.frames = [];
    this.acksFromClient = [];
  }

  get txIvIndex() {
    return this.ivUpdate ? this.ivIndex - 1 : this.ivIndex;
  }

  // `notify` delivers one 2ADE notification to the client.
  connect(notify) {
    this.notify = (frame) => setImmediate(() => notify(frame));
    if (this.beacon) this.sendBeacon();
  }

  sendBeacon() {
    this.send(proxy.TYPE_MESH_BEACON, buildSecureNetworkBeacon(this.netKey, { ivIndex: this.ivIndex, ivUpdate: this.ivUpdate }));
  }

  send(type, message) {
    for (const frame of proxy.encodeProxyPdus(type, message)) this.notify(frame);
  }

  // What the node sends into the mesh reaches the client only through the filter.
  forward(dst, pdu) {
    if (this.via) {
      this.via.forward(dst, pdu);
      return;
    }
    if (!this.filter || !this.filter.has(dst)) {
      this.events.push(`filtered 0x${dst.toString(16)}`);
      return;
    }
    this.send(proxy.TYPE_NETWORK_PDU, pdu);
  }

  // The client's write to 2ADD.
  async write(frame) {
    this.frames.push(Buffer.from(frame));
    const result = proxy.acceptProxyPdu(this.sar, frame, Date.now());
    this.sar = result.state;
    if (result.kind !== 'complete') return;
    if (result.messageType === proxy.TYPE_PROXY_CONFIG) this.onProxyConfig(result.message);
    else if (result.messageType === proxy.TYPE_NETWORK_PDU) {
      this.onNetworkPdu(result.message);
      this.relay(result.message);
    }
  }

  onProxyConfig(pdu) {
    const message = proxy.decodeProxyConfigPdu({ networkKey: this.netKey, ivIndex: this.ivIndex, pdu });
    if (!message) {
      this.events.push('filter message dropped');
      return;
    }
    if (message[0] === 0x00 && message[1] === proxy.FILTER_ACCEPT_LIST) this.filter = new Set();
    if (message[0] === 0x01 && this.filter) {
      for (let i = 1; i + 1 < message.length; i += 2) this.filter.add(message.readUInt16BE(i));
    }
    const status = Buffer.from([0x03, proxy.FILTER_ACCEPT_LIST, 0x00, 0x00]);
    status.writeUInt16BE(this.filter ? this.filter.size : 0, 2);
    this.send(proxy.TYPE_PROXY_CONFIG, proxy.encodeProxyConfigPdu({
      networkKey: this.netKey, ivIndex: this.txIvIndex, seq: this.seq++, src: this.address, message: status,
    }));
  }

  onNetworkPdu(pdu) {
    const net = decodeNetworkPdu({ networkKey: this.netKey, ivIndex: this.ivIndex, pdu });
    if (!net) {
      this.events.push('network PDU not for this network');
      return;
    }
    const last = this.lastRx.get(net.src);
    if (last && (net.ivIndex < last.ivIndex || (net.ivIndex === last.ivIndex && net.seq <= last.seq))) {
      this.events.push(`replay from 0x${net.src.toString(16)}, SEQ ${net.seq}`);
      return;
    }
    this.lastRx.set(net.src, { ivIndex: net.ivIndex, seq: net.seq });

    if (net.ctl) {
      const control = t.decodeUnsegmentedControl(net.transportPdu);
      if (control && control.opcode === t.SEGMENT_ACK_OPCODE) {
        this.acksFromClient.push({ ...t.decodeSegmentAck(control.parameters), ttl: net.ttl });
      }
      return;
    }
    if (net.dst !== this.address && net.dst !== 0xffff) return;
    const result = acceptAccessPdu(this.reassembly.get(net.src), net, { appKey: this.appKey });
    this.reassembly.set(net.src, result.state);
    // ackSegments 'partial' acknowledges only what it has after the first
    // segment; 'busy' answers with BlockAck 0, "cannot take it now".
    const ackNow = this.ackSegments === 'partial' ? result.kind === 'incomplete' : result.kind !== 'incomplete';
    if (result.ack && ackNow && this.ackSegments && net.dst === this.address) {
      this.sendAck(net.src, this.ackSegments === 'busy' ? { ...result.ack, blockAck: 0 } : result.ack);
    }
    if (result.kind === 'complete') this.onCommand(net.src, result.message);
  }

  // What reaches the proxy from the client also reaches the nodes behind it.
  relay(pdu) {
    for (const peer of this.peers) peer.onNetworkPdu(pdu);
  }

  sendAck(dst, ack) {
    this.forward(dst, encodeNetworkPdu({
      networkKey: this.netKey, ivIndex: this.txIvIndex, ctl: true, ttl: this.ttl, seq: this.seq++, src: this.address, dst,
      transportPdu: t.encodeUnsegmentedControl({ opcode: t.SEGMENT_ACK_OPCODE, parameters: t.encodeSegmentAck(ack) }),
    }));
  }

  onCommand(src, message) {
    if (message.opcode === 0x8201) {
      this.events.push('generic onoff get');
      this.publish(src, Buffer.from([this.on ? 1 : 0]), 0x8204);
      return;
    }
    if (message.opcode !== sg.OP_SG_COMMAND) return;
    const p = message.parameters;
    const [kind, tid, seq] = p;
    const node = p.readUInt16BE(3);
    if (node !== this.address && node !== 0xffff) return;
    if (tid === this.lastTid) {
      this.events.push(`TID ${tid} repeated, dropped`);
      return;
    }
    this.lastTid = tid;
    if (kind === 0x07) {
      const level = p[5];
      if (level === sg.LEVEL_OFF) this.on = false;
      else if (level === sg.LEVEL_LAST) this.on = true;
      else {
        this.on = true;
        this.level = level;
      }
      this.events.push(`level ${level}`);
    } else if (kind === 0x09) {
      this.publish(src, Buffer.from([0x09, 0x01, tid, seq, src >>> 8, src & 0xff, this.on ? 1 : 0, this.level, 0x19, 0x00]));
    }
  }

  // A wheel or the wall switch changed the light.
  localChange({ on, level }) {
    this.on = on;
    this.level = level;
    this.publish(this.statusGroup, Buffer.from([0x03, 0xa6, 0x84, 0xff, 0xff, on ? 1 : 0, level, 0x19]));
  }

  publish(dst, parameters, opcode = sg.OP_SG_STATUS) {
    const pdus = encodeMeshMessage({
      accessPayload: encodeAccessMessage({ opcode, parameters }),
      key: this.appKey, keyKind: 'application', src: this.address, dst,
      netKey: this.netKey, ivIndex: this.txIvIndex, ttl: this.ttl, allocateSeq: () => this.seq++,
    });
    for (const pdu of pdus) this.forward(dst, pdu);
  }
}

module.exports = {
  SimulatedSgNode,
};
