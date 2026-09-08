'use strict';

const Homey = require('homey');

// How many CSRmesh groups to offer at pairing. Groups are configured in the SG
// app; there is no way to enumerate them over the air, so the user picks the
// number and can correct it later in device settings.
const MAX_GROUPS = 8;

// A group device does not pair to one @NDxxxx node. It addresses a whole
// CSRmesh group in a single command, which reaches every dimmer in that group
// over one bridge connection - more reliable than driving each lamp separately.
class SGGroupDriver extends Homey.Driver {
  async onPairListDevices() {
    return Array.from({ length: MAX_GROUPS }, (_, index) => {
      const groupId = index + 1;
      return {
        name: `${this.homey.__('pair.group')} ${groupId}`,
        data: { id: `sg-group-${groupId}` },
        store: { meshId: groupId },
        settings: { group_id: groupId },
      };
    });
  }
}

module.exports = SGGroupDriver;
