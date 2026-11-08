'use strict';

const Homey = require('homey');
const SG3Device = require('../../lib/SG3Device');

const { sg3PairingDevices } = SG3Device;

// LEDDim Smart 3.0 (2.8.0): the SG Smart 3.0 dimmers, added from the SG
// account's 3.0 network (lib/account.js, sg3Network), never from a scan.
// Pairing sends nothing and scans nothing, so no link is paused for it: the
// guide says whether the account is fetched, and the list is the account's
// 3.0 dimmers not yet added. The link and the keys are the app's (app.js,
// sg3); the device is lib/SG3Device.js. It has no settings.
class SG3Driver extends Homey.Driver {
  // Athom: the-basics/devices/pairing.md and
  // advanced/custom-views/custom-pairing-views.md (Homey.emit). An error from
  // list_devices is shown in the list.
  async onPair(session) {
    session.setHandler('account', async () => ({ fetched: this._fetched() }));
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

  // The account's 3.0 dimmers that are not added, or an error that says why
  // there are none: no account fetched, one fetched before 2.8.0 that needs
  // "Fetch again", none in it, or all added.
  async _list() {
    if (!this._fetched()) throw new Error(this.homey.__('pair.sg3.loginFirst'));
    const addedIds = new Set(this.getDevices().map((device) => String((device.getData() || {}).id || '').toUpperCase()));
    const { devices, inAccount, added } = sg3PairingDevices(this._account(), addedIds);
    this.log(`pair: SG Smart 3.0: ${inAccount} dimmer(s) in the SG account, ${added} already added`);
    if (!inAccount && this._fetchAgain()) throw new Error(this.homey.__('pair.sg3Guide.fetchAgain'));
    if (!inAccount) throw new Error(this.homey.__('pair.sg3.none'));
    if (!devices.length) throw new Error(this.homey.__('pair.sg3.allAdded'));
    return devices;
  }
}

module.exports = SG3Driver;
