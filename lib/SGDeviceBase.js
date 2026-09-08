'use strict';

const Homey = require('homey');
const crypto = require('crypto');

// SG LEDDim data-model command (decoded from the SG app's own log):
//   [destLo destHi] [A0] [ctr] [F2 E7] [idHi idLo] [00 00] [01] [level]
// dest = 0x8001 written little-endian (01 80) = the SG data-model channel;
// the actual dimmer is selected by the 2-byte device id inside the payload.
// level is 0..100 decimal (NOT the CSRmesh -128..-1 lightbulb encoding).
const DEST = 0x8001;
const SG_OPCODE = 0xa0;
const SG_VENDOR = [0xf2, 0xe7];

class SGMeshDevice extends Homey.Device {
  _infoLog(...args) {
    if (this.homey.settings.get('loggingEnabled') !== false) super.log(...args);
  }

  async onInit() {
    this._lastDim = this.getCapabilityValue('dim');
    if (typeof this._lastDim !== 'number') this._lastDim = 1;

    this._ctr = this.getStoreValue('sgCtr');
    if (typeof this._ctr !== 'number') this._ctr = 0x10;

    await this.setAvailable().catch(() => {});

    this._target = null;   // latest requested percent (coalesced)
    this._busy = false;

    // Return to Homey immediately (BLE work runs in the background) so the
    // 10s capability timeout can never fire. The mesh burst finishes after.
    this.registerCapabilityListener('onoff', async (value) => {
      const pct = value ? Math.max(1, Math.round(this._lastDim * 100)) : 0;
      this._request(pct);
    });

    this.registerCapabilityListener('dim', async (value) => {
      this._lastDim = value;
      const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
      this._request(pct);
    });

    this._lastAppliedLevel = null;

    this._infoLog(`SG LEDDim device ready (v1.0.0, id 0x${this._deviceId().toString(16)})`);
  }

  async onDeleted() {
    if (this._passiveAdvertTimer) this.homey.clearTimeout(this._passiveAdvertTimer);
  }

  applyMeshStatus(idHex, level) {
    if (parseInt(idHex, 16) !== this._deviceId()) return;
    const pct = Math.max(0, Math.min(100, Math.round(level)));
    if (pct > 0) this._lastDim = pct / 100;
    this.setCapabilityValue('onoff', pct > 0).catch(() => {});
    this.setCapabilityValue('dim', pct / 100).catch(() => {});
    this._infoLog(`STATUS applied to tile: on=${pct > 0} dim=${pct}%`);
  }

  _deviceId() {
    // Prefer the id embedded in the @NDxxxx broadcast name, e.g. @ND32C3 -> 0x32C3.
    const name = String(this.getStoreValue('localName') || '');
    const m = name.match(/@ND([0-9A-Fa-f]{4})/);
    if (m) return parseInt(m[1], 16);
    const override = Number(this.getSettings().object_id || 0);
    return override & 0xffff;
  }

  _nextCtr() {
    this._ctr = (this._ctr + 1) & 0xff;
    this.setStoreValue('sgCtr', this._ctr).catch(() => {});
    return this._ctr;
  }

  _networkKey(pin) {
    const s = String(pin ?? '1234').padStart(4, '0');
    const d = crypto.createHash('sha256').update(Buffer.from(`${s}\x00MCP`, 'utf8')).digest();
    return Buffer.from(d).reverse().subarray(0, 16);
  }

  _resolveKey(settings) {
    const hex = String(settings.netkey_hex || '').replace(/[^0-9a-fA-F]/g, '');
    if (hex.length === 32) return Buffer.from(hex, 'hex');
    const pass = String(settings.passphrase || '').trim();
    if (pass) {
      const d = crypto.createHash('sha256').update(Buffer.from(`${pass}\x00MCP`, 'utf8')).digest();
      return Buffer.from(d).reverse().subarray(0, 16);
    }
    return this._networkKey(settings.pin || '1234');
  }

  _buildSGCommand(pct) {
    const id = this._deviceId();
    const level = Math.max(0, Math.min(100, Math.round(pct)));
    return Buffer.from([
      DEST & 0xff, (DEST >> 8) & 0xff,
      SG_OPCODE, this._nextCtr(),
      SG_VENDOR[0], SG_VENDOR[1],
      (id >> 8) & 0xff, id & 0xff,
      0x00, 0x00, 0x01, level,
    ]);
  }

