'use strict';

const Homey = require('homey');
const {
  foundNote, laterDevice, laterFindings, laterNodes, pairInLoadingView, sgNodesLine, withStates,
} = require('../../lib/csrPairing');

// The Pill family of SG's CSRmesh products after the first generation
// (lib/sgProducts.js, PILL_PREFIXES), a trial in 2.5.0. A search scans for
// Bluetooth names and asks the mesh for names (FF10, see lib/CsrNetwork.js): a
// Pill can be added once it has answered with its mesh id. Other SG products
// it finds are logged, and named in the list when it found no Pill.
class SGPillDriver extends Homey.Driver {
  // The guide, then Homey's loading view while this searches, and on to the
  // list, as in sg_mesh (lib/csrPairing.js).
  async onPair(session) {
    pairInLoadingView(this, session, { search: () => this._search(), list: (result) => this._listFrom(result) });
  }

  // FF10 did not get out and there is nothing to add: a Pill can only be
  // added once it has answered FF10, so the search did not get far enough to
  // say, and it failed. No SG device found at all: an empty list, and Homey
  // says itself that no new devices were found (Athom: devices-list.md),
  // rather than a text of ours that repeats the guide. Other products but no
  // Pill: the list can show one text only, so it names what was found
  // instead (lib/csrPairing.js). Otherwise the other products are only in the
  // log, and the log line says why a list is empty.
  _listFrom({ devices, found, out }) {
    if (!out && devices.length === 0) return { error: 'failed, FF10 not out', text: this.homey.__('pair.csr.failed') };
    if (found.length === 0) return { devices: [], why: 'none found' };
    const note = foundNote(found, (key, tokens) => this.homey.__(key, tokens), 'sg_pill');
    if (note) return { error: 'found, none to add', text: note };
    if (devices.length === 0) {
      return { devices, why: found.some((f) => f.state === 'noAnswer') ? 'no answer from a Pill seen' : 'all added' };
    }
    return { devices };
  }

  // { devices, found, out }: devices to offer, every SG device found, each
  // with its state (lib/csrPairing.js): add, added, noAnswer, elsewhere or
  // notYet, and whether FF10 got out.
  // The scan first, then FF10, so that connecting for FF10 does not compete
  // with the scan. A failed scan fails the search; FF10 that does not get out
  // only leaves its answers out (laterNodes).
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
    const { nodes, out } = await laterNodes(this);
    const added = new Set(this.getDevices().map((device) => String((device.getData() || {}).id || '')));
    const found = withStates(laterFindings(advertisements, nodes), 'sg_pill', added);
    const devices = found.filter((f) => f.state === 'add').map((f) => laterDevice(f, { icons: true }));
    // Counts and prefixes only: no addresses or names in the log.
    const states = found.map((f) => `${f.product.prefix} ${f.product.generation} ${f.product.kind} ${f.state}`);
    this.log(`pair: scan ${seconds.toFixed(1)} s, ${advertisements.length} advertisement(s), ${nodes.length} FF11 answer(s), `
      + `${found.length} SG device(s) after Gen1${states.length ? `: ${states.join('; ')}` : ''}`);
    return { devices, found, out };
  }
}

module.exports = SGPillDriver;
