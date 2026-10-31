'use strict';

const { makePacket } = require('./csrmesh');
const {
  ADDR_APP, OP_EXT_FAST_STATUS, OP_EXT_NAME, OP_EXT_STATUS,
  csrNameRequestData, csrStatusRequestData, opcodeValue,
  parseCsrFastStatus, parseCsrName, parseCsrStatus, parseExt, statusRequestData,
} = require('./sgProtocol');
const { csrProductForName } = require('./sgProducts');

// SG's CSRmesh products after the first generation (Gen2 to Gen4), next to the
// first generation dimmers. A trial in 2.5.0: the log is what forum testers
// send back, and the SG phone app is the reference for level and status.
// - Finds them by name: FF10 to everyone (00 00, then each location id known
//   here), and each is assumed to answer FF11 from its own mesh id (not
//   tried; the Bluetooth name does not carry it).
// - Asks each one once for its status (FF04), and the devices added in Homey
//   (lib/SGCsrDevice.js) again from time to time.
// - Logs every extension message they send, and hands their statuses (FF05,
//   FF50) and names to those devices.
const NAME = opcodeValue(OP_EXT_NAME);
const STATUS = opcodeValue(OP_EXT_STATUS);
const FAST_STATUS = opcodeValue(OP_EXT_FAST_STATUS);
// The first FF10 after the app starts, for the log, and then at most this
// often unless a search or a device asks.
const FIRST_NAME_REQUEST_MS = 30 * 1000;
const NAME_REQUEST_EVERY_MS = 10 * 60 * 1000;
// Even when asked, FF10 goes out at most this often.
const NAME_REQUEST_MIN_MS = 30 * 1000;
// Between the FF10 variants of one request (00 00, then each location id),
// so the log can tell which one an FF11 came after.
const NAME_VARIANT_GAP_MS = 2000;
// How long a search listens for FF11 answers.
const SEARCH_LISTEN_MS = 8000;
// How long the link that sent a request stays to hear the answers: the
// listening, and a second for its end (lib/MeshBridge.js, listenMs).
const LISTEN_MARGIN_MS = 1000;
// How long the link of an FF10 listens for FF11: at start, from a device
// and in a search.
const NAME_LISTEN_MS = SEARCH_LISTEN_MS + LISTEN_MARGIN_MS;
// How long the link that sent FF04 or FFFF stays to hear the status it asks
// for.
const STATUS_LISTEN_MS = 3000;
// The log: the same message from the same sender at most once a minute, and
// at most LOG_PER_SENDER lines a minute from one sender. The first FF11 and
// the first FF05 from each sender are always logged.
const LOG_WINDOW_MS = 60 * 1000;
const LOG_PER_SENDER = 20;

const hex4 = (value) => `0x${value.toString(16).padStart(4, '0')}`;

class CsrNetwork {
  constructor(app, { now = () => Date.now() } = {}) {
    this.app = app;
    this.homey = app.homey;
    this.now = now;
    this.nodes = new Map();      // mesh id -> { meshId, name, product, location, resets, seenAt }
    this._statusAsked = new Set(); // mesh ids asked once for their status
    this._logged = new Map();    // `${src} ${opcode} ${data}` -> when it was last logged
    this._senders = new Map();   // src -> { since, count, skipped }
    this._firstSeen = new Set(); // `${src} ${opcode}` for FF11 and FF05
    this._lastNameRequestAt = null;
    this._lastListeningNameRequestAt = null; // the last FF10 whose link listened
    this._nameRequests = [];     // the FF10 variants of the latest request that got out: { location, at }
    this._timer = null;
    this._waiting = new Set();   // timers of FF04s that wait for a listening to end
  }

  start() {
    this._timer = this.homey.setTimeout(() => {
      this._timer = null;
      this.requestNames({ listenMs: NAME_LISTEN_MS })
        .catch((err) => this.app.error(`[CSR] name request failed: ${err.message || err}`));
    }, FIRST_NAME_REQUEST_MS);
  }

  stop() {
    if (this._timer) this.homey.clearTimeout(this._timer);
    this._timer = null;
    for (const timer of this._waiting) this.homey.clearTimeout(timer);
    this._waiting.clear();
  }

