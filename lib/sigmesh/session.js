'use strict';

// One Bluetooth Mesh session over one GATT proxy link, with no Homey in it.
// The caller writes Proxy PDUs to Mesh Proxy Data In (2ADD) through `write`,
// and hands every notification from Data Out (2ADE) to receive(). The
// session:
//
// - keeps writes in order, so the Proxy PDUs of one message go out together;
// - learns the IV Index from the proxy's Secure Network Beacon;
// - sets the proxy filter on a new link (an empty accept list forwards
//   nothing to us);
// - decodes network PDUs, drops repeats and our own messages, reassembles
//   segments and acknowledges the ones addressed to us;
// - emits 'message' for every access message, and lets a caller wait for one.
//
// Segments we send are not sent again when the node's ack is missing: the
// result only says whether it came. Repeated sends upset the radio with the
// first generation of dimmers, and whether SG Smart 3.0 needs them is for the
// hardware test to show.
//
// Events: 'message' { src, dst, opcode, parameters, keyKind, seqAuth },
// 'beacon' { ivIndex, ivUpdate, changed }, 'filter' { filterType, listSize, proxy },
// 'disconnect' (reason): the proxy protocol broke and the link should be
// dropped, 'ignored' { src, reason }: a message that could not be read (it
// comes often enough to be counted rather than logged), 'log' (text). Keys
// never appear in any of them.

const { EventEmitter } = require('events');

const { parseSecureNetworkBeacon } = require('./beacon');
const { acceptAccessPdu, encodeMeshMessage } = require('./message');
const { decodeNetworkPdu, encodeNetworkPdu } = require('./network');
const proxy = require('./proxy');
const {
  SEGMENT_ACK_OPCODE, decodeSegmentAck, decodeUnsegmentedControl, encodeSegmentAck, encodeUnsegmentedControl,
} = require('./transport');

const DEFAULT_TTL = 7;
// How far a beacon may move the IV Index forward in one go (§3.10.5: IV Index
// recovery is limited to 42 steps).
const MAX_IV_STEP = 42;
const RECENT_SEQS = 64;
const MAX_SOURCES = 64;

function isUnicast(address) {
  return address >= 0x0001 && address <= 0x7fff;
}

class MeshSession extends EventEmitter {
  constructor({
    netKey, appKey, address, ivIndex = null, seqStore, write, deviceKeyFor = null,
    ttl = DEFAULT_TTL, maxProxyPdu = proxy.MAX_PROXY_PDU_LENGTH, timers = { setTimeout, clearTimeout }, now = Date.now,
  }) {
    super();
    if (!isUnicast(address)) throw new Error(`address must be a unicast address, got ${address}`);
    this.netKey = netKey;
    this.appKey = appKey;
    this.address = address;
    // null: not known yet (a network typed in by hand). Then the first
    // authenticated beacon is believed whatever its IV Index, and 0 is used
    // until it comes.
    this.ivKnown = ivIndex !== null;
    this.ivIndex = ivIndex === null ? 0 : ivIndex;
    this.ivUpdate = false;
    this.seqStore = seqStore;
    this.writeProxyPdu = write;
    this.deviceKeyFor = deviceKeyFor;
    this.ttl = ttl;
    this.maxProxyPdu = maxProxyPdu;
    this.timers = timers;
    this.now = now;

    this.closed = false;
    this.writes = Promise.resolve();
    this.sar = undefined;
    this.beaconSeen = false;
    this.recent = new Map(); // src -> recent "ivIndex:seq" keys
    this.reassembly = new Map(); // src -> acceptAccessPdu state
    this.ackTimers = new Map(); // src -> timer for a partial ack
    this.pendingTx = new Set(); // our segmented messages waiting for an ack
    this.waiters = new Set();
  }

  // While an IV Update is in progress, nodes still send with the old IV Index.
  get txIvIndex() {
    return this.ivUpdate && this.ivIndex > 0 ? this.ivIndex - 1 : this.ivIndex;
  }

  log(text) {
    this.emit('log', text);
  }

