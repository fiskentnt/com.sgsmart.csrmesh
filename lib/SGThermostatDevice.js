'use strict';

const Homey = require('homey');
const { makePacket, resolveKey } = require('./csrmesh');
const { NAME_LISTEN_MS, THERMOSTAT_LISTEN_MS } = require('./CsrNetwork');
const {
  OP_EXT_LEVEL, OP_EXT_THERMOSTAT_SET_POINT, isDeviceMeshId, opcodeValue, thermostatPowerData, thermostatPresetData,
  thermostatSetPointData,
} = require('./sgProtocol');
const { CHANGE_AFTER, learnLocation } = require('./location');
const { CommandTimer } = require('./commandTiming');
const { FAKE_ID_PREFIX } = require('./fakeDevices');

// HeatReg Smart (@MT, @ST), a floor heating thermostat with a room sensor and
// a floor sensor. The formats are assumed: no thermostat has been tried with
// Homey yet.
//
// Read: lib/CsrNetwork.js asks it and hands over its status (FF05), its
// temperatures (FF3D), its presets (FF5D) and its acknowledgement (FF08), and
// what another sends it: a set point (FF3E) or a preset (FF03), which is only
// shown here.
//
// Set: only with the device setting "Control from Homey" on (on by default,
// and turned on once for a thermostat added while it was off by default).
// Then the set point is FF3E, a preset FF03 in the thermostat's own format,
// each sent up to SEND_TIMES times until the thermostat acknowledges it (see
// _sendRepeated), and on and off one FF42, once; only to its own mesh id, and
// nothing is sent when the thermostat has the value already. With the
// setting off, each change is refused with a message, nothing is sent, and
// the device is handed to the Homey app again with the value it has. Nothing
// is sent to set its
// settings, presets, floor limit or sensor. Byte 4 of FF3E is always 01;
// what it does in the thermostat is not known (assumed: nothing else, also
// not to its schedule).
//
// Its methods are named getCsrMeshId and getCsrLocationId, as in
// lib/SGCsrDevice.js, and it has no applyCsrStatus: a light's status never
// reaches it, and lib/SGCsrDevice.js never sends a light's FF03 to it.

const SET_POINT_MIN = 5;
const SET_POINT_MAX = 35;
const SET_POINT_STEP = 0.5;
// The wheel: the set point goes this long after it was last turned.
const SET_POINT_DEBOUNCE_MS = 1500;
// After a setting from here, or one heard from another: a status about what
// was set is not taken for this long, as it may be from before.
const QUIET_MS = 8000;
// One FF04 this long after the last setting from here, to read it back.
const READ_BACK_MS = 9000;
// After a setting from here, what another sends is not taken for this long.
const OTHERS_QUIET_MS = 4000;
// After a change refused here: how long until the device is shown again,
// with the value the thermostat has.
const SHOW_AGAIN_MS = 1000;
// A set point or preset: sent at most this many times, this long after the
// last one went out, until FF08 acknowledges it.
const SEND_TIMES = 3;
const SEND_GAP_MS = 1000;
const SET_POINT_OPCODE = opcodeValue(OP_EXT_THERMOSTAT_SET_POINT);
const PRESET_OPCODE = opcodeValue(OP_EXT_LEVEL);
// The tid: one up per setting, and 1 again when more than this many whole
// seconds have passed since the last one. A setting heard from another with
// a tid that is not newer within that time is dropped: the same one again,
// through another node, or our own coming back.
const TID_RESET_S = 10;
// FF05 byte 8 (assumed): bits 3..2 the floor sensor (01 a fault, 10 no
// reading when the floor reads 0), bits 5..4 the room sensor (01 or 10 a
// fault), bit 6 the thermostat, bit 7 the floor limit.
const floorSensorOf = (errors) => (errors >> 2) & 0x03;
const roomSensorFault = (errors) => [1, 2].includes((errors >> 4) & 0x03);
const DEVICE_FAULT_BIT = 0x40;
const FLOOR_LIMIT_BIT = 0x80;
// The faults shown, first first: the device, the floor sensor (FFF), the room
// sensor (E2), the floor sensor without a reading (E1), and a temperature of
// 0 or below (L0). Which count depends on the sensor setting.
const FAULT_ORDER = ['EEE', 'FFF', 'E2', 'E1', 'L0'];
const SENSOR_FAULTS = {
  floor: ['EEE', 'FFF', 'E1', 'L0'],
  room: ['EEE', 'E2', 'L0'],
  roomFloor: ['EEE', 'FFF', 'E2', 'E1', 'L0'],
};
// Those that are a problem (alarm_problem); L0 is only a warning.
const PROBLEMS = ['EEE', 'FFF', 'E2', 'E1'];
const PRESETS = ['comfort', 'eco', 'min'];
// The thermostat modes it takes: heat (on) and off.
const MODES = ['heat', 'off'];