  _buildGen1Identify(nodeId = this._deviceId()) {
    // Real SG log ties CC40... to the BLE bridge node:
    // Bridge mesh connected: @ND32C3
    // sendDataModelMessage ... cc404e4432c300000000
    const id = Number(nodeId) & 0xffff;
    return Buffer.from([
      DEST & 0xff, (DEST >> 8) & 0xff,
      0xcc, 0x40, 0x4e, 0x44,
      (id >> 8) & 0xff, id & 0xff,
      0x00, 0x00, 0x00, 0x00,
    ]);
  }

  _buildExtensionFF26() {
    // SG Smart 2026 log:
    // sendExtensionModelMessage meshId:0x0000 opcode:0xff26 data:0xf2e77b
    //
    // Diagnostic raw extension-model hypothesis:
    // [meshId raw 00 00] [opcode ff 26] [data f2 e7 7b]
    //
    // Unlike the Data Model framing, this raw wrapper has not yet been
    // confirmed by an HCI capture, so it is logged explicitly as a test.
    return Buffer.from([
      0x00, 0x00,
      0xff, 0x26,
      0xf2, 0xe7, 0x7b,
    ]);
  }


  _osloDateParts() {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Oslo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    }).formatToParts(new Date());

    const value = (type) => parts.find((p) => p.type === type)?.value;
    const weekdayMap = {
      Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
    };

    return {
      year: Number(value('year')) % 100,
      month: Number(value('month')),
      day: Number(value('day')),
      hour: Number(value('hour')),
      minute: Number(value('minute')),
      second: Number(value('second')),
      weekday: weekdayMap[value('weekday')] || 0,
    };
  }

  _buildGen1TimeSync() {
    // Exact format inferred from SG log, e.g.
    // Real SG log at 2024-04-18 20:39:55:
    // f0 01 18 04 04 12 14 27 37 00
    // F0, gen1Seq, YY, MM, weekday, DD, HH, MM, SS, 00
    // (0x04=Thursday, 0x12=18th, 0x14=20h, 0x27=39m, 0x37=55s)
    const d = this._osloDateParts();
    return Buffer.from([
      DEST & 0xff, (DEST >> 8) & 0xff,
      0xf0, this._nextCtr(),
      d.year, d.month, d.weekday, d.day,
      d.hour, d.minute, d.second, 0x00,
    ]);
  }

  async _sleep(ms) {
    return new Promise((resolve) => this.homey.setTimeout(resolve, ms));
  }

  _makePacket(key, seq, data) {
    const seqBuf = Buffer.alloc(3);
    seqBuf.writeUIntLE(seq, 0, 3);
    const source = Buffer.from([0x00, 0x80]); // CSRmesh authenticated-bearer constant 0x0080
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
    // Coalesce: keep only the newest target. While a send is running, slider
    // moves just update the target; the drain loop sends the latest and skips
    // the intermediates.
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




  _serviceDataHex(advertisement) {
    if (!advertisement || !Array.isArray(advertisement.serviceData)) return [];
    return advertisement.serviceData.map((entry) => ({
      uuid: String(entry.uuid || ''),
      hex: Buffer.isBuffer(entry.data)
        ? entry.data.toString('hex')
        : (entry.data instanceof Uint8Array ? Buffer.from(entry.data).toString('hex') : ''),
    }));
  }

  _startPassiveAdvertMonitor() {
    const targetName = String(this.getStoreValue('localName') || '').trim().toUpperCase();
    if (!targetName) return;

    let lastSignature = null;

    const scan = async () => {
      try {
        // Never scan while the bridge holds the radio for a command; a
        // concurrent discover() destabilises the single BLE radio.
        if (!this.homey.app.bridge || !this.homey.app.bridge.isActive()) {
          const advs = await this.homey.ble.discover();
          const adv = advs.find(
            (a) => String(a.localName || '').trim().toUpperCase() === targetName
          );

          if (adv) {
            const status = this._parseGen1Status(adv);
            if (status) this._applyLevel(status.level);

            const allHex = this._collectAdvertHex(adv);
            const signature = JSON.stringify(allHex);
            if (signature !== lastSignature) {
              lastSignature = signature;
              this._infoLog(
                `ADVERT ${targetName} rssi=${adv.rssi} ` +
                `parsed=${status ? status.level + '%' : 'none'} ` +
                `hex=[${allHex.join(', ')}]`
              );
            }
          }
        }
      } catch (err) {
        this.error(`passive advert monitor failed: ${err.message || err}`);
      } finally {
        this._passiveAdvertTimer = this.homey.setTimeout(scan, 3000);
      }
    };

    this._passiveAdvertTimer = this.homey.setTimeout(scan, 2500);
  }

  _bufferHex(value) {
    if (Buffer.isBuffer(value)) return value.toString('hex');
    if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
    return null;
  }

  _collectAdvertHex(value, out = [], seen = new Set()) {
    if (value === null || value === undefined) return out;
    const direct = this._bufferHex(value);
    if (direct) {
      if (direct) out.push(direct.toLowerCase());
      return out;
    }
    if (typeof value !== 'object' || seen.has(value)) return out;
    seen.add(value);

    for (const v of Object.values(value)) {
      this._collectAdvertHex(v, out, seen);
    }
    return out;
  }

  _parseGen1Status(advertisement) {
    const id = this._deviceId();
    const idHex = id.toString(16).padStart(4, '0').toLowerCase();
    const marker = `f2e7${idHex}`;

    const chunks = this._collectAdvertHex(advertisement);
    for (const hex of chunks) {
      const idx = hex.indexOf(marker);
      if (idx < 0) continue;
      // Level is the final byte of the SG status frame (…000001LL or …0003LL).
      const levelHex = hex.slice(-2);
      const level = parseInt(levelHex, 16);
      if (Number.isInteger(level) && level >= 0 && level <= 100) {
        return { level, frame: hex.slice(idx) };
      }
    }
    return null;
  }

  async _verifyAdvert(expectedPct) {
    // Advertisements exposed by Homey contain only SG serviceData here,
    // not the full Gen1 frame seen in the SG iOS log. Do one compact scan
    // after TX for diagnostics, but do not block commands for many seconds.
    await new Promise((resolve) => this.homey.setTimeout(resolve, 400));
    const targetName = String(this.getStoreValue('localName') || '').trim().toUpperCase();

    try {
      const advs = await this.homey.ble.discover();
      const adv = advs.find(
        (a) => String(a.localName || '').trim().toUpperCase() === targetName
      );
      if (adv) {
        const data = this._serviceDataHex(adv);
        this._infoLog(
          `POST-TX ADVERT ${targetName} expected=${expectedPct} ` +
          `${data.map((x) => `${x.uuid}=${x.hex}`).join(' | ')}`
        );
      }
    } catch (err) {
      this.error(`post-TX advert scan failed: ${err.message || err}`);
    }
  }

  async _sendOnce(pct) {
    const settings = this.getSettings();
    const key = this._resolveKey(settings);
    const id = this._deviceId();
    const level = Math.max(0, Math.min(100, Math.round(pct)));

    // v0.8.21 produced real physical blinking while two duplicate Homey
    // device instances were simultaneously sweeping OFF and ON. That is
    // strong evidence that MCP model opcode 0x73 and this framing are valid.
    //
    // Stop brute force: send exactly ONE command per capability change.
    // Maintain a local rolling Gen1 byte. We seed it from the outer sequence
    // low byte on first use, then increment for subsequent commands.
    if (!Number.isInteger(this._gen1Seq)) {
      this._gen1Seq = this.homey.app.nextSeq() & 0xff;
    } else {
      this._gen1Seq = (this._gen1Seq + 1) & 0xff;
    }

    const ctr = this._gen1Seq;
    const data = Buffer.from([
      0x01, 0x80,
      0x73,
      0xa0, ctr,
      0xf2, 0xe7,
      (id >> 8) & 0xff, id & 0xff,
      0x00, 0x00, 0x01, level,
    ]);

    const seq = this.homey.app.nextSeq();
    const packet = this._makePacket(key, seq, data);

    this._infoLog(
      `SG MCP73 SINGLE gen1=0x${ctr.toString(16).padStart(2, '0')} ` +
      `seq=0x${seq.toString(16).padStart(6, '0')} level=${level} ` +
      `data=${data.toString('hex')}`
    );

    await this.homey.app.bridge.send(packet, { key: `device:${id.toString(16)}`, level });

    // Optimistic state so the tile matches what we just commanded. Real state
    // (below) corrects it if the dimmer's own advertisement is readable.
    await this.setCapabilityValue('onoff', level > 0).catch(() => {});
    await this.setCapabilityValue('dim', level / 100).catch(() => {});
    this._lastAppliedLevel = level;
  }

  _applyLevel(level) {
    const pct = Math.max(0, Math.min(100, Math.round(level)));
    if (pct === this._lastAppliedLevel) return;
    this._lastAppliedLevel = pct;
    if (pct > 0) this._lastDim = pct / 100;
    this.setCapabilityValue('onoff', pct > 0).catch(() => {});
    this.setCapabilityValue('dim', pct / 100).catch(() => {});
    this._infoLog(`STATUS applied level=${pct}`);
  }
}

module.exports = SGMeshDevice;
