'use strict';

// One A0 to every first generation dimmer of the home at once, for the flow
// card that sets them all to a level, 0 % off (app.js). The device id in it is 0,
// which the dimmers take as all of them with this location id (tried with
// two dimmers); it goes to 0x8001 as every A0. It reaches dimmers that are
// not added in Homey too. The location id and the key come from the Gen1
// dimmers added in Homey, which must all agree.
//
// Its counter byte goes on from the one it had last (the app setting
// TID_SETTING, stored before the A0 goes out, so a restart cannot give the
// same again). A dimmer is assumed to drop an A0 that repeats one it took
// lately, and not to forget them by itself (not tried; lib/SGDeviceBase.js,
// GEN1_TID_STORE_EVERY), so the counter keeps clear of every dimmer's own:
// of those it sent lately and of those it will send next, by more than
// TID_GAP (assumed far enough, not tried). With no such counter free, the
// one near the fewest dimmers is taken, and the log says so.

const { makePacket } = require('./csrmesh');
const { gen1LevelData } = require('./sgProtocol');

const TID_SETTING = 'gen1AllTid';
const TID_GAP = 20;
const TID_START_ABOVE = 128;
// After a restart a dimmer with a stored counter goes on this far above it
// (lib/SGDeviceBase.js: GEN1_TID_STORE_EVERY + 1).
const AFTER_RESTART = 17;
const ALL_ID = 0x0000;

const hex4 = (value) => `0x${value.toString(16).padStart(4, '0')}`;

// The first generation dimmers added in Homey: those with getMeshId, as the
// group's members (drivers/sg_group); later generations and groups have none.
function gen1Dimmers(devices) {
  return devices.filter((device) => typeof device.getMeshId === 'function');
}

// The counters a dimmer is near, as a stretch of the ring of 256: from, and
// span more after it; at is the one it uses next or last. With its counter in
// use (c): c - TID_GAP to c + TID_GAP. With only a stored one (s), it may have
// sent up to s + 15 since, and goes on at s + 17: s - TID_GAP to
// s + 17 + TID_GAP. Neither: null (it starts somewhere unknown).
function nearOf(device) {
  if (Number.isInteger(device._gen1Seq)) {
    return { at: device._gen1Seq, from: (device._gen1Seq - TID_GAP) & 0xff, span: 2 * TID_GAP };
  }
  const stored = typeof device.getStoreValue === 'function' ? device.getStoreValue('gen1Tid') : null;
  if (!Number.isInteger(stored) || stored < 0 || stored > 0xff) return null;
  return { at: (stored + AFTER_RESTART) & 0xff, from: (stored - TID_GAP) & 0xff, span: AFTER_RESTART + 2 * TID_GAP };
}

const nearCount = (tid, nears) => nears.filter(({ from, span }) => ((tid - from) & 0xff) <= span).length;

// The next counter, and how many dimmers it is near (0 but when none is
// free): one up from the last one (or TID_START_ABOVE over the dimmers' when
// there is none), then on to the first that is near none.
function nextTid(last, nears) {
  let start;
  if (Number.isInteger(last) && last >= 0 && last <= 0xff) start = (last + 1) & 0xff;
  else start = nears.length ? (Math.max(...nears.map(({ at }) => at)) + TID_START_ABOVE) & 0xff : 1;
  let best = { tid: start, near: nearCount(start, nears) };
  for (let i = 1; i < 256 && best.near > 0; i += 1) {
    const tid = (start + i) & 0xff;
    const near = nearCount(tid, nears);
    if (near < best.near) best = { tid, near };
  }
  return best;
}

// Sends the one A0 with this level (0 is off, 1 to 100). Throws, with the
// text for the flow card, when it cannot be sent: no first generation dimmer
// in Homey, not one home, not one key. Otherwise the card is answered at
// once and the A0 goes out after it, as every other command in the app (a
// link that is down can take a minute or more to give one up); one that is
// not written is logged.
async function sendToAll(app, level) {
  const t = (key) => app.homey.__(`flow.gen1All.${key}`);
  const dimmers = gen1Dimmers(app._devices());
  if (!dimmers.length) throw new Error(t('none'));
  const locations = [...new Set(dimmers.map((device) => device.getLocationId()))];
  if (locations.length !== 1 || !Number.isInteger(locations[0])) throw new Error(t('homes'));
  const keys = [...new Set(dimmers.map((device) => device.getNetworkKey().toString('hex')))];
  if (keys.length !== 1) throw new Error(t('keys'));
  const { tid, near } = nextTid(app.homey.settings.get(TID_SETTING), dimmers.map(nearOf).filter(Boolean));
  app.homey.settings.set(TID_SETTING, tid);
  const pct = Math.max(0, Math.min(100, Math.round(Number(level) || 0)));
  const data = gen1LevelData({
    location: locations[0], id: ALL_ID, level: pct, tid,
  });
  const packet = makePacket(dimmers[0].getNetworkKey(), app.nextSeq(), data);
  app.log(`[SG] all Gen1 dimmers in the home: level ${pct}, id 0 to 0x8001, tid ${tid}`
    + `${near ? ` (near the counter of ${near} dimmer(s): none was free)` : ''}, `
    + `${dimmers.length} dimmer(s) in Homey: ${dimmers.map((device) => hex4(device.getMeshId())).join(', ')}`);
  Promise.resolve(app.bridge.send(packet, { key: 'gen1:all', level: pct })).then((result) => {
    // A newer one from these cards replaced it before it was written: that
    // one goes out instead.
    if (result && result.superseded) {
      app.log(`[SG] all Gen1 dimmers in the home: level ${pct} replaced by a newer one before it was written`);
      return;
    }
    if (!result || !result.ok) {
      app.log(`[SG] all Gen1 dimmers in the home: level ${pct} not sent`);
      return;
    }
    // Their statuses tell each dimmer's tile; on a link that is not held,
    // they are asked for once (the first generation's status poll).
    if (typeof app.requestStatus === 'function') app.requestStatus();
  }).catch((err) => app.error(`[SG] all Gen1 dimmers in the home: level ${pct} sending failed: ${err.message || err}`));
  return true;
}

module.exports = {
  ALL_ID, TID_SETTING, nearOf, nextTid, sendToAll,
};
