'use strict';

// Homey's Bluetooth to a MeshSession. Finds a proxy node of our network (it
// advertises service 0x1828 with our Network ID), connects, subscribes to
// Mesh Proxy Data Out (2ADE), writes to Data In (2ADD), and sets the proxy
// filter. One link at a time.
//
// Not verified on hardware until step 5: which write type Homey uses for 2ADD
// (Athom documents none), the MTU (20 bytes per write is assumed), and the
// short UUID in the discover() filter (homey-ble-mesh uses it on a Homey Pro).
//
// What the first generation taught (lib/MeshBridge.js): Homey wants the
// notification subscription released before we disconnect, and that throws
// once the node has hung up; a remote hang-up comes as the peripheral's
// 'disconnect' event; and no new link may start while one is being torn down.
//
// Events: 'connected' { proxy, ivIndex }, 'disconnected' (reason, { link, upMs }),
// 'log' (text). Log lines name a peripheral only by the last four characters
// of its id, and never carry keys.

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const shortId = (uuid) => `…${String(uuid || '').slice(-4)}`;

const { EventEmitter } = require('events');

const PROXY_SERVICE_SHORT = '1828';
const PROXY_SERVICE = '0000182800001000800000805f9b34fb';
const DATA_IN = '00002add00001000800000805f9b34fb';
const DATA_OUT = '00002ade00001000800000805f9b34fb';
// 0x1828 service data: 00 + Network ID (8 bytes), or 01 + Node Identity.
const ADVERT_NETWORK_ID = 0x00;
const MAX_CANDIDATES = 3;

function shortUuid(uuid) {
  const s = String(uuid || '').toLowerCase().replace(/-/g, '');
  const base = /^0000([0-9a-f]{4})00001000800000805f9b34fb$/.exec(s);
  return base ? base[1] : s;
}

// Homey has given service data both as a list and as an object.
function serviceData(advertisement, short) {
  const data = advertisement.serviceData;
  const list = Array.isArray(data) ? data : Object.entries(data || {}).map(([uuid, value]) => ({ uuid, data: value }));
  const entry = list.find((d) => shortUuid(d.uuid) === short);
  return entry && entry.data ? Buffer.from(entry.data) : null;
}

// Advertisements of proxy nodes of our network, strongest first.
function proxyCandidates(advertisements, networkId) {
  return (advertisements || [])
    .filter((adv) => {
      const data = serviceData(adv, PROXY_SERVICE_SHORT);
      return data && data.length === 9 && data[0] === ADVERT_NETWORK_ID && data.subarray(1).equals(networkId);
    })
    .sort((a, b) => (b.rssi || -127) - (a.rssi || -127));
}

class Sg3Bridge extends EventEmitter {
  // `createSession(write)` returns a MeshSession that writes through `write`.
  // `listen` are the group addresses the filter lets through.
  constructor({ ble, networkId, createSession, listen = [], timers = { setTimeout, clearTimeout }, stepTimeoutMs = 15000 }) {
    super();
    this.ble = ble;
    this.networkId = networkId;
    this.createSession = createSession;
    this.listen = listen;
    this.timers = timers;
    this.stepTimeoutMs = stepTimeoutMs;
    this.link = null;
    this.opening = null;
    this.closing = null;
    this.linkNumber = 0;
  }

  // Writes on the current link: count, time and failures, for the log.
  get writeStats() {
    return this.link ? { ...this.link.writes } : null;
  }

  log(text) {
    this.emit('log', text);
  }

  get session() {
    return this.link ? this.link.session : null;
  }

  // The session on a ready link, connecting first when there is none.
  async ensureConnected() {
    if (this.link) return this.link.session;
    if (this.closing) await this.closing;
    if (!this.opening) {
      this.opening = this.open().finally(() => {
        this.opening = null;
      });
    }
    return this.opening;
  }

