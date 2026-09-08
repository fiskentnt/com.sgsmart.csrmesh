'use strict';

const Homey = require('homey');
const { makePacket, resolveKey } = require('../../lib/csrmesh');

// SG group ("extension model") command, decoded from the SG app + RX log:
//   MCP payload = [dstLo dstHi] [FF 03] [F2 E7 01 <level> <ctr> 00 00]
// dst = the group's mesh id written little-endian. level is 0..100.
const EXT_OPCODE = [0xff, 0x03];
const SG_VENDOR = [0xf2, 0xe7];
// Homey sets onoff and dim in the same breath when the slider is dragged on a
// dark group. Long enough to catch both, short enough not to feel laggy.
const DIM_DEBOUNCE_MS = 250;

class SGGroupDevice extends Homey.Device {
  _infoLog(...args) {
    if (this.homey.settings.get('loggingEnabled') !== false) super.log(...args);
  }

  async onInit() {
    // A group that is off reports dim 0, so the stored value cannot seed the
    // level to restore on the next "on": Math.max(1, 0) would command 1%, well
    // under the dimmers' own 10% floor, and the lights would look dead.
    const storedDim = this.getCapabilityValue('dim');
    this._lastDim = (typeof storedDim === 'number' && storedDim > 0) ? storedDim : 1;

    this._ctr = 0x10;
    this._target = null;
    this._busy = false;

    await this.setAvailable().catch(() => {});

    // onoff and dim must be coupled and debounced, as the SDK's light guidance
    // requires: dragging the slider on a dark group makes Homey set both at
    // once, and two separate listeners would race to send conflicting levels
    // for the same gesture. One listener turns each gesture into one level.
    this.registerMultipleCapabilityListener(['onoff', 'dim'], async (values) => {
      this._request(this._levelFor(values));
    }, DIM_DEBOUNCE_MS);

    this._infoLog(`group ready (mesh id ${this.getGroupId()})`);
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
    // Never remember 0 as the level to come back to.
    if (pct > 0) this._lastDim = pct / 100;
    return pct;
  }

  getGroupId() {
    const fromSettings = Number(this.getSettings().group_id);
    if (Number.isInteger(fromSettings) && fromSettings > 0) return fromSettings;
    const fromStore = Number(this.getStoreValue('meshId'));
    return Number.isInteger(fromStore) && fromStore > 0 ? fromStore : 1;
  }

  getNetworkKey() {
    return resolveKey(this.getSettings());
  }

  _nextCtr() {
    this._ctr = (this._ctr + 1) & 0xff;
    return this._ctr;
  }

  _request(pct) {
    this._target = pct;
    if (!this._busy) this._drain();
  }

  async _drain() {
    this._busy = true;
    try {
      while (this._target !== null) {
        const pct = this._target;
        this._target = null;
        try {
          await this._sendOnce(pct);
        } catch (err) {
          this.error(`group send failed: ${err.message || err}`);
        }
      }
    } finally {
      this._busy = false;
    }
  }

  async _sendOnce(pct) {
    const key = this.getNetworkKey();
    const level = Math.max(0, Math.min(100, Math.round(pct)));
    const gid = this.getGroupId();

    const data = Buffer.from([
      gid & 0xff, (gid >> 8) & 0xff,
      EXT_OPCODE[0], EXT_OPCODE[1],
      SG_VENDOR[0], SG_VENDOR[1], 0x01, level, this._nextCtr(), 0x00, 0x00,
    ]);

    const seq = this.homey.app.nextSeq();
    const packet = makePacket(key, seq, data);

    this._infoLog(`group ${gid} level=${level} seq=0x${seq.toString(16).padStart(6, '0')}`);

    // Show the commanded state before waiting for the mesh, not after: send()
    // only settles once the packet is actually on the wire, which a BLE
    // recovery round can delay by minutes.
    await this.setCapabilityValue('onoff', level > 0).catch(() => {});
    await this.setCapabilityValue('dim', level / 100).catch(() => {});

    await this.homey.app.bridge.send(packet, { key: `group:${gid}`, level });
  }
}

module.exports = SGGroupDevice;
