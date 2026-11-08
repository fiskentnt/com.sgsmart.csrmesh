'use strict';

const Homey = require('homey');
const SGMeshDevice = require('./SGDeviceBase');
const { SG3_PRODUCTS, sg3CanBeBridge } = require('./sgProducts');

// An SG Smart 3.0 dimmer (LEDDim Smart 3.0 and 2-pole 3.0, 2.8.0), the
// device of the driver LEDDim Smart 3.0 (drivers/sg3_dimmer). Its id is
// "sig:<home key>:<address>": the home's key from the SG account and the
// dimmer's address in its mesh, 4 hex digits. The id never changes after
// pairing. The network, its keys and the link are the app's (app.js, sg3,
// and lib/sg3/controller.js); this file loads nothing from lib/sg3, so
// without a 3.0 network none of it is loaded.
//
// On and off and the level go to the dimmer as one command per gesture: 0 is
// off, 1 to 100 the level, LEVEL_ON on at the level it had. Status from the
// dimmer sets onoff and dim. "On" alone is sent only to a dimmer that is
// off, as for the first generation (lib/SGDeviceBase.js): a LEVEL_ON to a
// dimmer that is on turned it off and on again (seen 2026-11-05). What is
// known of it goes stale when the link goes (the wall switch may change it
// unheard) and at start; "on" then asks the dimmer first.
//
// "Signal to Homey" and "Link" as for the first generation, with the same
// methods (lib/SGDeviceBase.js, setSignal and setConnection: the median, the
// limits for a weak signal and the texts): when a link comes up, the dimmer
// it goes through shows "Direct" and the signal of the advertisement the link
// was opened from, the other 3.0 devices "Indirect" (_showProxy). Shown as
// it was while no link is up, and after a restart until the first one. The
// methods are called from here, not put on this class under their names:
// app.js gives the first generation's signal and bridge to every device that
// has setSignal and setConnection (reportSignal, bridgeChanged), and those
// are not this dimmer's.
//
// Its methods are named getSg3Address and getSg3HomeKey, not getMeshId or
// getCsrMeshId, so the first generation and CSRmesh bookkeeping in app.js
// and lib/account.js leave it out. It has no settings: its keys come from
// the SG account.

// onoff and dim come in the same breath when a slider is dragged on a dark lamp.
const DIM_DEBOUNCE_MS = 250;
// Siri sends "on" and then the level 0.28 to 0.38 s apart (seen 2026-11-05),
// too far apart for the debounce above. "On" without a level to a dimmer
// that is off waits this long for one; to a dimmer that is on, it sends
// nothing. Off and levels are not held.
const ON_WAIT_MS = 800;
const LEVEL_ON = 101;
// The signal and the link, named as on the first generation's dimmers.
const SIGNAL_CAPABILITIES = ['measure_signal_strength', 'sg_connection'];
const SIGNAL_TITLE = { en: 'Signal to Homey', no: 'Signal til Homey' };

const SG3_ID = /^sig:([0-9a-f]{12}):([0-9a-f]{4})$/;

const hex4 = (value) => `0x${value.toString(16).padStart(4, '0')}`;

// A 3.0 device's id from its home's key and its address.
function sg3Id(homeKey, address) {
  return `sig:${homeKey}:${address.toString(16).padStart(4, '0')}`;
}

// { homeKey, address } from a 3.0 device's id, or null for any other id.
function parseSg3Id(id) {
  const match = SG3_ID.exec(String(id || ''));
  return match ? { homeKey: match[1], address: parseInt(match[2], 16) } : null;
}

