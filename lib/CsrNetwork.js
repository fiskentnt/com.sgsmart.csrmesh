'use strict';

const { makePacket } = require('./csrmesh');
const {
  ADDR_APP, OP_EXT_FAST_STATUS, OP_EXT_LEVEL, OP_EXT_NAME, OP_EXT_STATUS, OP_EXT_THERMOSTAT_ACK,
  OP_EXT_THERMOSTAT_PRESETS, OP_EXT_THERMOSTAT_SET_POINT, OP_EXT_THERMOSTAT_SETTINGS, OP_EXT_THERMOSTAT_TEMPERATURES,
  THERMOSTAT_ASK_PRESETS, THERMOSTAT_ASK_SETTINGS, THERMOSTAT_ASK_TEMPERATURES,
  csrNameRequestData, csrStatusRequestData, opcodeValue,
  parseCsrFastStatus, parseCsrName, parseCsrStatus, parseExt, parseThermostatAck, parseThermostatPresetChoice,
  parseThermostatPresets,
  parseThermostatSetPoint, parseThermostatSettings, parseThermostatStatus, parseThermostatTemperatures, statusRequestData,
  thermostatRequestData,
} = require('./sgProtocol');
const { csrProductForName } = require('./sgProducts');
const { learnLocation } = require('./location');

// SG's CSRmesh products after the first generation (Gen2 to Gen4), next to the
// first generation dimmers. A trial in 2.5.0: the log is what forum testers
// send back, and the SG phone app is the reference for level and status.
// - Finds them by name: FF10 to everyone (00 00, then each location id known
//   here, also from their statuses and the SG account), and each is assumed
//   to answer FF11 from its own mesh id (not tried; the Bluetooth name does
//   not carry it).
// - Asks each one once for its status (FF04), and the devices added in Homey
//   (lib/SGCsrDevice.js) again from time to time.
// - Logs every extension message they send, and hands their statuses (FF05,
//   FF50) and names to those devices.
// - Reads the HeatReg Smart thermostats (@MT, @ST) added in Homey
//   (lib/SGThermostatDevice.js): FF04 and FF3C 00 every THERMOSTAT_EVERY_MS,
//   FF3C 01 and 02 at the first reading and then every
//   THERMOSTAT_SETTINGS_EVERY_MS, each on a link that listens
//   THERMOSTAT_LISTEN_MS. Their answers are
//   logged as a thermostat's and go to the thermostat device, never to a
//   light; an answer that does not come is logged too. So does its FF08,
//   which acknowledges a set point or preset sent from here. A set point (FF3E) or
//   preset (FF03) that another sends one of them, heard on the mesh, goes to
//   the device as well, which only shows it. Setting a thermostat is the
//   device's own, and only when "Control from Homey" is on.
const NAME = opcodeValue(OP_EXT_NAME);
const STATUS = opcodeValue(OP_EXT_STATUS);
const FAST_STATUS = opcodeValue(OP_EXT_FAST_STATUS);
const THERMOSTAT_TEMPERATURES = opcodeValue(OP_EXT_THERMOSTAT_TEMPERATURES);
const THERMOSTAT_SETTINGS = opcodeValue(OP_EXT_THERMOSTAT_SETTINGS);
const THERMOSTAT_PRESETS = opcodeValue(OP_EXT_THERMOSTAT_PRESETS);
const LEVEL = opcodeValue(OP_EXT_LEVEL);
const THERMOSTAT_SET_POINT = opcodeValue(OP_EXT_THERMOSTAT_SET_POINT);
const THERMOSTAT_ACK = opcodeValue(OP_EXT_THERMOSTAT_ACK);
// A thermostat's answers, read for its device: the opcode as the device
// knows it, and how it is read.
const THERMOSTAT_ANSWERS = {
  [STATUS]: ['FF05', parseThermostatStatus],
  [THERMOSTAT_TEMPERATURES]: ['FF3D', parseThermostatTemperatures],
  [THERMOSTAT_SETTINGS]: ['FF5C', parseThermostatSettings],
  [THERMOSTAT_PRESETS]: ['FF5D', parseThermostatPresets],
  [THERMOSTAT_ACK]: ['FF08', parseThermostatAck],
};
// What another sends a thermostat that its device shows: the set point and
// the preset.
const THERMOSTAT_COMMANDS = {
  [THERMOSTAT_SET_POINT]: ['FF3E', parseThermostatSetPoint],
  [LEVEL]: ['FF03', parseThermostatPresetChoice],
};
// The first FF10 after the app starts, for the log, and then at most this
// often unless a search or a device asks.
const FIRST_NAME_REQUEST_MS = 30 * 1000;
const NAME_REQUEST_EVERY_MS = 10 * 60 * 1000;
// Even when asked, FF10 goes out at most this often.
const NAME_REQUEST_MIN_MS = 30 * 1000;
// Between the FF10 variants of one request (00 00, then each location id),
// so the log can tell which one an FF11 came after.
const NAME_VARIANT_GAP_MS = 2000;
// Between the FF10s of a search to one device each (requestNames, direct),
// after the variants to everyone: shorter, as there is one per device.
const NAME_DIRECT_GAP_MS = 500;
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
// A thermostat: how often it is read, how long the link listens after each
// request (its answer is assumed to come within seconds), how often its
// settings and presets are asked for, the time between two requests, and how
// soon a request held back by a pairing scan is tried again.
const THERMOSTAT_EVERY_MS = 5 * 60 * 1000;
const THERMOSTAT_LISTEN_MS = 10 * 1000;
const THERMOSTAT_SETTINGS_EVERY_MS = 60 * 60 * 1000;
const THERMOSTAT_GAP_MS = 2000;
const THERMOSTAT_SCAN_RETRY_MS = 30 * 1000;
// The requests of a reading: FF04, or FF3C with what it asks for, and the
// answer each one is assumed to bring.
const THERMOSTAT_ASKS = {
  status: { label: 'FF04', answer: STATUS },
  [THERMOSTAT_ASK_TEMPERATURES]: { label: 'FF3C 00 (temperatures)', answer: THERMOSTAT_TEMPERATURES },
  [THERMOSTAT_ASK_SETTINGS]: { label: 'FF3C 01 (settings)', answer: THERMOSTAT_SETTINGS },
  [THERMOSTAT_ASK_PRESETS]: { label: 'FF3C 02 (presets)', answer: THERMOSTAT_PRESETS },
};

