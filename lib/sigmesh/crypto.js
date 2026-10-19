'use strict';

// Bluetooth Mesh security toolbox (Mesh Profile 1.0.1 §3.8.2): AES-CMAC, the
// key derivations built on it, and AES-CCM. Node's crypto has AES-ECB and
// AES-CCM but no CMAC, so CMAC is written out here after RFC 4493.
//
// Translated from shejnowicz/homey-ble-mesh, commit 2aff983,
// lib/mesh/crypto/{cmac,ccm,derive}.ts (MIT, see LICENSE-MIT).

const crypto = require('crypto');

const BLOCK = 16;
// RFC 4493: folded into a subkey when its left shift overflows.
const RB = 0x87;
// The only MIC lengths mesh produces: 4 bytes, or 8 for control messages.
const MIC_LENGTHS = new Set([4, 8]);

// The spec's e(key, plaintext): AES-128 on a single 16-byte block.
function e(key, block) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
}

function shiftLeft(input) {
  const out = Buffer.alloc(input.length);
  let carry = 0;
  for (let i = input.length - 1; i >= 0; i -= 1) {
    out[i] = ((input[i] << 1) & 0xff) | carry;
    carry = (input[i] & 0x80) ? 1 : 0;
  }
  return out;
}

function xor(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i] ^ b[i];
  return out;
}

// RFC 4493 §2.3. Named subkey1/subkey2 so they are not mistaken for k1/k2.
function subkeys(key) {
  const l = e(key, Buffer.alloc(BLOCK));
  const subkey1 = shiftLeft(l);
  if (l[0] & 0x80) subkey1[BLOCK - 1] ^= RB;
  const subkey2 = shiftLeft(subkey1);
  if (subkey1[0] & 0x80) subkey2[BLOCK - 1] ^= RB;
  return { subkey1, subkey2 };
}

// AES-CMAC with a 128-bit key (RFC 4493). Returns 16 bytes.
function aesCmac(key, message) {
  const { subkey1, subkey2 } = subkeys(key);
  const complete = message.length > 0 && message.length % BLOCK === 0;
  const blockCount = complete ? message.length / BLOCK : Math.floor(message.length / BLOCK) + 1;

  let last;
  if (complete) {
    last = xor(message.subarray((blockCount - 1) * BLOCK), subkey1);
  } else {
    const tail = message.subarray((blockCount - 1) * BLOCK);
    const padded = Buffer.alloc(BLOCK);
    tail.copy(padded);
    padded[tail.length] = 0x80;
    last = xor(padded, subkey2);
  }

  let x = Buffer.alloc(BLOCK);
  for (let i = 0; i < blockCount - 1; i += 1) {
    x = e(key, xor(x, message.subarray(i * BLOCK, (i + 1) * BLOCK)));
  }
  return e(key, xor(x, last));
}

function assertKey(name, key) {
  if (!Buffer.isBuffer(key) || key.length !== 16) {
    throw new Error(`${name}: key must be 16 bytes, got ${key && key.length}`);
  }
}

// s1(M): CMAC with an all-zero key, the salt function (§3.8.2.4).
function s1(message) {
  return aesCmac(Buffer.alloc(BLOCK), message);
}

// k1(N, SALT, P) = CMAC(CMAC(SALT, N), P) (§3.8.2.5).
function k1(n, salt, p) {
  return aesCmac(aesCmac(salt, n), p);
}

// k2 (§3.8.2.6): the 7-bit NID carried in every network PDU, the key that
// encrypts it and the key that obfuscates its header. P is 0x00 for the
// master (flooding) credentials, which is all this app uses.
function k2(n, p) {
  assertKey('k2', n);
  if (!p || p.length < 1) throw new Error('k2: P must be at least 1 byte');
  const t = aesCmac(s1(Buffer.from('smk2')), n);
  const t1 = aesCmac(t, Buffer.concat([p, Buffer.from([0x01])]));
  const t2 = aesCmac(t, Buffer.concat([t1, p, Buffer.from([0x02])]));
  const t3 = aesCmac(t, Buffer.concat([t2, p, Buffer.from([0x03])]));
  return { nid: t1[15] & 0x7f, encryptionKey: t2, privacyKey: t3 };
}

// k3 (§3.8.2.7): the 8-byte Network ID, as carried in beacons and in the
// 0x1828 proxy advertisement.
function k3(n) {
  assertKey('k3', n);
  const t = aesCmac(s1(Buffer.from('smk3')), n);
  return aesCmac(t, Buffer.from('id64\x01', 'latin1')).subarray(8);
}

// k4 (§3.8.2.8): the 6-bit AID that tells a receiver which AppKey was used.
function k4(n) {
  assertKey('k4', n);
  const t = aesCmac(s1(Buffer.from('smk4')), n);
  return aesCmac(t, Buffer.from('id6\x01', 'latin1'))[15] & 0x3f;
}

// AES-CCM with a 128-bit key and a 13-byte mesh nonce (§3.8.2.3). Returns the
// ciphertext and the MIC (`tagLength` bytes) separately.
function ccmEncrypt(key, nonce, plaintext, tagLength, additionalData) {
  const cipher = crypto.createCipheriv('aes-128-ccm', key, nonce, { authTagLength: tagLength });
  if (additionalData && additionalData.length > 0) {
    cipher.setAAD(additionalData, { plaintextLength: plaintext.length });
  }
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, tag: cipher.getAuthTag() };
}

// Returns the plaintext, or null when the MIC does not verify. Traffic for
// other networks fails here all the time, so that is not an error. A wrong
// key or nonce length is a bug in the caller and still throws.
function ccmDecrypt(key, nonce, ciphertext, tag, additionalData) {
  if (!MIC_LENGTHS.has(tag.length)) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-128-ccm', key, nonce, { authTagLength: tag.length });
    decipher.setAuthTag(tag);
    if (additionalData && additionalData.length > 0) {
      decipher.setAAD(additionalData, { plaintextLength: ciphertext.length });
    }
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    if (err.code === 'ERR_CRYPTO_INVALID_KEYLEN' || err.code === 'ERR_CRYPTO_INVALID_IV') throw err;
    return null;
  }
}

module.exports = {
  aesCmac,
  ccmDecrypt,
  ccmEncrypt,
  e,
  k1,
  k2,
  k3,
  k4,
  s1,
};