// The 3.0 dimmers of the SG account's 3.0 network (lib/account.js,
// sg3Network), and those found in the pairing scan that the account does
// not have (found: { address, type } from lib/sg3/advert.js), as pairing
// lists them (drivers/sg3_dimmer), the added ones left out. The account's
// first, named as in the SG app, else "LEDDim Smart 3.0 0003"; then those
// from the scan by address, named so too. One per address: the account's
// wins. A node from the scan whose type is not known here is left out
// (unknown counts them). With onoff, dim, the signal and the link (Athom:
// the-basics/devices/pairing.md, capabilitiesOptions). addedIds are the ids
// of the devices added, in capitals. Never throws: a pairing of the other
// dimmers goes on without them.
function sg3PairingDevices(account, addedIds, found = []) {
  let network = null;
  try {
    network = account && typeof account.sg3Network === 'function' && account.fetched() ? account.sg3Network() : null;
  } catch (err) {
    network = null;
  }
  if (!network) return { devices: [], inAccount: 0, inScan: 0, unknown: 0, added: 0 };
  const listed = (address, type, name) => ({
    name: name || `${SG3_PRODUCTS[type].name} ${address.toString(16).toUpperCase().padStart(4, '0')}`,
    data: { id: sg3Id(network.homeKey, address) },
    capabilities: ['onoff', 'dim', ...SIGNAL_CAPABILITIES],
    capabilitiesOptions: { measure_signal_strength: { title: SIGNAL_TITLE } },
    store: { sg3Type: type },
  });
  const fromAccount = network.devices.map((device) => listed(device.meshId, device.type, device.name));
  const known = new Set(network.devices.map((device) => device.meshId));
  const scanned = new Map();
  let unknown = 0;
  for (const node of Array.isArray(found) ? found : []) {
    if (!node || known.has(node.address) || scanned.has(node.address)) continue;
    if (!Object.prototype.hasOwnProperty.call(SG3_PRODUCTS, node.type)) {
      unknown += 1;
      continue;
    }
    scanned.set(node.address, node.type);
  }
  const fromScan = [...scanned.entries()].sort(([a], [b]) => a - b).map(([address, type]) => listed(address, type, null));
  const all = [...fromAccount, ...fromScan];
  const devices = all.filter((device) => !addedIds.has(device.data.id.toUpperCase()));
  return { devices, inAccount: fromAccount.length, inScan: fromScan.length, unknown, added: all.length - devices.length };
}

class SG3Device extends Homey.Device {
  async onInit() {
    const parsed = parseSg3Id(this.getData().id);
    this._address = parsed.address;
    this._homeKey = parsed.homeKey;
    this._sg3 = null;
    this._shown = null;
    this._onWait = null;
    this._gesture = 0; // counts the gestures, so an older one's late answer is dropped
    // Whether the dimmer is on, as last known: from its status and the
    // commands sent here, and at start from onoff as Homey kept it. Stale
    // from start and whenever the link goes, until a status or a command.
    const kept = this.getCapabilityValue('onoff');
    this._on = typeof kept === 'boolean' ? kept : null;
    this._stale = true;
    this._onStatus = (status) => {
      if (status.node === this._address) this.applyStatus(status);
    };
    this._onConnection = (connected) => {
      if (!connected) this._stale = true;
    };
    this._onProxy = (node) => this._showProxy(node);
    this.registerMultipleCapabilityListener(['onoff', 'dim'], async (values) => {
      this._onCapabilities(values);
    }, DIM_DEBOUNCE_MS);
    await this._addSignal();
    await this.updateSg3();
    const app = this.homey.app;
    if (app && typeof app.sg3DevicesChanged === 'function') app.sg3DevicesChanged();
    this.log(`SG Smart 3.0 dimmer ready (${this.getStoreValue('sg3Type')}, address ${hex4(this._address)})`);
  }

  // null once deleted: Homey may still list the device while onDeleted runs.
  getSg3Address() {
    return this._deleted ? null : this._address;
  }

  getSg3HomeKey() {
    return this._homeKey;
  }

  // A 3.0 dimmer added before it had them gets the signal and the link, and
  // the signal its name (Athom: guides/how-to-breaking-changes.md).
  async _addSignal() {
    for (const capability of SIGNAL_CAPABILITIES) {
      if (this.hasCapability(capability)) continue;
      await this.addCapability(capability)
        .catch((err) => this.error(`adding ${capability} failed: ${err.message || err}`));
    }
    if (!this.hasCapability('measure_signal_strength')) return;
    let current = null;
    try {
      current = (this.getCapabilityOptions('measure_signal_strength') || {}).title;
    } catch (err) { /* no options yet */ }
    if (!current || current.en !== SIGNAL_TITLE.en || current.no !== SIGNAL_TITLE.no) {
      await this.setCapabilityOptions('measure_signal_strength', { title: SIGNAL_TITLE })
        .catch((err) => this.error(`naming the signal failed: ${err.message || err}`));
    }
  }

