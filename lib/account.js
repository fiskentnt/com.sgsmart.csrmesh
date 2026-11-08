'use strict';

const { DEFAULT_PASSPHRASE } = require('./csrmesh');
const { LISTEN_MARGIN_MS, STATUS_LISTEN_MS } = require('./CsrNetwork');
const { localText, localTime } = require('./localTime');
const { SG3_PRODUCTS, csrProductForType, familyForType, sg3CanBeBridge } = require('./sgProducts');

// The SG account in the app's settings (2.7.0). The settings page sends the
// e-mail and password through the app's API (api.js); they go to the account
// module (below) and are dropped. Kept, under one app setting the page never
// reads, is per home: the CSR network passphrase when it is not 1234, the two
// SG Smart 3.0 keys, the home's key (from interface 4), the location id and
// the devices (mesh id, type, and the name the user gave it in the SG app, as
// cleanName leaves it). The 3.0 keys and the home's key make the SG Smart
// 3.0 network (sg3Network). The page gets only the summary. Pairing takes a
// device's name as the name it suggests (nameFor); a device added in Homey
// keeps its name in Homey, also after "Forget SG account".
//
// After a fetch every device is checked once, for "X of Y answer": a later
// CSRmesh device gets one FF04 (lib/CsrNetwork.js, requestStatus), never
// again in that check, and any frame from its mesh id counts as an answer; a
// first generation dimmer counts when the app has heard its status lately,
// and nothing is sent to it; an SG Smart 3.0 device is kept, not asked. An
// FF04 needs a location id: the device's own, or else its home's from the
// account; without either the device is not asked and shows as unknown.
// "Forget SG account" removes all of it, and the devices fall back to their
// own passphrase or 1234 (lib/csrmesh.js, resolveKey).
//
// A device is uncertain when its id does not say which device it is: the
// account module says so (certain false), or another device of the same home
// has the same id. An uncertain device is kept and counted in its home's
// devices, but nothing goes by its id: no passphrase, name or type for a
// device here, no FF04, and it is not in "X of Y answer" or in the lists of
// devices that did not answer. When a home has no certain device to count,
// the page leaves "X of Y answer" out.
//
// Nothing here logs the e-mail, a password, a key or a name: counts only.
//
// The account module, which logs in and fetches, is lib/sky/: a private
// module in its own repository (sg-leddim-account), not in this one. It gives
// { interfaceVersion, fetchHomes }. fetchHomes(email, password, { log })
// gives { homes, loggedOut }, each home { homeKey, passphrase, netKey, appKey,
// locationId, devices: [{ meshId, type, name, certain }] }, values null when
// missing (interface 1 has no name: it counts as missing; before interface 3
// there is no certain, and every id counts as certain unless two devices of
// a home share it; before interface 4 there is no homeKey, and so no 3.0
// network); it
// fails with an error whose code starts with SG_CLOUD_ and whose message
// holds no value. It keeps nothing and logs counts only, through log. Without
// the module, with another interfaceVersion, or when it does not load, the
// account is not available in this build, and the rest of the app is as
// without an account.

const SETTING = 'sgAccount';
const INTERFACE_VERSIONS = [1, 2, 3, 4];
// A name from the account longer than this, after cleanName, is not used.
const NAME_MAX = 64;
// Our own address in the mesh: frames from it are our own messages coming back.
const OWN_ADDRESS = 0x8000;
// A home's key from the account module: 12 hex digits in small letters.
const HOME_KEY = /^[0-9a-f]{12}$/;
// A 3.0 network or application key: 16 bytes as 32 hex digits.
const SG3_KEY = /^[0-9a-fA-F]{32}$/;
// The unicast addresses SG Smart 3.0 nodes are assumed to have (the dimmer
// tried on 2026-11-05 had one inside them). A 3.0 device outside is left out,
// and the log says so (_logSg3).
const SG3_NODE_FIRST = 0x0001;
const SG3_NODE_LAST = 0x7f7f;
// At most this many lines for the 3.0 devices left out for their id.
const OUTSIDE_LINES = 5;
// After the last FF04, how long the answers may take.
const ANSWER_MS = STATUS_LISTEN_MS + LISTEN_MARGIN_MS;

const hex4 = (value) => `0x${value.toString(16).padStart(4, '0')}`;

