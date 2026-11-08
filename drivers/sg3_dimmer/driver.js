'use strict';

const Homey = require('homey');
const SG3Device = require('../../lib/SG3Device');
const { pauseForScan } = require('../../lib/csrPairing');
const { scanMakerLine } = require('../../lib/makerData');

const { sg3PairingDevices } = SG3Device;

// The proxy service, as the 3.0 link scans for it (lib/sg3/bridge.js).
const PROXY_SERVICE_SHORT = '1828';

// LEDDim Smart 3.0 (2.8.0): the SG Smart 3.0 dimmers of the 3.0 network
// whose keys the SG account kept (lib/account.js, sg3Network): those in the
// account, and those a scan finds that it does not have (a dimmer added in
// the SG app since the last fetch), so new ones need no fetch. Every
// pairing scans first, also without an account or a 3.0 network (2.9.0),
// with the links let go meanwhile (lib/csrPairing.js, pauseForScan): a node
// Homey or the phone is connected to does not advertise. The scan gives one
// line about the 3.0 nodes it saw (lib/makerData.js, scanMakerLine), so a
// tester's log tells the type byte of a product not known here; a node of
// such a type is never listed. Then the account: without kept keys the
// guide says to log in, and the list says so after the scan. A scan that
// fails leaves the account's alone. lib/sg3 is loaded only with a 3.0
// network, for the nodes of that network (lib/sg3/advert.js). The link and
// the keys are the app's (app.js, sg3); the device is lib/SG3Device.js. It
// has no settings.
class SG3Driver extends Homey.Driver {
  // Athom: the-basics/devices/pairing.md and
  // advanced/custom-views/custom-pairing-views.md (Homey.emit). An error from
  // list_devices is shown in the list.
  async onPair(session) {
    // For the guide: whether an account is fetched, and whether its 3.0 keys
    // are kept (then the pairing finds new dimmers without a fetch).
    session.setHandler('account', async () => {
      const fetched = this._fetched();
      return { fetched, keys: fetched && Boolean(this._network()) };
    });
    session.setHandler('list_devices', async () => this._list());
  }

  _account() {
    return this.homey.app ? this.homey.app.account : null;
  }

  _fetchAgain() {
    const account = this._account();
    try {
      return Boolean(account && typeof account.sg3FetchAgain === 'function' && account.sg3FetchAgain());
    } catch (err) {
      return false;
    }
  }

  _fetched() {
    const account = this._account();
    try {
      return Boolean(account && account.fetched());
    } catch (err) {
      return false;
    }
  }

  // The 3.0 dimmers not yet added, from the account and the scan, or an
  // error that says why there are none: no account fetched, one fetched
  // before 2.8.0 that needs "Fetch again", none found, or all added. The
  // scan comes first, so the error comes after it (about 10 s).
  async _list() {
    const scan = await this._scan();
    const fetched = this._fetched();
    const network = fetched ? this._network() : null;
    const found = this._nodesOf(scan, network);
    if (!fetched) throw new Error(this.homey.__('pair.sg3.loginFirst'));
    if (!network && this._fetchAgain()) throw new Error(this.homey.__('pair.sg3Guide.fetchAgain'));
    const addedIds = new Set(this.getDevices().map((device) => String((device.getData() || {}).id || '').toUpperCase()));
    const { devices, inAccount, inScan, unknown, added } = sg3PairingDevices(this._account(), addedIds, found);
    this.log(`pair: SG Smart 3.0: ${inAccount} dimmer(s) in the SG account, ${inScan} more found in the scan`
      + `${unknown ? `, ${unknown} of a type not known here left out` : ''}, ${added} already added`);
    if (!inAccount && !inScan) throw new Error(this.homey.__('pair.sg3.none'));
    if (!devices.length) throw new Error(this.homey.__('pair.sg3.allAdded'));
    return devices;
  }

  _network() {
    const account = this._account();
    try {
      return account && typeof account.sg3Network === 'function' ? account.sg3Network() : null;
    } catch (err) {
      return null;
    }
  }

  // A scan for proxy nodes, with the links let go meanwhile: { advertisements,
  // seconds }, or { failed } with why. Through the app's queue of scans when
  // there is one (app.js, bleDiscover).
  async _scan() {
    const end = await pauseForScan(this);
    const started = Date.now();
    try {
      const app = this.homey.app;
      const scan = app && typeof app.bleDiscover === 'function'
        ? app.bleDiscover([PROXY_SERVICE_SHORT]) : this.homey.ble.discover([PROXY_SERVICE_SHORT]);
      const advertisements = (await scan) || [];
      if (!Array.isArray(advertisements)) throw new Error('not a list of advertisements');
      return { advertisements, seconds: (Date.now() - started) / 1000 };
    } catch (err) {
      return { failed: (err && err.message) || String(err) };
    } finally {
      end('pairing done');
    }
  }

  // The nodes of the network in the scan ({ address, type }): none without a
  // 3.0 network or when the scan failed. Logs the scan, and the line about
  // the 3.0 nodes in it, of this network or not.
  _nodesOf(scan, network) {
    let failed = scan.failed;
    let nodes = [];
    if (!failed && network) {
      try {
        const { networkIdOf, sg3NodeFromAdvert } = require('../../lib/sg3/advert');
        const networkId = networkIdOf(network.netKey);
        nodes = scan.advertisements.map((advertisement) => sg3NodeFromAdvert(advertisement, networkId)).filter(Boolean);
      } catch (err) {
        failed = (err && err.message) || String(err);
      }
    }
    if (failed) {
      this.log(`pair: SG Smart 3.0 scan failed (${failed})${network ? ": the SG account's dimmers only" : ''}`);
      return [];
    }
    this.log(`pair: SG Smart 3.0 scan ${scan.seconds.toFixed(1)} s: ${scan.advertisements.length} advert(s), `
      + `${network ? `${nodes.length} of this network` : 'no 3.0 network kept'}`);
    try {
      this.log(`pair: ${scanMakerLine(scan.advertisements)}`);
    } catch (err) {
      this.log(`pair: manufacturer data not read (${(err && err.name) || 'error'})`);
    }
    return nodes;
  }
}

module.exports = SG3Driver;