const hex4 = (value) => `0x${value.toString(16).padStart(4, '0')}`;
const degrees = (value) => value.toFixed(1);

// The set point Homey can ask for: SET_POINT_MIN to SET_POINT_MAX, in steps
// of SET_POINT_STEP.
function setPointFor(value) {
  const stepped = Math.round(Number(value) / SET_POINT_STEP) * SET_POINT_STEP;
  return Math.max(SET_POINT_MIN, Math.min(SET_POINT_MAX, stepped));
}

// The faults FF05 byte 8 and the temperatures show for this sensor setting,
// in FAULT_ORDER.
function faultsOf(errors, temperatures, sensor) {
  const found = new Set();
  if (errors & DEVICE_FAULT_BIT) found.add('EEE');
  const floorBits = floorSensorOf(errors);
  if (floorBits === 1) found.add('FFF');
  if (floorBits === 2 && temperatures && temperatures.floor === 0) found.add('E1');
  if (roomSensorFault(errors)) found.add('E2');
  if (temperatures) {
    const floorLow = temperatures.floor <= 0;
    const roomLow = temperatures.room <= 0;
    const low = { floor: floorLow, room: roomLow, roomFloor: floorLow || roomLow };
    if (low[sensor]) found.add('L0');
  }
  const counted = SENSOR_FAULTS[sensor] || SENSOR_FAULTS.floor;
  return FAULT_ORDER.filter((code) => found.has(code) && counted.includes(code));
}

class SGThermostatDevice extends Homey.Device {
  async onInit() {
    // The time from a setting to its first status or acknowledgement, for the log.
    this._commandTimer = new CommandTimer(this);
    if (!this._net()) {
      this.log('fake device, but no fake network in this run: nothing is sent');
      await this.setUnavailable(this.homey.__('device.fakeLeftOver')).catch(() => {});
      return;
    }
    this._tid = 0;
    this._lastTidAt = 0;
    this._status = null;
    this._temperatures = null;
    this._presets = null;
    this._chosenPreset = null;
    this._asked = null;
    this._quietUntil = 0;
    this._othersQuietUntil = 0;
    this._readBack = null;
    this._showAgainTimers = new Set();

    this.registerMultipleCapabilityListener(['target_temperature'], async ({ target_temperature: value }) => {
      await this._orShowAgain('target_temperature', () => this._setPoint(value));
    }, SET_POINT_DEBOUNCE_MS);
    this.registerCapabilityListener('onoff', async (value) => this._power(value, 'onoff'));
    this.registerCapabilityListener('thermostat_mode', async (value) => this._orShowAgain('thermostat_mode', () => this._mode(value)));
    this.registerCapabilityListener('sg_heat_preset', async (value) => this._orShowAgain('sg_heat_preset', () => this._preset(value)));

    await this._settingsAtStart();
    await this._powerCapability();
    await this._quickAction();
    await this.updateAvailability();
    this._net().csr.watchThermostat(this.getCsrMeshId(), { name: this._bluetoothName(), location: this.getCsrLocationId() });
    const location = this.getCsrLocationId();
    this.log(`thermostat ready (${this.getStoreValue('prefix')}, mesh id ${hex4(this.getCsrMeshId())}, `
      + `loc ${location === null ? 'not known yet' : hex4(location)}, control from Homey ${this._controlOn() ? 'on' : 'off'})`);
  }

  async onDeleted() {
    this._stopTimers();
    const net = this._net();
    if (net && net.csr && typeof net.csr.unwatchThermostat === 'function') net.csr.unwatchThermostat(this.getCsrMeshId());
  }

