'use strict';

// SG Smart 3.0 in the app: the imported network, our address, the link, the
// commands and the search for dimmers. app.js creates this only when a
// network has been imported or is being imported, so the first generation
// never loads any of it.
//
// App settings it keeps:
//   sg3Network            the export text as imported (it holds the keys)
//   sg3Address            our unicast address, when chosen under Advanced
//   sg3KeepAlive          seconds to hold an idle link, 0 = always (HA's default)
//   sg3Seq:<Network ID>   our SEQ (seq-store.js), kept when the network is removed,
//   sg3Iv:<Network ID>    and the last IV Index heard, so a new import of the
//                         same network goes on where it left off
//
// Events: 'status' { node, on, level, kind }, 'connection' (connected: boolean).
//
// The log is read from diagnostics reports, which keep only the last 100
// stdout lines: one short line per event (app.js puts [SG3] in front), a
// summary every 10 minutes, and never keys, the export text, the network's
// name, node UUIDs or a whole peripheral id.

const crypto = require('crypto');
const { EventEmitter } = require('events');

const { MeshSession } = require('../sigmesh/session');
const { SeqStore } = require('../sigmesh/seq-store');
const { Sg3Bridge } = require('./bridge');
const { SgClient } = require('./client');
const imp = require('./network-import');

const DRIVER_ID = 'sg3_dimmer';
// Where nodes we set up ourselves will publish (HA's group), and the
// all-nodes address, where nodes set up by the SG app send their 0x03 status.
const STATUS_GROUP = 0xcee8;
const ALL_NODES = 0xffff;
const GENERIC_ONOFF_GET = Buffer.from([0x82, 0x01]);
const GENERIC_ONOFF_STATUS = 0x8204;
const SEARCH_ANSWER_MS = 3000;
const RECONNECT_DELAYS_MS = [15000, 60000, 300000];
const SUMMARY_MS = 10 * 60 * 1000;

const hex = (address) => `0x${address.toString(16).padStart(4, '0')}`;
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

