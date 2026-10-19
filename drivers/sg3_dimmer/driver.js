'use strict';

// SG Smart 3.0 dimmers (Bluetooth SIG Mesh). Homey loads this file at start
// for every user, so it loads nothing from lib/sg3: the app creates the 3.0
// controller only when a network has been imported.

const Homey = require('homey');

function hex(address) {
  return address.toString(16).padStart(4, '0').toUpperCase();
}

class Sg3DimmerDriver extends Homey.Driver {
  controller() {
    return this.homey.app.sg3({ create: Boolean(this.homey.settings.get('sg3Network')) });
  }

  async onPair(session) {
    let found = [];

    // The search view (pair/search.html) asks first; list_devices shows the result.
    session.setHandler('search', async () => {
      const sg3 = this.controller();
      if (!sg3 || !sg3.configured) return { configured: false };
      found = await sg3.searchDimmers();
      return { configured: true, count: found.length };
    });

    session.setHandler('list_devices', async () => {
      const sg3 = this.controller();
      if (!sg3 || !sg3.configured) return [];
      return found.map((dimmer) => ({
        name: dimmer.name || `SG Smart 3.0 ${hex(dimmer.unicast)}`,
        data: { id: `${sg3.networkId}:${hex(dimmer.unicast)}` },
        store: { unicast: dimmer.unicast },
      }));
    });
  }
}

module.exports = Sg3DimmerDriver;
