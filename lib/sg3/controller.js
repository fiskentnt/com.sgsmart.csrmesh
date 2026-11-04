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

class Sg3Controller extends EventEmitter {
  constructor({ homey, log = () => {}, searchAnswerMs = SEARCH_ANSWER_MS }) {
    super();
    this.homey = homey;
    this.searchAnswerMs = searchAnswerMs;
    this.logLine = log;
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
    if (this.network.skipped.length) this.log(`${this.network.skipped.length} node(s) in the export were skipped: ${this.network.skipped.join('; ')}`);
    this.log(`network ${this.networkId}, ${this.network.nodes.length} node(s) in the export, sending from 0x${this.address.toString(16)}`);
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
      this.log(`chosen address 0x${chosen.toString(16)} is taken or not unicast; picking one`);
    }
    return imp.freeUnicast(this.network);
  }

  // `{ netKey, appKey }` from the key fields, or `{ json }` from Advanced.
  // Both go through the same import. Returns { ok: true } or { error, detail }.
  async importNetwork(body = {}) {
    let text;
    let network;
    try {
      text = typeof body.json === 'string' ? body.json : imp.buildExportFromKeys(body);
      network = imp.parseNetworkExport(text);
    } catch (err) {
      if (err instanceof imp.ImportError) return { error: err.code, detail: err.detail };
      throw err;
    }
    // The same network is the same Network ID. HA compares meshUUID, but the
    // key fields make an export without one, so that would call the network
    // from the SG app different from itself.
    if (this.network && imp.networkId(network) !== this.networkId) {
      return { error: 'other_network', detail: imp.networkId(network) };
    }
    await this.disconnect('new import');
    this.settings.set('sg3Network', text);
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
    return { ok: true };
  }

  async setAdvanced({ address, keepAlive } = {}) {
    if (!this.network) return { error: 'not_configured' };
    if (keepAlive !== undefined) {
      if (!Number.isInteger(keepAlive) || keepAlive < 0 || keepAlive > 3600) return { error: 'invalid_keep_alive' };
      this.settings.set('sg3KeepAlive', keepAlive);
    }
    if (address !== undefined) {
      try {
        if (imp.freeUnicast({ ...this.network, reservedRanges: [] }, address) !== address) return { error: 'address_taken' };
      } catch (err) {
        return { error: 'invalid_address' };
      }
      this.settings.set('sg3Address', address);
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
        session.on('beacon', ({ ivIndex, changed }) => {
          if (changed) this.settings.set(`sg3Iv:${this.networkId}`, ivIndex);
        });
        this.client = new SgClient(session, this.tid === undefined ? {} : { tid: this.tid });
        this.client.on('status', (status) => this.emit('status', status));
        return session;
      },
    });
    bridge.on('log', (line) => this.log(line));
    bridge.on('connected', ({ proxy, ivIndex }) => {
      this.connectedVia = proxy;
      this.reconnectAttempt = 0;
      this.log(`connected through 0x${proxy.toString(16)}, IV Index ${ivIndex}`);
      this.emit('connection', true);
    });
    bridge.on('disconnected', (reason) => {
      this.connectedVia = null;
      if (this.client) this.tid = this.client.tid;
      this.log(`disconnected: ${reason}`);
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
    if (this.reconnectTimer) this.homey.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    await this.disconnect('app stopping');
  }

  // ------------------------------------------------------------ commands

  async setLevel(node, level) {
    await this.session();
    const result = await this.client.setLevel(node, level);
    if (!result.acked) this.log(`0x${node.toString(16)} did not acknowledge level ${level}`);
    return result;
  }

  async getStatus(node) {
    await this.session();
    return this.client.getStatus(node);
  }

  // Dimmers to offer in pairing (sketch, point 5): the export's SG dimmers,
  // with no traffic at all. Only when the export has none: one Generic OnOff
  // Get to all nodes, then an SG status request to each node that answered,
  // one at a time. Nodes that send a status by themselves meanwhile count
  // too. Nothing is sent twice.
  async searchDimmers() {
    const fromExport = imp.sgDimmerNodes(this.network)
      .map((node) => ({ unicast: node.unicast, name: node.name, source: 'export' }));
    if (fromExport.length > 0) return fromExport.sort((a, b) => a.unicast - b.unicast);

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
          this.log(`0x${node.toString(16)} answered Generic OnOff but not the SG status request`);
        }
      }
    } finally {
      session.off('message', onMessage);
      this.off('status', onStatus);
    }
    return [...found.values()].sort((a, b) => a.unicast - b.unicast);
  }
}

module.exports = {
  DRIVER_ID,
  Sg3Controller,
};
