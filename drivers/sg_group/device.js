'use strict';

const Homey = require('homey');

// A group is a set of dimmers paired in this app, driven from one tile. Which
// dimmers is chosen at pairing and can be changed under repair.
//
// It sends nothing itself. These dimmers do not act on a group-addressed
// message: the SG app sends one too, but always alongside a command to each
// dimmer, and those are what do the work. So the group hands its level to each
// dimmer device, which sends it the usual way. Each dimmer keeps only its
// newest level, so when Homey commands the room and the group tile and the
// dimmer tiles all get the same value at once, still one packet goes out per
// dimmer.

// Homey sets onoff and dim in the same breath when the slider is dragged on a
// dark group. Long enough to catch both, short enough not to feel laggy.
const DIM_DEBOUNCE_MS = 250;
// When Homey commands a whole room, the dimmers' own listeners fire within a
// few milliseconds of the group's. Letting them go first means the group can
// see that a dimmer is already sending this level and leave it alone.
const FAN_OUT_DELAY_MS = 100;
const MEMBER_DRIVER = 'sg_mesh';

class SGGroupDevice extends Homey.Device {
  _infoLog(...args) {
    if (this.homey.settings.get('loggingEnabled') !== false) super.log(...args);
  }

  async onInit() {
    // A group that is off reports dim 0, so the stored value cannot seed the
    // level to restore on the next "on": Math.max(1, 0) would command 1%, well
    // under the dimmers' own 10% floor, and the lights would look dead.
    // So the level to come back to is kept in the store, across app restarts.
    const storedDim = this.getCapabilityValue('dim');
    const keptDim = Number(this.getStoreValue('lastDim'));
    if (typeof storedDim === 'number' && storedDim > 0) this._lastDim = storedDim;
    else this._lastDim = (keptDim > 0 && keptDim <= 1) ? keptDim : 1;

    // Last level each member reported, by mesh id.
    this._levels = new Map();

    await this.setAvailable().catch(() => {});

    // onoff and dim must be coupled and debounced, as the SDK's light guidance
    // requires: dragging the slider on a dark group makes Homey set both at
    // once, and two separate listeners would race to send conflicting levels
    // for the same gesture. One listener turns each gesture into one level.
    this.registerMultipleCapabilityListener(['onoff', 'dim'], async (values) => {
      const pct = this._levelFor(values);
      // The Homey app reads the tile back when this listener answers and then
      // ignores updates for a moment, so both values must be stored by then.
      await this._show(pct, true);
      this._request(pct);
    }, DIM_DEBOUNCE_MS);

    this._infoLog('group ready');
  }

  // Turn one coupled onoff/dim change into a single 0..100 level.
  //   both set   — dragging the slider on a dark group: dim wins, unless the
  //                gesture explicitly asks for off.
  //   dim only   — slider on a lit group; 0 means off.
  //   onoff only — the power button: restore the last level the group was at.
  _levelFor(values) {
    const { onoff, dim } = values;
    let pct;

    if (typeof dim === 'number') {
      pct = Math.round(dim * 100);
      if (onoff === false) pct = 0;
    } else if (typeof onoff === 'boolean') {
      pct = onoff ? Math.max(1, Math.round(this._lastDim * 100)) : 0;
    } else {
      return 0;
    }

    pct = Math.max(0, Math.min(100, pct));
    this._remember(pct);
    return pct;
  }

  // Never remember 0 as the level to come back to.
  _remember(pct) {
    if (pct <= 0 || pct / 100 === this._lastDim) return;
    this._lastDim = pct / 100;
    this.setStoreValue('lastDim', this._lastDim).catch(() => {});
  }

  // Ids of the member dimmers, as chosen at pairing. A group paired before
  // members could be chosen has none stored, and drives every dimmer.
  getMemberIds() {
    const stored = this.getStoreValue('members');
    return Array.isArray(stored) ? stored : null;
  }

  async setMemberIds(members) {
    await this.setStoreValue('members', members);
    // Forget levels of dimmers that may no longer belong.
    this._levels.clear();
    this._infoLog(`group members: ${members.join(', ')}`);
  }

  _members() {
    try {
      const ids = this.getMemberIds();
      const dimmers = this.homey.drivers.getDriver(MEMBER_DRIVER).getDevices();
      return ids ? dimmers.filter((dimmer) => ids.includes(dimmer.getData().id)) : dimmers;
    } catch (err) {
      this.error(`listing dimmers failed: ${err.message || err}`);
      return [];
    }
  }

  _show(pct, force = false) {
    if (pct === this._shown && !force) return undefined;
    this._shown = pct;
    return Promise.all([
      this.setCapabilityValue('onoff', pct > 0).catch(() => {}),
      this.setCapabilityValue('dim', pct / 100).catch(() => {}),
    ]);
  }

  _request(pct) {
    // Only the newest gesture is fanned out.
    this._pending = pct;
    if (this._fanOutTimer) return;
    this._fanOutTimer = this.homey.setTimeout(() => {
      this._fanOutTimer = null;
      this._fanOut(this._pending);
    }, FAN_OUT_DELAY_MS);
  }

  _fanOut(pct) {
    const members = this._members();
    let sent = 0;

    for (const member of members) {
      this._levels.set(member.getMeshId(), pct);
      // Already sending exactly this, from its own tile or the room: a second
      // request would only put the same packet on the air twice.
      if (member._busy && member._target === null && member._lastAppliedLevel === pct) continue;
      // "On" from the dimmer's own tile should come back to this level too.
      if (pct > 0) member._lastDim = pct / 100;
      member._request(pct);
      sent += 1;
    }

    this._infoLog(`group level=${pct}: passed to ${sent} of ${members.length} dimmer(s)`);
  }

  async onDeleted() {
    if (this._fanOutTimer) this.homey.clearTimeout(this._fanOutTimer);
  }

  // Called by the app for every status frame heard on the mesh. The group is
  // on while any member is, and shows the brightest member's level.
  applyMeshStatus(idHex, level) {
    const id = parseInt(idHex, 16);
    if (!this._members().some((member) => member.getMeshId() === id)) return;

    this._levels.set(id, Math.max(0, Math.min(100, Math.round(level))));
    const pct = Math.max(0, ...this._levels.values());
    this._remember(pct);
    this._show(pct);
  }
}

module.exports = SGGroupDevice;
