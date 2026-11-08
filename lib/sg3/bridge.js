'use strict';

// Homey's Bluetooth to a MeshSession. Connects to the proxy node used last
// (lastProxy, through ble.find: no scan when Homey knows it), else finds a
// proxy node of our network (it advertises service 0x1828 with our Network
// ID); subscribes to Mesh Proxy Data Out (2ADE), writes to Data In (2ADD),
// and sets the proxy filter. The filter's answer names the proxy node; one
// that may not carry the link (allowedProxy: a battery switch or a gateway)
// is let go, and the next is tried. One link at a time.
//
// Tried with a LEDDim Smart 3.0 on a Homey Pro (2026-11-05): the short UUID
// in the discover() filter finds the proxy node, writes to 2ADD go through
// (which write type Homey uses, Athom documents none), and the node sends
// network PDUs of 43 bytes in one notification. What we send is still cut
// to 20 bytes per write (assumed safe; the MTU Homey agrees is not known).
//
// What the first generation taught (lib/MeshBridge.js): Homey wants the
// notification subscription released before we disconnect, and that throws
// once the node has hung up; a remote hang-up comes as the peripheral's
// 'disconnect' event; and no new link may start while one is being torn down.
//
// Each link's log line says where the advertisement it was opened from came
// from, a new scan or find() without a scan, and how old it was when Homey
// says (advertAge): its signal is what the dimmer shows as "Signal to Homey".
//
// The kept advertisement: once a link is up, the bridge keeps the
// advertisement it was opened from, in memory only, with the time it was
// fetched (by find or a scan). A caller that asks for it (ensureConnected
// with kept: a command, or a dimmer asking its status) connects on it while
// it is under KEPT_MAX_MS old and is of the proxy used last, without find:
// find takes about 10 s when Homey has no answer at hand, a connect about
// 0.2 s. That a kept 3.0 advertisement connects for as long as KEPT_MAX_MS is
// assumed; the first generation's connected every time up to 226 s old on a
// Homey Pro 2026 (lib/MeshBridge.js). Its connect gives up after
// KEPT_CONNECT_MS; then, and on any other failure, the advertisement is
// forgotten and the link is opened as before (find, then a scan). A link from
// it does not give the signal: the signal is as old as the advertisement.
// The status round and a new link after a drop use find, and the
// advertisement they get takes the place of the kept one.
//
// Each advertisement a link is opened with, from a scan, find or the kept
// one, is told to the caller as 'advertisement' before the connect (the
// controller logs its manufacturer data once per node).
//
// A disconnect while a link is being opened (the app stops, a pairing
// pauses, no 3.0 device left) closes that link as soon as it is up, and
// nothing more is tried for it: a link left open survives an app restart.
//
// One connect at a time to the same node: Homey cannot cancel a connect, and
// a second one while Homey's first is still going came up slowly and then
// gave no filter (2026-11-08). So a connect to a node waits until Homey has
// ended the one before to that node (it came up, or failed, and a late one
// was let go), at most CONNECT_SETTLE_MS after that one began; then it goes
// anyway, with a line in the log.
//
// A connect slower than its time (3 s on the kept advertisement) is waited
// for, up to CONNECT_SETTLE_MS from its start, and the link is opened on it
// when it comes: no second connect beside it. Only one that has not come by
// then is given up, and let go if it comes later.
//
// Homey cannot cancel a connect: one that comes after the bridge gave up is
// let go at once, as the first generation does, so it holds no link to the
// node.
//
// Events: 'connected' { proxy, ivIndex, uuid, rssi, source }, 'disconnected'
// (reason, { link, upMs }), 'log' (text). rssi is null on a link from the
// kept advertisement. Log lines name a peripheral only by the last four
// characters of its id, and never carry keys.

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const shortId = (uuid) => `…${String(uuid || '').slice(-4)}`;

const { EventEmitter } = require('events');

