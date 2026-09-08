'use strict';

const Homey = require('homey');
const { NODE_NAME } = require('../../lib/csrmesh');

class SGMeshDriver extends Homey.Driver {
  async onPairListDevices() {
    const advertisements = await this.homey.ble.discover();

    // A mesh node repeats its advertisement; keep the strongest sighting of each.
    const byName = new Map();
    for (const adv of advertisements) {
      const localName = String(adv.localName || '').trim().toUpperCase();
      if (!NODE_NAME.test(localName)) continue;
      if (adv.connectable === false) continue;

      const previous = byName.get(localName);
      if (!previous || Number(adv.rssi ?? -999) > Number(previous.rssi ?? -999)) {
        byName.set(localName, adv);
      }
    }

    const candidates = [...byName.entries()]
      .sort(([, a], [, b]) => Number(b.rssi ?? -999) - Number(a.rssi ?? -999));

    if (!candidates.length) {
      throw new Error(this.homey.__('pair.noDimmersFound'));
    }

    this.log(`found ${candidates.length} CSRmesh node(s): ${candidates.map(([n]) => n).join(', ')}`);

    // Devices are listed under the name they broadcast; the user renames them
    // in Homey after pairing. data.id is that stable broadcast identity, which
    // is also what Homey uses to filter out already-paired devices.
    return candidates.map(([localName, adv]) => ({
      name: localName,
      data: { id: localName },
      store: {
        peripheralUuid: adv.uuid,
        address: adv.address || '',
        localName,
      },
    }));
  }
}

module.exports = SGMeshDriver;