  async onUninit() {
    this._stopTimers();
  }

  _stopTimers() {
    if (this._commandTimer) this._commandTimer.stop();
    if (this._readBack) this.homey.clearTimeout(this._readBack);
    this._readBack = null;
    if (this._repeat && this._repeat.timer) this.homey.clearTimeout(this._repeat.timer);
    this._repeat = null;
    for (const timer of this._showAgainTimers || []) this.homey.clearTimeout(timer);
    if (this._showAgainTimers) this._showAgainTimers.clear();
  }

  // Settings a thermostat may lack at start: the sensor, when it has no
  // valid value (shown as empty in the Homey app), is set to Floor; and
  // "Control from Homey", on by default, is turned on once for a thermostat
  // added while it was off by default. One turned off after that stays off.
  // A failure is logged, and tried again at the next start.
  async _settingsAtStart() {
    const settings = this.getSettings();
    const changes = {};
    if (!SENSOR_FAULTS[settings.sensor]) changes.sensor = 'floor';
    const turnOn = !this.getStoreValue('controlOnByDefault');
    if (turnOn && settings.control_from_homey !== true) changes.control_from_homey = true;
    if (Object.keys(changes).length) {
      try {
        await this.setSettings(changes);
        this.log(`settings at start: ${Object.entries(changes).map(([key, value]) => `${key}=${value}`).join(', ')}`);
      } catch (err) {
        this.error(`settings at start not saved: ${err.message || err}`);
        return;
      }
    }
    if (turnOn) await this.setStoreValue('controlOnByDefault', true).catch((err) => this.error(`storing failed: ${err.message || err}`));
  }

  // As lib/SGCsrDevice.js: the app, or for a fake device its fake network.
  _net() {
    const { app } = this.homey;
    return typeof app.networkFor === 'function' ? app.networkFor(this) : app;
  }

  getCsrMeshId() {
    return Number(this.getStoreValue('meshId')) & 0xffff;
  }

  // The Bluetooth name it was added by, such as @MT1A2B.
  _bluetoothName() {
    return String((this.getData() || {}).id || '').replace(FAKE_ID_PREFIX, '');
  }

  // The device's own settings, or while they are the default the home's
  // passphrase from the SG account (lib/csrmesh.js, resolveKey).
  getNetworkKey() {
    const app = this.homey && this.homey.app;
    return resolveKey(this.getSettings(), app && typeof app.accountPassphrase === 'function' ? app.accountPassphrase(this) : null);
  }

  getCsrLocationId() {
    if (this._location && Number.isInteger(this._location.value)) return this._location.value;
    const stored = this.getStoreValue('locationId');
    return Number.isInteger(stored) ? stored : null;
  }

  // "Control from Homey (being tried out)": on by default, off only when it
  // is set off.
  _controlOn(settings = this.getSettings()) {
    return settings.control_from_homey !== false;
  }

  _sensor(settings = this.getSettings()) {
    return SENSOR_FAULTS[settings.sensor] ? settings.sensor : 'floor';
  }

  // As the other devices (lib/location.js).
  _learnLocation(location) {
    const before = this.getCsrLocationId();
    const { state, outcome } = learnLocation(this._location || { value: before, other: null, count: 0 }, location);
    this._location = state;
    if (outcome === 'learned' || outcome === 'changed') {
      this.setStoreValue('locationId', state.value).catch((err) => this.error(`storing the location id failed: ${err.message || err}`));
      this.log(outcome === 'learned'
        ? `location id learned: ${hex4(state.value)}`
        : `location id changed: ${hex4(before)} to ${hex4(state.value)} (heard ${CHANGE_AFTER} times in a row)`);
      this.updateAvailability();
    }
    return outcome;
  }