  // The node a new link goes through (lib/sg3/controller.js, 'proxy'): this
  // dimmer shows "Direct" with the signal, any other node makes it
  // "Indirect". The link first, so the signal's text has it.
  _showProxy({ address, rssi }) {
    const direct = address === this._address;
    SGMeshDevice.prototype.setConnection.call(this, direct);
    if (direct) SGMeshDevice.prototype.setSignal.call(this, rssi);
  }

  // Whether Homey's link may go through this dimmer (lib/sgProducts.js):
  // what the default of "Keep SG Smart 3.0 connected" counts.
  canBeSg3Bridge() {
    return sg3CanBeBridge(this.getStoreValue('sg3Type'));
  }

  // Takes the app's 3.0 controller as it is now (app.js, sg3): at start,
  // and when the SG account was fetched or forgotten. Unavailable while the
  // account has no 3.0 network, or one of another home.
  async updateSg3() {
    const app = this.homey.app;
    const sg3 = app && typeof app.sg3 === 'function' ? app.sg3() : null;
    const ours = sg3 && app.sg3HomeKey() === this._homeKey ? sg3 : null;
    if (ours !== this._sg3) {
      this._detach();
      this._sg3 = ours;
      if (ours) {
        ours.on('status', this._onStatus);
        ours.on('connection', this._onConnection);
        ours.on('proxy', this._onProxy);
        // A link already up before this device was: its node now.
        if (ours.proxyNode) this._showProxy(ours.proxyNode);
        ours.start();
      }
    }
    if (ours) await this._typeFromAccount();
    const why = ours ? null : sg3 ? 'device.sg3OtherHome' : 'device.sg3NoNetwork';
    if (why === this._shown) return;
    this._shown = why;
    if (why) {
      this.log(`unavailable: ${sg3 ? 'the account\'s 3.0 network is another home\'s' : 'no 3.0 network in the SG account'}`);
      await this.setUnavailable(this.homey.__(why)).catch(() => {});
    } else {
      await this.setAvailable().catch(() => {});
    }
  }

  // The SG account has this dimmer (a later fetch after it was added from
  // the pairing scan): the account's type counts, if it differs from the one
  // the scan gave, with one line in the log. The name in Homey is the user's
  // and stays.
  async _typeFromAccount() {
    let network = null;
    try {
      const account = this.homey.app && this.homey.app.account;
      network = account && typeof account.sg3Network === 'function' ? account.sg3Network() : null;
    } catch (err) {
      network = null;
    }
    if (!network || network.homeKey !== this._homeKey) return;
    const inAccount = network.devices.find((device) => device.meshId === this._address);
    if (!inAccount || !Object.prototype.hasOwnProperty.call(SG3_PRODUCTS, inAccount.type)) return;
    const kept = this.getStoreValue('sg3Type');
    if (kept === inAccount.type) return;
    await this.setStoreValue('sg3Type', inAccount.type).catch((err) => this.error(`type not kept: ${err.message || err}`));
    this.log(`type from the SG account: ${inAccount.type} (was ${kept})`);
  }

  // One gesture from Homey, after the debounce. "On" alone: nothing to a
  // dimmer known to be on; to one known to be off, LEVEL_ON after
  // ON_WAIT_MS, unless a level or off comes first. When what is known is
  // stale or there is nothing, the dimmer is asked at once, and after
  // ON_WAIT_MS its answer decides: on, nothing; off or no answer, LEVEL_ON.
  _onCapabilities(values) {
    // Each change from Homey, with how long after the one before it came, as
    // the first generation logs it (lib/SGDeviceBase.js): what Homey sent
    // shows, also the gap between Siri's "on" and level.
    const now = Date.now();
    const gap = this._capabilitiesAt ? ` (+${now - this._capabilitiesAt}ms)` : '';
    this._capabilitiesAt = now;
    this.log(`capability in: ${Object.entries(values).map(([key, value]) => `${key}=${value}`).join(' ')}${gap}`);
    this._cancelOnWait();
    this._gesture += 1;
    if (values.onoff === true && typeof values.dim !== 'number') {
      const stale = this._stale || this._on === null;
      if (this._on === true && !stale) {
        this.log('"on" while on: nothing sent');
        return;
      }
      const gesture = this._gesture;
      // Its answer decides here alone: as a status it would set onoff to off
      // just before LEVEL_ON turns the dimmer on.
      const asked = stale && this._sg3 ? this._sg3.getStatus(this._address, { quiet: true }).catch(() => null) : null;
      this._onWait = this.homey.setTimeout(async () => {
        this._onWait = null;
        if (asked) {
          const status = await asked;
          if (gesture !== this._gesture) return;
          if (status && status.on) {
            this.log('status before "on": on, nothing sent');
            return;
          }
          this.log(`status before "on": ${status ? 'off' : 'no answer'}`);
        }
        this._command(LEVEL_ON);
      }, ON_WAIT_MS);
      return;
    }
    this._command(this._levelFor(values));
  }