const PROXY_SERVICE_SHORT = '1828';
const PROXY_SERVICE = '0000182800001000800000805f9b34fb';
const DATA_IN = '00002add00001000800000805f9b34fb';
const DATA_OUT = '00002ade00001000800000805f9b34fb';
// 0x1828 service data: 00 + Network ID (8 bytes), or 01 + Node Identity.
const ADVERT_NETWORK_ID = 0x00;
const ADVERT_NODE_IDENTITY = 0x01;
const MAX_CANDIDATES = 3;
// How long the advertisement of the last link is kept for a command, counted
// from when it was fetched: as the first generation's ADV_CACHE_TTL_MS. The
// status round, every 5 min, fetches a new one while the link is not held.
const KEPT_MAX_MS = 6 * 60 * 1000;
// How long a connect on the kept advertisement may take: about 0.2 s is
// usual, and find and a scan come after it.
const KEPT_CONNECT_MS = 3000;
// How long a new connect to a node waits for Homey to end the one before to
// it: the longest a connect went on before Homey gave up in the logs (20.1 s,
// 2026-11-07).
const CONNECT_SETTLE_MS = 20000;

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

// How old an advertisement is in ms, when Homey says, else null. Homey's own
// Bluetooth state gives each peripheral a lastSeen (ms since 1970, or a
// date); that an advertisement from find() or discover() has it is assumed,
// not documented.
function advertAge(advertisement, now = Date.now()) {
  const seen = advertisement ? advertisement.lastSeen : undefined;
  const at = typeof seen === 'string' ? Date.parse(seen) : Number(seen);
  if (seen === undefined || seen === null || !Number.isFinite(at) || at <= 0) return null;
  return Math.max(0, now - at);
}

