'use strict';

const Homey = require('homey');
const { makePacket, meshIdFromName, resolveKey } = require('./csrmesh');

// SG LEDDim data-model command, decoded from the SG app's own log:
//   [dstLo dstHi] [73] [A0 ctr] [F2 E7] [idHi idLo] [00 00] [01] [level]
// dst = 0x8001 written little-endian (01 80) = the SG data-model channel; the
// dimmer itself is selected by the 2-byte device id inside the payload.
// level is 0..100 decimal, not the CSRmesh -128..-1 lightbulb encoding.
const DEST = 0x8001;
// Homey sets onoff and dim in the same breath when the slider is dragged on a
// dark lamp. Long enough to catch both, short enough not to feel laggy.
const DIM_DEBOUNCE_MS = 250;
const MCP_OPCODE = 0x73;
const SG_SUBCODE = 0xa0;
const SG_VENDOR = [0xf2, 0xe7];

class SGMeshDevice extends Homey.Device {
  _infoLog(...args) {
    if (this.homey.settings.get('loggingEnabled') !== false) super.log(...args);
  }

  async onInit() {
    // A dimmer that is off reports dim 0, so the stored value cannot seed the
    // level to restore on the next "on": Math.max(1, 0) would command 1%, well
    // under the dimmer's own 10% floor, and the light would look dead.
    const storedDim = this.getCapabilityValue('dim');
    this._lastDim = (typeof storedDim === 'number' && storedDim > 0) ? storedDim : 1;

    this._target = null;        // latest requested percent (coalesced)
    this._busy = false;
    this._lastAppliedLevel = null;

    await this.setAvailable().catch(() => {});

    // onoff and dim must be coupled and debounced, as the SDK's light guidance
    // requires: dragging the slider on a dark lamp makes Homey set both at once,
    // and two separate listeners would race to send conflicting levels for the
    // same gesture. One listener turns each gesture into exactly one level.
    // Returns to Homey immediately; the BLE burst runs in the background so the
    // 10 s capability timeout can never fire on a slow mesh.
    this.registerMultipleCapabilityListener(['onoff', 'dim'], async (values) => {
      this._request(this._levelFor(values));
    }, DIM_DEBOUNCE_MS);

    this._infoLog(`dimmer ready (mesh id 0x${this.getMeshId().toString(16).padStart(4, '0')})`);
  }

  // The mesh id is normally carried in the @NDxxxx advertisement name captured
  // during pairing; the setting is a manual fallback.
  getMeshId() {
    const fromName = meshIdFromName(this.getStoreValue('localName'));
    if (fromName !== null) return fromName;
    return Number(this.getSettings().object_id || 0) & 0xffff;
  }

  getNetworkKey() {
    return resolveKey(this.getSettings());
  }

  applyMeshStatus(idHex, level) {
    if (parseInt(idHex, 16) !== this.getMeshId()) return;
    this._applyLevel(level);
  }

  _applyLevel(level) {
    const pct = Math.max(0, Math.min(100, Math.round(level)));
    if (pct === this._lastAppliedLevel) return;
    this._lastAppliedLevel = pct;
    if (pct > 0) this._lastDim = pct / 100;
    this.setCapabilityValue('onoff', pct > 0).catch(() => {});
    this.setCapabilityValue('dim', pct / 100).catch(() => {});
    this._infoLog(`status applied: on=${pct > 0} dim=${pct}%`);
  }

  // Turn one coupled onoff/dim change into a single 0..100 level.
  //   both set   — dragging the slider on a dark lamp: dim wins, unless the
  //                gesture explicitly asks for off.
  //   dim only   — slider on a lit lamp; 0 means off.
  //   onoff only — the power button: restore the last level the lamp was at.
  _levelFor(values) {
    const { onoff, dim } = values;
    let pct;

    if (typeof dim === 'number') {
      pct = Math.round(dim * 100);
      if (onoff === false) pct = 0;
    } else if (typeof onoff === 'boolean') {
      pct = onoff ? Math.max(1, Math.round(this._lastDim * 100)) : 0;
    } else {
      return this._lastAppliedLevel ?? 0;
    }

    pct = Math.max(0, Math.min(100, pct));
    // Never remember 0 as the level to come back to; "on" would command 1%,
    // far under the dimmer's own 10% floor, and the lamp would look dead.
    if (pct > 0) this._lastDim = pct / 100;
    return pct;
  }

  // Coalesce: keep only the newest target. While a send is running, slider
  // moves just update the target; the drain loop sends the latest and skips
  // the intermediates.
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
          this.error(`send failed: ${err.message || err}`);
        }
      }
    } finally {
      this._busy = false;
    }
  }

  async _sendOnce(pct) {
    const key = this.getNetworkKey();
    const id = this.getMeshId();
    const level = Math.max(0, Math.min(100, Math.round(pct)));

    // Exactly one command per capability change. The Gen1 counter byte is a
    // local rolling value, seeded from the app-wide sequence on first use.
    if (!Number.isInteger(this._gen1Seq)) {
      this._gen1Seq = this.homey.app.nextSeq() & 0xff;
    } else {
      this._gen1Seq = (this._gen1Seq + 1) & 0xff;
    }
    const ctr = this._gen1Seq;

    const data = Buffer.from([
      DEST & 0xff, (DEST >> 8) & 0xff,
      MCP_OPCODE,
      SG_SUBCODE, ctr,
      SG_VENDOR[0], SG_VENDOR[1],
      (id >> 8) & 0xff, id & 0xff,
      0x00, 0x00, 0x01, level,
    ]);

    const seq = this.homey.app.nextSeq();
    const packet = makePacket(key, seq, data);

    this._infoLog(
      `command id=0x${id.toString(16).padStart(4, '0')} level=${level} ` +
      `seq=0x${seq.toString(16).padStart(6, '0')}`
    );

    // Show the commanded state before waiting for the mesh, not after: send()
    // only settles once the packet is actually on the wire, which a BLE
    // recovery round can delay by minutes. Dragging the slider on a dark lamp
    // would otherwise leave Homey showing the new level next to "off" for that
    // whole time. A status poll corrects it if the dimmer reports something else.
    this._lastAppliedLevel = level;
    await this.setCapabilityValue('onoff', level > 0).catch(() => {});
    await this.setCapabilityValue('dim', level / 100).catch(() => {});

    await this.homey.app.bridge.send(packet, { key: `device:${id.toString(16)}`, level });
  }
}

module.exports = SGMeshDevice;
