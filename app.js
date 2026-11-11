'use strict';

const Homey = require('homey');
const MeshBridge = require('./lib/MeshBridge');
const { deriveNetworkKey, DEFAULT_PASSPHRASE, meshIdFromName } = require('./lib/csrmesh');
const { learnLocation } = require('./lib/location');
const { FileLog, maskLog } = require('./lib/FileLog');
const { CsrNetwork, STATUS_LISTEN_MS } = require('./lib/CsrNetwork');
const { isFakeDevice, loadFakes } = require('./lib/fakeDevices');
const { SgAccount } = require('./lib/account');
const { localText, localTime } = require('./lib/localTime');
const { sendToAll } = require('./lib/gen1All');

// App settings and their defaults. keepConnected ("Keep dimmers connected")
// has no stored default: unset, it follows the number of dimmers; see
// MeshBridge._keepConnected().
const DEFAULTS = {
  debugLogging: false,     // verbose BLE/GATT tracing, for troubleshooting only
};

// No status from a dimmer for this long: show a warning on it. A held link
// usually hears every dimmer about every 1.5 s, but the bridge itself has gone
// quiet for up to about 2 min; without it, a status poll runs every five
// minutes and can miss a round or two.
const NOT_HEARD_HELD_MS = 5 * 60 * 1000;
const NOT_HEARD_POLL_MS = 30 * 60 * 1000;
const NOT_HEARD_CHECK_MS = 60 * 1000;
// The same for a device after the first generation, held link or not: it is
// asked for its status every 10 min (a thermostat every 5), and whether it
// sends one by itself is not known.
const LATER_NOT_HEARD_MS = 30 * 60 * 1000;
// This app's own address in the mesh: a frame from it is our own coming back.
const OWN_ADDRESS = 0x8000;
// "Show log" on the settings page shows this many of the latest lines.
const LOG_VIEW_LINES = 500;
// While the held link through a later node asks every few seconds, a status
// line the same as a device's last is logged again only after this long.
const SAME_STATUS_LOG_MS = 10 * 60 * 1000;
// A scan in the queue (bleDiscover) waits for the one before it at most this
// long: Homey's scan takes about 10 s, and one that never ends must not hold
// the next ones for good.
const SCAN_QUEUE_WAIT_MS = 20 * 1000;

class SGSmartApp extends Homey.App {
  async onInit() {
    // A copy of the app's log in /userdata, always on, for "Show log".
    this.fileLog = new FileLog(this.homey);
    this.fileLog.install();

    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (this.homey.settings.get(key) === null) this.homey.settings.set(key, value);
    }

    this._startNotHeardCheck();
    // Location id per mesh id, from every status heard, learned as a dimmer
    // learns its own (see lib/location.js).
    this._locations = new Map();
    // Set when no status could be read at all (MeshBridge._startKeyCheck).
    this._statusUnreadable = false;
    // The timeline notification for that goes out at most once per start.
    this._passwordNotified = false;
    this.bridge = new MeshBridge(this);
    this.bridge.startStatus((idHex, level, location) => this._dispatchStatus(idHex, level, location));
    // SG's later CSRmesh products (lib/SGCsrDevice.js, a trial in 2.5.0).
    this.csr = new CsrNetwork(this);
    // The SG account in the app's settings (lib/account.js, 2.7.0): it
    // only notes who was heard, for "X of Y answer".
    this.account = new SgAccount(this);
    this.bridge.onFrame((frame) => this._onCsrFrame(frame));
    this.csr.start();
    this._registerFlowCards();
    // Only in a run with `homey app run` (lib/fakeDevices.js); otherwise null.
    // An error there never stops the start: it is logged.
    try {
      this.fakes = loadFakes(this);
    } catch (err) {
      this.fakes = null;
      this.error(`fake devices not loaded: ${err.message || err}`);
    }

    // "Keep dimmers connected", "Keep SG LEDDim Gen2 to 4 connected (test)"
    // and "Keep SG Smart 3.0 connected" take effect at once, without a
    // restart.
    this.homey.settings.on('set', (key) => {
      if (key === 'keepConnected' || key === 'laterKeepConnected') this.bridge.applyMode();
      if (key === 'sg3KeepConnected' && this._sg3) this._sg3.applyMode();
    });