class Sg3Controller extends EventEmitter {
  constructor({ homey, log = () => {}, searchAnswerMs = SEARCH_ANSWER_MS, summaryMs = SUMMARY_MS }) {
    super();
    this.homey = homey;
    this.searchAnswerMs = searchAnswerMs;
    this.summaryMs = summaryMs;
    this.summaryTimer = null;
    this.logLine = log;
    // Since this app start, for the summary line.
    this.counts = { commands: 0, acked: 0, statuses: 0, otherStatuses: 0, drops: 0, links: 0, unreadable: 0 };
    const version = homey.manifest ? homey.manifest.version : '?';
    this.log(`v${version}, node ${process.version}, aes-128-ccm ${crypto.getCiphers().includes('aes-128-ccm') ? 'yes' : 'no'}`);
    this.network = null;
    this.bridge = null;
    this.client = null;
    this.tid = undefined;
    this.connectedVia = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.idleTimer = null;
    this.stopped = false;
    this.load();
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

  // Reads the stored export. A damaged one leaves 3.0 unconfigured with a
  // line in the log, as HA refuses the entry and asks for a new import.
  load() {
    this.network = null;
    this.bridge = null;
    const text = this.settings.get('sg3Network');
    if (!text) return;
    try {
      this.network = imp.parseNetworkExport(text);
    } catch (err) {
      this.log(`stored network is unreadable (${err.detail || err.message}); import it again`);
      return;
    }
    this.networkId = imp.networkId(this.network);
    this.address = this.chooseAddress();
    this.appKey = imp.appKeyForModels(this.network, [imp.MODEL_SG_VENDOR]).key;
    this.seqStore = new SeqStore(this.settings, `sg3Seq:${this.networkId}`);
    const skipped = this.network.skipped.length ? ` (${this.network.skipped.length} skipped)` : '';
    const iv = this.storedIvIndex();
    this.log(`network ${this.networkId}: ${this.network.nodes.length} node(s) in the export${skipped}, `
      + `sending from ${hex(this.address)}, IV Index ${iv === null ? 'unknown' : iv}`);
    this.startSummary();
  }

  // Our address: the one chosen under Advanced if it is still usable, else
  // 0x7FFF or the next free one down (HA's rule, plus the phones' ranges).
  chooseAddress() {
    const chosen = this.settings.get('sg3Address');
    if (Number.isInteger(chosen)) {
      try {
        if (imp.freeUnicast({ ...this.network, reservedRanges: [] }, chosen) === chosen) return chosen;
      } catch (err) {
        // not a unicast address
      }
      this.log(`chosen address ${hex(chosen)} is taken or not unicast; picking one`);
    }
    return imp.freeUnicast(this.network);
  }

  // `{ netKey, appKey }` from the key fields, or `{ json }` from Advanced.
  // Both go through the same import. Returns { ok: true } or { error, detail }.
  async importNetwork(body = {}) {
    const how = typeof body.json === 'string' ? 'json' : 'keys';
    let text;
    let network;
    try {
      text = how === 'json' ? body.json : imp.buildExportFromKeys(body);
      network = imp.parseNetworkExport(text);
    } catch (err) {
      if (!(err instanceof imp.ImportError)) throw err;
      this.log(`import (${how}): ${err.code}`);
      return { error: err.code, detail: err.detail };
    }
    // The same network is the same Network ID. HA compares meshUUID, but the
    // key fields make an export without one, so that would call the network
    // from the SG app different from itself.
    if (this.network && imp.networkId(network) !== this.networkId) {
      this.log(`import (${how}): another network, refused`);
      return { error: 'other_network', detail: imp.networkId(network) };
    }
    await this.disconnect('new import');
    this.settings.set('sg3Network', text);
    this.log(`import (${how}): ok`);
    this.load();
    if (this.deviceCount() > 0) this.connectSoon(0);
    return { ok: true };
  }

  // Keys and export go; our SEQ and IV Index for the network stay.
  async removeNetwork() {
    if (this.deviceCount() > 0) return { error: 'devices_left', detail: String(this.deviceCount()) };
    await this.disconnect('network removed');
    this.settings.unset('sg3Network');
    this.settings.unset('sg3Address');
    this.network = null;
    this.stopSummary();
    this.log('network removed (SEQ and IV Index kept)');
    return { ok: true };
  }

  async setAdvanced({ address, keepAlive } = {}) {
    if (!this.network) return { error: 'not_configured' };
    if (keepAlive !== undefined) {
      if (!Number.isInteger(keepAlive) || keepAlive < 0 || keepAlive > 3600) return { error: 'invalid_keep_alive' };
      this.settings.set('sg3KeepAlive', keepAlive);
      this.log(`keep-alive set to ${keepAlive} s`);
    }
    if (address !== undefined) {
      try {
        if (imp.freeUnicast({ ...this.network, reservedRanges: [] }, address) !== address) return { error: 'address_taken' };
      } catch (err) {
        return { error: 'invalid_address' };
      }
      this.settings.set('sg3Address', address);
      this.log(`address set to ${hex(address)}`);
      await this.disconnect('new address');
      this.load();
      if (this.deviceCount() > 0) this.connectSoon(0);
    }
    return { ok: true };
  }

  deviceCount() {
    try {
      return this.homey.drivers.getDriver(DRIVER_ID).getDevices().length;
    } catch (err) {
      return 0;
    }
  }

  // What the settings page shows: name, dimmers, connected; the rest under Advanced.
  status() {
    if (!this.network) return { configured: false };
    const session = this.bridge && this.bridge.session;
    return {
      configured: true,
      name: this.network.name,
      dimmers: this.deviceCount(),
      connected: Boolean(session),
      advanced: {
        networkId: this.networkId,
        ivIndex: session ? session.ivIndex : this.storedIvIndex(),
        address: this.address,
        proxy: this.connectedVia,
        keepAlive: this.keepAliveSeconds(),
      },
    };
  }

  storedIvIndex() {
    const value = this.settings.get(`sg3Iv:${this.networkId}`);
    if (Number.isInteger(value)) return value;
    return this.network.ivIndex;
  }

  keepAliveSeconds() {
    const value = this.settings.get('sg3KeepAlive');
    return Number.isInteger(value) ? value : 0;
  }

  // ------------------------------------------------------------ link

  createBridge() {
    const bridge = new Sg3Bridge({
      ble: this.homey.ble,
      networkId: Buffer.from(this.networkId, 'hex'),
      listen: [STATUS_GROUP, ALL_NODES],
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
        session.on('log', (line) => this.log(line));
        session.on('ignored', () => { this.counts.unreadable += 1; });
        session.on('beacon', ({ ivIndex, changed }) => {
          if (changed) this.settings.set(`sg3Iv:${this.networkId}`, ivIndex);
        });
        this.client = new SgClient(session, this.tid === undefined ? {} : { tid: this.tid });
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
    });
    bridge.on('disconnected', (reason, { link, upMs }) => {
      this.connectedVia = null;
      if (this.client) this.tid = this.client.tid;
      const dropped = reason === 'remote hang-up' || reason.startsWith('proxy protocol');
      if (dropped) this.counts.drops += 1;
      this.log(`link #${link} ${dropped ? 'dropped' : 'closed'} after ${seconds(upMs)}: ${reason}`);
      this.emit('connection', false);
      if (reason === 'remote hang-up' && this.keepAliveSeconds() === 0 && this.deviceCount() > 0) this.connectSoon();
    });
    return bridge;
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

  // Called by app.js at start (when a network exists) and when a dimmer is added.
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

  async setLevel(node, level) {
    await this.session();
    const before = this.bridge.writeStats || { count: 0, totalMs: 0 };
    const started = Date.now();
    const result = await this.client.setLevel(node, level);
    const after = this.bridge.writeStats || before;
    const writes = after.count - before.count;
    const average = writes > 0 ? Math.round((after.totalMs - before.totalMs) / writes) : 0;
    this.counts.commands += 1;
    if (result.acked) this.counts.acked += 1;
    this.log(`${hex(node)} level ${level}: ${result.segments} segment(s), ${writes} write(s) (avg ${average} ms), `
      + `acked ${result.acked ? 'yes' : 'no'} after ${seconds(Date.now() - started)}`);
    return result;
  }

  async getStatus(node) {
    await this.session();
    const started = Date.now();
    try {
      const status = await this.client.getStatus(node);
      this.log(`${hex(node)} status: ${status.on ? 'on' : 'off'} ${status.level} after ${seconds(Date.now() - started)}`);
      return status;
    } catch (err) {
      this.log(`${hex(node)} status: ${err.message}`);
      throw err;
    }
  }

  deviceAddresses() {
    try {
      return new Set(this.homey.drivers.getDriver(DRIVER_ID).getDevices()
        .map((device) => (typeof device.getStore === 'function' ? device.getStore().unicast : undefined)));
    } catch (err) {
      return new Set();
    }
  }

  // A status from a dimmer in Homey is logged when the node sent it by
  // itself (a wheel or the wall switch); replies are logged by getStatus.
  // Statuses from other nodes are only counted.
  onStatus(status) {
    if (this.deviceAddresses().has(status.node)) {
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
    const state = link ? `link #${link.number} up ${Math.round((Date.now() - link.upSince) / 1000)} s` : 'no link';
    this.log(`${state}; since start: commands ${c.commands} (acked ${c.acked}), status ${c.statuses} `
      + `(other nodes ${c.otherStatuses}), drops ${c.drops}, links ${c.links}, unreadable ${c.unreadable}`);
  }

  // Dimmers to offer in pairing (sketch, point 5): the export's SG dimmers,
  // with no traffic at all. Only when the export has none: one Generic OnOff
  // Get to all nodes, then an SG status request to each node that answered,
  // one at a time. Nodes that send a status by themselves meanwhile count
  // too. Nothing is sent twice.
  async searchDimmers() {
    const fromExport = imp.sgDimmerNodes(this.network)
      .map((node) => ({ unicast: node.unicast, name: node.name, source: 'export' }));
    if (fromExport.length > 0) {
      this.log(`search: ${fromExport.length} dimmer(s) from the export, nothing sent`);
      return fromExport.sort((a, b) => a.unicast - b.unicast);
    }

    const searchStarted = Date.now();
    const found = new Map();
    const session = await this.session();
    const answered = new Set();
    const onMessage = (message) => {
      if (message.opcode === GENERIC_ONOFF_STATUS) answered.add(message.src);
    };
    const onStatus = (status) => {
      if (!found.has(status.node)) found.set(status.node, { unicast: status.node, name: '', source: 'heard', on: status.on, level: status.level });
    };
    session.on('message', onMessage);
    this.on('status', onStatus);
    try {
      await session.sendAccess(ALL_NODES, GENERIC_ONOFF_GET);
      await new Promise((resolve) => this.homey.setTimeout(resolve, this.searchAnswerMs));
      for (const node of answered) {
        if (found.has(node)) continue;
        try {
          const status = await this.client.getStatus(node, { timeoutMs: 2000 });
          found.set(node, { unicast: node, name: '', source: 'search', ...status });
        } catch (err) {
          found.set(node, null);
        }
      }
    } finally {
      session.off('message', onMessage);
      this.off('status', onStatus);
    }
    const dimmers = [...found.values()].filter(Boolean).sort((a, b) => a.unicast - b.unicast);
    const onoff = [...answered].sort((a, b) => a - b).map(hex).join(' ') || 'none';
    const sgStatus = dimmers.map((d) => `${hex(d.unicast)} ${d.on ? 'on' : 'off'} ${d.level}`).join(', ') || 'none';
    this.log(`search ${seconds(Date.now() - searchStarted)}: Generic OnOff answered by ${onoff}; SG status from ${sgStatus}`);
    return dimmers;
  }
}

module.exports = {
  DRIVER_ID,
  Sg3Controller,
};