const hex4 = (value) => `0x${value.toString(16).padStart(4, '0')}`;
const hex2 = (value) => `0x${value.toString(16).padStart(2, '0')}`;
const flag = (value) => (value ? 1 : 0);
const degrees = (value) => value.toFixed(1);
const signed = (value) => `${value > 0 ? '+' : value < 0 ? '-' : ''}${Math.abs(value).toFixed(1)}`;

// What a thermostat's message says, for the log: '' when it is not one of
// its answers or too short to read.
function thermostatText(opcode, data) {
  if (opcode === STATUS) {
    const s = parseThermostatStatus(data);
    return s ? ` thermostat on=${flag(s.on)} heating=${flag(s.heating)} setPoint=${degrees(s.setPoint)}`
      + ` window=${flag(s.window)} childLock=${flag(s.childLock)} clockSet=${flag(s.clockSet)}`
      + ` paused=${flag(s.paused)} schedule=${flag(s.schedule)} errors=${hex2(s.errors)} firmware=${s.firmware}`
      + ` loc=${hex4(s.location)}` : '';
  }
  if (opcode === THERMOSTAT_TEMPERATURES) {
    const t = parseThermostatTemperatures(data);
    return t ? ` thermostat room=${degrees(t.room)} floor=${degrees(t.floor)} floorLimit=${degrees(t.floorLimit)}`
      + ` loc=${hex4(t.location)}` : '';
  }
  if (opcode === THERMOSTAT_SETTINGS) {
    const s = parseThermostatSettings(data);
    return s ? ` thermostat roomOffset=${signed(s.roomOffset)} floorOffset=${signed(s.floorOffset)} b4=${s.b4} b5=${s.b5}`
      + ` sensorType=${s.sensorType} adaptive=${flag(s.adaptive)} windowDetection=${flag(s.windowDetection)}`
      + ` loc=${hex4(s.location)}` : '';
  }
  if (opcode === THERMOSTAT_PRESETS) {
    const p = parseThermostatPresets(data);
    return p ? ` thermostat presets=${p.presets.map(degrees).join('/')} loc=${hex4(p.location)}` : '';
  }
  if (opcode === THERMOSTAT_ACK) {
    const a = parseThermostatAck(data);
    return a ? ` thermostat acknowledged ${a.opcode.toString(16).toUpperCase()} loc=${hex4(a.location)}` : '';
  }
  return '';
}

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
    this._nameRequests = [];     // the FF10 variants of the latest request that got out: { location, at, meshId when to one }
    // mesh id -> its location id as learned from its FF05, FF50, FF3D and
    // FF5C (lib/location.js), from any sender, added or not; for FF10 only.
    this._statusLocations = new Map();
    this._timer = null;
    this._waiting = new Set();   // timers of FF04s that wait for a listening to end
    this._thermostats = new Map(); // mesh id -> { askedAt: when FF3C 01 and 02 last went }
    this._thermostatTimer = null;
    this._thermostatReads = Promise.resolve(); // one reading after another
    this._readings = 0;          // thermostat readings waiting or running
    this._readingSince = null;   // when the oldest of them was queued
    this._expected = new Map();  // `${meshId} ${answer opcode}` -> { answered } for a request out
    this._stopped = false;
  }

  start() {
    this._timer = this.homey.setTimeout(() => {
      this._timer = null;
      this.requestNames({ listenMs: NAME_LISTEN_MS })
        .catch((err) => this.app.error(`[CSR] name request failed: ${err.message || err}`));
    }, FIRST_NAME_REQUEST_MS);
  }

  stop() {
    this._stopped = true;
    if (this._timer) this.homey.clearTimeout(this._timer);
    this._timer = null;
    if (this._thermostatTimer) this.homey.clearTimeout(this._thermostatTimer);
    this._thermostatTimer = null;
    for (const timer of this._waiting) this.homey.clearTimeout(timer);
    this._waiting.clear();
  }

  // From MeshBridge.onFrame: a decrypted frame that is not a first generation
  // status. Our own messages come back through the mesh with our address.
  handleFrame({ src, plain }) {
    const ext = parseExt(plain);
    if (!ext) return;
    // A set point or preset to a thermostat added here, from any address,
    // 0x8000 too; the device drops our own by its tid.
    if (THERMOSTAT_COMMANDS[ext.opcode] && this._thermostatDevices(ext.dst).length) {
      this._heardThermostatCommand(src, ext);
      return;
    }
    if (src === ADDR_APP) return;
    // A thermostat (known by its FF11): its answers are logged in words and go
    // to its device.
    if (ext.opcode !== NAME && this.isThermostat(src)) {
      const expected = this._expected.get(`${src} ${ext.opcode}`);
      if (expected) expected.answered = true;
      this._log(src, ext, null, thermostatText(ext.opcode, ext.data) || ' thermostat');
      const [kind, read] = THERMOSTAT_ANSWERS[ext.opcode] || [];
      const parsed = read ? read(ext.data) : null;
      if (parsed) for (const device of this._thermostatDevices(src)) device.applyThermostat(kind, parsed);
      return;
    }
    let parsed = null;
    if (ext.opcode === NAME) parsed = parseCsrName(ext.data);
    else if (ext.opcode === STATUS) parsed = parseCsrStatus(ext.data);
    else if (ext.opcode === FAST_STATUS) parsed = parseCsrFastStatus(ext.data);
    this._log(src, ext, parsed);
    // A thermostat not known by its FF11 yet: its temperatures and settings
    // carry its location id, for FF10.
    if (ext.opcode === THERMOSTAT_TEMPERATURES || ext.opcode === THERMOSTAT_SETTINGS) {
      const [, read] = THERMOSTAT_ANSWERS[ext.opcode];
      const answer = read(ext.data);
      if (answer) this._heardLocation(src, answer.location);
    }
    if (!parsed) return;
    if (ext.opcode === NAME) this._onName(src, parsed);
    else this._onStatus(src, ext.opcode, parsed);
  }

  // The FF10 variant written last before now, if one went out less than
  // NAME_REQUEST_MIN_MS ago: one to everyone, or one to src itself.
  _nameRequestBefore(now, src) {
    const before = this._nameRequests.filter((r) => r.at <= now && now - r.at < NAME_REQUEST_MIN_MS
      && (r.meshId === undefined || r.meshId === src));
    return before.length ? before[before.length - 1] : null;
  }

  // thermostat: what a thermostat's message says, in place of parsed.
  _log(src, ext, parsed, thermostat = '') {
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
    const after = ext.opcode === NAME ? this._nameRequestBefore(now, src) : null;
    const key = `${src} ${ext.opcode} ${data}${after ? ` ${after.location}${after.meshId === undefined ? '' : ' direct'}` : ''}`;
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
    let about = thermostat;
    if (parsed && ext.opcode === NAME) {
      const product = csrProductForName(parsed.name);
      about = ` name=${parsed.name} product=${product ? `"${product.name} (${product.generation})"` : 'unknown'}`
        + ` loc=${hex4(parsed.location)} reset=${parsed.resets}`
        + `${after ? ` after FF10 loc=${hex4(after.location)}${after.meshId === undefined ? '' : ' to this device'}`
          + ` (+${((now - after.at) / 1000).toFixed(1)} s)` : ''}`;
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
    for (const device of this._devicesFor(src, 'applyCsrName')) device.applyCsrName(name);
    // A thermostat added in Homey is read from now on, with FF04 among its
    // requests; one that is not added is only known. A mesh id that was one
    // and now names another product is not read.
    if (product && product.kind === 'thermostat') {
      if (name.location && this._thermostatDevices(src).length) this._watchThermostat(src);
      return;
    }
    if (this._thermostats.has(src)) this._stillThermostat(src);
    // Once per node, for the log: does it answer FF04 with FF05? Not while
    // the link still listens for the FF11 answers (a search), but when that
    // is over, so it does not end the listening.
    if (product && name.location && !this._statusAsked.has(src)) {
      this._statusAsked.add(src);
      this._afterListening(() => this.requestStatus(src, name.location).catch(() => {}));
    }
  }

  // Whether the node with this mesh id is a thermostat, by its latest FF11.
  isThermostat(meshId) {
    const node = this.nodes.get(meshId);
    return !!(node && node.product && node.product.kind === 'thermostat');
  }

  // A watched mesh id that no longer is a thermostat (another product has
  // it now) is not read any more, and the log says so once.
  _stillThermostat(meshId) {
    if (this.isThermostat(meshId)) return true;
    if (this._thermostats.delete(meshId)) {
      const node = this.nodes.get(meshId);
      this.app.log(`[CSR] ${hex4(meshId)} is ${node ? node.name : 'not known'} now, not a thermostat: no longer read`);
    }
    return false;
  }

  // A thermostat added in Homey (lib/SGThermostatDevice.js), known by the
  // name and location id it was added with until its own FF11 comes: read
  // from now on.
  watchThermostat(meshId, { name, location }) {
    const known = this.nodes.get(meshId);
    if (!known || !known.product || known.product.kind !== 'thermostat') {
      this.nodes.set(meshId, {
        meshId, name, product: csrProductForName(name), location: location || null, resets: null, seenAt: this.now(),
      });
    }
    if (location || (known && known.location)) this._watchThermostat(meshId);
  }

  // A thermostat deleted in Homey is not read any more.
  unwatchThermostat(meshId) {
    if (this._thermostats.delete(meshId)) this.app.log(`[CSR] thermostat ${hex4(meshId)}: deleted in Homey, no longer read`);
  }

  // A thermostat to read: now, and then every THERMOSTAT_EVERY_MS with the
  // others.
  _watchThermostat(meshId) {
    if (this._thermostats.has(meshId) || this._stopped) return;
    this._thermostats.set(meshId, { askedAt: null });
    this.app.log(`[CSR] thermostat ${hex4(meshId)}: read every ${THERMOSTAT_EVERY_MS / 60000} min`);
    this._queueReading([meshId]);
    if (!this._thermostatTimer) this._scheduleThermostats();
  }

  // Every THERMOSTAT_EVERY_MS all thermostats are read, one after another. A
  // round that comes while a reading is still waiting or running is skipped,
  // so readings that take long never pile up.
  _scheduleThermostats() {
    this._thermostatTimer = this.homey.setTimeout(() => {
      this._thermostatTimer = null;
      this._scheduleThermostats();
      if (this._readings > 0) {
        const ago = Math.round((this.now() - this._readingSince) / 1000);
        this.app.log(`[CSR] thermostat round skipped: the reading that began ${ago} s ago is not done`);
        return;
      }
      this._queueReading([...this._thermostats.keys()]);
    }, THERMOSTAT_EVERY_MS);
  }

  // A reading of these thermostats: once the link no longer listens, after
  // the reading before it. It counts as not done (_readings) from here until
  // its last request has gone out.
  _queueReading(meshIds) {
    this._readings += 1;
    if (this._readingSince === null) this._readingSince = this.now();
    this._afterListening(() => {
      this._thermostatReads = this._thermostatReads
        .then(() => this._readThermostats(meshIds))
        .catch((err) => this.app.error(`[CSR] thermostat reading failed: ${err.message || err}`))
        .finally(() => {
          this._readings -= 1;
          if (this._readings === 0) this._readingSince = null;
        });
    });
  }

  async _readThermostats(meshIds) {
    for (const meshId of meshIds) {
      if (this._stopped) return;
      await this._readThermostat(meshId)
        .catch((err) => this.app.error(`[CSR] thermostat ${hex4(meshId)} not read: ${err.message || err}`));
    }
  }

  // FF04 and FF3C 00, the first time and then once every
  // THERMOSTAT_SETTINGS_EVERY_MS also FF3C 01 and 02, THERMOSTAT_GAP_MS
  // apart. Before each request, a pairing scan that has the radio is waited
  // for, and the node must still be a thermostat. Each link listens
  // THERMOSTAT_LISTEN_MS for the answer.
  async _readThermostat(meshId) {
    const watched = this._thermostats.get(meshId);
    if (!watched) return;
    const asks = ['status', THERMOSTAT_ASK_TEMPERATURES];
    if (watched.askedAt === null || this.now() - watched.askedAt >= THERMOSTAT_SETTINGS_EVERY_MS) {
      asks.push(THERMOSTAT_ASK_SETTINGS, THERMOSTAT_ASK_PRESETS);
      watched.askedAt = this.now();
    }
    for (const [i, what] of asks.entries()) {
      if (i > 0) await this._wait(THERMOSTAT_GAP_MS);
      await this._scanOver();
      if (this._stopped || !this._stillThermostat(meshId)) return;
      const { location } = this.nodes.get(meshId);
      if (!location) return;
      await this._askThermostat(meshId, location, what, THERMOSTAT_LISTEN_MS);
    }
  }

  // One request to a thermostat, and a line in the log if its answer has not
  // come when the listening is over.
  async _askThermostat(meshId, location, what, listenMs) {
    const { label, answer } = THERMOSTAT_ASKS[what];
    const key = `${meshId} ${answer}`;
    const expected = { answered: false };
    this._expected.set(key, expected);
    let sent;
    if (what === 'status') {
      sent = await this.requestStatus(meshId, location, listenMs);
    } else {
      this.app.log(`[CSR] ${label} to thermostat ${hex4(meshId)} loc=${hex4(location)}`);
      sent = await this._send(thermostatRequestData({ meshId, location, what }),
        `csr:thermostat:${meshId}:${what}`, listenMs);
    }
    if (!sent || this._stopped) {
      if (this._expected.get(key) === expected) this._expected.delete(key);
      return;
    }
    const timer = this.homey.setTimeout(() => {
      this._waiting.delete(timer);
      if (this._expected.get(key) !== expected) return;
      this._expected.delete(key);
      if (!expected.answered) {
        this.app.log(`[CSR] thermostat ${hex4(meshId)}: no ${answer.toString(16).toUpperCase()} within `
          + `${listenMs / 1000} s of ${label}`);
      }
    }, listenMs);
    this._waiting.add(timer);
  }

  // A pairing scan that has the radio is waited for, THERMOSTAT_SCAN_RETRY_MS
  // at a time (MeshBridge.pauseForScan; its count is read from MeshBridge,
  // which has no getter for it).
  async _scanOver() {
    while (!this._stopped && this.app.bridge && this.app.bridge._scanPauses > 0) {
      this.app.log(`[CSR] thermostat reading waits ${THERMOSTAT_SCAN_RETRY_MS / 1000} s for the pairing scan`);
      await this._wait(THERMOSTAT_SCAN_RETRY_MS);
    }
  }

  _wait(ms) {
    return new Promise((resolve) => this.homey.setTimeout(resolve, ms));
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
    this._heardLocation(src, status.location);
    for (const device of this._devicesFor(src)) device.applyCsrStatus(status, opcode === STATUS ? 'FF05' : 'FF50');
  }

  // A location id src sent in a status (FF05, FF50) or a thermostat's
  // temperatures or settings (FF3D, FF5C), learned per sender as
  // lib/location.js does, for FF10 only; 0 counts not.
  _heardLocation(src, location) {
    if (!Number.isInteger(location) || location <= 0 || location > 0xffff) return;
    this._statusLocations.set(src, learnLocation(this._statusLocations.get(src), location).state);
  }

  // The devices added here with this mesh id that take method: applyCsrStatus
  // for a light or a plug, applyCsrName for those and a thermostat.
  _devicesFor(meshId, method = 'applyCsrStatus') {
    return this.app._devices().filter((device) => typeof device[method] === 'function'
      && device.getCsrMeshId() === meshId);
  }

  // The thermostat devices added here with this mesh id.
  _thermostatDevices(meshId) {
    return this._devicesFor(meshId, 'applyThermostat');
  }

  // A set point (FF3E) or preset (FF03) another sent a thermostat added here:
  // logged in words, and handed to its device, which only shows it.
  _heardThermostatCommand(src, ext) {
    const [kind, read] = THERMOSTAT_COMMANDS[ext.opcode];
    const parsed = read(ext.data);
    const about = !parsed ? ' to a thermostat, too short to read'
      : ` to a thermostat: ${kind === 'FF3E' ? `set point ${degrees(parsed.setPoint)}` : `preset ${parsed.preset}`}`
        + ` tid=${parsed.tid} loc=${hex4(parsed.location)}`;
    this._log(src, ext, null, about);
    if (!parsed) return;
    for (const device of this._thermostatDevices(ext.dst)) device.applyThermostatCommand(kind, parsed, src);
  }

  // FF10 to everyone: first with 00 00, which a device without a location id
  // is assumed to answer, then once with each location id known here
  // (_nameLocations), which a device of that home is assumed to answer.
  // NAME_VARIANT_GAP_MS between them. With `direct` (a search), then one FF10
  // to each device known by its mesh id (_nameTargets), with its location id,
  // NAME_DIRECT_GAP_MS between them: the devices heard here need no SG
  // account for it. That a generation 3 or 4 device (@GD, @GN, @GO, @ST and
  // the like) answers FF10 with its home's location id, to everyone or to
  // itself, is assumed: none has been tried, and none answered FF10 with
  // 00 00 in a home where they all sent their status.
  // Not more often than NAME_REQUEST_EVERY_MS, or with `asked` (a search, a
  // device without a location id) NAME_REQUEST_MIN_MS; the limit is for the
  // request as a whole, so it never stops a variant, and one whose link did
  // not listen never stops one that listens. With listenMs, each link listens
  // that long for the FF11 answers. Resolves once every variant has been
  // sent: true when one got out.
  async requestNames({ asked = false, listenMs = 0, direct = false } = {}) {
    const now = this.now();
    const wait = asked ? NAME_REQUEST_MIN_MS : NAME_REQUEST_EVERY_MS;
    const last = listenMs > 0 ? this._lastListeningNameRequestAt : this._lastNameRequestAt;
    if (last !== null && now - last < wait) return false;
    this._lastNameRequestAt = now;
    if (listenMs > 0) this._lastListeningNameRequestAt = now;
    this._nameRequests = [];
    let out = false;
    for (const [i, location] of [0, ...this._nameLocations()].entries()) {
      if (i > 0) await new Promise((resolve) => this.homey.setTimeout(resolve, NAME_VARIANT_GAP_MS));
      this.app.log(`[CSR] FF10 name request to everyone, loc=${hex4(location)}`);
      if (await this._send(csrNameRequestData(location), location ? `csr:names:${location}` : 'csr:names', listenMs)) {
        this._nameRequests.push({ location, at: this.now() });
        out = true;
      }
    }
    if (!direct) return out;
    for (const [meshId, location] of this._nameTargets()) {
      await new Promise((resolve) => this.homey.setTimeout(resolve, NAME_DIRECT_GAP_MS));
      this.app.log(`[CSR] FF10 name request to ${hex4(meshId)}, loc=${hex4(location)}`);
      if (await this._send(csrNameRequestData(location, meshId), `csr:names:${location}:${meshId}`, listenMs)) {
        this._nameRequests.push({ location, meshId, at: this.now() });
        out = true;
      }
    }
    return out;
  }

  // The devices a search asks one by one, as [mesh id, location id], sorted
  // by mesh id: each one heard here (_statusLocations), with the location id
  // it sent, and each later CSRmesh device in the SG account, with its home's
  // (none without an account); a device heard wins over the account. Not one
  // that has answered FF11 since the app started, one added in Homey, or our
  // own address.
  _nameTargets() {
    const targets = new Map();
    const { account } = this.app;
    const fromAccount = account && typeof account.deviceLocations === 'function' ? account.deviceLocations() : new Map();
    for (const [meshId, location] of fromAccount) targets.set(meshId, location);
    for (const [meshId, state] of this._statusLocations) {
      if (Number.isInteger(state.value) && state.value > 0) targets.set(meshId, state.value);
    }
    return [...targets.entries()]
      .filter(([meshId]) => Number.isInteger(meshId) && meshId > 0 && meshId < 0xffff && meshId !== ADDR_APP
        && !this.nodes.has(meshId) && this._devicesFor(meshId, 'getCsrMeshId').length === 0)
      .sort((a, b) => a[0] - b[0]);
  }

  // The location ids FF10 goes with after 00 00: the app's (knownLocations:
  // the first generation dimmers' status, a device added), the homes' in the
  // SG account (none without one), and those in the later products'
  // statuses heard so far (_statusLocations). A home without a first
  // generation dimmer and without a device in Homey has only the last two.
  // The app's first, as before, then the others sorted; none twice, never 0.
  _nameLocations() {
    const app = typeof this.app.knownLocations === 'function' ? this.app.knownLocations() : [];
    const { account } = this.app;
    const fromAccount = account && typeof account.locations === 'function' ? account.locations() : [];
    const heard = [...this._statusLocations.values()].map((state) => state.value);
    const valid = (location) => Number.isInteger(location) && location > 0;
    const first = app.filter(valid);
    const more = [...fromAccount, ...heard].filter((location) => valid(location) && !first.includes(location));
    return [...new Set([...first, ...more.sort((a, b) => a - b)])];
  }

  // FF04 to one device: its link listens for the FF05 answer, also when it
  // is not held. A thermostat's listens longer (listenMs).
  async requestStatus(meshId, location, listenMs = STATUS_LISTEN_MS) {
    this.app.log(`[CSR] FF04 status request to ${hex4(meshId)} loc=${hex4(location)}`);
    return this._send(csrStatusRequestData({ meshId, location }), `csr:status:${meshId}`, listenMs);
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
  CsrNetwork, LISTEN_MARGIN_MS, LOG_PER_SENDER, LOG_WINDOW_MS, NAME_DIRECT_GAP_MS, NAME_LISTEN_MS, NAME_REQUEST_EVERY_MS,
  NAME_REQUEST_MIN_MS, NAME_VARIANT_GAP_MS, SEARCH_LISTEN_MS, STATUS_LISTEN_MS, THERMOSTAT_EVERY_MS, THERMOSTAT_GAP_MS,
  THERMOSTAT_LISTEN_MS, THERMOSTAT_SCAN_RETRY_MS, THERMOSTAT_SETTINGS_EVERY_MS,
};