  // From MeshBridge.onFrame: a decrypted frame that is not a first generation
  // status. Our own messages come back through the mesh with our address.
  handleFrame({ src, plain }) {
    if (src === ADDR_APP) return;
    const ext = parseExt(plain);
    if (!ext) return;
    let parsed = null;
    if (ext.opcode === NAME) parsed = parseCsrName(ext.data);
    else if (ext.opcode === STATUS) parsed = parseCsrStatus(ext.data);
    else if (ext.opcode === FAST_STATUS) parsed = parseCsrFastStatus(ext.data);
    this._log(src, ext, parsed);
    if (!parsed) return;
    if (ext.opcode === NAME) this._onName(src, parsed);
    else this._onStatus(src, ext.opcode, parsed);
  }

  // The FF10 variant written last before now, if one went out less than
  // NAME_REQUEST_MIN_MS ago.
  _nameRequestBefore(now) {
    const before = this._nameRequests.filter((r) => r.at <= now && now - r.at < NAME_REQUEST_MIN_MS);
    return before.length ? before[before.length - 1] : null;
  }

  _log(src, ext, parsed) {
    const now = this.now();
    const data = ext.data.toString('hex');
    const first = (ext.opcode === NAME || ext.opcode === STATUS) && !this._firstSeen.has(`${src} ${ext.opcode}`);
    if (first) this._firstSeen.add(`${src} ${ext.opcode}`);
    let sender = this._senders.get(src);
    if (!sender || now - sender.since >= LOG_WINDOW_MS) {
      sender = { since: now, count: 0, skipped: sender ? sender.skipped : 0 };
      this._senders.set(src, sender);
    }
    // An FF11 after each FF10 variant is logged, also when it is the same.
    const after = ext.opcode === NAME ? this._nameRequestBefore(now) : null;
    const key = `${src} ${ext.opcode} ${data}${after ? ` ${after.location}` : ''}`;
    const lastAt = this._logged.get(key);
    if (!first && ((lastAt !== undefined && now - lastAt < LOG_WINDOW_MS) || sender.count >= LOG_PER_SENDER)) {
      sender.skipped += 1;
      return;
    }
    if (this._logged.size > 1000) {
      for (const [k, at] of this._logged) if (now - at >= LOG_WINDOW_MS) this._logged.delete(k);
    }
    this._logged.set(key, now);
    sender.count += 1;
    const skipped = sender.skipped ? `, ${sender.skipped} not logged since` : '';
    sender.skipped = 0;
    let about = '';
    if (parsed && ext.opcode === NAME) {
      const product = csrProductForName(parsed.name);
      about = ` name=${parsed.name} product=${product ? `"${product.name} (${product.generation})"` : 'unknown'}`
        + ` loc=${hex4(parsed.location)} reset=${parsed.resets}`
        + `${after ? ` after FF10 loc=${hex4(after.location)} (+${((now - after.at) / 1000).toFixed(1)} s)` : ''}`;
    } else if (parsed) {
      about = ` on=${parsed.on ? 1 : 0} level=${parsed.level === null ? '-' : parsed.level} loc=${hex4(parsed.location)}`;
    }
    this.app.log(`[CSR] EXT src=${hex4(src)} dst=${hex4(ext.dst)} op=${ext.opcode.toString(16).toUpperCase()} `
      + `len=${ext.data.length} data=${data || '-'}${about}${skipped}`);
  }

  _onName(src, name) {
    const product = csrProductForName(name.name);
    this.nodes.set(src, {
      meshId: src, name: name.name, product, location: name.location || null, resets: name.resets, seenAt: this.now(),
    });
    for (const device of this._devicesFor(src)) device.applyCsrName(name);
    // Once per node, for the log: does it answer FF04 with FF05? Not while
    // the link still listens for the FF11 answers (a search), but when that
    // is over, so it does not end the listening.
    if (product && name.location && !this._statusAsked.has(src)) {
      this._statusAsked.add(src);
      this._afterListening(() => this.requestStatus(src, name.location).catch(() => {}));
    }
  }

  // run now, or once the bridge's link no longer listens for an answer; a
  // listening made longer meanwhile is waited for as well.
  _afterListening(run) {
    const left = this.app.bridge && typeof this.app.bridge.listenLeftMs === 'function' ? this.app.bridge.listenLeftMs() : 0;
    if (left <= 0) {
      run();
      return;
    }
    const timer = this.homey.setTimeout(() => {
      this._waiting.delete(timer);
      this._afterListening(run);
    }, left);
    this._waiting.add(timer);
  }