  // Never unavailable. A warning while no status can be read at all
  // (password), while the location id is not known, while nothing has been
  // heard from it for a while (the app's notHeard), or for a fault.
  async updateAvailability() {
    const net = this._net();
    if (!net) return;
    const unreadable = net.statusUnreadableText ? net.statusUnreadableText() : null;
    await this.setAvailable().catch(() => {});
    let warning = unreadable;
    if (!warning && this.getCsrLocationId() === null) warning = this.homey.__('thermostat.waitingForStatus');
    if (!warning && typeof net.notHeard === 'function' && net.notHeard(this)) warning = this.homey.__('thermostat.notHeard');
    if (!warning && this._fault) warning = this.homey.__(`thermostat.fault.${this._fault}`);
    if (warning === this._warningShown) return;
    this._warningShown = warning;
    if (warning) await this.setWarning(warning).catch(() => {});
    else await this.unsetWarning().catch(() => {});
  }

  // ---- setting the thermostat, only with "Control from Homey" on

  // Throws with the text Homey shows when it cannot be set: control off, a
  // fake device without its network, or no location id yet. Otherwise the
  // network and the location id.
  _controlTarget(what) {
    if (!this._controlOn()) {
      this.log(`${what} refused: control from Homey is off, nothing sent`);
      throw new Error(this.homey.__('thermostat.controlOff'));
    }
    const net = this._net();
    if (!net) throw new Error(this.homey.__('device.fakeLeftOver'));
    // Only to the thermostat's own mesh id: never 0, 0xFFFF or this app's own
    // addresses (a group cannot be told from a device by its number).
    if (!isDeviceMeshId(this.getCsrMeshId())) {
      this.log(`${what} refused: mesh id ${hex4(this.getCsrMeshId())} is not one device's, nothing sent`);
      throw new Error(this.homey.__('device.badMeshId'));
    }
    const location = this.getCsrLocationId();
    if (location === null) {
      this.log(`${what} refused: location id not known yet, nothing sent`);
      net.csr.requestNames({ asked: true, listenMs: NAME_LISTEN_MS }).catch(() => {});
      throw new Error(this.homey.__('thermostat.waitingForStatus'));
    }
    return { net, location };
  }

  _nextTid() {
    const now = Date.now();
    this._tid = Math.floor((now - this._lastTidAt) / 1000) > TID_RESET_S ? 1 : (this._tid % 0xff) + 1;
    this._lastTidAt = now;
    return this._tid;
  }

  // One message, under the key of its queue: the set point (FF3E) and the
  // preset (FF03) share one, as both set the set point and the last one
  // chosen counts; on and off (FF42) has its own. A newer message replaces
  // one not yet sent in the same queue, never one in the other. A message
  // that did not go out is logged.
  async _send(net, data, what, queue, tid = this._tid) {
    const seq = net.nextSeq();
    this.log(`${what} to ${hex4(this.getCsrMeshId())} tid=${tid} seq=0x${seq.toString(16).padStart(6, '0')}`);
    const key = `thermostat:${this.getCsrMeshId()}:${queue}`;
    this._quiet();
    const result = await net.bridge.send(makePacket(this.getNetworkKey(), seq, data), { key });
    if (this._commandTimer) this._commandTimer.sent(result);
    // Counted again from when it went out, which a slow link may delay.
    this._quiet();
    this._readBackSoon(net);
    if (!result || !result.ok) {
      const why = result && result.superseded ? 'replaced by a newer one' : 'not delivered';
      this.log(`${what} not sent: ${why}`);
      return false;
    }
    return true;
  }

  // A set point (FF3E) or a preset (FF03): sent up to SEND_TIMES times, each
  // SEND_GAP_MS after the last one went out, the same message with the same
  // tid each time, and no more once the thermostat acknowledges it with FF08
  // (_acknowledged). A newer set point or preset ends the sends left of this
  // one. Each send is logged, and so is how it ended. Assumed: the
  // thermostat acknowledges what it took, and takes the same tid once (not
  // tried with a thermostat).
  async _sendRepeated(net, data, what, opcode) {
    this._endRepeats('replaced by a newer setting');
    const run = { what, opcode, tid: this._tid, sent: 0, timer: null };
    this._repeat = run;
    const next = async () => {
      run.timer = null;
      if (this._repeat !== run) return;
      if (run.sent === SEND_TIMES) {
        this._repeat = null;
        this.log(`${what}: no acknowledgement (FF08) after ${SEND_TIMES} of ${SEND_TIMES}`);
        return;
      }
      run.sent += 1;
      await this._send(net, data, `${what} (${run.sent} of ${SEND_TIMES})`, 'set-point', run.tid);
      if (this._repeat !== run) return;
      run.timer = this.homey.setTimeout(() => {
        next().catch((err) => this.error(`${what}: sending again failed: ${err.message || err}`));
      }, SEND_GAP_MS);
    };
    await next();
  }

