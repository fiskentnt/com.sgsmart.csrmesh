'use strict';

const fs = require('fs');

// A copy of everything the app writes to stdout and stderr, kept in a file in
// /userdata, so the settings page can show the latest lines ("Show log") for a
// tester to send privately to the developer, not to paste in the forum. A line
// without the SDK's own timestamp gets one. The file is kept under MAX_BYTES by
// dropping its oldest lines. The raw 8003/8004 notification lines of detailed
// logging are left out: they are most of the volume. Started from the file log
// of the test builds (2.2.0 to 2.4.0).
const FILE = '/userdata/app.log';
const SKIP = /\[MeshBridge\] RX 800[34]/;
const STAMPED = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /;
const MAX_BYTES = 2 * 1024 * 1024;
const KEEP_BYTES = 1.5 * 1024 * 1024;
const FLUSH_MS = 5000;
// The latest lines are read from at most this much of the end of the file.
const TAIL_BYTES = 256 * 1024;

class FileLog {
  constructor(homey, file = FILE) {
    this.homey = homey;
    this.file = file;
    this.lines = [];
    this.partial = { out: '', err: '' };
    this.timer = null;
    this.writing = null;
  }

  // Tap stdout and stderr; everything still goes where it went before.
  install() {
    for (const [stream, level] of [[process.stdout, 'out'], [process.stderr, 'err']]) {
      const write = stream.write.bind(stream);
      stream.write = (chunk, ...rest) => {
        try {
          this._take(level, chunk);
        } catch (err) { /* logging must never break the app */ }
        return write(chunk, ...rest);
      };
    }
  }

  _take(level, chunk) {
    const text = this.partial[level] + (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    const parts = text.split('\n');
    this.partial[level] = parts.pop();
    const at = new Date().toISOString();
    for (const line of parts) {
      if (!line || SKIP.test(line)) continue;
      this.lines.push(STAMPED.test(line) ? `${line}\n` : `${at} [${level}] ${line}\n`);
    }
    if (this.lines.length && !this.timer) {
      this.timer = this.homey.setTimeout(() => {
        this.timer = null;
        this.flush().catch(() => {});
      }, FLUSH_MS);
    }
  }

  async flush() {
    if (this.writing) await this.writing;
    if (!this.lines.length) return;
    const chunk = this.lines.join('');
    this.lines = [];
    this.writing = (async () => {
      try {
        await fs.promises.appendFile(this.file, chunk);
        const { size } = await fs.promises.stat(this.file);
        if (size > MAX_BYTES) await this._trim();
      } catch (err) { /* logging must never break the app */ }
    })();
    try {
      await this.writing;
    } finally {
      this.writing = null;
    }
  }

  // Keep the newest KEEP_BYTES, starting at a whole line.
  async _trim() {
    const data = await fs.promises.readFile(this.file);
    const from = data.indexOf(10, data.length - KEEP_BYTES);
    await fs.promises.writeFile(this.file, from < 0 ? Buffer.alloc(0) : data.subarray(from + 1));
  }

  // The last `count` lines, read from the end of the file only. No file yet
  // gives no lines.
  async tail(count) {
    await this.flush();
    let handle;
    try {
      handle = await fs.promises.open(this.file, 'r');
    } catch (err) {
      return [];
    }
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const lines = buffer.toString('utf8').split('\n');
      if (length < size) lines.shift(); // started inside a line
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      return lines.slice(-count);
    } finally {
      await handle.close();
    }
  }
}

// Before the log leaves the app: Bluetooth addresses, UUIDs (Homey's device
// ids among them), 32-digit hex (keys, as a safeguard) and the names of the
// paired devices are replaced. Within one text the same value gets the same
// replacement, so a reader can still follow one node or device. Mesh ids,
// @ND names and location ids stay: they are what the log is for. So does the
// data of an FF05, FF50 or FF11 line from CsrNetwork, whatever its length: it
// is a decrypted mesh message, not an address or a key. The rest of that line
// is masked as any other.
const KEPT_DATA = /^(.*\[CSR\] EXT .* op=(?:FF05|FF50|FF11) len=\d+ data=)([0-9a-f]+)(.*)$/;

function maskLog(text, names = []) {
  const seen = new Map();
  const label = (kind, value) => {
    const key = `${kind} ${value}`;
    if (!seen.has(key)) {
      const count = [...seen.keys()].filter((k) => k.startsWith(`${kind} `)).length;
      seen.set(key, `${kind}-${count + 1}`);
    }
    return seen.get(key);
  };
  // Longest first, so a name inside another name does not split it.
  const unique = [...new Set(names.map((n) => String(n || '').trim()).filter((n) => n.length >= 3))]
    .sort((a, b) => b.length - a.length);
  const mask = (part) => {
    let out = part
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (m) => label('dev', m.toLowerCase()))
      .replace(/\b[0-9a-f]{32}\b/gi, '[hidden]')
      .replace(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi, (m) => label('ble', m.replace(/:/g, '').toLowerCase()))
      .replace(/\b[0-9a-f]{12}\b/gi, (m) => label('ble', m.toLowerCase()));
    for (const name of unique) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu'), () => label('device', name));
    }
    return out;
  };
  return String(text).split('\n').map((line) => {
    const kept = KEPT_DATA.exec(line);
    return kept ? `${mask(kept[1])}${kept[2]}${mask(kept[3])}` : mask(line);
  }).join('\n');
}

module.exports = { FileLog, maskLog };