  _onStatus(src, opcode, status) {
    const node = this.nodes.get(src);
    if (node && status.location) node.location = status.location;
    for (const device of this._devicesFor(src)) device.applyCsrStatus(status, opcode === STATUS ? 'FF05' : 'FF50');
  }

  _devicesFor(meshId) {
    return this.app._devices().filter((device) => typeof device.applyCsrStatus === 'function'
      && device.getCsrMeshId() === meshId);
  }

  // FF10 to everyone: first with 00 00, which a device without a location id
  // is assumed to answer, then once with each location id known here (the
  // first generation dimmers' status, a Pill added), which a device of that
  // home is assumed to answer (not tried). NAME_VARIANT_GAP_MS between them.
  // Not more often than NAME_REQUEST_EVERY_MS, or with `asked` (a search, a
  // device without a location id) NAME_REQUEST_MIN_MS; the limit is for the
  // request as a whole, so it never stops a variant, and one whose link did
  // not listen never stops one that listens. With listenMs, each link listens
  // that long for the FF11 answers. Resolves once every variant has been
  // sent: true when one got out.
  async requestNames({ asked = false, listenMs = 0 } = {}) {
    const now = this.now();
    const wait = asked ? NAME_REQUEST_MIN_MS : NAME_REQUEST_EVERY_MS;
    const last = listenMs > 0 ? this._lastListeningNameRequestAt : this._lastNameRequestAt;
    if (last !== null && now - last < wait) return false;
    this._lastNameRequestAt = now;
    if (listenMs > 0) this._lastListeningNameRequestAt = now;
    this._nameRequests = [];
    const known = typeof this.app.knownLocations === 'function' ? this.app.knownLocations() : [];
    let out = false;
    for (const [i, location] of [0, ...known.filter((l) => l > 0)].entries()) {
      if (i > 0) await new Promise((resolve) => this.homey.setTimeout(resolve, NAME_VARIANT_GAP_MS));
      this.app.log(`[CSR] FF10 name request to everyone, loc=${hex4(location)}`);
      if (await this._send(csrNameRequestData(location), location ? `csr:names:${location}` : 'csr:names', listenMs)) {
        this._nameRequests.push({ location, at: this.now() });
        out = true;
      }
    }
    return out;
  }

  // FF04 to one device: its link listens for the FF05 answer, also when it
  // is not held.
  async requestStatus(meshId, location) {
    this.app.log(`[CSR] FF04 status request to ${hex4(meshId)} loc=${hex4(location)}`);
    return this._send(csrStatusRequestData({ meshId, location }), `csr:status:${meshId}`, STATUS_LISTEN_MS);
  }

  // FFFF, once: assumed to make every first generation dimmer answer with its
  // status (not shown, as in lib/sgProtocol.js), heard on a link that listens
  // (a held one, or this one for STATUS_LISTEN_MS).
  async requestAllStatus() {
    this.app.log('[CSR] FFFF status request to everyone');
    return this._send(statusRequestData(), 'csr:status-all', STATUS_LISTEN_MS);
  }

  async _send(data, key, listenMs = 0) {
    const packet = makePacket(this.app.getNetworkKey(), this.app.nextSeq(), data);
    const result = await this.app.bridge.send(packet, listenMs > 0 ? { key, listenMs } : { key });
    return !!(result && result.ok);
  }

  // A pairing search: FF10, then SEARCH_LISTEN_MS of answers. Every node heard
  // since the app started, newest first.
  async search() {
    await this.requestNames({ asked: true, listenMs: NAME_LISTEN_MS }).catch((err) => this.app.error(`[CSR] name request failed: ${err.message || err}`));
    await new Promise((resolve) => this.homey.setTimeout(resolve, SEARCH_LISTEN_MS));
    return [...this.nodes.values()].sort((a, b) => b.seenAt - a.seenAt);
  }
}

module.exports = {
  CsrNetwork, LISTEN_MARGIN_MS, LOG_PER_SENDER, LOG_WINDOW_MS, NAME_LISTEN_MS, NAME_REQUEST_EVERY_MS,
  NAME_REQUEST_MIN_MS, SEARCH_LISTEN_MS, STATUS_LISTEN_MS,
};