  // Ends the sends left of the set point or preset, if any, with why.
  _endRepeats(why) {
    const run = this._repeat;
    if (!run) return;
    if (run.timer) this.homey.clearTimeout(run.timer);
    this._repeat = null;
    if (run.sent < SEND_TIMES) this.log(`${run.what}: the last ${SEND_TIMES - run.sent} of ${SEND_TIMES} not sent, ${why}`);
  }

  // FF08 from this thermostat: the set point or preset sent from here is
  // taken, so the sends left of it end.
  _acknowledged(ack) {
    const run = this._repeat;
    const opcode = ack.opcode.toString(16).toUpperCase();
    if (!run || run.opcode !== ack.opcode) {
      this.log(`FF08 for ${opcode}: nothing from here waits for it`);
      return;
    }
    if (run.timer) this.homey.clearTimeout(run.timer);
    this._repeat = null;
    this.log(`${run.what}: acknowledged (FF08) after ${run.sent} of ${SEND_TIMES}, no more sent`);
  }

  // Around a setting: QUIET_MS without taking a status about it, and
  // OTHERS_QUIET_MS without taking another's.
  _quiet() {
    const now = Date.now();
    this._quietUntil = now + QUIET_MS;
    this._othersQuietUntil = now + OTHERS_QUIET_MS;
  }

  // One FF04 READ_BACK_MS after the last setting.
  _readBackSoon(net) {
    if (this._readBack) this.homey.clearTimeout(this._readBack);
    this._readBack = this.homey.setTimeout(() => {
      this._readBack = null;
      const location = this.getCsrLocationId();
      if (location !== null) net.csr.requestStatus(this.getCsrMeshId(), location, THERMOSTAT_LISTEN_MS).catch(() => {});
    }, READ_BACK_MS);
  }

  async _setPoint(value) {
    const setPoint = setPointFor(value);
    if (!Number.isFinite(setPoint)) throw new Error(`not a temperature: ${value}`);
    const what = `set point ${degrees(setPoint)}`;
    const { net, location } = this._controlTarget(what);
    if (this._status && this._status.setPoint === setPoint) {
      this.log(`${what}: the thermostat has it already, nothing sent`);
      return;
    }
    this._asked = { ...this._asked, setPoint };
    this._expect({ setPoint });
    const data = thermostatSetPointData({ meshId: this.getCsrMeshId(), location, temperature: setPoint, tid: this._nextTid() });
    await this._sendRepeated(net, data, `FF3E ${what}`, SET_POINT_OPCODE);
  }

  // A thermostat mode: heat is on and off is off; any other is refused, and
  // nothing is sent.
  async _mode(value) {
    if (!MODES.includes(value)) {
      this.log(`thermostat mode ${value} refused: only heat and off, nothing sent`);
      throw new Error(`no such mode: ${value}`);
    }
    await this._power(value === 'heat', 'thermostat_mode');
  }

  // On or off, from onoff or thermostat_mode; the other one follows.
  async _power(on, from) {
    const what = on ? 'on' : 'off';
    const { net, location } = this._controlTarget(what);
    const other = from === 'onoff' ? ['thermostat_mode', on ? 'heat' : 'off'] : ['onoff', on];
    this.setCapabilityValue(...other).catch(() => {});
    if (this._status && this._status.on === on) {
      this.log(`${what}: the thermostat is ${what} already, nothing sent`);
      return;
    }
    this._asked = { ...this._asked, on };
    this._expect({ on });
    const data = thermostatPowerData({ meshId: this.getCsrMeshId(), location, on, tid: this._nextTid() });
    await this._send(net, data, `FF42 ${what}`, 'power');
  }

