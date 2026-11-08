'use strict';

// A LEDDim Smart 3.0 node from its advertisement alone (lib/sg3/advert.js):
// its address from bytes 8 and 9 of the manufacturer data for 0x0EE8 (low
// byte first) and its type from byte 18, when it advertises the Network ID
// of the network whose keys are kept. 0xA5 is LEDDim Smart 3.0; 0xA6 is the
// 2-pole, assumed, not seen on a real 2-pole. Made-up data; the
// specification's sample network key.

const test = require('node:test');
const assert = require('node:assert/strict');

const { MAKER_TYPES, networkIdOf, sg3NodeFromAdvert } = require('../../lib/sg3/advert');
const { NETWORK_ID } = require('./fake-homey');

const NET_KEY = '7dd7364cd842ad18c17c2b820c84c3d6';

// An advertisement with the proxy service data (Network ID, type 0x00) and
// made-up manufacturer data: the company, filler, the address at 8 and the
// type byte at 18.
function advertisement({ address = 0x0005, typeByte = 0xa5, length = 29, networkId = NETWORK_ID, serviceType = 0x00, company = 0x0ee8 } = {}) {
  const data = Buffer.alloc(length, 0x5a);
  data.writeUInt16LE(company, 0);
  if (length >= 10) data.writeUInt16LE(address, 8);
  if (length >= 19) data[18] = typeByte;
  return {
    uuid: 'made-up-node-0005',
    serviceData: [{ uuid: '00001828-0000-1000-8000-00805f9b34fb', data: Buffer.concat([Buffer.from([serviceType]), Buffer.from(networkId, 'hex')]) }],
    manufacturerData: data,
  };
}

test('the Network ID of the kept keys, as the nodes advertise it', () => {
  assert.equal(networkIdOf(NET_KEY), NETWORK_ID);
});

test('the address (low byte first) and the type: 0xA5 is 3080, 0xA6 is 3081 (assumed), another byte has no type', () => {
  assert.deepEqual(sg3NodeFromAdvert(advertisement(), NETWORK_ID), { address: 0x0005, type: 3080 });
  assert.deepEqual(sg3NodeFromAdvert(advertisement({ address: 0x66bb }), NETWORK_ID), { address: 0x66bb, type: 3080 });
  assert.deepEqual(sg3NodeFromAdvert(advertisement({ typeByte: 0xa6 }), NETWORK_ID), { address: 0x0005, type: 3081 });
  assert.deepEqual(sg3NodeFromAdvert(advertisement({ typeByte: 0x42 }), NETWORK_ID), { address: 0x0005, type: null });
  assert.deepEqual(MAKER_TYPES, { 0xa5: 3080, 0xa6: 3081 });
  const forms = advertisement();
  for (const manufacturerData of [[...forms.manufacturerData], forms.manufacturerData.toJSON(), new Uint8Array(forms.manufacturerData)]) {
    assert.deepEqual(sg3NodeFromAdvert({ ...forms, manufacturerData }, NETWORK_ID), { address: 0x0005, type: 3080 });
  }
});

test('not a node of this network, or no usable data: null', () => {
  const none = [
    ['another network', advertisement({ networkId: '0011223344556677' })],
    ['Node Identity, not the Network ID', advertisement({ serviceType: 0x01 })],
    ['no service data', { ...advertisement(), serviceData: [] }],
    ['another company', advertisement({ company: 0x004c })],
    ['too short for byte 18', advertisement({ length: 18 })],
    ['no manufacturer data', { ...advertisement(), manufacturerData: undefined }],
    ['data as a string', { ...advertisement(), manufacturerData: 'e80e' }],
    ['address 0', advertisement({ address: 0x0000 })],
    ['Homey\'s own range', advertisement({ address: 0x7f80 })],
    ['above Homey\'s range', advertisement({ address: 0x7fff })],
    ['a group address', advertisement({ address: 0xc000 })],
  ];
  for (const [what, ad] of none) assert.equal(sg3NodeFromAdvert(ad, NETWORK_ID), null, what);
  assert.equal(sg3NodeFromAdvert(advertisement(), null), null, 'no Network ID kept');
  assert.equal(sg3NodeFromAdvert(null, NETWORK_ID), null);
});