  // ------------------------------------------------------------ link setup

  // Run once a new link is up and 2ADE is subscribed. Waits for a beacon (or
  // goes on with the IV Index it has), then sets the filter to an accept list
  // of our address and `listen` (group addresses to hear), and waits for the
  // proxy to confirm it.
  async start({ listen = [], beaconTimeoutMs = 2000, filterTimeoutMs = 3000 } = {}) {
    if (!this.beaconSeen) {
      await this.waitForEvent('beacon', beaconTimeoutMs).catch(() => {
        this.log(`no beacon within ${beaconTimeoutMs} ms, using IV Index ${this.ivIndex}`);
      });
    }
    const addresses = [this.address, ...listen.filter((a) => a !== this.address)];
    const messages = [proxy.setFilterType(proxy.FILTER_ACCEPT_LIST)];
    for (let i = 0; i < addresses.length; i += 5) messages.push(proxy.addAddresses(addresses.slice(i, i + 5)));

    const confirmed = this.waitForEvent('filter', filterTimeoutMs, (status) => (
      status.filterType === proxy.FILTER_ACCEPT_LIST && status.listSize === addresses.length
    ));
    for (const message of messages) await this.sendProxyConfig(message);
    const filter = await confirmed.catch(() => {
      throw new Error(`proxy filter not confirmed within ${filterTimeoutMs} ms`);
    });
    return { ivIndex: this.ivIndex, ivUpdate: this.ivUpdate, beacon: this.beaconSeen, filter };
  }

  sendProxyConfig(message) {
    const seq = this.seqStore.allocate(this.txIvIndex);
    const pdu = proxy.encodeProxyConfigPdu({ networkKey: this.netKey, ivIndex: this.txIvIndex, seq, src: this.address, message });
    return this.enqueue(proxy.encodeProxyPdus(proxy.TYPE_PROXY_CONFIG, pdu, this.maxProxyPdu));
  }

  // ------------------------------------------------------------ sending

  enqueue(frames) {
    if (this.closed) return Promise.reject(new Error('session is closed'));
    const run = this.writes.then(async () => {
      for (const frame of frames) await this.writeProxyPdu(frame);
    });
    this.writes = run.catch(() => {});
    return run;
  }

  // Sends one access message. Returns { seqAuth, segments, acked }: `acked`
  // is true or false for a segmented message to a unicast address (the
  // destination acknowledges segments), and undefined otherwise.
  async sendAccess(dst, accessPayload, { keyKind = 'application', key = this.appKey, ackTimeoutMs = 2000 } = {}) {
    const ivIndex = this.txIvIndex;
    let seqAuth;
    const pdus = encodeMeshMessage({
      accessPayload, key, keyKind, src: this.address, dst, netKey: this.netKey, ivIndex, ttl: this.ttl,
      allocateSeq: () => {
        const seq = this.seqStore.allocate(ivIndex);
        if (seqAuth === undefined) seqAuth = seq;
        return seq;
      },
    });
    const frames = pdus.flatMap((pdu) => proxy.encodeProxyPdus(proxy.TYPE_NETWORK_PDU, pdu, this.maxProxyPdu));

    if (pdus.length === 1 || !isUnicast(dst)) {
      await this.enqueue(frames);
      return { seqAuth, segments: pdus.length, acked: undefined };
    }

    // Register before writing: the ack can come before the write resolves.
    const pending = { dst, seqZero: seqAuth & 0x1fff, full: 2 ** pdus.length - 1, blockAck: 0 };
    const acked = new Promise((resolve) => {
      pending.done = (value) => {
        pending.settled = true;
        this.timers.clearTimeout(pending.timer);
        this.pendingTx.delete(pending);
        resolve(value);
      };
    });
    this.pendingTx.add(pending);
    try {
      await this.enqueue(frames);
    } catch (err) {
      pending.done(false);
      throw err;
    }
    if (!pending.settled) pending.timer = this.timers.setTimeout(() => pending.done(false), ackTimeoutMs);
    return { seqAuth, segments: pdus.length, acked: await acked };
  }