  // The thermostat has a preset already when its status (outside the quiet
  // time) shows it on at the preset's temperature; a pause is not counted.
  async _preset(preset) {
    if (!PRESETS.includes(preset)) throw new Error(`no such preset: ${preset}`);
    const what = `preset ${preset}`;
    const { net, location } = this._controlTarget(what);
    const temperature = this._presets ? this._presets[preset] : undefined;
    if (this._status && Date.now() >= this._quietUntil && this._status.on && temperature === this._status.setPoint) {
      this.log(`${what}: the thermostat has it already, nothing sent`);
      return;
    }
    this._chosenPreset = preset;
    // The preset sets the set point: one sent before it is not compared.
    const asked = { ...this._asked, preset };
    delete asked.setPoint;
    this._asked = asked;
    const data = thermostatPresetData({ meshId: this.getCsrMeshId(), location, preset, tid: this._nextTid() });
    await this._sendRepeated(net, data, `FF03 ${what}`, PRESET_OPCODE);
  }

  // A change refused here (nothing sent) leaves the value as it was, but the
  // Homey app may keep showing what was chosen, such as where the wheel was
  // turned to. So SHOW_AGAIN_MS later the capability's options are set
  // again, unchanged, which hands the device to the app anew with the value
  // it has (assumed: not tried in the Homey app). The value itself is never
  // set again: that would run the "changed" Flow cards, give a refused Flow
  // a change, and could overwrite a status that came meanwhile. Not for
  // onoff, whose button on the tile is hidden while control is off.
  async _orShowAgain(capability, change) {
    try {
      await change();
    } catch (err) {
      const timer = this.homey.setTimeout(() => {
        this._showAgainTimers.delete(timer);
        this.setCapabilityOptions(capability, this._optionsOf(capability))
          .then(() => this.log(`${capability} shown again after a refused change`))
          .catch((e) => this.error(`${capability} not shown again: ${e.message || e}`));
      }, SHOW_AGAIN_MS);
      this._showAgainTimers.add(timer);
      throw err;
    }
  }

  // A capability's options as they are, which setting them replaces in
  // full: the driver's, with the device's own over them, so a set read
  // empty or in part never drops one the driver gives (such as the hidden
  // thermostat mode or the range 5 to 35).
  _optionsOf(capability) {
    const manifest = (this.driver && this.driver.manifest) || {};
    const options = { ...((manifest.capabilitiesOptions || {})[capability] || {}) };
    let own = null;
    try {
      own = this.getCapabilityOptions(capability);
    } catch (err) {
      // none read for it yet
    }
    for (const [key, value] of Object.entries(own || {})) {
      if (value !== undefined) options[key] = value;
    }
    return options;
  }

  // What was just sent counts as the thermostat's until its next status
  // after the quiet time, which shows what it took.
  _expect(fields) {
    if (this._status) this._status = { ...this._status, ...fields };
  }

  // ---- what the network hands over

  // FF11 from this thermostat (lib/CsrNetwork.js).
  applyCsrName(name) {
    if (name.location) this._learnLocation(name.location);
  }

  // An answer from this thermostat: FF05, FF3D, FF5C, FF5D or FF08, read.
  applyThermostat(kind, parsed) {
    if (parsed.location && this._learnLocation(parsed.location) === 'other') return;
    if ((kind === 'FF08' || kind === 'FF05') && this._commandTimer) this._commandTimer.status();
    if (kind === 'FF08') this._acknowledged(parsed);
    else if (kind === 'FF05') this._applyStatus(parsed);
    else if (kind === 'FF3D') this._applyTemperatures(parsed);
    else if (kind === 'FF5D') this._applyPresets(parsed);
  }

  _applyStatus(status) {
    const now = Date.now();
    const quiet = now < this._quietUntil;
    // Within the quiet time, what was set stays what the thermostat has.
    this._status = quiet && this._status
      ? { ...status, on: this._status.on, setPoint: this._status.setPoint, paused: this._status.paused } : status;
    if (!quiet) {
      if (this._asked) this._compareWithAsked(status);
      this._set('onoff', status.on);
      this._set('thermostat_mode', status.on ? 'heat' : 'off');
      this._set('target_temperature', status.setPoint);
      this._set('sg_heat_preset', this._presetOf(status));
    }
    this._set('sg_heating', status.heating);
    this._set('sg_window_open', status.window);
    this._applyPower();
    // The temperatures are shown again with the faults this status brings,
    // such as a floor temperature that is empty from now with FFF.
    if (this._temperatures) this._applyTemperatures(this._temperatures);
    else this._applyFaults();
    this.log(`status FF05 ${quiet ? 'during the quiet time after a setting: set point and on/off not taken' : 'applied'}: `
      + `on=${status.on} setPoint=${degrees(status.setPoint)} heating=${status.heating} window=${status.window} `
      + `errors=0x${status.errors.toString(16).padStart(2, '0')}`);
  }

