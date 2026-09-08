'use strict';

const Homey = require('homey');

const FRIENDLY_NAMES = {
  '@ND32C3': 'Stue sofa',
  '@ND44D0': 'Stue spisebord',
};

class SGMeshDriver extends Homey.Driver {
  _friendlyName(localName) {
    const key = String(localName || '').trim().toUpperCase();
    return FRIENDLY_NAMES[key] || String(localName || '').trim();
  }

  async onPairListDevices() {
    const advertisements = await this.homey.ble.discover();

    // Deduplicate repeated advertisements from the same SG node.
    const byName = new Map();

    for (const adv of advertisements) {
      const localName = String(adv.localName || '').trim().toUpperCase();

      if (!/^@ND[0-9A-F]{4,}$/i.test(localName)) continue;
      if (adv.connectable === false) continue;

      const previous = byName.get(localName);
      if (!previous || Number(adv.rssi ?? -999) > Number(previous.rssi ?? -999)) {
        byName.set(localName, adv);
      }
    }

    const candidates = [...byName.entries()]
      .map(([localName, adv]) => ({
        localName,
        adv,
      }))
      .sort((a, b) => Number(b.adv.rssi ?? -999) - Number(a.adv.rssi ?? -999));

    this.log(
      'SG pairing candidates:',
      candidates.map(({ localName, adv }) => ({
        name: this._friendlyName(localName),
        technicalName: localName,
        uuid: adv.uuid,
        address: adv.address,
        rssi: adv.rssi,
      }))
    );

    if (!candidates.length) {
      throw new Error('Fant ingen SG Smart-lys i nærheten. Prøv igjen mens lysene har strøm.');
    }

    // Keep the returned object deliberately simple and compatible with
    // Homey's built-in list_devices template.
    //
    // data.id is the stable SG broadcast identity rather than a transient
    // pairing/session value. Homey uses data to filter already-paired devices.
    return candidates.map(({ localName, adv }) => ({
      name: this._friendlyName(localName),
      data: {
        id: localName,
      },
      store: {
        peripheralUuid: adv.uuid,
        address: adv.address || '',
        localName,
        friendlyName: this._friendlyName(localName),
      },
      settings: {
        pin: '1234',
        passphrase: '1234',
        object_id: 0,
        repeats: 1,
      },
    }));
  }
}

module.exports = SGMeshDriver;
