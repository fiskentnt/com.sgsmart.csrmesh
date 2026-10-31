'use strict';

const Homey = require('homey');

const MEMBER_DRIVER = 'sg_mesh';

// A group device does not pair to one @NDxxxx node. It stands for a set of
// dimmers already paired in this app and passes its level on to each of them,
// so pairing is a matter of ticking which dimmers belong. The same view is
// offered under repair, to change the set later.
class SGGroupDriver extends Homey.Driver {
  // First generation dimmers only (they have getMeshId): later generations in
  // the same driver are not group members in 2.5.0.
  _dimmers(selected) {
    const dimmers = this.homey.drivers.getDriver(MEMBER_DRIVER).getDevices()
      .filter((device) => typeof device.getMeshId === 'function');
    return dimmers.map((device) => {
      const { id } = device.getData();
      return {
        id,
        name: device.getName(),
        // A new group starts with every dimmer ticked.
        selected: selected ? selected.includes(id) : true,
      };
    });
  }

  async onPair(session) {
    session.setHandler('list_dimmers', async () => ({ dimmers: this._dimmers(), repair: false }));
  }

  async onRepair(session, device) {
    session.setHandler('list_dimmers', async () => ({
      dimmers: this._dimmers(device.getMemberIds()),
      repair: true,
    }));
    session.setHandler('set_members', async (members) => {
      await device.setMemberIds(members);
      return true;
    });
  }
}

module.exports = SGGroupDriver;