  // What was set from here against what the thermostat has: logged when it
  // differs, and the thermostat's value is shown. Nothing is sent again.
  _compareWithAsked(status) {
    const asked = this._asked;
    this._asked = null;
    if (asked.setPoint !== undefined && asked.setPoint !== status.setPoint) {
      this.log(`set point ${degrees(asked.setPoint)} was sent, the thermostat has ${degrees(status.setPoint)}: shown as it is`);
    }
    if (asked.on !== undefined && asked.on !== status.on) {
      this.log(`${asked.on ? 'on' : 'off'} was sent, the thermostat is ${status.on ? 'on' : 'off'}: shown as it is`);
    }
  }

  // The preset the status shows: none when off; min when paused (assumed);
  // otherwise the one whose temperature is the set point, the one chosen here
  // first when two have it.
  _presetOf(status) {
    if (!status.on) return null;
    if (status.paused) return 'min';
    if (!this._presets) return null;
    const matches = PRESETS.filter((preset) => this._presets[preset] === status.setPoint);
    if (!matches.length) return null;
    return matches.includes(this._chosenPreset) ? this._chosenPreset : matches[0];
  }

  // The thermostat's temperature and the floor's, as the sensor setting says:
  // - Room: the room temperature alone, never the floor's (the floor
  //   capability is empty).
  // - Floor, and Room with floor limit: the room temperature when there is
  //   one, otherwise the floor's; the floor on its own.
  // 0.0 is shown as 0.0. Empty with a sensor fault: E2 for the room, FFF for
  // the floor, and E1, whose floor reads 0. With Floor, a room reading of 0
  // counts as no room sensor, and the floor is shown.
  _applyTemperatures(temperatures, settings = this.getSettings()) {
    this._temperatures = temperatures;
    const errors = this._status ? this._status.errors : 0;
    const sensor = this._sensor(settings);
    const reads = (value) => typeof value === 'number' && Number.isFinite(value);
    const roomShown = reads(temperatures.room) && !roomSensorFault(errors)
      && (temperatures.room > 0 || (temperatures.room === 0 && sensor !== 'floor'));
    const room = roomShown ? temperatures.room : null;
    const floorBits = floorSensorOf(errors);
    const floorShown = sensor !== 'room' && reads(temperatures.floor) && temperatures.floor >= 0
      && floorBits !== 1 && !(floorBits === 2 && temperatures.floor === 0);
    const floor = floorShown ? temperatures.floor : null;
    this._set('measure_temperature', sensor === 'room' || room !== null ? room : floor);
    this._set('measure_temperature.floor', floor);
    this._applyFaults(settings);
  }

  _applyPresets({ presets }) {
    const [comfort, eco, min] = presets;
    this._presets = { comfort, eco, min };
    if (this._status && Date.now() >= this._quietUntil) this._set('sg_heat_preset', this._presetOf(this._status));
  }

  // measure_power always, also while the cable's power is 0 W (then empty):
  // Homey gives a device with onoff and without measure_power its own power
  // usage when on and off, which counts by on and off rather than by the
  // relay, and next to the cable's power. Added at start to a thermostat
  // that lacks it, and marked as approximated, as the driver's options are
  // not assumed to come with it. A failure is logged.
  async _powerCapability() {
    if (this.hasCapability('measure_power')) return;
    try {
      await this.addCapability('measure_power');
      this.log('measure_power added');
    } catch (err) {
      this.error(`measure_power not added: ${err.message || err}`);
      return;
    }
    await this.setCapabilityOptions('measure_power', { approximated: true })
      .catch((err) => this.error(`measure_power not marked as approximated: ${err.message || err}`));
  }