  step(promise, what) {
    let timer;
    return Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = this.timers.setTimeout(() => reject(new Error(`${what} took over ${this.stepTimeoutMs} ms`)), this.stepTimeoutMs);
      }),
    ]).finally(() => this.timers.clearTimeout(timer));
  }

  async open() {
    const started = Date.now();
    const advertisements = await this.ble.discover([PROXY_SERVICE_SHORT]);
    const proxies = (advertisements || []).filter((adv) => serviceData(adv, PROXY_SERVICE_SHORT));
    const ours = proxyCandidates(advertisements, this.networkId);
    const best = ours.length ? `, best ${ours[0].rssi} dBm` : '';
    this.log(`scan ${seconds(Date.now() - started)}: ${proxies.length} proxy advert(s), ${ours.length} of this network${best}`);
    const candidates = ours.slice(0, MAX_CANDIDATES);
    if (candidates.length === 0) throw new Error('no proxy node of this network in range');
    let lastError;
    for (const advertisement of candidates) {
      try {
        return await this.openVia(advertisement);
      } catch (err) {
        lastError = err;
        this.log(`proxy ${shortId(advertisement.uuid)} (${advertisement.rssi} dBm) failed: ${err.message}`);
      }
    }
    throw lastError;
  }

  async openVia(advertisement) {
    this.linkNumber += 1;
    const number = this.linkNumber;
    let at = Date.now();
    const lap = () => {
      const now = Date.now();
      const ms = now - at;
      at = now;
      return seconds(ms);
    };
    const peripheral = await this.step(advertisement.connect(), 'connect');
    const connectTime = lap();
    const link = { peripheral, dataOut: null, session: null, subscribed: false, number, upSince: 0, writes: { count: 0, totalMs: 0, maxMs: 0, failed: 0 } };
    try {
      const service = await this.step(peripheral.getService(PROXY_SERVICE), 'getService 1828');
      const characteristics = await this.step(service.discoverCharacteristics([DATA_IN, DATA_OUT]), 'characteristics');
      const serviceTime = lap();
      const dataIn = characteristics.find((c) => shortUuid(c.uuid) === '2add');
      link.dataOut = characteristics.find((c) => shortUuid(c.uuid) === '2ade');
      if (!dataIn || !link.dataOut) throw new Error('2ADD or 2ADE missing on the proxy');

      link.session = this.createSession((frame) => this.timedWrite(link, dataIn, frame));
      link.session.on('disconnect', (reason) => this.disconnect(`proxy protocol: ${reason}`));
      peripheral.once('disconnect', () => this.lost(link));
      let beaconAfter = null;
      link.session.once('beacon', () => { beaconAfter = Date.now(); });
      await this.step(link.dataOut.subscribeToNotifications((data) => link.session.receive(data)), 'subscribe 2ADE');
      link.subscribed = true;
      const subscribedAt = Date.now();
      const properties = (c) => `[${(Array.isArray(c.properties) ? c.properties : []).join(', ')}]`;
      this.log(`link #${number} ${shortId(advertisement.uuid)} (${advertisement.rssi} dBm): connect ${connectTime}, service ${serviceTime}, `
        + `2ADD ${properties(dataIn)}, 2ADE ${properties(link.dataOut)}, subscribed ${lap()}`);

      const started = await link.session.start({ listen: this.listen });
      if (started.beacon) {
        const after = beaconAfter === null ? 'before subscribing' : `${seconds(Math.max(0, beaconAfter - subscribedAt))} after subscribing`;
        this.log(`beacon: IV Index ${started.ivIndex}, update ${started.ivUpdate ? 'yes' : 'no'}, ${after}`);
      }
      this.log(`filter ok via 0x${started.filter.proxy.toString(16).padStart(4, '0')}, ${started.filter.listSize} address(es), ${lap()}`);
      link.upSince = Date.now();
      this.link = link;
      this.emit('connected', { proxy: started.filter.proxy, ivIndex: started.ivIndex, beacon: started.beacon });
      return link.session;
    } catch (err) {
      await this.teardown(link, 'setup failed');
      throw err;
    }
  }

  // Every write to 2ADD is timed; a failure is logged with Homey's message,
  // which carries the ATT error code when there is one.
  async timedWrite(link, dataIn, frame) {
    const started = Date.now();
    try {
      await dataIn.write(frame);
    } catch (err) {
      link.writes.failed += 1;
      this.log(`write to 2ADD failed on link #${link.number}: ${err.message || err}`);
      throw err;
    }
    const ms = Date.now() - started;
    link.writes.count += 1;
    link.writes.totalMs += ms;
    link.writes.maxMs = Math.max(link.writes.maxMs, ms);
  }

  linkInfo(link) {
    return { link: link.number, upMs: link.upSince ? Date.now() - link.upSince : 0 };
  }

  // The node hung up: nothing left to unsubscribe.
  lost(link) {
    if (link.session) link.session.close('link lost');
    if (this.link !== link) return;
    this.link = null;
    this.emit('disconnected', 'remote hang-up', this.linkInfo(link));
  }

  async disconnect(reason = 'closed') {
    const link = this.link;
    if (!link) return;
    this.link = null;
    this.closing = this.teardown(link, reason).finally(() => {
      this.closing = null;
    });
    await this.closing;
    this.emit('disconnected', reason, this.linkInfo(link));
  }

  async teardown(link, reason) {
    if (link.session) link.session.close(reason);
    if (link.subscribed) {
      try {
        await link.dataOut.unsubscribeFromNotifications();
      } catch (err) {
        this.log(`unsubscribe 2ADE failed: ${err.message}`);
      }
    }
    try {
      await link.peripheral.disconnect();
    } catch (err) {
      this.log(`disconnect failed: ${err.message}`);
    }
  }
}

module.exports = {
  Sg3Bridge,
  proxyCandidates,
};
