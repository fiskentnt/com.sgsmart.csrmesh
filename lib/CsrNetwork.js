'use strict';

const { makePacket } = require('./csrmesh');
const {
  ADDR_APP, ADDR_BROADCAST, OP_EXT_FAST_STATUS, OP_EXT_LEVEL, OP_EXT_NAME, OP_EXT_STATUS, OP_EXT_THERMOSTAT_ACK,
  OP_EXT_THERMOSTAT_PRESETS, OP_EXT_THERMOSTAT_SET_POINT, OP_EXT_THERMOSTAT_SETTINGS, OP_EXT_THERMOSTAT_TEMPERATURES,
  THERMOSTAT_ASK_PRESETS, THERMOSTAT_ASK_SETTINGS, THERMOSTAT_ASK_TEMPERATURES,
  csrNameRequestData, csrStatusRequestData, opcodeValue,
  parseCsrFastStatus, parseCsrName, parseCsrStatus, parseExt, parseThermostatAck, parseThermostatPresetChoice,
  parseThermostatPresets,
  parseThermostatSetPoint, parseThermostatSettings, parseThermostatStatus, parseThermostatTemperatures, statusRequestData,
  thermostatRequestData,
} = require('./sgProtocol');
const { csrProductForName, driverForType } = require('./sgProducts');
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
// After the last FF10 to everyone, before a search chooses the devices it
// asks one by one: the answers to the one to everyone come within a second
// or two (assumed), and a device that has answered needs no FF10 of its own.
const NAME_ANSWER_WAIT_MS = 1500;
// How long a search listens for FF11 answers.
const SEARCH_LISTEN_MS = 8000;
// A search's FF10 to one device at a time goes to at most this many devices,
// those asked longest ago first, so a pairing stays short in a home with
// many; the others are asked at the next search.
const DIRECT_MAX = 10;
// How long the link that sent a request stays to hear the answers: the
// listening, and a second for its end (lib/MeshBridge.js, listenMs).
const LISTEN_MARGIN_MS = 1000;
// How long the link of an FF10 listens for FF11: at start, from a device
// and in a search.
const NAME_LISTEN_MS = SEARCH_LISTEN_MS + LISTEN_MARGIN_MS;
// How long the link that sent FF04 or FFFF stays to hear the status it asks
// for.
const STATUS_LISTEN_MS = 3000;
// The status polls of the devices after the first generation
// (lib/SGCsrDevice.js, requestStatus), and the FF04 a search sends each node
// that answered FF11, go through one queue, so they do not go out in a burst:
// the oldest first, each device once, and the next one handed to the bridge
// only POLL_SLOT_MS after the one before was written. bridge.send answers
// when a packet is written (or given up), so while the link is down the
// queue waits instead of piling FF04s up in the bridge. A device that sent a
// status in the last POLL_SKIP_HEARD_MS (one a device took, see _onStatus) is
// skipped when its turn comes. A
// round runs from the first queued until the queue is empty; STATUS_LISTEN_MS
// after its last FF04 was written one line says how many were asked, how many
// answered within that time of their write, and how many were skipped. An
// FF04 the bridge gives up on ends the round, and the line says so, so the
// rest do not each wait for the link in turn; they ask again at their next
// turn. A pairing pause (lib/MeshBridge.js, pauseForScan) and stop empty the
// queue. The SG account's check (lib/account.js) queues all its devices at
// once (queueStatusAll) and waits for the round to end.
const POLL_SLOT_MS = 800;
const POLL_SKIP_HEARD_MS = 30 * 1000;
// bridge.send answers when the packet is written or given up, but not when
// the bridge shuts down, nor while one of its Bluetooth calls without a time
// limit hangs (assumed: not seen). So the shared pace (_paced) waits for it
// at most this long, and then counts the FF04 or FF3C as given up.
const POLL_GIVE_UP_MS = 60 * 1000;
// The log: the same message from the same sender at most once a minute, and
// at most LOG_PER_SENDER lines a minute from one sender. The first FF11 and
// the first FF05 from each sender are always logged.
const LOG_WINDOW_MS = 60 * 1000;
const LOG_PER_SENDER = 20;
// A frame from a sender that was asked something from here (a request or a
// command, to it or to everyone) less than this long ago counts as asked;
// any other frame as unasked, whatever its opcode. Counted per opcode, for
// the held link's lines in the log (MeshBridge).
const ASKED_MS = 3000;
const emptyCounts = () => ({ asked: {}, unasked: {} });
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
    this._paceChain = Promise.resolve(); // the FF04s and FF3Cs that share one pace (_paced)
    this._pacedWrittenAt = null; // when the last of them was written
    this._thermostatReads = Promise.resolve(); // one reading after another
    this._readings = 0;          // thermostat readings waiting or running
    this._readingSince = null;   // when the oldest of them was queued
    this._expected = new Map();  // `${meshId} ${answer opcode}` -> { answered } for a request out
    this._askedAt = new Map();   // mesh id -> when it was last asked something from here
    this._directAskedAt = new Map(); // mesh id -> when a search last sent it FF10 directly
    this._askedAllAt = null;     // when everyone was last asked
    this._quietAskedAt = new Map(); // mesh id -> when the held link's quiet FF04 last asked it
    this._frameCounts = { link: emptyCounts(), minute: emptyCounts() };
    this._lastStatusAt = new Map(); // mesh id -> when its last FF05 or FF50 came
    // The status poll queue (queueStatus).
    this._poll = {
      queue: [], timer: null, round: null, busy: false,
    };
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
    this.clearPollQueue('stop');
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
  handleFrame({ src, plain, ttl = null }) {
    const ext = parseExt(plain);
    if (!ext) return;
    // A set point or preset to a thermostat added here, from any address,
    // 0x8000 too; the device drops our own by its tid.
    if (THERMOSTAT_COMMANDS[ext.opcode] && this._thermostatDevices(ext.dst).length) {
      this._heardThermostatCommand(src, ext, ttl);
      return;
    }
    if (src === ADDR_APP) return;
    this._countFrame(src, ext.opcode);
    // A thermostat (known by its FF11): its answers are logged in words and go
    // to its device.
    if (ext.opcode !== NAME && this.isThermostat(src)) {
      const expected = this._expected.get(`${src} ${ext.opcode}`);
      if (expected) expected.answered = true;
      this._log(src, ext, null, thermostatText(ext.opcode, ext.data) || ' thermostat', ttl);
      const [kind, read] = THERMOSTAT_ANSWERS[ext.opcode] || [];
      const parsed = read ? read(ext.data) : null;
      if (parsed) for (const device of this._thermostatDevices(src)) device.applyThermostat(kind, parsed);
      return;
    }
    let parsed = null;
    if (ext.opcode === NAME) parsed = parseCsrName(ext.data);
    else if (ext.opcode === STATUS) parsed = parseCsrStatus(ext.data);
    else if (ext.opcode === FAST_STATUS) parsed = parseCsrFastStatus(ext.data);
    this._log(src, ext, parsed, '', ttl);
    // A thermostat not known by its FF11 yet: its temperatures and settings
    // carry its location id, for FF10.
    if (ext.opcode === THERMOSTAT_TEMPERATURES || ext.opcode === THERMOSTAT_SETTINGS) {
      const [, read] = THERMOSTAT_ANSWERS[ext.opcode];
      const answer = read(ext.data);
      if (answer) this._heardLocation(src, answer.location);
    }
    if (!parsed) return;
    if (ext.opcode === NAME) this._onName(src, parsed);
    else this._onStatus(src, ext.opcode, parsed, ext.data);
  }

  // Something was asked of meshId from here (ADDR_BROADCAST: of everyone).
  noteAsked(meshId) {
    if (meshId === ADDR_BROADCAST) this._askedAllAt = this.now();
    else this._askedAt.set(meshId, this.now());
  }

  // When this app last sent the device with this mesh id something of its
  // own (a request or a command, noteAsked), or 0: for its tid
  // (lib/SGCsrDevice.js).
  lastAskedAt(meshId) {
    return this._askedAt.get(meshId) || 0;
  }

  _asked(src, now) {
    const at = Math.max(this._askedAt.get(src) || 0, this._askedAllAt || 0);
    return at > 0 && now - at < ASKED_MS;
  }

  // A frame from another sender, counted by opcode in each bucket: asked or
  // unasked (ASKED_MS).
  _countFrame(src, opcode) {
    const now = this.now();
    const kind = this._asked(src, now) ? 'asked' : 'unasked';
    const name = opcode.toString(16).toUpperCase().padStart(4, '0');
    for (const counts of Object.values(this._frameCounts)) counts[kind][name] = (counts[kind][name] || 0) + 1;
    // Kept a minute when the map is pruned: a device's tid looks further back
    // than ASKED_MS (lastAskedAt).
    if (this._askedAt.size > 1000) {
      for (const [meshId, at] of this._askedAt) if (now - at >= LOG_WINDOW_MS) this._askedAt.delete(meshId);
    }
  }

  // The frames counted in a bucket ('link' or 'minute') since it was last
  // taken: { asked: { opcode: n }, unasked: { opcode: n } }. It starts again.
  takeFrameCounts(bucket) {
    const counts = this._frameCounts[bucket];
    this._frameCounts[bucket] = emptyCounts();
    return counts;
  }

  // The counts as one part of a line, opcodes in order, no sender.
  static frameCountsText({ asked, unasked }) {
    const part = (counts) => Object.keys(counts).sort().map((opcode) => `${opcode} ${counts[opcode]}`).join(', ') || 'none';
    return `asked ${part(asked)}; unasked ${part(unasked)}`;
  }

  // The FF10 variant written last before now, if one went out less than
  // NAME_REQUEST_MIN_MS ago: one to everyone, or one to src itself.
  _nameRequestBefore(now, src) {
    const before = this._nameRequests.filter((r) => r.at <= now && now - r.at < NAME_REQUEST_MIN_MS
      && (r.meshId === undefined || r.meshId === src));
    return before.length ? before[before.length - 1] : null;
  }

  // thermostat: what a thermostat's message says, in place of parsed.
  // ttl: the frame's last byte as it came (MeshBridge), shown as a raw
  // number in the line; it is not part of what makes a line the same.
  _log(src, ext, parsed, thermostat = '', ttl = null) {
    const now = this.now();
    const data = ext.data.toString('hex');
    const first = (ext.opcode === NAME || ext.opcode === STATUS) && !this._firstSeen.has(`${src} ${ext.opcode}`);
    if (first) this._firstSeen.add(`${src} ${ext.opcode}`);
    let sender = this._senders.get(src);
    if (!sender || now - sender.since >= LOG_WINDOW_MS) {
      sender = { since: now, count: 0, skipped: sender ? sender.skipped : 0 };
      this._senders.set(src, sender);
    }
    // An answer to the held link's quiet FF04, every few seconds: counted
    // (_countFrame), not logged, unless it is the sender's first.
    const quietAt = this._quietAskedAt.get(src);
    if (!first && quietAt !== undefined && now - quietAt < ASKED_MS) {
      sender.skipped += 1;
      return;
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
    const ttlText = Number.isInteger(ttl) ? ` ttl=${ttl}` : '';
    let about = `${thermostat}${ttlText}`;
    if (parsed && ext.opcode === NAME) {
      const product = csrProductForName(parsed.name);
      about = ` name=${parsed.name} product=${product ? `"${product.name} (${product.generation})"` : 'unknown'}`
        + ` loc=${hex4(parsed.location)}${ttlText} reset=${parsed.resets}`
        + `${after ? ` after FF10 loc=${hex4(after.location)}${after.meshId === undefined ? '' : ' to this device'}`
          + ` (+${((now - after.at) / 1000).toFixed(1)} s)` : ''}`;
    } else if (parsed) {
      about = ` on=${parsed.on ? 1 : 0} level=${parsed.level === null ? '-' : parsed.level} loc=${hex4(parsed.location)}${ttlText}`;
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
    // is over, so it does not end the listening; through the poll queue, so
    // the nodes a search heard are not asked in a burst.
    if (product && name.location && !this._statusAsked.has(src)) {
      this._statusAsked.add(src);
      this._afterListening(() => this.queueStatus(src, name.location));
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

  // One after another. A request the bridge gave up on, or did not answer
  // in POLL_GIVE_UP_MS, ends the reading, with a line that says so, so the
  // reading can never stand still and the others do not each wait for the
  // link in turn; they are read again in the next round.
  async _readThermostats(meshIds) {
    for (const [n, meshId] of meshIds.entries()) {
      if (this._stopped) return;
      const outcome = await this._readThermostat(meshId)
        .catch((err) => this.app.error(`[CSR] thermostat ${hex4(meshId)} not read: ${err.message || err}`));
      if (outcome && outcome.gaveUp) {
        this.app.log(`[CSR] thermostat reading ended: ${outcome.label} to ${hex4(meshId)} not written in `
          + `${Math.round(outcome.waitedMs / 1000)} s (${outcome.noAnswer ? 'no answer from the bridge, ' : ''}given up), `
          + `${meshIds.length - n - 1} thermostat(s) not read`);
        return;
      }
    }
  }

  // FF04 and FF3C 00, the first time and then once every
  // THERMOSTAT_SETTINGS_EVERY_MS also FF3C 01 and 02, THERMOSTAT_GAP_MS
  // apart. Every request goes in the pace it shares with the poll queue
  // (_paced), so two thermostats are not asked back to back either. Before
  // each request, a pairing scan that has the radio is waited for, and the
  // node must still be a thermostat. Each link listens THERMOSTAT_LISTEN_MS
  // for the answer.
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
      if (!location) return null;
      const outcome = await this._askThermostat(meshId, location, what, THERMOSTAT_LISTEN_MS);
      if (outcome && outcome.gaveUp) return outcome;
    }
    return null;
  }

  // One request to a thermostat, in the shared pace (_paced), and a line in
  // the log if its answer has not come when the listening is over. Given up
  // (the bridge gave up, or did not answer in POLL_GIVE_UP_MS), it says so to
  // the reading: { gaveUp, label, noAnswer, waitedMs }.
  async _askThermostat(meshId, location, what, listenMs) {
    const { label, answer } = THERMOSTAT_ASKS[what];
    const key = `${meshId} ${answer}`;
    const expected = { answered: false };
    this._expected.set(key, expected);
    const askedAt = this.now();
    let result;
    if (what === 'status') {
      result = await this._paced(() => this._requestStatusResult(meshId, location, listenMs));
    } else {
      this.app.log(`[CSR] ${label} to thermostat ${hex4(meshId)} loc=${hex4(location)}`);
      result = await this._paced(() => this._sendResult(thermostatRequestData({ meshId, location, what }),
        `csr:thermostat:${meshId}:${what}`, listenMs));
    }
    if (!(result && result.ok) || this._stopped) {
      if (this._expected.get(key) === expected) this._expected.delete(key);
      if (result && result.failed && !this._stopped) {
        return {
          gaveUp: true, label, noAnswer: !!result.noAnswer, waitedMs: this.now() - askedAt,
        };
      }
      return null;
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
    return null;
  }

  // One pace for the FF04s and FF3Cs of the poll queue and of the thermostat
  // reading: a send waits for the one before (written, given up, or
  // POLL_GIVE_UP_MS without an answer), and then POLL_SLOT_MS when that was
  // written less than POLL_SLOT_MS ago, so none of them is written sooner than
  // POLL_SLOT_MS after another, whichever sent it. The read-back after a
  // command and the held link's own FF04 are not in it. Resolves with what the
  // bridge answered (_sendResult), or { failed, noAnswer }; null when stopped.
  _paced(send) {
    const turn = this._paceChain.then(async () => {
      if (this._stopped) return null;
      if (this._pacedWrittenAt !== null && this.now() - this._pacedWrittenAt < POLL_SLOT_MS) await this._wait(POLL_SLOT_MS);
      if (this._stopped) return null;
      const result = await this._capped(send());
      if (result && result.ok) this._pacedWrittenAt = this.now();
      return result;
    });
    this._paceChain = turn.catch(() => {});
    return turn;
  }

  // What the bridge answers for a send (_sendResult), or { failed, noAnswer }
  // when it has not answered in POLL_GIVE_UP_MS.
  _capped(sending) {
    return new Promise((resolve) => {
      const timer = this.homey.setTimeout(() => {
        this._waiting.delete(timer);
        resolve({ failed: true, noAnswer: true });
      }, POLL_GIVE_UP_MS);
      this._waiting.add(timer);
      sending.then((result) => result, () => ({ failed: true })).then((result) => {
        this.homey.clearTimeout(timer);
        this._waiting.delete(timer);
        resolve(result);
      });
    });
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

  // A status counts as heard for the poll queue (_lastStatusAt, and answered
  // in its round), and its location id goes to the node (node.location: the
  // location id a device added from the pairing gets, the one a thermostat is
  // asked with, and the SG account's check's for a device without its own),
  // only when a device here took it, or when no device here has this mesh id.
  // One a device did not take (another location id, an exact copy, its quiet
  // time) does not make the next FF04 to it be skipped, nor change the node.
  _onStatus(src, opcode, status, data = null) {
    this._heardLocation(src, status.location);
    const devices = this._devicesFor(src);
    let taken = devices.length === 0;
    for (const device of devices) {
      if (device.applyCsrStatus(status, opcode === STATUS ? 'FF05' : 'FF50', data) === true) taken = true;
    }
    if (!taken) return;
    const node = this.nodes.get(src);
    if (node && status.location) node.location = status.location;
    this._lastStatusAt.set(src, this.now());
    const { round } = this._poll;
    if (round) {
      const askedAt = round.asked.get(src);
      if (askedAt !== undefined && this.now() - askedAt <= STATUS_LISTEN_MS) round.answered.add(src);
    }
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
  _heardThermostatCommand(src, ext, ttl = null) {
    const [kind, read] = THERMOSTAT_COMMANDS[ext.opcode];
    const parsed = read(ext.data);
    const about = !parsed ? ' to a thermostat, too short to read'
      : ` to a thermostat: ${kind === 'FF3E' ? `set point ${degrees(parsed.setPoint)}` : `preset ${parsed.preset}`}`
        + ` tid=${parsed.tid} loc=${hex4(parsed.location)}`;
    this._log(src, ext, null, about, ttl);
    if (!parsed) return;
    for (const device of this._thermostatDevices(ext.dst)) device.applyThermostatCommand(kind, parsed, src);
  }

  // FF10 to everyone: first with 00 00, which a device without a location id
  // is assumed to answer, then once with each location id known here
  // (_nameLocations), which a device of that home is assumed to answer.
  // NAME_VARIANT_GAP_MS between them. With `direct` (a search), then one FF10
  // to each device known by its mesh id (_nameTargets), with its location id,
  // NAME_DIRECT_GAP_MS between them: the devices heard here need no SG
  // account for it. They are chosen NAME_ANSWER_WAIT_MS after the last FF10
  // to everyone, so that a device that answered it is not asked again. At
  // most DIRECT_MAX of them, those asked longest ago
  // first; with forDriver (the pairing's driver), only that driver's devices
  // in the SG account, and every device heard that is not in it. That a generation 3 or 4 device (@GD, @GN, @GO, @ST and
  // the like) answers FF10 with its home's location id, to everyone or to
  // itself, is assumed: none has been tried, and none answered FF10 with
  // 00 00 in a home where they all sent their status.
  // Not more often than NAME_REQUEST_EVERY_MS, or with `asked` (a search, a
  // device without a location id) NAME_REQUEST_MIN_MS; the limit is for the
  // request as a whole, so it never stops a variant, and one whose link did
  // not listen never stops one that listens. With listenMs, each link listens
  // that long for the FF11 answers. Resolves once every variant has been
  // sent: true when one got out.
  async requestNames({
    asked = false, listenMs = 0, direct = false, forDriver = null,
  } = {}) {
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
    if (out) await new Promise((resolve) => this.homey.setTimeout(resolve, NAME_ANSWER_WAIT_MS));
    const targets = this._nameTargets(forDriver);
    const askedAt = (meshId) => this._directAskedAt.get(meshId) || 0;
    const chosen = [...targets].sort((a, b) => askedAt(a[0]) - askedAt(b[0]) || a[0] - b[0])
      .slice(0, DIRECT_MAX).sort((a, b) => a[0] - b[0]);
    if (targets.length) {
      this.app.log(`[CSR] FF10 direct to ${chosen.length} of ${targets.length} device(s) that have not answered `
        + `(at most ${DIRECT_MAX}, those asked longest ago first)`);
    }
    for (const [meshId, location] of chosen) {
      this._directAskedAt.set(meshId, this.now());
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
  _nameTargets(forDriver = null) {
    const targets = new Map();
    const { account } = this.app;
    // With forDriver, a device the SG account has a type for goes only to
    // that type's driver; one it does not know (heard here only) always.
    const typeFor = forDriver && account && typeof account.typeFor === 'function' ? (meshId) => account.typeFor(meshId) : () => null;
    const forThisDriver = (meshId) => {
      const type = typeFor(meshId);
      return type === null || type === undefined || driverForType(type) === forDriver;
    };
    const fromAccount = account && typeof account.deviceLocations === 'function' ? account.deviceLocations() : new Map();
    for (const [meshId, location] of fromAccount) targets.set(meshId, location);
    for (const [meshId, state] of this._statusLocations) {
      if (Number.isInteger(state.value) && state.value > 0) targets.set(meshId, state.value);
    }
    return [...targets.entries()]
      .filter(([meshId]) => Number.isInteger(meshId) && meshId > 0 && meshId < 0xffff && meshId !== ADDR_APP
        && !this.nodes.has(meshId) && this._devicesFor(meshId, 'getCsrMeshId').length === 0 && forThisDriver(meshId))
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

  // A status poll for one device (see POLL_SLOT_MS): queued once, sent in
  // turn by _pollNext. True when queued, false when it is there already, or
  // its FF04 is the one waiting to be written, or the network is stopped.
  queueStatus(meshId, location) {
    if (this._stopped) return false;
    if (this._poll.inFlight === meshId) return false;
    if (this._poll.queue.some((entry) => entry.meshId === meshId)) return false;
    this._poll.queue.push({ meshId, location });
    if (!this._poll.round) {
      this._poll.round = {
        asked: new Map(), answered: new Set(), skipped: new Set(), endTimer: null, waiting: [], gaveUp: null,
      };
    } else if (this._poll.round.endTimer) {
      // Queued again before the round's line: the round goes on.
      this.homey.clearTimeout(this._poll.round.endTimer);
      this._poll.round.endTimer = null;
    }
    if (!this._poll.timer && !this._poll.busy) this._pollNext();
    return true;
  }

  // Status polls for many devices at once (the SG account's check), each
  // queued as by queueStatus, and a promise for the end of the round they
  // are in: resolved with the mesh ids the round asked and skipped as heard
  // (also those queued by the devices themselves) and how it ended ('done'
  // STATUS_LISTEN_MS after its last FF04 was written, 'given up' when the
  // bridge gave up on one, or why the queue was emptied: 'pairing pause' or
  // 'stop'; then those not yet sent were dropped).
  // Nothing queued, or the network stopped: resolved at once.
  queueStatusAll(entries) {
    for (const { meshId, location } of entries) this.queueStatus(meshId, location);
    const { round } = this._poll;
    if (!round) return Promise.resolve({ asked: [], skipped: [], ended: this._stopped ? 'stop' : 'done' });
    return new Promise((resolve) => { round.waiting.push(resolve); });
  }

  // The round is over: its line, and those waiting for it get its result.
  _endPollRound(round, ended) {
    const counts = `${round.asked.size} asked, ${round.answered.size} answered within `
      + `${STATUS_LISTEN_MS / 1000} s, ${round.skipped.size} skipped as heard`;
    if (ended === 'done') this.app.log(`[CSR] poll: ${counts}`);
    if (ended === 'given up') {
      const { waitedMs, left, noAnswer } = round.gaveUp;
      this.app.log(`[CSR] poll: ${counts}; ended: an FF04 not written in ${Math.round(waitedMs / 1000)} s `
        + `(${noAnswer ? 'no answer from the bridge, ' : ''}given up), ${left} not asked`);
    }
    const result = { asked: [...round.asked.keys()], skipped: [...round.skipped], ended };
    for (const resolve of round.waiting) resolve(result);
    round.waiting = [];
  }

  // The next FF04 of the queue, now. The next one waits until this one is
  // written, and then POLL_SLOT_MS, also when the queue is empty, so one
  // queued meanwhile waits its turn; a device skipped as heard takes a slot
  // too.
  _pollNext() {
    this._poll.timer = null;
    const entry = this._poll.queue.shift();
    const { round } = this._poll;
    if (!entry || !round) return;
    const heardAt = this._lastStatusAt.get(entry.meshId);
    if (heardAt !== undefined && this.now() - heardAt < POLL_SKIP_HEARD_MS) {
      round.skipped.add(entry.meshId);
      this._pollSlot(round);
      return;
    }
    const handedAt = this.now();
    this._poll.busy = true;
    this._poll.inFlight = entry.meshId;
    this._paced(() => this._requestStatusResult(entry.meshId, entry.location))
      .catch((err) => {
        this.app.error(`[CSR] status poll of ${hex4(entry.meshId)} failed: ${err.message || err}`);
        return { failed: true };
      })
      .then((result) => this._pollWritten(round, entry, handedAt, result))
      .catch((err) => this.app.error(`[CSR] status poll after ${hex4(entry.meshId)} failed: ${err.message || err}`));
  }

  // An FF04 of the queue is through the bridge: asked from now when it was
  // written; a round whose FF04 was given up ends here.
  _pollWritten(round, entry, handedAt, result) {
    if (this._poll.round !== round) return; // emptied meanwhile (pause, stop)
    this._poll.busy = false;
    this._poll.inFlight = null;
    if (result && result.ok) {
      round.asked.set(entry.meshId, this.now());
    } else if (result && result.failed) {
      round.gaveUp = {
        meshId: entry.meshId, waitedMs: this.now() - handedAt, left: this._poll.queue.length, noAnswer: !!result.noAnswer,
      };
      this._poll.queue = [];
      this._poll.round = null;
      this._endPollRound(round, 'given up');
      return;
    }
    this._pollSlot(round);
  }

  // The slot after an FF04 (or a device skipped), and the round's line
  // STATUS_LISTEN_MS after the last.
  _pollSlot(round) {
    this._poll.timer = this.homey.setTimeout(() => this._pollNext(), POLL_SLOT_MS);
    if (!this._poll.queue.length) {
      round.endTimer = this.homey.setTimeout(() => {
        if (this._poll.round !== round) return;
        this._poll.round = null;
        this._endPollRound(round, 'done');
      }, STATUS_LISTEN_MS);
    }
  }

  // Empties the status poll queue and forgets the round: a pairing pause,
  // or stop. The devices ask again at their next turn; the account's check
  // ends with what went out.
  clearPollQueue(why) {
    const { queue, timer, round } = this._poll;
    if (timer) this.homey.clearTimeout(timer);
    if (round && round.endTimer) this.homey.clearTimeout(round.endTimer);
    this._poll = {
      queue: [], timer: null, round: null, busy: false,
    };
    if (queue.length || round) this.app.log(`[CSR] poll: cleared, ${queue.length} queued (${why})`);
    if (round) this._endPollRound(round, why);
  }

  // How many status polls wait in the queue.
  pollQueueLength() {
    return this._poll.queue.length;
  }

  // FF04 to one device: its link listens for the FF05 answer, also when it
  // is not held. A thermostat's listens longer (listenMs). A quiet one (the
  // held link's, every few seconds) has no line in the log, here or in
  // MeshBridge.
  async requestStatus(meshId, location, listenMs = STATUS_LISTEN_MS, { quiet = false } = {}) {
    if (!quiet) this.app.log(`[CSR] FF04 status request to ${hex4(meshId)} loc=${hex4(location)}`);
    return this._send(csrStatusRequestData({ meshId, location }), `csr:status:${meshId}`, listenMs, { quiet });
  }

  // An FF04 (requestStatus) with what the bridge answered: the poll queue's and
  // the thermostats'.
  async _requestStatusResult(meshId, location, listenMs = STATUS_LISTEN_MS) {
    this.app.log(`[CSR] FF04 status request to ${hex4(meshId)} loc=${hex4(location)}`);
    return this._sendResult(csrStatusRequestData({ meshId, location }), `csr:status:${meshId}`, listenMs);
  }

  // FFFF, once: assumed to make every first generation dimmer answer with its
  // status (not shown, as in lib/sgProtocol.js), heard on a link that listens
  // (a held one, or this one for STATUS_LISTEN_MS).
  async requestAllStatus() {
    this.app.log('[CSR] FFFF status request to everyone');
    return this._send(statusRequestData(), 'csr:status-all', STATUS_LISTEN_MS);
  }

  // Its destination counts as asked from when it is queued and again from
  // when it is written, which a slow link may delay.
  async _send(data, key, listenMs = 0, options = {}) {
    const result = await this._sendResult(data, key, listenMs, options);
    return !!(result && result.ok);
  }

  // As _send, with what the bridge answered: { ok }, { failed } (given up),
  // { superseded } (a newer one with the same key took its place).
  async _sendResult(data, key, listenMs = 0, { quiet = false } = {}) {
    const dst = data.readUInt16LE(0);
    this.noteAsked(dst);
    if (quiet) this._quietAskedAt.set(dst, this.now());
    const packet = makePacket(this.app.getNetworkKey(), this.app.nextSeq(), data);
    const meta = listenMs > 0 ? { key, listenMs } : { key };
    if (quiet) meta.quiet = true;
    const result = await this.app.bridge.send(packet, meta);
    if (result && result.ok) {
      this.noteAsked(dst);
      if (quiet) this._quietAskedAt.set(dst, this.now());
    }
    return result || null;
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
  ASKED_MS, CsrNetwork, DIRECT_MAX, LISTEN_MARGIN_MS, LOG_PER_SENDER, LOG_WINDOW_MS, NAME_ANSWER_WAIT_MS,
  NAME_DIRECT_GAP_MS, NAME_LISTEN_MS,
  NAME_REQUEST_MIN_MS, NAME_VARIANT_GAP_MS, POLL_GIVE_UP_MS, POLL_SKIP_HEARD_MS, POLL_SLOT_MS, SEARCH_LISTEN_MS,
  STATUS_LISTEN_MS, THERMOSTAT_EVERY_MS,
  THERMOSTAT_GAP_MS,
  THERMOSTAT_LISTEN_MS, THERMOSTAT_SCAN_RETRY_MS, THERMOSTAT_SETTINGS_EVERY_MS,
};