  // The on/off quick action on the tile only with "Control from Homey" on:
  // with it off, a tap could only be refused. Without the option it counts
  // as shown, as Homey shows it by default. Set at start and when the
  // setting changes; a failure is logged.
  async _quickAction(settings = this.getSettings()) {
    if (!this.hasCapability('onoff')) return;
    const wanted = this._controlOn(settings);
    try {
      const shown = (this.getCapabilityOptions('onoff') || {}).uiQuickAction !== false;
      if (shown === wanted) return;
      await this.setCapabilityOptions('onoff', { uiQuickAction: wanted });
      this.log(`on/off on the tile ${wanted ? 'shown' : 'hidden'}: control from Homey ${wanted ? 'on' : 'off'}`);
    } catch (err) {
      this.error(`on/off on the tile not ${wanted ? 'shown' : 'hidden'}: ${err.message || err}`);
    }
  }

  // The heating cable's power when the relay is in, 0 when it is out; empty
  // without the cable's power in the settings.
  _applyPower(settings = this.getSettings()) {
    const watts = Number(settings.heating_cable_power) || 0;
    if (watts <= 0 || !this._status) {
      this._set('measure_power', null);
      return;
    }
    this._set('measure_power', this._status.heating ? watts : 0);
  }

  _applyFaults(settings = this.getSettings()) {
    if (!this._status) return;
    const faults = faultsOf(this._status.errors, this._temperatures, this._sensor(settings));
    this._set('alarm_problem', faults.some((code) => PROBLEMS.includes(code)));
    this._set('sg_floor_limit', !!(this._status.errors & FLOOR_LIMIT_BIT) && this._sensor(settings) !== 'room');
    const fault = faults[0] || null;
    if (fault !== this._fault) {
      const also = faults.length > 1 ? ` (also ${faults.slice(1).join(', ')})` : '';
      this.log(fault ? `fault shown: ${fault}${also}` : 'fault cleared');
      this._fault = fault;
      this.updateAvailability();
    }
  }

  // A set point or a preset another sent this thermostat (lib/CsrNetwork.js):
  // shown, never answered or sent on. Dropped within OTHERS_QUIET_MS of a
  // setting from here, and when its tid is not newer than the last one
  // (TID_RESET_S); one taken makes its tid the thermostat's.
  applyThermostatCommand(kind, parsed, src) {
    const now = Date.now();
    const from = `${kind} from ${hex4(src)}`;
    if (parsed.location !== this.getCsrLocationId()) return;
    if (now < this._othersQuietUntil) {
      this.log(`${from} not taken: within ${OTHERS_QUIET_MS / 1000} s of a setting from here`);
      return;
    }
    const recent = Math.floor((now - this._lastTidAt) / 1000) <= TID_RESET_S;
    if (parsed.tid === 0 || (recent && parsed.tid <= this._tid)) return;
    this._tid = parsed.tid;
    this._lastTidAt = now;
    this._quietUntil = now + QUIET_MS;
    if (kind === 'FF3E') {
      this._set('target_temperature', parsed.setPoint);
      if (this._status) this._status = { ...this._status, setPoint: parsed.setPoint };
      this.log(`${from}: set point ${degrees(parsed.setPoint)} shown`);
    } else {
      this._chosenPreset = parsed.preset;
      this._set('sg_heat_preset', parsed.preset);
      if (this._presets && this._presets[parsed.preset] !== undefined) {
        this._set('target_temperature', this._presets[parsed.preset]);
      }
      this.log(`${from}: preset ${parsed.preset} shown`);
    }
  }

  // The new settings count from now: the quick action follows "Control from
  // Homey", and the power and the faults are shown with them at once.
  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('control_from_homey')) {
      this.log(`control from Homey ${this._controlOn(newSettings) ? 'on' : 'off'}`);
      await this._quickAction(newSettings);
    }
    this._applyPower(newSettings);
    if (changedKeys.includes('sensor') && this._temperatures) this._applyTemperatures(this._temperatures, newSettings);
    this._applyFaults(newSettings);
  }

  _set(capability, value) {
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    this.setCapabilityValue(capability, value).catch((err) => this.error(`${capability} failed: ${err.message || err}`));
  }
}

module.exports = SGThermostatDevice;
module.exports.faultsOf = faultsOf;
module.exports.setPointFor = setPointFor;
