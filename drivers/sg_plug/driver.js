'use strict';

const Homey = require('homey');
const {
  accountFindings, ff11CountLine, foundNote, laterDevice, laterNodes, loginHint, named, pairInLoadingView, quietInAccount, sgNodesLine,
  withStates,
} = require('../../lib/csrPairing');
const { meshAdvertsLineFor } = require('../../lib/meshAdverts');

// Smart Plug and Smart Socket (lib/sgProducts.js, PLUG_PREFIXES), and Smart
// DIN 3600 (DIN_ONOFF_PREFIXES, with the DIN icon, assets/icons/din.svg; not
// tried with a device): turned on and off, found and added as the Pill family is in
// sg_pill: a search scans for Bluetooth names and asks the mesh for names
// (FF10, see lib/CsrNetwork.js), and a plug can be added once it has answered
// with its mesh id. The countdown cards are run by the device
// (drivers/sg_plug/device.js).
class SGPlugDriver extends Homey.Driver {
  async onInit() {
    const { flow } = this.homey;
    flow.getActionCard('plug_off_in').registerRunListener(({ device, minutes }) => device.offIn(minutes));
    flow.getActionCard('plug_on_for').registerRunListener(({ device, minutes }) => device.onFor(minutes));
    flow.getActionCard('plug_countdown_cancel').registerRunListener(({ device }) => device.cancelCountdown());
    flow.getConditionCard('plug_countdown_running').registerRunListener(({ device }) => device.countdownRunning());
  }

  // The guide, then Homey's loading view while this searches, and on to the
  // list, as in sg_pill (lib/csrPairing.js).
  async onPair(session) {
    pairInLoadingView(this, session, { search: () => this._search(), list: (result) => this._listFrom(result) });
  }

  // As in sg_pill: FF10 not out and nothing to add fails; nothing found at
  // all is an empty list, which Homey answers with its own text; other
  // products but no plug name what was found instead (lib/csrPairing.js).
  _listFrom({ devices, found, out }) {
    if (!out && devices.length === 0) return { error: 'failed, FF10 not out', text: this.homey.__('pair.csr.failed') };
    if (found.length === 0) return { devices: [], why: 'none found' };
    const note = foundNote(found, (key, tokens) => this.homey.__(key, tokens), 'sg_plug');
    if (note) return { error: 'found, none to add', text: note };
    if (devices.length === 0) {
      // Seen but no answer, and no SG account fetched: the login may bring the
      // password (lib/csrPairing.js, loginHint).
      const hint = loginHint(this, found, 'sg_plug');
      if (hint) return { error: 'no answer from a plug seen, no SG account', text: hint };
      return { devices, why: found.some((f) => f.state === 'noAnswer') ? 'no answer from a plug seen' : 'all added' };
    }
    return { devices };
  }

  // { devices, found, out }, as in sg_pill: the scan first, then FF10.
  async _search() {
    const started = Date.now();
    let advertisements;
    try {
      advertisements = await this.homey.ble.discover();
    } catch (err) {
      this.error(`pair: scan failed: ${err.message || err}`);
      throw err;
    }
    const seconds = (Date.now() - started) / 1000;
    this.log(sgNodesLine(advertisements));
    this.log(meshAdvertsLineFor(this, advertisements));
    const { nodes, out } = await laterNodes(this, 'sg_plug');
    const added = new Set(this.getDevices().map((device) => String((device.getData() || {}).id || '')));
    const found = withStates(accountFindings(this, advertisements, nodes), 'sg_plug', added);
    const devices = found.filter((f) => f.state === 'add').map((f) => named(this, laterDevice(f, { icons: true }), f.node.meshId));
    // Counts and prefixes only: no addresses or names in the log.
    const states = found.map((f) => `${f.product.prefix} ${f.product.generation} ${f.product.kind} ${f.state}`);
    this.log(`pair: scan ${seconds.toFixed(1)} s, ${advertisements.length} advertisement(s), ${nodes.length} FF11 answer(s), `
      + `${found.length} SG device(s) after Gen1${states.length ? `: ${states.join('; ')}` : ''}`);
    this.log(ff11CountLine(found));
    const quiet = quietInAccount(this, 'sg_plug');
    return { devices, found, out, ...(quiet.length ? { quiet } : {}) };
  }
}

module.exports = SGPlugDriver;
