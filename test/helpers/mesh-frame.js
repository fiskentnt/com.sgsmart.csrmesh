'use strict';

const crypto = require('node:crypto');

// A frame as a node sends it, from any sender: seq(3) source(2), the payload
// encrypted with AES-128-OFB, the MAC (8) and the TTL. lib/csrmesh.js
// makePacket builds this app's own, always from 0x8000.
function meshFrame(key, seq, src, plain, ttl = 0x32) {
  const seqBuf = Buffer.alloc(3);
  seqBuf.writeUIntLE(seq, 0, 3);
  const srcBuf = Buffer.from([src & 0xff, src >> 8]);
  const iv = Buffer.alloc(16);
  seqBuf.copy(iv, 0);
  srcBuf.copy(iv, 4);
  const cipher = crypto.createCipheriv('aes-128-ofb', key, iv);
  const payload = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = Buffer.from(crypto.createHmac('sha256', key).update(Buffer.concat([Buffer.alloc(8), seqBuf, srcBuf, payload])).digest())
    .reverse().subarray(0, 8);
  return Buffer.concat([seqBuf, srcBuf, payload, mac, Buffer.from([ttl])]);
}

module.exports = { meshFrame };