  sendSegmentAck(dst, receivedTtl, { seqZero, blockAck }) {
    // A message that reached us with TTL 0 came from the proxy itself; an ack
    // with a routable TTL would leak into the mesh (as HA does it).
    const ttl = receivedTtl === 0 ? 0 : this.ttl;
    const ivIndex = this.txIvIndex;
    const fail = (err) => this.log(`segment ack to 0x${dst.toString(16)} not sent: ${err.message}`);
    try {
      const pdu = encodeNetworkPdu({
        networkKey: this.netKey, ivIndex, ctl: true, ttl, seq: this.seqStore.allocate(ivIndex), src: this.address, dst,
        transportPdu: encodeUnsegmentedControl({ opcode: SEGMENT_ACK_OPCODE, parameters: encodeSegmentAck({ seqZero, blockAck }) }),
      });
      this.enqueue(proxy.encodeProxyPdus(proxy.TYPE_NETWORK_PDU, pdu, this.maxProxyPdu)).catch(fail);
    } catch (err) {
      fail(err);
    }
  }

  // ------------------------------------------------------------ waiting

  // Resolves with the first message (from now on) that `predicate` accepts.
  waitFor(predicate, timeoutMs) {
    if (this.closed) return Promise.reject(new Error('session is closed'));
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timer = this.timers.setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  waitForEvent(name, timeoutMs, predicate = () => true) {
    return new Promise((resolve, reject) => {
      const onEvent = (value) => {
        if (!predicate(value)) return;
        this.timers.clearTimeout(timer);
        this.off(name, onEvent);
        resolve(value);
      };
      const timer = this.timers.setTimeout(() => {
        this.off(name, onEvent);
        reject(new Error(`no ${name} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.on(name, onEvent);
    });
  }

  // ------------------------------------------------------------ receiving

  // One notification from 2ADE. Never throws on what a node sends.
  receive(frame) {
    if (this.closed) return;
    try {
      this.handleFrame(frame);
    } catch (err) {
      this.log(`notification not handled: ${err.message}`);
    }
  }

  handleFrame(frame) {
    const result = proxy.acceptProxyPdu(this.sar, frame, this.now());
    this.sar = result.state;
    if (result.kind === 'disconnect') {
      this.emit('disconnect', result.reason);
      return;
    }
    if (result.kind !== 'complete') return;
    if (result.messageType === proxy.TYPE_MESH_BEACON) this.onBeacon(result.message);
    else if (result.messageType === proxy.TYPE_PROXY_CONFIG) this.onProxyConfig(result.message);
    else if (result.messageType === proxy.TYPE_NETWORK_PDU) this.onNetworkPdu(result.message);
  }

  onBeacon(payload) {
    const beacon = parseSecureNetworkBeacon(payload, this.netKey);
    if (beacon === null) return;
    if (this.ivKnown && (beacon.ivIndex < this.ivIndex || beacon.ivIndex > this.ivIndex + MAX_IV_STEP)) {
      this.log(`beacon with IV Index ${beacon.ivIndex} ignored, ours is ${this.ivIndex}`);
      return;
    }
    const changed = beacon.ivIndex !== this.ivIndex || beacon.ivUpdate !== this.ivUpdate;
    this.ivIndex = beacon.ivIndex;
    this.ivUpdate = beacon.ivUpdate;
    this.ivKnown = true;
    this.beaconSeen = true;
    this.emit('beacon', { ivIndex: beacon.ivIndex, ivUpdate: beacon.ivUpdate, changed });
  }

  // The Filter Status comes from the proxy node's own address: that tells us
  // which node we are connected through.
  onProxyConfig(pdu) {
    const net = decodeNetworkPdu({ networkKey: this.netKey, ivIndex: this.ivIndex, pdu, proxy: true });
    if (net === null || !net.ctl) return;
    const status = proxy.parseFilterStatus(net.transportPdu);
    if (status) this.emit('filter', { ...status, proxy: net.src });
  }

  // Remembers the last SEQs per source and says whether this one was seen.
  // Deliberately not the spec's strict replay list: a node whose SEQ went
  // backwards (a lost counter) would make us deaf to it for good, while a
  // replayed status can at worst show an old value for a moment. HA chose
  // the same.
  isRepeat(net) {
    const key = `${net.ivIndex}:${net.seq}`;
    let seen = this.recent.get(net.src);
    if (!seen) {
      if (this.recent.size >= MAX_SOURCES) this.recent.delete(this.recent.keys().next().value);
      seen = [];
      this.recent.set(net.src, seen);
    }
    if (seen.includes(key)) return true;
    seen.push(key);
    if (seen.length > RECENT_SEQS) seen.shift();
    return false;
  }

  onNetworkPdu(pdu) {
    const net = decodeNetworkPdu({ networkKey: this.netKey, ivIndex: this.ivIndex, pdu });
    if (net === null || net.src === this.address || this.isRepeat(net)) return;
    if (net.ctl) this.onControl(net);
    else this.onAccess(net);
  }

  onControl(net) {
    const control = decodeUnsegmentedControl(net.transportPdu);
    if (!control || control.opcode !== SEGMENT_ACK_OPCODE || net.dst !== this.address) return;
    const ack = decodeSegmentAck(control.parameters);
    if (!ack) return;
    for (const pending of this.pendingTx) {
      if (pending.dst !== net.src || pending.seqZero !== ack.seqZero) continue;
      pending.blockAck |= ack.blockAck;
      // BlockAck 0 means the node cannot take the message (§3.5.3.3).
      if (ack.blockAck === 0) pending.done(false);
      else if ((pending.blockAck & pending.full) === pending.full) pending.done(true);
    }
  }

  onAccess(net) {
    const state = this.reassembly.get(net.src);
    const result = acceptAccessPdu(state, net, { appKey: this.appKey, deviceKeyFor: this.deviceKeyFor });
    if (result.state === undefined) {
      this.reassembly.delete(net.src);
    } else {
      if (!this.reassembly.has(net.src) && this.reassembly.size >= MAX_SOURCES) {
        this.reassembly.delete(this.reassembly.keys().next().value);
      }
      this.reassembly.set(net.src, result.state);
    }

    if (result.ack && net.dst === this.address) this.scheduleAck(net, result);
    if (result.kind === 'ignored') this.emit('ignored', { src: net.src, reason: result.reason });
    if (result.kind !== 'complete') return;

    const message = {
      src: net.src, dst: net.dst, opcode: result.message.opcode, parameters: result.message.parameters,
      keyKind: result.keyKind, seqAuth: result.seqAuth,
    };
    this.emit('message', message);
    for (const waiter of this.waiters) {
      if (!waiter.predicate(message)) continue;
      this.timers.clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(message);
    }
  }

  // A finished message is acknowledged at once. A partial one after the
  // spec's ack timer (150 ms + 50 ms per TTL), so the ack covers the segments
  // that follow close behind.
  scheduleAck(net, result) {
    this.timers.clearTimeout(this.ackTimers.get(net.src));
    this.ackTimers.delete(net.src);
    if (result.kind !== 'incomplete') {
      this.sendSegmentAck(net.src, net.ttl, result.ack);
      return;
    }
    this.ackTimers.set(net.src, this.timers.setTimeout(() => {
      this.ackTimers.delete(net.src);
      this.sendSegmentAck(net.src, net.ttl, result.ack);
    }, 150 + 50 * net.ttl));
  }

  // ------------------------------------------------------------ closing

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.ackTimers.values()) this.timers.clearTimeout(timer);
    this.ackTimers.clear();
    for (const pending of this.pendingTx) pending.done(false);
    for (const waiter of this.waiters) {
      this.timers.clearTimeout(waiter.timer);
      waiter.reject(new Error(`session ${reason}`));
    }
    this.waiters.clear();
  }
}

module.exports = {
  DEFAULT_TTL,
  MeshSession,
};
