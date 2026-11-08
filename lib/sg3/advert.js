'use strict';

// A LEDDim Smart 3.0 node from its advertisement alone, for pairing without
// the SG account (drivers/sg3_dimmer): its address and its type, from the
// manufacturer data for company MAKER_COMPANY, when the node advertises the
// Network ID of the network whose keys are kept.
//
// Seen on a LEDDim Smart 3.0 on 2026-11-08: 29 bytes of manufacturer data,
// the company in bytes 0 and 1, bytes 8 and 9 the node's address (low byte
// first), byte 18 0xA5. For a 2-pole the type byte 0xA6 is assumed, not seen
// on a real 2-pole. That every 3.0 dimmer has them in the same place is
// assumed.

const { k3 } = require('../sigmesh/crypto');
const { SG3_NODE_FIRST, SG3_NODE_LAST } = require('../sgProducts');
const { proxyCandidates } = require('./bridge');

const MAKER_COMPANY = 0x0ee8;
const MAKER_ADDRESS_AT = 8;
const MAKER_TYPE_AT = 18;
// The type byte (MAKER_TYPE_AT) and the account's type it stands for.
const MAKER_TYPES = Object.freeze({
  0xa5: 3080, // LEDDim Smart 3.0, seen on a real dimmer (2026-11-08)
  0xa6: 3081, // LEDDim Smart 2-pole 3.0: assumed, not seen on a real 2-pole
});

// The manufacturer data of an advertisement as a Buffer, or null. Homey
// gives a Buffer (homey-docs, wireless/bluetooth.md); a list of bytes or a
// Buffer in JSON form is taken too.
function makerData(advertisement) {
  const raw = advertisement ? advertisement.manufacturerData : null;
  if (!raw || typeof raw === 'string') return null;
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array || Array.isArray(raw)) return Buffer.from(raw);
  if (raw.type === 'Buffer' && Array.isArray(raw.data)) return Buffer.from(raw.data);
  return null;
}

// The data for MAKER_COMPANY (in bytes 0 and 1, low byte first), or null.
function companyData(advertisement) {
  const data = makerData(advertisement);
  return data && data.length >= 2 && data.readUInt16LE(0) === MAKER_COMPANY ? data : null;
}

// The Network ID a network's nodes advertise, k3(NetKey), as 16 hex digits,
// from the network key as 32 hex digits. Not secret.
function networkIdOf(netKey) {
  return k3(Buffer.from(netKey, 'hex')).toString('hex');
}

// { address, type } of a node of the network with this Network ID (16 hex
// digits) from its advertisement: type is the account's type (3080, 3081),
// or null for a type byte not known here. null when the advertisement is not
// of that network, has no data for MAKER_COMPANY long enough, or no address
// in the node range.
function sg3NodeFromAdvert(advertisement, networkId) {
  if (!advertisement || !networkId) return null;
  if (proxyCandidates([advertisement], Buffer.from(networkId, 'hex')).length !== 1) return null;
  const data = companyData(advertisement);
  if (!data || data.length <= MAKER_TYPE_AT) return null;
  const address = data.readUInt16LE(MAKER_ADDRESS_AT);
  if (address < SG3_NODE_FIRST || address > SG3_NODE_LAST) return null;
  const typeByte = data[MAKER_TYPE_AT];
  const type = Object.prototype.hasOwnProperty.call(MAKER_TYPES, typeByte) ? MAKER_TYPES[typeByte] : null;
  return { address, type };
}

module.exports = {
  MAKER_ADDRESS_AT, MAKER_COMPANY, MAKER_TYPES, MAKER_TYPE_AT, companyData, makerData, networkIdOf, sg3NodeFromAdvert,
};
