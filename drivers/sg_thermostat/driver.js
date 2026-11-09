'use strict';

const Homey = require('homey');
const {
  accountFindings, foundNote, laterNodes, loginHint, named, pairInLoadingView, quietInAccount, sgNodesLine, thermostatDevice,
  withStates,
} = require('../../lib/csrPairing');
const { meshAdvertsLineFor } = require('../../lib/meshAdverts');

// HeatReg Smart (lib/sgProducts.js, THERMOSTAT_PREFIXES), found and added as
// the Pill family is in sg_pill: a search scans for Bluetooth names and asks
// the mesh for names (FF10, see lib/CsrNetwork.js), and a thermostat can be
// added once it has answered with its mesh id. The device is
// lib/SGThermostatDevice.js.
class SGThermostatDriver extends Homey.Driver {
  async onInit() {
    const { flow } = this.homey;
    flow.getConditionCard('sg_heating_is').registerRunListener(({ device }) => device.getCapabilityValue('sg_heating') === true);
    flow.getConditionCard('sg_window_open_is').registerRunListener(({ device }) => device.getCapabilityValue('sg_window_open') === true);
    flow.getConditionCard('sg_heat_preset_is').registerRunListener(({ device, preset }) => device.getCapabilityValue('sg_heat_preset') === preset);
    // Through the same listener as the picker, so "Control from Homey" decides.
    flow.getActionCard('sg_heat_preset_set').registerRunListener(({ device, preset }) => device.triggerCapabilityListener('sg_heat_preset', preset));
  }

  // The guide, then Homey's loading view while this searches, and on to the
  // list, as in sg_pill (lib/csrPairing.js).
  async onPair(session) {
    pairInLoadingView(this, session, { search: () => this._search(), list: (result) => this._listFrom(result) });
  }

  // As in sg_pill and sg_plug.
  _listFrom({ devices, found, out }) {
    if (!out && devices.length === 0) return { error: 'failed, FF10 not out', text: this.homey.__('pair.csr.failed') };
    if (found.length === 0) return { devices: [], why: 'none found' };
    const note = foundNote(found, (key, tokens) => this.homey.__(key, tokens), 'sg_thermostat');
    if (note) return { error: 'found, none to add', text: note };
    if (devices.length === 0) {
      // Seen but no answer, and no SG account fetched: the login may bring the
      // password (lib/csrPairing.js, loginHint).
      const hint = loginHint(this, found, 'sg_thermostat');
      if (hint) return { error: 'no answer from a thermostat seen, no SG account', text: hint };
      return { devices, why: found.some((f) => f.state === 'noAnswer') ? 'no answer from a thermostat seen' : 'all added' };
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
    const { nodes, out } = await laterNodes(this);
    const added = new Set(this.getDevices().map((device) => String((device.getData() || {}).id || '')));
    const found = withStates(accountFindings(this, advertisements, nodes), 'sg_thermostat', added);
    const devices = found.filter((f) => f.state === 'add').map((f) => named(this, thermostatDevice(f), f.node.meshId));
    // Counts and prefixes only: no addresses or names in the log.
    const states = found.map((f) => `${f.product.prefix} ${f.product.generation} ${f.product.kind} ${f.state}`);
    this.log(`pair: scan ${seconds.toFixed(1)} s, ${advertisements.length} advertisement(s), ${nodes.length} FF11 answer(s), `
      + `${found.length} SG device(s) after Gen1${states.length ? `: ${states.join('; ')}` : ''}`);
    const quiet = quietInAccount(this, 'sg_thermostat');
    return { devices, found, out, ...(quiet.length ? { quiet } : {}) };
  }
}

module.exports = SGThermostatDriver;
