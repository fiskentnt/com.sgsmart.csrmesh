'use strict';

// Known-answer tests. Sample data from the Mesh Profile 1.0.1 specification,
// §8.1 and §8.7, as transcribed in shejnowicz/homey-ble-mesh
// (lib/mesh/crypto/__tests__/vectors.ts) and, for s1 and k1 to k4, also in
// frekarlsen/ha-sg-smart-mesh (tests/test_crypto.py). Plus RFC 4493 and
// FIPS-197.

const test = require('node:test');
const assert = require('node:assert/strict');

const { aesCmac, ccmDecrypt, ccmEncrypt, e, k1, k2, k3, k4, s1 } = require('../../lib/sigmesh/crypto');

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

test('e is plain AES-128 (FIPS-197 appendix C.1)', () => {
  const out = e(hex('000102030405060708090a0b0c0d0e0f'), hex('00112233445566778899aabbccddeeff'));
  assert.equal(out.toString('hex'), '69c4e0d86a7b0430d8cdb78070b4c55a');
});

test('aesCmac matches RFC 4493 §4, examples 1 to 4', () => {
  const key = hex('2b7e151628aed2a6abf7158809cf4f3c');
  const message = hex(`
    6bc1bee22e409f96e93d7e117393172a ae2d8a571e03ac9c9eb76fac45af8e51
    30c81c46a35ce411e5fbc1191a0a52ef f69f2445df4f9b17ad2b417be66c3710`);
  assert.equal(aesCmac(key, Buffer.alloc(0)).toString('hex'), 'bb1d6929e95937287fa37d129b756746');
  assert.equal(aesCmac(key, message.subarray(0, 16)).toString('hex'), '070a16b46b4d4144f79bdd9dd04a287c');
  assert.equal(aesCmac(key, message.subarray(0, 40)).toString('hex'), 'dfa66747de9ae63030ca32611497c827');
  assert.equal(aesCmac(key, message).toString('hex'), '51f0bebf7e3b9d92fc49741779363cfe');
});

test('s1 (§8.1.1)', () => {
  assert.equal(s1(Buffer.from('test')).toString('hex'), 'b73cefbd641ef2ea598c2b6efb62f79c');
});

test('k1 (§8.1.2)', () => {
  const out = k1(
    hex('3216d1509884b533248541792b877f98'),
    hex('2ba14ffa0df84a2831938d57d276cab4'),
    hex('5a09d60797eeb4478aada59db3352a0d'),
  );
  assert.equal(out.toString('hex'), 'f6ed15a8934afbe7d83e8dcb57fcf5d7');
});

test('k2 with master credentials (§8.1.3)', () => {
  const out = k2(hex('f7a2a44f8e8a8029064f173ddc1e2b00'), hex('00'));
  assert.equal(out.nid, 0x7f);
  assert.equal(out.encryptionKey.toString('hex'), '9f589181a0f50de73c8070c7a6d27f46');
  assert.equal(out.privacyKey.toString('hex'), '4c715bd4a64b938f99b453351653124f');
});

test('k2 with friendship credentials (§8.1.4)', () => {
  const out = k2(hex('f7a2a44f8e8a8029064f173ddc1e2b00'), hex('010203040506070809'));
  assert.equal(out.nid, 0x73);
  assert.equal(out.encryptionKey.toString('hex'), '11efec0642774992510fb5929646df49');
  assert.equal(out.privacyKey.toString('hex'), 'd4d7cc0dfa772d836a8df9df5510d7a7');
});

test('k3 (§8.1.5)', () => {
  assert.equal(k3(hex('f7a2a44f8e8a8029064f173ddc1e2b00')).toString('hex'), 'ff046958233db014');
});

test('k4 (§8.1.6)', () => {
  assert.equal(k4(hex('3216d1509884b533248541792b877f98')), 0x38);
});

test('k2, k3 and k4 refuse a key that is not 16 bytes', () => {
  assert.throws(() => k2(Buffer.alloc(15), hex('00')), /16 bytes/);
  assert.throws(() => k3(Buffer.alloc(17)), /16 bytes/);
  assert.throws(() => k4(Buffer.alloc(0)), /16 bytes/);
});

// §8.7: the Provisioning Data, encrypted with the session key and nonce.
const CCM_SAMPLE = {
  key: hex('c80253af86b33dfa450bbdb2a191fea3'),
  nonce: hex('da7ddbe78b5f62b81d6847487e'),
  plaintext: hex('efb2255e6422d330088e09bb015ed707056700010203040b0c'),
  ciphertext: 'd0bd7f4a89a2ff6222af59a90a60ad58acfe3123356f5cec29',
  tag: '73e0ec50783b10c7',
};

test('ccmEncrypt matches the provisioning data sample (§8.7)', () => {
  const { ciphertext, tag } = ccmEncrypt(CCM_SAMPLE.key, CCM_SAMPLE.nonce, CCM_SAMPLE.plaintext, 8);
  assert.equal(ciphertext.toString('hex'), CCM_SAMPLE.ciphertext);
  assert.equal(tag.toString('hex'), CCM_SAMPLE.tag);
});

test('ccmDecrypt returns the plaintext of the sample', () => {
  const plain = ccmDecrypt(CCM_SAMPLE.key, CCM_SAMPLE.nonce, hex(CCM_SAMPLE.ciphertext), hex(CCM_SAMPLE.tag));
  assert.deepEqual(plain, CCM_SAMPLE.plaintext);
});

test('ccmDecrypt returns null for a wrong MIC, and for a MIC length mesh never uses', () => {
  const badTag = hex(CCM_SAMPLE.tag);
  badTag[0] ^= 0x01;
  assert.equal(ccmDecrypt(CCM_SAMPLE.key, CCM_SAMPLE.nonce, hex(CCM_SAMPLE.ciphertext), badTag), null);
  assert.equal(ccmDecrypt(CCM_SAMPLE.key, CCM_SAMPLE.nonce, hex(CCM_SAMPLE.ciphertext), hex('73e0ec50783b')), null);
});

test('ccm round trip with a 4-byte MIC and additional data', () => {
  const key = hex('000102030405060708090a0b0c0d0e0f');
  const nonce = hex('00800000011201000012345678');
  const aad = hex('0123456789abcdef0123456789abcdef');
  const { ciphertext, tag } = ccmEncrypt(key, nonce, hex('0102030405'), 4, aad);
  assert.equal(tag.length, 4);
  assert.deepEqual(ccmDecrypt(key, nonce, ciphertext, tag, aad), hex('0102030405'));
  assert.equal(ccmDecrypt(key, nonce, ciphertext, tag, Buffer.alloc(16)), null);
});

test('ccmDecrypt still throws for a key of the wrong length (a caller bug)', () => {
  assert.throws(() => ccmDecrypt(Buffer.alloc(15), CCM_SAMPLE.nonce, hex(CCM_SAMPLE.ciphertext), hex(CCM_SAMPLE.tag)));
});
