'use strict';

const Homey = require('homey');
const crypto = require('crypto');

// SG group ("extension model") command, decoded from the SG app + RX log:
//   MCP payload = [dstLo dstHi] [ff 03] [f2 e7 01 <level> <ctr> 00 00]
// dst = group meshId written little-endian (group 1 -> 01 00). level is 0..100.
class SGGroupDevice extends Homey.Device {
  _infoLog(...args) { if (this.homey.settings.get('loggingEnabled') !== false) super.log(...args); }
  async onInit() {
    this._lastDim = this.getCapabilityValue('dim');
    if (typeof this._lastDim !== 'number') this._lastDim = 1;
    this._ctr = 0x10;
    this._target = null;
    this._busy = false;

    await this.setAvailable().catch(() => {});

    this.registerCapabilityListener('onoff', async (value) => {
      const pct = value ? Math.max(1, Math.round(this._lastDim * 100)) : 0;
      this._request(pct);
    });
    this.registerCapabilityListener('dim', async (value) => {
      this._lastDim = value;
      this._request(Math.max(0, Math.min(100, Math.round(value * 100))));
    });

    this._infoLog(`SG group device ready (meshId ${this._groupId()})`);
  }

  _groupId() {
    const s = Number(this.getSettings().group_id);
    if (Number.isInteger(s) && s > 0) return s;
    const st = Number(this.getStoreValue('meshId'));
    return Number.isInteger(st) && st > 0 ? st : 1;
  }

  _resolveKey(settings) {
    const hex = String(settings.netkey_hex || '').replace(/[^0-9a-fA-F]/g, '');
    if (hex.length === 32) return Buffer.from(hex, 'hex');
    const secret = String(settings.passphrase || settings.pin || '1234').trim() || '1234';
    const d = crypto.createHash('sha256').update(Buffer.from(`${secret}\x00MCP`, 'utf8')).digest();
    return Buffer.from(d).reverse().subarray(0, 16);
  }

  _nextCtr() {
    this._ctr = (this._ctr + 1) & 0xff;
    return this._ctr;
  }

  _makePacket(key, seq, data) {
    const seqBuf = Buffer.alloc(3);
    seqBuf.writeUIntLE(seq, 0, 3);
    const source = Buffer.from([0x00, 0x80]);
    const iv = Buffer.alloc(16);
    seqBuf.copy(iv, 0);
    source.copy(iv, 4);
    const cipher = crypto.createCipheriv('aes-128-ofb', key, iv);
    cipher.setAutoPadding(false);
    const payload = Buffer.concat([cipher.update(data), cipher.final()]);
    const preHmac = Buffer.concat([Buffer.alloc(8), seqBuf, source, payload]);
    const mac = crypto.createHmac('sha256', key).update(preHmac).digest();
    const shortMac = Buffer.from(mac).reverse().subarray(0, 8);
    return Buffer.concat([seqBuf, source, payload, shortMac, Buffer.from([0xff])]);
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
        try { await this._sendOnce(pct); } catch (err) { this.error(`group send failed: ${err.message || err}`); }
      }
    } finally { this._busy = false; }
  }

  async _sendOnce(pct) {
    const settings = this.getSettings();
    const key = this._resolveKey(settings);
    const level = Math.max(0, Math.min(100, Math.round(pct)));
    const gid = this._groupId();
    const ctr = this._nextCtr();

    const data = Buffer.from([
      gid & 0xff, (gid >> 8) & 0xff,   // dst = group meshId (LE)
      0xff, 0x03,                      // extension-model opcode
      0xf2, 0xe7, 0x01, level, ctr, 0x00, 0x00,
    ]);

    const seq = this.homey.app.nextSeq();
    const packet = this._makePacket(key, seq, data);
    this._infoLog(`SG GROUP ${gid} level=${level} seq=0x${seq.toString(16)} data=${data.toString('hex')}`);

    await this.homey.app.bridge.send(packet, { key: `group:${gid}`, level });
    await this.setCapabilityValue('onoff', level > 0).catch(() => {});
    await this.setCapabilityValue('dim', level / 100).catch(() => {});
  }
}

module.exports = SGGroupDevice;