// Where the advertisement of a link came from, for its log line.
const SOURCE_TEXT = { scan: 'from a new scan', find: 'from find without a scan' };

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
  // `listen` are the group addresses the filter lets through; with passAll
  // the filter lets everything through instead (MeshSession.start).
  constructor({
    ble, networkId, createSession, listen = [], passAll = false, timers = { setTimeout, clearTimeout }, stepTimeoutMs = 15000,
    lastProxy = () => null, allowedProxy = () => true,
    keptMaxMs = KEPT_MAX_MS, keptConnectMs = KEPT_CONNECT_MS, now = Date.now, connectSettleMs = CONNECT_SETTLE_MS,
  }) {
    super();
    this.ble = ble;
    this.lastProxy = lastProxy;
    this.allowedProxy = allowedProxy;
    this.networkId = networkId;
    this.createSession = createSession;
    this.listen = listen;
    this.passAll = passAll;
    this.timers = timers;
    this.stepTimeoutMs = stepTimeoutMs;
    this.keptMaxMs = keptMaxMs;
    this.keptConnectMs = keptConnectMs;
    this.connectSettleMs = connectSettleMs;
    this.now = now;
    // The connects Homey has not ended, by peripheral id: { started, ended }.
    this.connects = new Map();
    this.kept = null; // { advertisement, uuid, fetchedAt } of the last link
    this.link = null;
    this.opening = null;
    this.closing = null;
    this.closeWhenOpen = null; // why, when a disconnect came while opening
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

  // The session on a ready link, connecting first when there is none. With
  // kept, a new link may be opened on the kept advertisement. A caller that
  // comes while a link is being opened waits for that one.
  async ensureConnected({ kept = false } = {}) {
    if (this.link) return this.link.session;
    if (this.closing) await this.closing;
    if (!this.opening) {
      this.opening = this.open({ kept }).finally(() => {
        this.opening = null;
        this.closeWhenOpen = null;
      });
    }
    return this.opening;
  }

  // Throws when a disconnect came while this link was being opened.
  checkNotClosed() {
    if (!this.closeWhenOpen) return;
    throw Object.assign(new Error(`closed while opening (${this.closeWhenOpen})`), { code: 'SG3_CLOSED_WHILE_OPENING' });
  }

  step(promise, what, ms = this.stepTimeoutMs) {
    let timer;
    return Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = this.timers.setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms);
      }),
    ]).finally(() => this.timers.clearTimeout(timer));
  }

  async open({ kept = false } = {}) {
    const last = this.lastProxy();
    if (kept && last && this.kept && this.kept.uuid === last) {
      const held = this.kept;
      const age = Math.max(0, this.now() - held.fetchedAt);
      if (age < this.keptMaxMs) {
        this.log(`the proxy used last, ${shortId(last)}, from the kept advertisement (${seconds(age)} old)`);
        const tried = this.now();
        try {
          return await this.openVia(held.advertisement, 'kept', { connectMs: this.keptConnectMs, keptAge: age });
        } catch (err) {
          if (err.code === 'SG3_CLOSED_WHILE_OPENING') throw err;
          if (this.kept === held) this.kept = null;
          this.log(`the kept advertisement of ${shortId(last)} gave up after ${seconds(this.now() - tried)} (${err.message}): find`);
        }
      } else {
        this.log(`the kept advertisement of ${shortId(last)} is ${seconds(age)} old: find`);
      }
    }
    if (last && typeof this.ble.find === 'function') {
      const asked = Date.now();
      try {
        const advertisement = await this.step(Promise.resolve(this.ble.find(last)), 'find');
        const fetchedAt = this.now();
        this.log(`the proxy used last, ${shortId(last)}, without a scan (find ${seconds(Date.now() - asked)})`);
        return await this.openVia(advertisement, 'find', { fetchedAt });
      } catch (err) {
        if (err.code === 'SG3_CLOSED_WHILE_OPENING') throw err;
        this.log(`the proxy used last, ${shortId(last)}, did not answer (${err.message}): scanning`);
      }
    }
    this.checkNotClosed();
    const started = Date.now();
    const advertisements = await this.ble.discover([PROXY_SERVICE_SHORT]);
    const fetchedAt = this.now();
    const all = advertisements || [];
    const kinds = all.map((adv) => serviceData(adv, PROXY_SERVICE_SHORT)).filter(Boolean);
    const networkIds = kinds.filter((data) => data.length === 9 && data[0] === ADVERT_NETWORK_ID).length;
    const identities = kinds.filter((data) => data[0] === ADVERT_NODE_IDENTITY).length;
    const ours = proxyCandidates(advertisements, this.networkId);
    const best = ours.length ? `, best ${ours[0].rssi} dBm` : '';
    this.log(`scan ${seconds(Date.now() - started)}: ${all.length} advert(s) with 1828, ${kinds.length} with its service data `
      + `(${networkIds} Network ID, ${identities} Node Identity), ${ours.length} of this network${best}`);
    const candidates = ours.slice(0, MAX_CANDIDATES);
    if (candidates.length === 0) throw new Error('no proxy node of this network in range');
    let lastError;
    for (const advertisement of candidates) {
      try {
        return await this.openVia(advertisement, 'scan', { fetchedAt });
      } catch (err) {
        if (err.code === 'SG3_CLOSED_WHILE_OPENING') throw err;
        lastError = err;
        this.log(`proxy ${shortId(advertisement.uuid)} (${advertisement.rssi} dBm) failed: ${err.message}`);
      }
    }
    throw lastError;
  }

  // Waits until Homey has ended the connect before to this peripheral, if
  // one goes on, at most connectSettleMs after it began.
  async connectEnded(uuid, number) {
    const before = uuid ? this.connects.get(uuid) : null;
    if (!before) return;
    const left = before.started + this.connectSettleMs - Date.now();
    this.log(`link #${number}: Homey's connect to ${shortId(uuid)} before this one has not ended: waiting`);
    const waited = Date.now();
    try {
      if (left <= 0) throw new Error('over the limit');
      await this.step(before.ended, 'the connect before', left);
      this.log(`link #${number}: the connect before ended after ${seconds(Date.now() - waited)} more`);
    } catch (err) {
      this.log(`link #${number}: the connect before did not end within ${seconds(this.connectSettleMs)}: connecting anyway`);
    }
  }

  // source: 'scan', 'find' or 'kept', where the advertisement came from;
  // fetchedAt when it was fetched (for the kept one), connectMs how long its
  // connect may take, keptAge how old the kept one is.
  async openVia(advertisement, source = 'scan', { fetchedAt = this.now(), connectMs = this.stepTimeoutMs, keptAge = 0 } = {}) {
    this.checkNotClosed();
    this.emit('advertisement', advertisement, source);
    this.linkNumber += 1;
    const number = this.linkNumber;
    const age = advertAge(advertisement);
    const signal = source === 'kept' ? `kept advertisement, ${seconds(keptAge)} old, signal not used`
      : `${advertisement.rssi} dBm ${SOURCE_TEXT[source] || source}, `
        + `${age === null ? 'no age from Homey' : `advert ${seconds(age)} old`}`;
    let at = Date.now();
    const lap = () => {
      const now = Date.now();
      const ms = now - at;
      at = now;
      return seconds(ms);
    };
    await this.connectEnded(advertisement.uuid, number);
    this.checkNotClosed();
    lap();
    const connecting = Promise.resolve(advertisement.connect());
    // Ended when Homey's connect has: it came up, or failed; one that comes
    // after this gave up is let go, and ends when Homey has let it go.
    let gaveUp = false;
    const entry = { started: Date.now(), ended: null };
    entry.ended = connecting.then((late) => {
      if (!gaveUp || !late || (this.link && this.link.peripheral === late)) return undefined;
      this.log(`link #${number}: the connect came after giving up, let go`);
      return late.disconnect();
    }).catch(() => {}).finally(() => {
      if (this.connects.get(advertisement.uuid) === entry) this.connects.delete(advertisement.uuid);
    });
    if (advertisement.uuid) this.connects.set(advertisement.uuid, entry);
    let peripheral;
    try {
      peripheral = await this.step(connecting, 'connect', connectMs);
    } catch (err) {
      // Homey's own failure ends it; a connect that is only slow is waited for.
      if (!/^connect took over/.test(err.message)) {
        gaveUp = true;
        throw err;
      }
      this.log(`link #${number}: the connect takes over ${seconds(connectMs)}: waiting for it, up to ${seconds(this.connectSettleMs)} in all`);
      try {
        const left = entry.started + this.connectSettleMs - Date.now();
        if (left <= 0) throw new Error(`connect took over ${this.connectSettleMs} ms`);
        peripheral = await this.step(connecting, 'connect', left).catch((late) => {
          throw /^connect took over/.test(late.message) ? new Error(`connect took over ${this.connectSettleMs} ms`) : late;
        });
        this.log(`link #${number}: the connect came after ${seconds(Date.now() - entry.started)}, used`);
      } catch (late) {
        gaveUp = true;
        throw late;
      }
    }
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
      // The first beacon on the link, whenever it comes: the session waits
      // for it only when it knows no IV Index.
      let subscribedAt = null;
      link.session.once('beacon', ({ ivIndex, ivUpdate }) => {
        const after = subscribedAt === null ? 'before subscribing' : `${seconds(Math.max(0, Date.now() - subscribedAt))} after subscribing`;
        this.log(`beacon: IV Index ${ivIndex}, update ${ivUpdate ? 'yes' : 'no'}, ${after}`);
      });
      await this.step(link.dataOut.subscribeToNotifications((data) => link.session.receive(data)), 'subscribe 2ADE');
      link.subscribed = true;
      subscribedAt = Date.now();
      const properties = (c) => `[${(Array.isArray(c.properties) ? c.properties : []).join(', ')}]`;
      this.log(`link #${number} ${shortId(advertisement.uuid)} (${signal}): connect ${connectTime}, service ${serviceTime}, `
        + `2ADD ${properties(dataIn)}, 2ADE ${properties(link.dataOut)}, subscribed ${lap()}`);

      const started = await link.session.start({ listen: this.listen, passAll: this.passAll });
      const filter = this.passAll ? 'an empty reject list (all let through)' : `${started.filter.listSize} address(es)`;
      const via = `0x${started.filter.proxy.toString(16).padStart(4, '0')}`;
      this.log(`filter ok via ${via}, ${filter}, ${lap()}`);
      if (!this.allowedProxy(started.filter.proxy)) throw new Error(`${via} may not be a bridge`);
      this.checkNotClosed();
      link.upSince = Date.now();
      this.link = link;
      if (source !== 'kept') this.kept = { advertisement, uuid: advertisement.uuid, fetchedAt };
      this.emit('connected', {
        proxy: started.filter.proxy,
        ivIndex: started.ivIndex,
        beacon: started.beacon,
        uuid: advertisement.uuid,
        rssi: source === 'kept' ? null : advertisement.rssi,
        source,
      });
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
    if (!link && this.opening) {
      // Being opened: closed as soon as it is up (openVia), and the open
      // fails, so no 'connected' comes.
      this.closeWhenOpen = reason;
      this.log(`a link being opened is closed when it is up: ${reason}`);
      await this.opening.catch(() => {});
      return;
    }
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
  CONNECT_SETTLE_MS,
  KEPT_CONNECT_MS,
  KEPT_MAX_MS,
  Sg3Bridge,
  advertAge,
  proxyCandidates,
};
