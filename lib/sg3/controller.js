'use strict';

// SG Smart 3.0 in the app: the network from the SG account, our address, the
// link, the commands and the status. app.js creates this only when the
// account has a 3.0 network (lib/account.js, sg3Network), so without one
// none of lib/sg3 is loaded and the first generation runs as before.
//
// The keys stay with the account; nothing here stores them. App settings it
// keeps, per Network ID, also after "Forget SG account", so a new login to
// the same network goes on where it left off:
//   sg3Addr:<Network ID>  our unicast address on the network (chooseAddress)
//   sg3Seq:<Network ID>   our SEQ (seq-store.js)
//   sg3Iv:<Network ID>    the last IV Index heard
// and sg3KeepAlive, seconds to hold an idle link (0, the default, holds it).
//
// The proxy filter in this build is an empty reject list: the proxy forwards
// every message, and the log counts where they go (incoming.js). Once a real
// device has shown where its status goes, the filter is to be an accept list
// of those addresses.
//
// A command goes to the node itself, segmented, and the node acknowledges
// the segments (sendTo 'node'); the reserve is the all-nodes address 0xFFFF
// with the node in the payload (sendTo 'all'), with nothing acknowledged.
// One send per change: nothing is sent again when an ack is missing. For
// STATUS_BLOCK_MS after a command to a node, a status from it is not passed
// on, so a light still on its way does not set the old value back. When a
// link comes up, each 3.0 device in Homey is asked for its status once.
//
// Events: 'status' { node, on, level, kind }, 'connection' (connected: boolean).
//
// The log is read from diagnostics reports, which keep only the last 100
// stdout lines: one short line per event (app.js puts [SG3] in front), a
// summary every 10 minutes, and never keys, names or a whole peripheral id.

const crypto = require('crypto');
const { EventEmitter } = require('events');

const { MeshSession } = require('../sigmesh/session');
const { SeqStore } = require('../sigmesh/seq-store');
const { Sg3Bridge } = require('./bridge');
const { CommandIds, SgClient } = require('./client');
const { IncomingCounts } = require('./incoming');
const imp = require('./network-import');

const RECONNECT_DELAYS_MS = [15000, 60000, 300000];
const STATUS_BLOCK_MS = 4000;
const ALL_NODES = 0xffff;
const SEND_TO = ['node', 'all'];
const SUMMARY_MS = 10 * 60 * 1000;
// Where Homey draws its own address from: above the node addresses, assumed
// to be 0x0001 to 0x7F7F (not seen on a real device yet), and below 0x7FFF,
// which HA sends from.
const HOMEY_FIRST = 0x7f80;
const HOMEY_LAST = 0x7ffe;

const hex = (address) => `0x${address.toString(16).padStart(4, '0')}`;
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

class Sg3Controller extends EventEmitter {
  // network: { netKey, appKey, addresses } from the account (the keys as 32
  // hex digits, addresses the node addresses of the home, to keep clear of).
  // deviceAddresses() gives the addresses of the 3.0 devices in Homey.
  // randomInt(n) gives 0 to n - 1: for our address and the TIDs.
  constructor({
    homey, network, deviceAddresses = () => [], log = () => {}, summaryMs = SUMMARY_MS, randomInt = crypto.randomInt,
    sendTo = 'node', now = Date.now,
  }) {
    super();
    if (!SEND_TO.includes(sendTo)) throw new Error(`sendTo must be ${SEND_TO.join(' or ')}, got ${sendTo}`);
    this.homey = homey;
    this.sendTo = sendTo;
    this.now = now;
    this.ids = new CommandIds({ randomInt, now });
    this.commandAt = new Map(); // node -> when the last command to it was sent
    this.deviceAddresses = deviceAddresses;
    this.summaryMs = summaryMs;
    this.summaryTimer = null;
    this.logLine = log;
    this.randomInt = randomInt;
    // Since this app start, for the summary line.
    this.counts = { commands: 0, acked: 0, statuses: 0, otherStatuses: 0, blocked: 0, drops: 0, links: 0, unreadable: 0 };
    const version = homey.manifest ? homey.manifest.version : '?';
    this.log(`v${version}, node ${process.version}, aes-128-ccm ${crypto.getCiphers().includes('aes-128-ccm') ? 'yes' : 'no'}`);
    this.network = null;
    this.bridge = null;
    this.client = null;
    this.incoming = null;
    this.connectedVia = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.idleTimer = null;
    this.stopped = false;
    this.use(network);
  }

