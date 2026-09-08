'use strict';

const Homey = require('homey');

// Virtual group device. It does not pair to one @ND node; it controls the whole
// "Stue" group (meshId 1) in a single command, which reaches both dimmers over
// one bridge connection (more reliable than driving each lamp separately).
module.exports = class SGGroupDriver extends Homey.Driver {
  async onPairListDevices() {
    return [{
      name: 'Stue (gruppe)',
      data: { id: 'sg-group-1' },
      store: { meshId: 1, friendlyName: 'Stue (gruppe)' },
      settings: { pin: '1234', passphrase: '1234', netkey_hex: '', group_id: 1 },
    }];
  }
};