  _cancelOnWait() {
    if (this._onWait) this.homey.clearTimeout(this._onWait);
    this._onWait = null;
  }

  // One gesture: 0 off, 1 to 100 the level, LEVEL_ON for "on" alone.
  _levelFor({ onoff, dim }) {
    if (typeof dim === 'number') return onoff === false ? 0 : Math.max(0, Math.min(100, Math.round(dim * 100)));
    return onoff ? LEVEL_ON : 0;
  }

  // Sent in the background, so the capability listener answers Homey at
  // once also while the link is being set up. A command that does not get
  // out leaves a warning, until the next one gets out.
  _command(level) {
    const sg3 = this._sg3;
    if (!sg3) return;
    this._on = level !== 0;
    this._stale = false;
    const gesture = this._gesture;
    if (level === 0) this.setCapabilityValue('onoff', false).catch(() => {});
    else if (level !== LEVEL_ON) this.setCapabilityValue('onoff', true).catch(() => {});
    sg3.setLevel(this._address, level).then((result) => {
      // A newer command took its place while it waited for a link.
      if (result && result.superseded) return;
      // LEVEL_ON went out: the dimmer is on, whatever onoff showed meanwhile.
      if (level === LEVEL_ON) this.setCapabilityValue('onoff', true).catch(() => {});
      if (this._failed) {
        this._failed = false;
        this.unsetWarning().catch(() => {});
      }
    }, (err) => {
      this.error(`level ${level} not sent: ${err.message || err}`);
      // Not sent: what the dimmer has is unknown, so the next "on" asks it
      // first, unless a newer gesture came meanwhile.
      if (gesture === this._gesture) this._stale = true;
      this._failed = true;
      this.setWarning(this.homey.__('device.sg3NotSent')).catch(() => {});
    });
  }

  // A status from the dimmer (lib/sg3/controller.js, 'status'). The
  // controller has logged it, so it is not logged again here.
  applyStatus({ on, level }) {
    this._on = on;
    this._stale = false;
    const changes = [this.setCapabilityValue('onoff', on)];
    if (on && level > 0) changes.push(this.setCapabilityValue('dim', level / 100));
    Promise.all(changes).catch(() => {});
  }

  async onAdded() {
    const app = this.homey.app;
    if (app && typeof app.sg3DevicesChanged === 'function') app.sg3DevicesChanged();
  }

  async onDeleted() {
    this._deleted = true;
    this._cancelOnWait();
    this._detach();
    const app = this.homey.app;
    if (app && typeof app.sg3DevicesChanged === 'function') app.sg3DevicesChanged();
  }

  async onUninit() {
    this._cancelOnWait();
    this._detach();
  }

  _detach() {
    if (this._sg3) {
      this._sg3.off('status', this._onStatus);
      this._sg3.off('connection', this._onConnection);
      this._sg3.off('proxy', this._onProxy);
    }
    this._sg3 = null;
  }
}

// What the first generation's setSignal and setConnection call for the
// text under "Link" (see the top).
SG3Device.prototype._showConnection = SGMeshDevice.prototype._showConnection;

module.exports = SG3Device;
module.exports.LEVEL_ON = LEVEL_ON;
module.exports.parseSg3Id = parseSg3Id;
module.exports.sg3Id = sg3Id;
module.exports.sg3PairingDevices = sg3PairingDevices;
