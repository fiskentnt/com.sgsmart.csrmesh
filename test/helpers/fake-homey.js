'use strict';

// A stand-in for the 'homey' module, so the app's classes can be loaded and
// driven outside Homey. Only what the tests touch is here.

const Module = require('module');

const { SEARCH_LISTEN_MS } = require('../../lib/CsrNetwork');

class FakeDevice {
  constructor({ homey, store = {}, settings = {}, data = {}, name = 'device' } = {}) {
    this.homey = homey;
    this._store = { ...store };
    this._settings = { ...settings };
    this._data = { ...data };
    this._name = name;
    this._capabilities = {};
    this.available = true;
    this.unavailableReason = null;
    this.warning = null;
    this.logs = [];
    this.errors = [];
  }

  getStoreValue(key) { return this._store[key]; }
  async setStoreValue(key, value) { this._store[key] = value; }
  getSettings() { return this._settings; }
  getData() { return this._data; }
  getName() { return this._name; }
  hasCapability(capability) { return ['onoff', 'dim', 'measure_signal_strength', 'sg_connection'].includes(capability); }
  async addCapability() {}
  async removeCapability() {}
  getCapabilityOptions() { return { title: { en: 'Signal to Homey', no: 'Signal til Homey' } }; }
  async setCapabilityOptions() {}
  getCapabilityValue(capability) { return this._capabilities[capability]; }
  async setCapabilityValue(capability, value) { this._capabilities[capability] = value; }
  async setAvailable() { this.available = true; this.unavailableReason = null; }
  async setUnavailable(reason) { this.available = false; this.unavailableReason = reason; }
  async setWarning(text) { this.warning = text; }
  async unsetWarning() { this.warning = null; }
  registerMultipleCapabilityListener() {}
  log(...args) { this.logs.push(args.join(' ')); }
  error(...args) { this.errors.push(args.join(' ')); }
}

class FakeApp {
  log(...args) { (this.logs || (this.logs = [])).push(args.join(' ')); }
  error(...args) { (this.errors || (this.errors = [])).push(args.join(' ')); }
}

class FakeDriver extends FakeDevice {}

// Timers that run only when a test says so.
function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimeout(fn, ms) { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    setInterval() { return next++; },
    clearInterval() {},
    pending,
    runAll() {
      for (const [id, { fn }] of [...pending]) {
        pending.delete(id);
        fn();
      }
    },
    // Only the timers set for this long.
    runMs(ms) {
      for (const [id, entry] of [...pending]) {
        if (entry.ms !== ms) continue;
        pending.delete(id);
        entry.fn();
      }
    },
  };
}

function fakeHomey(app, extra = {}) {
  const settings = new Map();
  return {
    app,
    __: (key) => key,
    settings: { get: (key) => (settings.has(key) ? settings.get(key) : null), set: (key, value) => settings.set(key, value) },
    ...fakeTimers(),
    ...extra,
  };
}

const homeyModule = { Device: FakeDevice, App: FakeApp, Driver: FakeDriver };

// Hand the fake to every require('homey') from here on.
function install() {
  const load = Module._load;
  Module._load = function loadWithFakeHomey(request, ...rest) {
    if (request === 'homey') return homeyModule;
    return load.call(this, request, ...rest);
  };
}

// CsrNetwork as a pairing search uses it (lib/csrPairing.js): requestNames
// sends FF10 and hears the answers (a list, or a function giving one), and
// nodes holds every node heard, the first answer newest. sent counts FF10s,
// asked holds the options of the last one.
function fakeCsr(answers = []) {
  const csr = { nodes: new Map(), sent: 0 };
  csr.requestNames = async (options) => {
    csr.sent += 1;
    csr.asked = options;
    const heard = typeof answers === 'function' ? await answers() : answers;
    heard.forEach((node, i) => csr.nodes.set(node.meshId, { ...node, seenAt: heard.length - i }));
    return true;
  };
  return csr;
}

// The listening after FF10 (SEARCH_LISTEN_MS) is over at once; the other
// timers still wait for the test.
function listenAtOnce(homey) {
  const wait = homey.setTimeout;
  homey.setTimeout = (fn, ms) => (ms === SEARCH_LISTEN_MS ? (setImmediate(fn), 0) : wait(fn, ms));
  return homey;
}

module.exports = {
  FakeDevice, fakeCsr, fakeHomey, fakeTimers, install, listenAtOnce,
};