// The account module's fetchHomes, or null, with why for the log. load is
// for the tests.
function loadAccountModule(load = () => require('./sky')) {
  let loaded;
  try {
    loaded = load();
  } catch (err) {
    const missing = err && err.code === 'MODULE_NOT_FOUND' && String(err.message).startsWith("Cannot find module './sky'");
    return { fetch: null, why: missing ? 'not in this build' : `did not load (${(err && err.name) || 'error'})` };
  }
  if (!loaded || !INTERFACE_VERSIONS.includes(loaded.interfaceVersion)) {
    return { fetch: null, why: `has interface ${loaded && loaded.interfaceVersion} where ${INTERFACE_VERSIONS.join(' or ')} is needed` };
  }
  if (typeof loaded.fetchHomes !== 'function') return { fetch: null, why: 'has no fetchHomes' };
  return { fetch: loaded.fetchHomes, why: null };
}

// What an error from the account module means for the settings page.
function errorKey(err) {
  const code = err && err.code;
  if (code === 'SG_CLOUD_LOGIN') return 'login';
  if (code === 'SG_CLOUD_MISSING') return 'missing';
  if (code === 'SG_CLOUD_TIMEOUT' || code === 'SG_CLOUD_NETWORK') return 'network';
  return 'other';
}

// A device's name from the account as it may be used, or null: text, with
// control characters, line breaks and tabs made spaces and invisible format
// characters (such as a right-to-left mark, but not the joiner inside an
// emoji) left out, spaces run together
// and trimmed; null when nothing is left or it is longer than NAME_MAX
// characters. Never throws.
function cleanName(value) {
  try {
    if (typeof value !== 'string') return null;
    const name = value.replace(/(?!\u200d)\p{Cf}/gu, '').replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!name || [...name].length > NAME_MAX) return null;
    return name;
  } catch (err) {
    return null;
  }
}

// devices with certain set: false when the device says so (certain false)
// or another device in devices has the same mesh id, else true.
function withCertainty(devices) {
  const count = new Map();
  for (const device of devices) count.set(device.meshId, (count.get(device.meshId) || 0) + 1);
  return devices.map((device) => ({ ...device, certain: device.certain !== false && count.get(device.meshId) === 1 }));
}

// A home as kept from a fetched one: the passphrase only when it is not
// 1234, and only devices with a mesh id, each with its name cleaned and
// whether it is certain (withCertainty).
function keptHome(home) {
  const passphrase = typeof home.passphrase === 'string' && home.passphrase.trim()
    && home.passphrase.trim() !== DEFAULT_PASSPHRASE ? home.passphrase : null;
  return {
    homeKey: typeof home.homeKey === 'string' && HOME_KEY.test(home.homeKey) ? home.homeKey : null,
    passphrase,
    netKey: home.netKey || null,
    appKey: home.appKey || null,
    locationId: Number.isInteger(home.locationId) ? home.locationId : null,
    devices: withCertainty(home.devices.filter((device) => Number.isInteger(device.meshId))
      .map((device) => ({ meshId: device.meshId, type: device.type, name: cleanName(device.name), certain: device.certain !== false }))),
  };
}

// The homes that make an SG Smart 3.0 network here: the home's key, both
// 3.0 keys, and a certain device of a type this build adds (SG3_PRODUCTS)
// with an id in the node range.
function sg3Homes(homes) {
  return homes.filter((home) => typeof home.homeKey === 'string' && HOME_KEY.test(home.homeKey)
    && SG3_KEY.test(home.netKey || '') && SG3_KEY.test(home.appKey || '')
    && home.devices.some(isSg3Node));
}

// A certain 3.0 device of a type this build adds, with an id in the node
// range.
function isSg3Node(device) {
  return device.certain && Object.prototype.hasOwnProperty.call(SG3_PRODUCTS, device.type)
    && Number.isInteger(device.meshId) && device.meshId >= SG3_NODE_FIRST && device.meshId <= SG3_NODE_LAST;
}