  log(text) {
    this.logLine(text);
  }

  get configured() {
    return this.network !== null;
  }

  get settings() {
    return this.homey.settings;
  }

  // ------------------------------------------------------------ network

  // Takes the network from the account's keys, through the same import as
  // an export. Keys that do not import leave 3.0 unconfigured, with the
  // import's code in the log.
  use({ netKey, appKey, addresses = [] } = {}) {
    this.network = null;
    this.bridge = null;
    let network;
    try {
      network = imp.parseNetworkExport(imp.buildExportFromKeys({ netKey, appKey }));
    } catch (err) {
      if (!(err instanceof imp.ImportError)) throw err;
      this.log(`the account's 3.0 keys do not import (${err.code}): no 3.0 network`);
      return;
    }
    network.reservedAddresses.push(...addresses.filter(Number.isInteger));
    this.networkId = imp.networkId(network);
    try {
      this.seqStore = new SeqStore(this.settings, `sg3Seq:${this.networkId}`);
    } catch (err) {
      this.log(`${err.message}: no 3.0 network`);
      return;
    }
    this.network = network;
    this.appKey = network.appKeys[0].key;
    this.address = this.chooseAddress();
    const iv = this.storedIvIndex();
    this.log(`network ${this.networkId}: ${addresses.length} node address(es) in the account, `
      + `sending from ${hex(this.address)}, IV Index ${iv === null ? 'unknown (from the beacon)' : iv}, `
      + `commands to ${this.sendTo === 'node' ? 'the node' : '0xffff'}`);
    this.startSummary();
  }

  // Our address on the network: the one kept for it, while no node of the
  // account has it; else one drawn from HOMEY_FIRST to HOMEY_LAST that no
  // node has, and kept. Drawn, not fixed: a Homey without our address kept
  // has no SEQ for the network either, and may have sent before from an
  // address it no longer knows, so a fixed address could start again at a
  // SEQ the nodes take for a replay.
  chooseAddress() {
    const key = `sg3Addr:${this.networkId}`;
    const taken = new Set(this.network.reservedAddresses);
    const kept = this.settings.get(key);
    if (Number.isInteger(kept) && kept >= HOMEY_FIRST && kept <= HOMEY_LAST && !taken.has(kept)) return kept;
    if (Number.isInteger(kept)) this.log(`address ${hex(kept)} is taken now or out of range; drawing one`);
    const free = [];
    for (let address = HOMEY_FIRST; address <= HOMEY_LAST; address += 1) if (!taken.has(address)) free.push(address);
    if (free.length === 0) throw new Error(`no free address from ${hex(HOMEY_FIRST)} to ${hex(HOMEY_LAST)}`);
    const address = free[this.randomInt(free.length)];
    this.settings.set(key, address);
    this.log(`no address kept for this network on this Homey: drew ${hex(address)}`);
    return address;
  }

  deviceCount() {
    return this.deviceAddresses().length;
  }

  // What the settings page shows.
  status() {
    if (!this.network) return { configured: false };
    const session = this.bridge && this.bridge.session;
    return {
      configured: true,
      dimmers: this.deviceCount(),
      connected: Boolean(session),
      networkId: this.networkId,
      ivIndex: session ? session.ivIndex : this.storedIvIndex(),
      address: this.address,
      proxy: this.connectedVia,
    };
  }

  // The IV Index last heard on the network, or null: the account does not
  // give it, so the first link takes it from the proxy's beacon.
  storedIvIndex() {
    const value = this.settings.get(`sg3Iv:${this.networkId}`);
    return Number.isInteger(value) ? value : null;
  }

  keepAliveSeconds() {
    const value = this.settings.get('sg3KeepAlive');
    return Number.isInteger(value) ? value : 0;
  }

  // ------------------------------------------------------------ link