    let seq = Number(this.homey.settings.get('seqCounter'));
    if (!Number.isInteger(seq) || seq < 0 || seq > 0xFFFFFF) {
      seq = 0x800000;
      this.homey.settings.set('seqCounter', seq);
    }
    this._seq = seq;

    this.log(`SG LEDDim v${this.homey.manifest.version} initialized`);
  }

  // Homey keeps BLE connections outside the app process: one left open here
  // survives an app restart and is only cleared by rebooting Homey. Release it.
  async onUninit() {
    if (this._sg3) await this._sg3.stop().catch((err) => this.error(`SG Smart 3.0 stop failed: ${err.message || err}`));
    if (this._notHeardTimer) this.homey.clearInterval(this._notHeardTimer);
    if (this.account) this.account.stop();
    if (this.csr) this.csr.stop();
    if (this.fakes) this.fakes.stop();
    if (this.bridge) {
      await this.bridge.shutdown().catch((err) => {
        this.error(`bridge shutdown failed: ${err.message || err}`);
      });
    }
    if (this.fileLog) await this.fileLog.flush().catch(() => {});
  }

  // "Show log" on the settings page (GET /log-view in api.js): a short summary
  // and the latest LOG_VIEW_LINES of the file log, with Bluetooth addresses,
  // UUIDs and device names hidden, for a tester to send privately to the
  // developer. It is not to be pasted in the forum.
  async logView() {
    const lines = await this.fileLog.tail(LOG_VIEW_LINES);
    const devices = this._devices();
    const dimmers = devices.filter((device) => typeof device.getMeshId === 'function').length;
    const csr = devices.filter((device) => typeof device.getCsrMeshId === 'function').length;
    const sg3 = devices.filter((device) => typeof device.getSg3Address === 'function').length;
    const keep = this.bridge && typeof this.bridge._keepConnected === 'function'
      ? (this.bridge._keepConnected() ? 'on' : 'off') : 'unknown';
    const at = (line) => (line && /^\d{4}-\d\d-\d\dT[\d:.]+Z/.test(line) ? line.slice(0, 24) : null);
    const from = at(lines[0]);
    const to = at(lines[lines.length - 1]);
    const summary = [
      `SG LEDDim ${this.homey.manifest.version}, Homey ${this.homey.version || 'unknown'}, `
        + `keep connected: ${keep}, detailed logging: ${this.homey.settings.get('debugLogging') ? 'on' : 'off'}`,
      `Dimmers: ${dimmers}, later generations: ${csr}, SG Smart 3.0: ${sg3}, groups: ${devices.length - dimmers - csr - sg3}`,
      `Log from ${from || 'unknown'} to ${to || 'unknown'}, ${lines.length} lines`,
    ];
    const names = devices.map((device) => device.getName());
    return {
      count: lines.length, from, to, fromShown: this._shownTime(from), toShown: this._shownTime(to),
      text: maskLog([...summary, ...lines].join('\n'), names),
    };
  }

  // A time in the log as "Show log" shows it: in Homey's time zone and
  // language, as "Fetched" on the settings page (lib/localTime.js), or in UTC
  // marked "UTC" when the zone cannot be used; null for none.
  _shownTime(iso) {
    if (!iso) return null;
    let zone = null;
    try {
      zone = this.homey.clock && typeof this.homey.clock.getTimezone === 'function' ? this.homey.clock.getTimezone() : null;
    } catch (err) {
      zone = null;
    }
    return localText(localTime(iso, zone), (key, tokens) => this.homey.__(key, tokens));
  }

  // Dimmers (not groups) paired in this app.
  dimmerCount() {
    return this._devices().filter((device) => typeof device.getMeshId === 'function').length;
  }

  // Devices after the first generation (lib/SGCsrDevice.js,
  // lib/SGThermostatDevice.js) paired in this app.
  laterCount() {
    return this._devices().filter((device) => typeof device.getCsrMeshId === 'function').length;
  }

  // A dimmer was initialised, added or deleted. The default of "Keep dimmers
  // connected" depends on how many there are, and the settings page shows it,
  // and shows the box only with one at least (keepConnectedShown).
  dimmersChanged() {
    if (this._dimmersTimer) this.homey.clearTimeout(this._dimmersTimer);
    this._dimmersTimer = this.homey.setTimeout(() => {
      this._dimmersTimer = null;
      this.homey.settings.set('keepConnectedDefault', this.dimmerCount() >= 2);
      this.homey.settings.set('keepConnectedShown', this.dimmerCount() >= 1);
      this._setLaterShown();
      if (this.bridge) this.bridge.applyMode();
      if (this._dimmerAdded) this._firstStatus();
    }, 2000);
  }

  // A device after the first generation was initialised, added or deleted:
  // "Keep SG LEDDim Gen2 to 4 connected (test)" is shown, as the 3.0 box, and
  // the link follows (applyMode).
  laterDevicesChanged() {
    if (this._laterTimer) this.homey.clearTimeout(this._laterTimer);
    this._laterTimer = this.homey.setTimeout(() => {
      this._laterTimer = null;
      this._setLaterShown();
      if (this.bridge) this.bridge.applyMode();
    }, 2000);
  }

  // The box shows only with a device after the first generation and no first
  // generation dimmer (laterKeepConnectedShown): with one, the link is held
  // through it already (keepConnected), and the box would do nothing.
  _setLaterShown() {
    this.homey.settings.set('laterKeepConnectedShown', this.dimmerCount() === 0 && this.laterCount() >= 1);
  }

  // "Keep SG LEDDim Gen2 to 4 connected (test)": the held link's FF04 every
  // few seconds (MeshBridge), always to the same one of our devices after
  // the first generation that has a location id: a light before a
  // thermostat, then the lowest mesh id. So a frame from any other device is
  // unasked, and the log shows whether they send status of their own. Quiet
  // in the log; the device says once that it is the one asked. False with
  // none to ask.
  async heldAsk() {
    const device = this._devices()
      .filter((d) => typeof d.getCsrMeshId === 'function' && d.getCsrLocationId() !== null)
      .sort((a, b) => (typeof b.applyCsrStatus === 'function') - (typeof a.applyCsrStatus === 'function')
        || a.getCsrMeshId() - b.getCsrMeshId())[0];
    if (!device) return false;
    if (this._heldAskTo !== device) {
      this._heldAskTo = device;
      device.log(`asked for its status every ${MeshBridge.HELD_ASK_MS / 1000} s while the link is held through a later node`);
    }
    return this.csr.requestStatus(device.getCsrMeshId(), device.getCsrLocationId(), STATUS_LISTEN_MS, { quiet: true });
  }

  // "Keep SG LEDDim Gen2 to 4 connected (test)" is on and in effect
  // (MeshBridge).
  laterHeld() {
    return !!this.bridge && this.bridge.laterHeld();
  }

  // A device's status line: while laterHeld, one the same as the device's
  // last is logged again only after SAME_STATUS_LOG_MS, as the device asked
  // answers every few seconds; otherwise every one, as before.
  logStatus(device, text) {
    if (this.laterHeld()) {
      if (!this._statusLines) this._statusLines = new WeakMap();
      const last = this._statusLines.get(device);
      if (last && last.text === text && Date.now() - last.at < SAME_STATUS_LOG_MS) return;
      this._statusLines.set(device, { text, at: Date.now() });
    }
    device.log(text);
  }

  // The frames counted since a bucket ('link' or 'minute') was last taken,
  // as a part of a line (lib/CsrNetwork.js); the bucket starts again.
  frameCountsText(bucket) {
    return CsrNetwork.frameCountsText(this.csr.takeFrameCounts(bucket));
  }

  // A dimmer was paired: its first status now, not at the next change or the
  // next poll. Decided after applyMode, which may just have started holding
  // the link; several added at once give one request.
  dimmerAdded() {
    this._dimmerAdded = true;
    this.dimmersChanged();
  }

  // On a held link FFFF, once; otherwise a status poll soon, which listens.
  _firstStatus() {
    this._dimmerAdded = false;
    if (!this.bridge) return;
    if (this.bridge._held && this.csr) {
      this.csr.requestAllStatus().catch((err) => this.error(`[CSR] status request failed: ${err.message || err}`));
    } else {
      this.bridge.pollSoon();
    }
  }

  // Every paired device, across all drivers, but the fake ones
  // (lib/fakeDevices.js): they have a network of their own, and nothing here
  // (the network key, the location ids for FF10, a status) may come from or
  // go to one.
  _devices() {
    const devices = [];
    try {
      for (const driver of Object.values(this.homey.drivers.getDrivers())) {
        devices.push(...driver.getDevices());
      }
    } catch (err) {
      this.error(`enumerating devices failed: ${err.message || err}`);
    }
    return devices.filter((device) => !isFakeDevice(device));
  }

  // An error about one device, as that device's own line: Homey puts the
  // device's id in front ([Device:...]), which "Show log" shows as dev-N, so
  // the device's name is not in the log.
  _deviceError(device, text) {
    if (device && typeof device.error === 'function') device.error(text);
    else this.error(text);
  }

  // What a device sends and asks through (lib/SGCsrDevice.js): this app, or
  // for a fake device the fake network. null for a fake device without one:
  // one left from a run with `homey app run`.
  networkFor(device) {
    if (!isFakeDevice(device)) return this;
    return this.fakes || null;
  }

  _dispatchStatus(idHex, level, location) {
    const meshId = parseInt(idHex, 16);
    this._locations.set(meshId, learnLocation(this._locations.get(meshId), location).state);
    if (this._statusUnreadable) this._statusReadable();
    this._statusHeard(idHex);
    // Dimmers first: a group shows the level its dimmers have just decided on.
    const devices = this._devices()
      .sort((a, b) => (typeof b.getMeshId === 'function') - (typeof a.getMeshId === 'function'));
    for (const device of devices) {
      if (typeof device.applyMeshStatus === 'function') {
        try {
          device.applyMeshStatus(idHex, level, location);
        } catch (err) {
          this._deviceError(device, `applying status failed: ${err.message || err}`);
        }
      }
    }
  }

  // The location id learned for a mesh id, or null.
  locationFor(meshId) {
    const state = this._locations ? this._locations.get(meshId) : undefined;
    return state && Number.isInteger(state.value) ? state.value : null;
  }

  // The location id every paired dimmer but this one has learned, when they
  // all have the same; null when none has one or they differ. For a dimmer
  // whose own status does not reach Homey (see SGDeviceBase._keptWaited).
  sharedLocation(exceptMeshId) {
    const seen = new Set();
    for (const device of this._devices()) {
      if (typeof device.getLocationId !== 'function' || device.getMeshId() === exceptMeshId) continue;
      const location = device.getLocationId();
      if (location !== null) seen.add(location);
    }
    return seen.size === 1 ? [...seen][0] : null;
  }

  // The location ids the app knows, for FF10 (lib/CsrNetwork.js, which adds
  // the SG account's and those in the later products' statuses): the first
  // generation dimmers' from their status, also those not added yet, and the
  // later products' added in Homey. Sorted, none twice, never 0.
  knownLocations() {
    const known = new Set();
    for (const state of (this._locations || new Map()).values()) {
      if (Number.isInteger(state.value) && state.value > 0) known.add(state.value);
    }
    for (const device of this._devices()) {
      let location = null;
      if (typeof device.getLocationId === 'function') location = device.getLocationId();
      else if (typeof device.getCsrLocationId === 'function') location = device.getCsrLocationId();
      if (Number.isInteger(location) && location > 0) known.add(location);
    }
    return [...known].sort((a, b) => a - b);
  }

  // The app's own flow card (.homeycompose/flow/actions): one A0 with a
  // level to all first generation dimmers of the home, 0 % off
  // (lib/gen1All.js).
  _registerFlowCards() {
    if (!this.homey.flow || typeof this.homey.flow.getActionCard !== 'function') return;
    this.homey.flow.getActionCard('gen1_all_level')
      .registerRunListener((args) => sendToAll(this, Math.round(Number(args.level) * 100)));
  }

  // A dimmer waits for its first status.
  requestStatus() {
    if (this.bridge) this.bridge.pollSoon();
  }

  // MeshBridge heard frames but could read no status: every dimmer shows why
  // as a warning, and stays available, until a frame is read (a first
  // generation status, or any frame from a later device). The timeline
  // gets one notification as well, at most once per start. Both point to the
  // login in the app settings while it can bring the password
  // (_loginMayHelp), else to the device settings as before.
  statusUnreadable() {
    if (this._statusUnreadable) return;
    this._statusUnreadable = true;
    this.log('no status could be read: the network password is probably wrong ("Network Isolation" in the SG app?)');
    this._updateAvailability();
    if (this._passwordNotified || !this.homey.notifications) return;
    this._passwordNotified = true;
    const excerpt = this.homey.__(this._loginMayHelp() ? 'notification.passwordWrongLogin' : 'notification.passwordWrong');
    this.homey.notifications.createNotification({ excerpt })
      .then(() => this.log('timeline notification sent: suspected wrong password'))
      .catch((err) => this.error(`timeline notification failed: ${err.message || err}`));
  }

  statusUnreadableText() {
    if (!this._statusUnreadable) return null;
    return this.homey.__(this._loginMayHelp() ? 'device.passwordWrongLogin' : 'device.passwordWrong');
  }

  // The SG account module is in this build and no account is fetched: the
  // login may bring the network password (lib/account.js).
  _loginMayHelp() {
    return !!(this.account && this.account.available() && !this.account.fetched());
  }

  // From lib/account.js after a fetch or "Forget SG account": while no
  // status can be read, the dimmers' warning is said again, as it depends on
  // whether an account is fetched; and the SG Smart 3.0 network is taken
  // again (_sg3Changed).
  accountChanged() {
    if (this._statusUnreadable) this._updateAvailability();
    this._sg3Changed();
  }

  _statusReadable() {
    this._statusUnreadable = false;
    this.log('status can be read again');
    this._updateAvailability();
  }

  _updateAvailability() {
    for (const device of this._devices()) {
      if (typeof device.updateAvailability === 'function') device.updateAvailability();
    }
  }

  // The status the app already gets is the only source: nothing is sent or
  // scanned for this. A dimmer's clock starts when the app first sees it, at
  // start or just after pairing. Homey is called only when the warning changes.
  _startNotHeardCheck() {
    this._heardAt = new Map(); // mesh id -> last status
    this._firstSeen = new WeakMap(); // device -> first check that saw it
    this._warned = new WeakMap(); // device -> true (set), false (cleared)
    // The devices after the first generation: their mesh id -> last frame
    // heard from it, and which of them is not heard (notHeard).
    this._csrHeardAt = new Map();
    this._csrUnheard = new WeakMap();
    this._notHeardTimer = this.homey.setInterval(() => this._checkNotHeard(), NOT_HEARD_CHECK_MS);
  }

  // A frame from MeshBridge that is not a first generation status: noted as
  // heard (for "X of Y answer" and "no contact"), then read by the CSRmesh
  // network. One from another sender than this app passed the key check, so
  // status can be read, as a first generation status shows (_dispatchStatus).
  _onCsrFrame(frame) {
    if (this._statusUnreadable && frame.src !== OWN_ADDRESS) this._statusReadable();
    this.account.heard(frame.src);
    this._csrHeard(frame.src);
    this.csr.handleFrame(frame);
  }

  // A device after the first generation was heard: a frame from its mesh id.
  // One that was not heard gets its warning cleared.
  _csrHeard(src) {
    if (!Number.isInteger(src) || src === OWN_ADDRESS || !this._csrHeardAt) return;
    const now = Date.now();
    const before = this._csrHeardAt.get(src);
    this._csrHeardAt.set(src, now);
    for (const device of this._devices()) {
      if (typeof device.getCsrMeshId !== 'function' || device.getCsrMeshId() !== src) continue;
      if (this._csrUnheard.get(device) !== true) continue;
      this._csrUnheard.set(device, false);
      const since = Math.max(before || 0, this._firstSeen.get(device) || 0);
      device.log(`heard again after ${Math.round((now - since) / 60000)} min`);
      device.updateAvailability();
    }
  }

  // Whether any frame from this mesh id has been heard since the app
  // started: a first generation status (_heardAt) or a later product's frame
  // (_csrHeardAt). For the pairing line (lib/csrPairing.js, noAnswerText).
  heardSinceStart(meshId) {
    return !!((this._heardAt && this._heardAt.has(meshId)) || (this._csrHeardAt && this._csrHeardAt.has(meshId)));
  }

  // Whether nothing has been heard from this device after the first
  // generation for LATER_NOT_HEARD_MS (its "no contact" warning).
  notHeard(device) {
    return !!(this._csrUnheard && this._csrUnheard.get(device) === true);
  }

  _statusHeard(idHex) {
    const id = parseInt(idHex, 16);
    const before = this._heardAt.get(id);
    const now = Date.now();
    this._heardAt.set(id, now);
    for (const device of this._devices()) {
      if (typeof device.getMeshId !== 'function' || device.getMeshId() !== id) continue;
      // Unknown after a start: clear a warning Homey may still show.
      if (this._warned.get(device) === false) continue;
      const wasSet = this._warned.get(device) === true;
      this._warned.set(device, false);
      device.unsetWarning().catch((err) => this.error(`clearing warning failed: ${err.message || err}`));
      if (wasSet) {
        const since = Math.max(before || 0, this._firstSeen.get(device) || 0);
        device.log(`warning cleared: status heard again after ${Math.round((now - since) / 60000)} min`);
      }
    }
  }

  // A first generation dimmer's status was heard within the time a dimmer
  // may go unheard before its warning (_checkNotHeard), for "X of Y answer"
  // (lib/account.js). Nothing is sent for it.
  recentlyHeard(meshId) {
    const at = this._heardAt ? this._heardAt.get(meshId) : undefined;
    const limit = this.bridge && this.bridge._held ? NOT_HEARD_HELD_MS : NOT_HEARD_POLL_MS;
    return Number.isFinite(at) && Date.now() - at < limit;
  }

  _checkNotHeard() {
    // The dimmers already say why: no status can be read at all.
    if (this._statusUnreadable) return;
    const now = Date.now();
    // Read only: which mode MeshBridge is in right now.
    const held = !!(this.bridge && this.bridge._held);
    const limit = held ? NOT_HEARD_HELD_MS : NOT_HEARD_POLL_MS;
    for (const device of this._devices()) {
      if (typeof device.getMeshId !== 'function') continue;
      if (!this._firstSeen.has(device)) this._firstSeen.set(device, now);
      const last = Math.max(this._heardAt.get(device.getMeshId()) || 0, this._firstSeen.get(device));
      if (now - last < limit || this._warned.get(device) === true) continue;
      this._warned.set(device, true);
      device.setWarning(this.homey.__('device.notHeard'))
        .catch((err) => this.error(`setting warning failed: ${err.message || err}`));
      device.log(`warning set: no status for ${Math.round((now - last) / 60000)} min `
        + `(limit ${limit / 60000} min, ${held ? 'held link' : 'without held link'})`);
    }
    // The devices after the first generation: their own warning, set by the
    // device (updateAvailability), which asks notHeard.
    for (const device of this._devices()) {
      if (typeof device.getCsrMeshId !== 'function') continue;
      if (!this._firstSeen.has(device)) this._firstSeen.set(device, now);
      const last = Math.max(this._csrHeardAt.get(device.getCsrMeshId()) || 0, this._firstSeen.get(device));
      const unheard = now - last >= LATER_NOT_HEARD_MS;
      if (unheard === (this._csrUnheard.get(device) === true)) continue;
      this._csrUnheard.set(device, unheard);
      if (unheard) device.log(`no frame from it for ${Math.round((now - last) / 60000)} min (limit ${LATER_NOT_HEARD_MS / 60000} min)`);
      device.updateAvailability();
    }
  }

  // A node seen in a scan: its @NDxxxx name carries the dimmer's mesh id.
  reportSignal(nodeName, rssi) {
    const id = meshIdFromName(nodeName);
    if (id === null) return;
    for (const device of this._devices()) {
      if (typeof device.setSignal === 'function' && device.getMeshId() === id) device.setSignal(rssi);
    }
  }

  // The bridge was changed (MeshBridge stores it as bridgeUuid): Homey now
  // connects to that dimmer directly and reaches the others via it.
  bridgeChanged() {
    const id = this.bridgeMeshId();
    if (id === null) return;
    for (const device of this._devices()) {
      if (typeof device.setConnection === 'function') device.setConnection(device.getMeshId() === id);
    }
  }

  // Mesh id of the last known bridge, kept across restarts in bridgeUuid.
  bridgeMeshId() {
    const uuid = this.bridge && this.bridge._preferredUuid;
    if (!uuid) return null;
    return meshIdFromName(this.bridge._nodeNameFor({ uuid }));
  }

  // Mesh ids of every paired dimmer, so a status poll knows when it has heard
  // from all of them and can release the radio.
  getPairedMeshIds() {
    const ids = new Set();
    for (const device of this._devices()) {
      if (typeof device.getMeshId !== 'function') continue;
      const id = device.getMeshId();
      if (Number.isInteger(id) && id > 0) {
        ids.add(id.toString(16).padStart(4, '0').toLowerCase());
      }
    }
    return [...ids];
  }

  // All devices on one CSRmesh network share the same key, so inbound status
  // frames are decrypted with the key of any paired device. With none paired
  // yet, the one passphrase the SG account has fetched, if it has exactly one
  // other than 1234, else 1234.
  getNetworkKey() {
    for (const device of this._devices()) {
      if (typeof device.getNetworkKey === 'function') {
        try {
          return device.getNetworkKey();
        } catch (err) {
          this._deviceError(device, `reading the network key failed: ${err.message || err}`);
        }
      }
    }
    return deriveNetworkKey((this.account && this.account.onlyPassphrase()) || DEFAULT_PASSPHRASE);
  }

  // The home's passphrase from the SG account for a device's mesh id, or
  // null: for a fake device, or when the account has none for it
  // (lib/account.js). Used by each device's getNetworkKey.
  accountPassphrase(device) {
    if (!this.account || isFakeDevice(device)) return null;
    let meshId = null;
    if (typeof device.getCsrMeshId === 'function') meshId = device.getCsrMeshId();
    else if (typeof device.getMeshId === 'function') meshId = device.getMeshId();
    return this.account.passphraseFor(meshId);
  }

  nextSeq() {
    this._seq = (this._seq + 1) & 0xFFFFFF;
    if (this._seq === 0) this._seq = 1;
    this.homey.settings.set('seqCounter', this._seq);
    return this._seq;
  }

  // SG Smart 3.0 (lib/sg3, 2.8.0): the controller for the 3.0 network of
  // the SG account (lib/account.js, sg3Network), made when a 3.0 device asks
  // for it. Without a 3.0 network it is null, and none of lib/sg3 is loaded;
  // the first generation and the CSRmesh devices run as before.
  sg3() {
    const network = this._sg3Network();
    if (!network) return null;
    const key = `${network.homeKey}:${network.netKey}:${network.appKey}`;
    if (this._sg3 && this._sg3Key === key) return this._sg3;
    if (this._sg3) this._sg3Stop('another 3.0 network in the SG account');
    const { Sg3Controller } = require('./lib/sg3/controller');
    this._sg3Key = key;
    this._sg3Home = network.homeKey;
    this._sg3 = new Sg3Controller({
      homey: this.homey,
      network,
      deviceAddresses: () => this._sg3Devices().map((device) => device.getSg3Address()),
      homeyBridges: () => this._sg3Devices().filter((device) => typeof device.canBeSg3Bridge === 'function' && device.canBeSg3Bridge())
        .map((device) => device.getSg3Address()),
      held: () => this.sg3Held(),
      log: (line) => this.log(`[SG3] ${line}`),
      detailed: () => this.homey.settings.get('debugLogging') === true,
    });
    return this._sg3;
  }

  // "Keep SG Smart 3.0 connected", as the first generation's setting: the
  // user's choice, or by default on with two or more 3.0 devices in Homey
  // that can carry the link (the SG app on a phone can still reach another
  // one) and off with one. { held, why }, why for the log.
  sg3Held() {
    const devices = this._sg3Devices().length;
    const bridges = this._sg3Bridges();
    const choice = this.homey.settings.get('sg3KeepConnected');
    if (typeof choice === 'boolean') return { held: devices > 0 && choice, why: `chosen ${choice ? 'on' : 'off'}` };
    return { held: devices > 0 && bridges >= 2, why: `by default with ${bridges} 3.0 device(s) in Homey that can be a bridge` };
  }

  // How many 3.0 devices in Homey can carry the link (lib/SG3Device.js).
  _sg3Bridges() {
    return this._devices().filter((device) => typeof device.canBeSg3Bridge === 'function'
      && device.getSg3Address() !== null && device.canBeSg3Bridge()).length;
  }

  // Before a pairing search scans (lib/csrPairing.js): a held 3.0 link is
  // let go until the returned function is called; null without 3.0.
  async sg3PauseForScan(label) {
    return this._sg3 ? this._sg3.pauseForScan(label) : null;
  }

  // The account's 3.0 network, or null; also null for an account without
  // one (a test's).
  _sg3Network() {
    return this.account && typeof this.account.sg3Network === 'function' ? this.account.sg3Network() : null;
  }

  // The home key of the 3.0 network in use, or null.
  sg3HomeKey() {
    return this._sg3 ? this._sg3Home : null;
  }

  // The 3.0 devices in Homey of the network in use (lib/SG3Device.js).
  _sg3Devices() {
    return this._devices().filter((device) => typeof device.getSg3Address === 'function'
      && device.getSg3Address() !== null && device.getSg3HomeKey() === this._sg3Home);
  }

  _sg3Stop(why) {
    const old = this._sg3;
    this._sg3 = null;
    this._sg3Key = null;
    this._sg3Home = null;
    this.log(`[SG3] stopped: ${why}`);
    old.stop().catch((err) => this.error(`SG Smart 3.0 stop failed: ${err.message || err}`));
  }

  // The SG account was fetched or forgotten: the 3.0 network may have come,
  // gone or changed, and each 3.0 device takes it as it is now.
  _sg3Changed() {
    const network = this._sg3Network();
    if (this._sg3 && (!network || this._sg3Key !== `${network.homeKey}:${network.netKey}:${network.appKey}`)) {
      this._sg3Stop(network ? 'another 3.0 network in the SG account' : 'no 3.0 network in the SG account');
    } else if (this._sg3 && network) {
      // The same network: its nodes may have changed (a dimmer added in the
      // SG app), and the running controller takes them as they are now.
      this._sg3.updateBridges(network.bridges);
    }
    for (const device of this._devices()) {
      if (typeof device.updateSg3 === 'function') device.updateSg3().catch(() => {});
    }
  }

  // A 3.0 device started, was added or deleted. The default of "Keep SG
  // Smart 3.0 connected" depends on how many there are, and the settings
  // page shows it (sg3KeepConnectedDefault), and shows the box only with one
  // at least (sg3KeepConnectedShown); the link follows (applyMode).
  sg3DevicesChanged() {
    if (this._sg3DevicesTimer) this.homey.clearTimeout(this._sg3DevicesTimer);
    this._sg3DevicesTimer = this.homey.setTimeout(() => {
      this._sg3DevicesTimer = null;
      const devices = this._devices().filter((device) => typeof device.getSg3Address === 'function'
        && device.getSg3Address() !== null).length;
      this.homey.settings.set('sg3KeepConnectedDefault', this._sg3Bridges() >= 2);
      this.homey.settings.set('sg3KeepConnectedShown', devices >= 1);
      if (this._sg3) this._sg3.applyMode();
    }, 2000);
  }

  // A Bluetooth scan (homey.ble.discover) for the CSRmesh bridge and the SG
  // Smart 3.0 link (2.8.0). While the 3.0 link exists (_sg3), a scan waits
  // for the one before it, at most SCAN_QUEUE_WAIT_MS, so the two do not
  // scan at the same time; without it, a scan starts at once, as before.
  // Whether Homey minds two at once is not tried.
  bleDiscover(...args) {
    const before = this._sg3 && this._bleScan ? this._bleScan : null;
    const scan = () => this.homey.ble.discover(...args);
    const run = before ? this._waitAtMost(before, SCAN_QUEUE_WAIT_MS).then(scan) : scan();
    this._bleScan = Promise.resolve(run).catch(() => {});
    return run;
  }

  // Resolves when promise settles, or after ms with a line in the log.
  _waitAtMost(promise, ms) {
    return new Promise((resolve) => {
      const timer = this.homey.setTimeout(() => {
        this.log(`[BLE] the scan before has not ended in ${Math.round(ms / 1000)} s: scanning anyway`);
        resolve();
      }, ms);
      Promise.resolve(promise).catch(() => {}).then(() => {
        this.homey.clearTimeout(timer);
        resolve();
      });
    });
  }
}

module.exports = SGSmartApp;