class SgAccount {
  // fetch is the account module's fetchHomes, or a test's; load, for the
  // tests, loads the module instead of lib/sky/.
  constructor(app, { fetch, load } = {}) {
    this.app = app;
    this.homey = app.homey;
    if (fetch) {
      this._fetch = fetch;
    } else {
      const found = loadAccountModule(load);
      this._fetch = found.fetch;
      if (found.why) app.log(`[SG account] the account module ${found.why}: no SG account in this build`);
    }
    this._state = this._load();
    if (this.sg3FetchAgain()) this.app.log('[SG account] kept without the home\'s key: fetch again to use SG Smart 3.0');
    this._heardAt = new Map(); // mesh id -> when a frame from it was last heard
    this._busy = false;        // a fetch runs
    this._checking = false;    // a check runs
    this._run = 0;             // the latest fetch, check or forget
    this._timeSaid = null;     // what the log last said about the fetched time
    this._timers = new Set();
  }

  // What was kept, with certain set again for each device (withCertainty):
  // what was kept before certain was, has none.
  _load() {
    const state = this.homey.settings.get(SETTING);
    if (!state || !Array.isArray(state.homes)) return null;
    return {
      ...state,
      homes: state.homes.map((home) => ({ ...home, devices: withCertainty(Array.isArray(home.devices) ? home.devices : []) })),
    };
  }

  _save() {
    this.homey.settings.set(SETTING, this._state);
  }

  // Tells the app that an account was fetched or forgotten (app.js,
  // accountChanged).
  _changed() {
    if (typeof this.app.accountChanged === 'function') this.app.accountChanged();
  }

  stop() {
    this._run += 1;
    for (const timer of this._timers) this.homey.clearTimeout(timer);
    this._timers.clear();
  }

  // From MeshBridge.onFrame (app.js): a frame from this mesh id was heard.
  heard(src) {
    if (Number.isInteger(src) && src !== OWN_ADDRESS) this._heardAt.set(src, Date.now());
  }

  fetched() {
    return !!this._state;
  }

  // The account module is in this build.
  available() {
    return typeof this._fetch === 'function';
  }

  // The homes with a certain device of this mesh id.
  _homesWith(meshId) {
    if (!this._state || !Number.isInteger(meshId)) return [];
    return this._state.homes.filter((home) => home.devices.some((device) => device.certain && device.meshId === meshId));
  }

  // The passphrase of the one home that has this mesh id, or null: also when
  // two homes have it, or that home's is 1234.
  passphraseFor(meshId) {
    const homes = this._homesWith(meshId);
    return homes.length === 1 ? homes[0].passphrase : null;
  }

  // The one passphrase other than 1234 the account has, or null when it has
  // none or several.
  onlyPassphrase() {
    if (!this._state) return null;
    const all = new Set(this._state.homes.map((home) => home.passphrase).filter(Boolean));
    return all.size === 1 ? [...all][0] : null;
  }

  // The name of this mesh id in the account (cleanName), when exactly one
  // home has it as a certain device, else null.
  nameFor(meshId) {
    const homes = this._homesWith(meshId);
    if (homes.length !== 1) return null;
    const device = homes[0].devices.find((d) => d.certain && d.meshId === meshId);
    return device ? cleanName(device.name) : null;
  }

  // The type of this mesh id in the account, when exactly one home has it as
  // a certain device.
  typeFor(meshId) {
    const homes = this._homesWith(meshId);
    if (homes.length !== 1) return null;
    const device = homes[0].devices.find((d) => d.certain && d.meshId === meshId);
    return device ? device.type : null;
  }

  // Every device of the account, with its home's number from 1, uncertain
  // ones too (certain false).
  devices() {
    if (!this._state) return [];
    return this._state.homes.flatMap((home, i) => home.devices.map((device) => ({ ...device, home: i + 1 })));
  }

