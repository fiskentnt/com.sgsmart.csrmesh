'use strict';

const Homey = require('homey');
const {
  accountFindings, ff11CountLine, foundNote, laterDevice, laterNodes, loginHint, named, pairInLoadingView, quietInAccount, sgNodesLine,
  withStates,
} = require('../../lib/csrPairing');
const { meshAdvertsLineFor } = require('../../lib/meshAdverts');

// LEDDim Smart DIN: the DIN dimmers of SG's CSRmesh products after the first
// generation (lib/sgProducts.js, DIN_DIMMER_PREFIXES), DIN and DIN 1000, also
// TW. One driver per product as the user sees it. Found and added as a Pill
// in sg_pill: a search scans for Bluetooth names and asks the mesh for names
// (FF10, see lib/CsrNetwork.js), and a DIN dimmer can be added once it has
// answered with its mesh id. Listed with the driver's icon. Other SG
// products it finds are logged, and named in the list when it found no DIN
// dimmer. Not tried with a device.
class SGDinDriver extends Homey.Driver {
  // The guide, then Homey's loading view while this searches, and on to the
  // list, as in sg_pill (lib/csrPairing.js).
  async onPair(session) {
    pairInLoadingView(this, session, { search: () => this._search(), list: (result) => this._listFrom(result) });
  }

  // As in sg_pill: FF10 that did not get out with nothing to add fails the
  // search; nothing found at all is an empty list; other products but no DIN
  // dimmer name what was found instead (lib/csrPairing.js); a DIN dimmer seen
  // without an answer and no SG account fetched gives the login hint.
  _listFrom({ devices, found, out }) {
    if (!out && devices.length === 0) return { error: 'failed, FF10 not out', text: this.homey.__('pair.csr.failed') };
    if (found.length === 0) return { devices: [], why: 'none found' };
    const note = foundNote(found, (key, tokens) => this.homey.__(key, tokens), 'sg_din');
    if (note) return { error: 'found, none to add', text: note };
    if (devices.length === 0) {
      const hint = loginHint(this, found, 'sg_din');
      if (hint) return { error: 'no answer from a DIN dimmer seen, no SG account', text: hint };
      return { devices, why: found.some((f) => f.state === 'noAnswer') ? 'no answer from a DIN dimmer seen' : 'all added' };
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
    const { nodes, out } = await laterNodes(this, 'sg_din');
    const added = new Set(this.getDevices().map((device) => String((device.getData() || {}).id || '')));
    const found = withStates(accountFindings(this, advertisements, nodes), 'sg_din', added);
    const devices = found.filter((f) => f.state === 'add').map((f) => named(this, laterDevice(f), f.node.meshId));
    // Counts and prefixes only: no addresses or names in the log.
    const states = found.map((f) => `${f.product.prefix} ${f.product.generation} ${f.product.kind} ${f.state}`);
    this.log(`pair: scan ${seconds.toFixed(1)} s, ${advertisements.length} advertisement(s), ${nodes.length} FF11 answer(s), `
      + `${found.length} SG device(s) after Gen1${states.length ? `: ${states.join('; ')}` : ''}`);
    this.log(ff11CountLine(found));
    const quiet = quietInAccount(this, 'sg_din');
    return {
      devices, found, out, ...(quiet.length ? { quiet } : {}),
    };
  }
}

module.exports = SGDinDriver;