  createBridge() {
    const bridge = new Sg3Bridge({
      ble: { discover: (...args) => this.discover(...args) },
      networkId: Buffer.from(this.networkId, 'hex'),
      passAll: true,
      timers: { setTimeout: (...a) => this.homey.setTimeout(...a), clearTimeout: (t) => this.homey.clearTimeout(t) },
      createSession: (write) => {
        const session = new MeshSession({
          netKey: this.network.netKey,
          appKey: this.appKey,
          address: this.address,
          ivIndex: this.storedIvIndex(),
          seqStore: this.seqStore,
          write,
          timers: { setTimeout: (...a) => this.homey.setTimeout(...a), clearTimeout: (t) => this.homey.clearTimeout(t) },
        });
        // The link the session is on, for the log of each command.
        session.linkNumber = bridge.linkNumber;
        this.incoming = new IncomingCounts(this.address);
        const count = (dst, what) => {
          const line = this.incoming.add(dst, what);
          if (line) this.log(line);
        };
        session.on('log', (line) => this.log(line));
        session.on('message', ({ dst, opcode }) => count(dst, { kind: 'access', opcode }));
        session.on('control', ({ dst, opcode }) => count(dst, { kind: 'control', opcode }));
        session.on('ignored', ({ dst }) => {
          this.counts.unreadable += 1;
          count(dst, { kind: 'unreadable' });
        });
        session.on('beacon', ({ ivIndex }) => {
          if (this.settings.get(`sg3Iv:${this.networkId}`) !== ivIndex) this.settings.set(`sg3Iv:${this.networkId}`, ivIndex);
        });
        this.client = new SgClient(session, { ids: this.ids });
        this.client.on('status', (status) => this.onStatus(status));
        return session;
      },
    });
    bridge.on('log', (line) => this.log(line));
    bridge.on('connected', ({ proxy }) => {
      this.connectedVia = proxy;
      this.reconnectAttempt = 0;
      this.counts.links += 1;
      this.emit('connection', true);
      this.askStatus();
    });
    bridge.on('disconnected', (reason, { link, upMs }) => {
      this.connectedVia = null;
      const dropped = reason === 'remote hang-up' || reason.startsWith('proxy protocol');
      if (dropped) this.counts.drops += 1;
      this.log(`link #${link} ${dropped ? 'dropped' : 'closed'} after ${seconds(upMs)}: ${reason}; `
        + `${this.incoming ? this.incoming.summary() : 'in 0'}`);
      this.emit('connection', false);
      if (reason === 'remote hang-up' && this.keepAliveSeconds() === 0 && this.deviceCount() > 0) this.connectSoon();
    });
    return bridge;
  }

  // The scan for proxy nodes, through the app's queue of scans when there is
  // one (app.js, bleDiscover), so it never runs while the CSRmesh bridge
  // scans.
  discover(...args) {
    const app = this.homey.app;
    if (app && typeof app.bleDiscover === 'function') return app.bleDiscover(...args);
    return this.homey.ble.discover(...args);
  }

  async session() {
    if (!this.network) throw new Error('SG Smart 3.0 is not set up');
    if (!this.bridge) this.bridge = this.createBridge();
    const session = await this.bridge.ensureConnected();
    this.touch();
    return session;
  }

  // Holding the link is what lets status from a wheel or a wall switch reach
  // Homey. With a keep-alive in seconds, an idle link is let go.
  touch() {
    if (this.idleTimer) this.homey.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const seconds = this.keepAliveSeconds();
    if (seconds > 0) this.idleTimer = this.homey.setTimeout(() => this.disconnect('idle'), seconds * 1000);
  }

  // Reconnect after a drop, slower each time: 15 s, 1 min, then every 5 min.
  connectSoon(delay) {
    if (this.stopped || this.reconnectTimer) return;
    const wait = delay !== undefined ? delay : RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt += 1;
    if (wait > 0) this.log(`new link in ${Math.round(wait / 1000)} s`);
    this.reconnectTimer = this.homey.setTimeout(() => {
      this.reconnectTimer = null;
      this.session().catch((err) => {
        this.log(`connect failed: ${err.message}`);
        if (this.keepAliveSeconds() === 0 && this.deviceCount() > 0) this.connectSoon();
      });
    }, wait);
  }