  // Log in, fetch and keep (e-mail and password go no further than the
  // account module), then check the devices without waiting for it. Gives
  // the summary, with error ('login', 'missing', 'network', 'busy',
  // 'unavailable', 'noHomes' or 'other') when it failed; what was kept
  // before stays then. A fetch with no homes is such a failure: the keys
  // fetched before are only ever removed by "Forget SG account".
  async login(email, password) {
    if (!this.available()) return { ...this.summary(), error: 'unavailable' };
    if (this._busy || this._checking) return { ...this.summary(), error: 'busy' };
    this._busy = true;
    const run = ++this._run;
    try {
      let fetched;
      try {
        fetched = await this._fetch(email, password, { log: (line) => this.app.log(`[SG account] ${line}`) });
      } catch (err) {
        const safe = err && /^SG_CLOUD_/.test(err.code) ? err.message : `fetch failed (${(err && err.name) || 'error'})`;
        this.app.error(`[SG account] ${safe}`);
        return { ...this.summary(), error: errorKey(err) };
      }
      if (run !== this._run) return this.summary();
      if (!fetched || !Array.isArray(fetched.homes) || fetched.homes.length === 0) {
        this.app.log(`[SG account] the account has no homes: ${this._state ? 'what was fetched before is kept' : 'nothing kept'}`);
        return { ...this.summary(), error: 'noHomes' };
      }
      const homes = fetched.homes.map(keptHome);
      this._state = { fetchedAt: new Date().toISOString(), homes, check: null };
      this._save();
      this._changed();
      const left = fetched.homes.reduce((sum, home) => sum + home.devices.length, 0)
        - homes.reduce((sum, home) => sum + home.devices.length, 0);
      this.app.log(`[SG account] kept ${homes.length} home(s): passphrase other than 1234 for `
        + `${homes.filter((home) => home.passphrase).length}, 3.0 keys for ${homes.filter((home) => home.netKey && home.appKey).length}, `
        + `${homes.reduce((sum, home) => sum + home.devices.length, 0)} device(s)${left ? `, ${left} without a mesh id left out` : ''}, `
        + `${homes.reduce((sum, home) => sum + home.devices.filter((device) => device.name).length, 0)} with a name, `
        + `${homes.reduce((sum, home) => sum + home.devices.filter((device) => !device.certain).length, 0)} uncertain`);
      this._logSg3(homes);
      this._checking = true;
      this._check(run).catch((err) => this.app.error(`[SG account] check failed: ${err.message || err}`))
        .finally(() => { if (run === this._run) this._checking = false; });
      return this.summary();
    } finally {
      this._busy = false;
    }
  }

  // What the fetch gave for SG Smart 3.0, in counts: the 3.0 devices, how
  // many are certain with an id in the node range, how many of those are of
  // a type this build adds, and the homes that make a network (sg3Homes).
  _logSg3(homes) {
    const all = homes.flatMap((home) => home.devices.filter((device) => familyForType(device.type) === 'sg3'));
    if (!all.length) return;
    const inRange = all.filter((device) => device.certain && device.meshId >= SG3_NODE_FIRST && device.meshId <= SG3_NODE_LAST);
    const networks = sg3Homes(homes).length;
    this.app.log(`[SG account] SG Smart 3.0: ${all.length} device(s), ${inRange.length} certain with an id from `
      + `${hex4(SG3_NODE_FIRST)} to ${hex4(SG3_NODE_LAST)}, ${inRange.filter(isSg3Node).length} of a type this build adds; `
      + `${networks} home(s) with a 3.0 network${networks > 1 ? ', only the first is used' : ''}, `
      + `${homes.filter((home) => home.homeKey).length} home key(s)`);
    // A certain device of a type this build adds, left out for its id alone.
    const outside = all.filter((device) => device.certain && Object.prototype.hasOwnProperty.call(SG3_PRODUCTS, device.type)
      && !isSg3Node(device));
    for (const device of outside.slice(0, OUTSIDE_LINES)) {
      const id = Number.isInteger(device.meshId) ? hex4(device.meshId) : 'no id';
      this.app.log(`[SG account] SG Smart 3.0: type ${device.type} with ${id} left out: not from `
        + `${hex4(SG3_NODE_FIRST)} to ${hex4(SG3_NODE_LAST)}`);
    }
    if (outside.length > OUTSIDE_LINES) {
      this.app.log(`[SG account] SG Smart 3.0: and ${outside.length - OUTSIDE_LINES} more left out for the id`);
    }
  }

  // The SG Smart 3.0 network, or null: from the first home that makes one
  // Whether "Fetch again" is what SG Smart 3.0 needs: no 3.0 network to use,
  // and a home kept before the home's key (fetched before 2.8.0) with its
  // keys and 3.0 devices.
  sg3FetchAgain() {
    if (!this._state || this.sg3Network()) return false;
    return this._state.homes.some((home) => !home.homeKey && home.netKey && home.appKey
      && home.devices.some((device) => familyForType(device.type) === 'sg3'));
  }

