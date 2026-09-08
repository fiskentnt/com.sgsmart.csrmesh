'use strict';

const Homey = require('homey');

const TARGET_NAME = '@ND32C3';
const FRIENDLY_NAME = 'Stue sofa';

module.exports = class SGFixedDriver extends Homey.Driver {
  async onPairListDevices() {
    const advertisements = await this.homey.ble.discover();

    const matches = advertisements
      .filter((adv) =>
        String(adv.localName || '').trim().toUpperCase() === TARGET_NAME
        && adv.connectable !== false
      )
      .sort((a, b) => Number(b.rssi ?? -999) - Number(a.rssi ?? -999));

    if (!matches.length) {
      throw new Error(`${FRIENDLY_NAME} (${TARGET_NAME}) ble ikke funnet. Prøv igjen.`);
    }

    const adv = matches[0];
    this.log(`Pair ${FRIENDLY_NAME}: ${TARGET_NAME} ${adv.uuid} rssi ${adv.rssi}`);

    return [{
      name: FRIENDLY_NAME,
      data: { id: TARGET_NAME },
      store: {
        peripheralUuid: adv.uuid,
        address: adv.address || '',
        localName: TARGET_NAME,
        friendlyName: FRIENDLY_NAME,
      },
      settings: {
        pin: '1234',
        passphrase: '1234',
        object_id: 0,
        repeats: 1,
      },
    }];
  }
};