  async disconnect(reason) {
    if (this.idleTimer) this.homey.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.bridge) await this.bridge.disconnect(reason);
  }

  // Called by app.js at start and when a 3.0 device is added.
  start() {
    this.stopped = false;
    if (this.network && this.deviceCount() > 0 && this.keepAliveSeconds() === 0) this.connectSoon(0);
  }

  async stop() {
    this.stopped = true;
    this.stopSummary();
    if (this.reconnectTimer) this.homey.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    await this.disconnect('app stopping');
  }

  // ------------------------------------------------------------ commands

  // Where a command to node goes: the node itself, or 0xFFFF (sendTo).
  target(node) {
    return this.sendTo === 'node' ? node : ALL_NODES;
  }

  // The log says what was written on which link, and when the ack came or
  // why it did not: "0x66bb level 25 to 0x66bb on link #2: 2 segment(s), 4
  // write(s) in 0.1 s after 0.0 s in the queue, acked yes after 0.3 s". The
  // count comes from the session, so it holds also when the link goes while
  // the command is under way.
  async setLevel(node, level) {
    const session = await this.session();
    const client = this.client;
    const started = Date.now();
    this.commandAt.set(node, this.now());
    const result = await client.setLevel(node, level, { dst: this.target(node) });
    this.counts.commands += 1;
    if (result.acked) this.counts.acked += 1;
    const acked = result.acked === undefined ? 'not asked' : result.acked ? 'yes' : `no (${result.ackMissing})`;
    this.log(`${hex(node)} level ${level} to ${hex(this.target(node))} on link #${session.linkNumber}: ${result.segments} segment(s), `
      + `${result.writes} write(s) in ${seconds(result.writeMs)} after ${seconds(result.queuedMs)} in the queue, `
      + `acked ${acked} after ${seconds(Date.now() - started)}`);
    return result;
  }

  // Each 3.0 device in Homey asked for its status, one after the other, when
  // a link comes up. A node that does not answer is logged, and the rest are
  // still asked.
  async askStatus() {
    for (const node of this.deviceAddresses()) {
      if (this.stopped || !this.bridge || !this.bridge.link) return;
      await this.getStatus(node).catch(() => {});
    }
  }

  async getStatus(node) {
    await this.session();
    const started = Date.now();
    try {
      const status = await this.client.getStatus(node, { dst: this.target(node) });
      this.log(`${hex(node)} status: ${status.on ? 'on' : 'off'} ${status.level} after ${seconds(Date.now() - started)}`);
      return status;
    } catch (err) {
      this.log(`${hex(node)} status: ${err.message}`);
      throw err;
    }
  }

  // A status from a dimmer in Homey is logged when the node sent it by
  // itself (a wheel or the wall switch); replies are logged by getStatus.
  // Statuses from other nodes are only counted. Within STATUS_BLOCK_MS of a
  // command to the node, a status is counted and not passed on.
  onStatus(status) {
    const commandAt = this.commandAt.get(status.node);
    if (commandAt !== undefined && this.now() - commandAt < STATUS_BLOCK_MS) {
      this.counts.blocked += 1;
      return;
    }
    if (this.deviceAddresses().includes(status.node)) {
      this.counts.statuses += 1;
      if (status.kind === 0x03) this.log(`status ${hex(status.node)} (by itself): ${status.on ? 'on' : 'off'} ${status.level}`);
    } else {
      this.counts.otherStatuses += 1;
    }
    this.emit('status', status);
  }

  startSummary() {
    if (this.summaryTimer || !this.network) return;
    this.summaryTimer = this.homey.setInterval(() => this.logSummary(), this.summaryMs);
  }

  stopSummary() {
    if (this.summaryTimer) this.homey.clearInterval(this.summaryTimer);
    this.summaryTimer = null;
  }

  // Every 10 minutes while there are 3.0 dimmers or a link, like the first
  // generation's keep-alive line, so a report always holds the counts.
  logSummary() {
    const link = this.bridge && this.bridge.link;
    if (!link && this.deviceCount() === 0) return;
    const c = this.counts;
    const state = link ? `link #${link.number} up ${Math.round((Date.now() - link.upSince) / 1000)} s, `
      + `${this.incoming ? this.incoming.summary() : 'in 0'}` : 'no link';
    this.log(`${state}; since start: commands ${c.commands} (acked ${c.acked}), status ${c.statuses} `
      + `(other nodes ${c.otherStatuses}, held back ${c.blocked}), drops ${c.drops}, links ${c.links}, unreadable ${c.unreadable}`);
  }
}

module.exports = {
  HOMEY_FIRST,
  HOMEY_LAST,
  STATUS_BLOCK_MS,
  Sg3Controller,
};