  // (sg3Homes), as { homeKey, netKey, appKey, devices, addresses, bridges },
  // the devices being that home's certain 3.0 devices of the types this
  // build adds, with an id in the node range; addresses every id of the
  // home's 3.0 devices, for Homey to keep clear of; and bridges the ids of
  // those of them that may carry Homey's link (sgProducts, sg3CanBeBridge).
  // One network only for now.
  sg3Network() {
    if (!this._state) return null;
    const home = sg3Homes(this._state.homes)[0];
    if (!home) return null;
    return {
      homeKey: home.homeKey,
      netKey: home.netKey.toLowerCase(),
      appKey: home.appKey.toLowerCase(),
      devices: home.devices.filter(isSg3Node).map((device) => ({ meshId: device.meshId, type: device.type, name: device.name })),
      addresses: [...new Set(home.devices.filter((device) => familyForType(device.type) === 'sg3' && Number.isInteger(device.meshId))
        .map((device) => device.meshId))].sort((a, b) => a - b),
      bridges: home.devices.filter((device) => isSg3Node(device) && sg3CanBeBridge(device.type))
        .map((device) => device.meshId).sort((a, b) => a - b),
    };
  }

  // The location id for an FF04 to this mesh id, or null: the device's own
  // (from its device here, or the one its FF11 brought), else its home's from
  // the account when the homes that have this mesh id agree on one.
  _locationFor(meshId) {
    for (const device of this.app._devices()) {
      if (typeof device.getCsrMeshId !== 'function' || device.getCsrMeshId() !== meshId) continue;
      const location = device.getCsrLocationId();
      if (Number.isInteger(location) && location > 0) return location;
    }
    const node = this.app.csr && this.app.csr.nodes.get(meshId);
    if (node && Number.isInteger(node.location) && node.location > 0) return node.location;
    const homes = new Set(this._homesWith(meshId).map((home) => home.locationId).filter(Number.isInteger));
    return homes.size === 1 ? [...homes][0] : null;
  }

  _wait(ms) {
    return new Promise((resolve) => {
      const timer = this.homey.setTimeout(() => {
        this._timers.delete(timer);
        resolve();
      }, ms);
      this._timers.add(timer);
    });
  }

  // One FF04 to each certain later CSRmesh device of the account that has a
  // location id, one after the other and none twice, then ANSWER_MS for the
  // answers. One without a location id is not asked: unknown. An uncertain
  // device is not asked, and does not count.
  async _check(run) {
    const startedAt = Date.now();
    const asked = [];
    const unknown = [];
    for (const meshId of new Set(this.devices().filter((device) => device.certain && familyForType(device.type) === 'csr')
      .map((device) => device.meshId))) {
      if (run !== this._run) return;
      const location = this._locationFor(meshId);
      if (location === null) {
        unknown.push(meshId);
        continue;
      }
      asked.push(meshId);
      try {
        await this.app.csr.requestStatus(meshId, location);
      } catch (err) {
        this.app.error(`[SG account] FF04 to ${hex4(meshId)} failed: ${err.message || err}`);
      }
    }
    if (asked.length) await this._wait(ANSWER_MS);
    if (run !== this._run || !this._state) return;
    const answers = (device) => {
      if (!device.certain) return false;
      const family = familyForType(device.type);
      if (family === 'gen1') return typeof this.app.recentlyHeard === 'function' && this.app.recentlyHeard(device.meshId);
      if (family === 'csr') return asked.includes(device.meshId) && (this._heardAt.get(device.meshId) || 0) >= startedAt;
      return false;
    };
    this._state.check = {
      at: new Date().toISOString(),
      answering: this._state.homes.map((home) => home.devices.filter(answers).map((device) => device.meshId)),
      unknown,
    };
    this._save();
    const isUnknown = (device) => device.certain && familyForType(device.type) === 'csr' && unknown.includes(device.meshId);
    const counted = this.devices().filter((device) => device.certain && familyForType(device.type) !== 'sg3' && !isUnknown(device));
    const answering = this._state.check.answering.reduce((sum, ids) => sum + ids.length, 0);
    const unknownCount = this.devices().filter(isUnknown).length;
    const uncertain = this.devices().filter((device) => !device.certain && familyForType(device.type) !== 'sg3').length;
    this.app.log(`[SG account] check: ${answering} of ${counted.length} answer, ${asked.length} FF04 sent, `
      + `${unknownCount} unknown (no location id), ${uncertain} uncertain (not counted), `
      + `${this.devices().filter((device) => familyForType(device.type) === 'sg3').length} SG Smart 3.0 not asked`);
  }

  // Remove everything kept from the account. A fetch or check that still
  // runs keeps nothing.
  forget() {
    this._run += 1;
    this._checking = false;
    for (const timer of this._timers) this.homey.clearTimeout(timer);
    this._timers.clear();
    this._state = null;
    this._heardAt.clear();
    if (typeof this.homey.settings.unset === 'function') this.homey.settings.unset(SETTING);
    else this.homey.settings.set(SETTING, null);
    this.app.log('[SG account] forgotten: the devices use their own passphrase or 1234');
    this._changed();
    return this.summary();
  }

  // A device of the account by name for the page: its name in Homey when it
  // is added here, else its product and address.
  _shown(device) {
    for (const added of this.app._devices()) {
      const meshId = typeof added.getCsrMeshId === 'function' ? added.getCsrMeshId()
        : typeof added.getMeshId === 'function' ? added.getMeshId() : null;
      if (meshId === device.meshId) return { name: added.getName() };
    }
    const family = familyForType(device.type);
    const product = family === 'gen1' ? 'LEDDim Smart' : family === 'sg3' ? 'SG Smart 3.0'
      : (csrProductForType(device.type) || {}).name || null;
    return { product, type: device.type, address: device.meshId.toString(16).toUpperCase().padStart(4, '0') };
  }

  // When the account was fetched, as the settings page shows it: in Homey's
  // time zone and language ("4. nov. kl. 06:40"), or in UTC marked "UTC" when
  // the zone cannot be used (lib/localTime.js). What is kept and logged stays
  // ISO in UTC. The log says which it was when that changes, never the zone.
  _shownTime(iso) {
    let zone = null;
    try {
      const clock = this.app.homey && this.app.homey.clock;
      zone = clock && typeof clock.getTimezone === 'function' ? clock.getTimezone() : null;
    } catch (err) {
      zone = null;
    }
    const shown = localTime(iso, zone);
    const said = shown.zoned ? 'in Homey\'s time zone' : `in UTC (${shown.why})`;
    if (said !== this._timeSaid) {
      this._timeSaid = said;
      this.app.log(`[SG account] the fetched time is shown ${said}`);
    }
    return localText(shown, (key, tokens) => this.homey.__(key, tokens));
  }

  // What the settings page shows.
  summary() {
    const available = this.available();
    if (!this._state) return { available, fetched: false, checking: false, homes: [] };
    const { check } = this._state;
    const network = sg3Homes(this._state.homes)[0];
    return {
      available,
      fetched: true,
      fetchedAt: this._state.fetchedAt,
      fetchedAtShown: this._shownTime(this._state.fetchedAt),
      checking: this._checking,
      homes: this._state.homes.map((home, i) => {
        const sg3 = home.devices.filter((device) => familyForType(device.type) === 'sg3').length;
        const unknownIds = new Set(check && Array.isArray(check.unknown) ? check.unknown : []);
        const unknown = home.devices.filter((device) => device.certain && familyForType(device.type) === 'csr' && unknownIds.has(device.meshId));
        const counted = home.devices.filter((device) => device.certain && familyForType(device.type) !== 'sg3' && !unknown.includes(device));
        const answering = new Set(check && check.answering[i] ? check.answering[i] : []);
        return {
          number: i + 1,
          devices: home.devices.length,
          passphrase: !!home.passphrase,
          sg3,
          // The 3.0 devices here: the network in use ('ready'), kept before
          // the home's key ('fetchAgain'), or for a later version.
          sg3State: home === network ? 'ready' : !home.homeKey && home.netKey && home.appKey && sg3 ? 'fetchAgain' : 'later',
          checked: !!check,
          answering: counted.filter((device) => answering.has(device.meshId)).length,
          total: counted.length,
          quiet: check ? counted.filter((device) => !answering.has(device.meshId)).map((device) => this._shown(device)) : [],
          unknown: unknown.map((device) => this._shown(device)),
        };
      }),
    };
  }
}

module.exports = {
  INTERFACE_VERSIONS, NAME_MAX, SETTING, SgAccount, cleanName, errorKey, loadAccountModule,
};
