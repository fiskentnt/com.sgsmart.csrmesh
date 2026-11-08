'use strict';

// The manufacturer data of a Bluetooth advertisement for company
// MAKER_COMPANY, read without lib/sg3, so the pairing for SG Smart 3.0 can
// log what a scan saw also in a home without a 3.0 network, where nothing of
// lib/sg3 is loaded (app.js, sg3). It loads nothing.
//
// scanMakerLine is the pairing's one line per scan (drivers/sg3_dimmer): how
// many nodes with data for MAKER_COMPANY the scan saw, per length of the data
// and value of byte MAKER_TYPE_AT, the byte that gives the type on the
// LEDDim Smart 3.0 seen on 2026-11-08 (29 bytes, 0xA5). That the byte is
// the type on other 3.0 products and other lengths is not known; the line is
// there so a tester's log can tell. Without the network's keys a node cannot
// be told to be in this home, so the line says so: a neighbour's nodes are
// counted too. No other bytes (bytes 8 and 9 are the node's address), and no
// addresses or ids: a node is counted once per scan by its peripheral id,
// kept in memory for that scan only. That no other maker's nodes have data
// for MAKER_COMPANY is assumed.

const MAKER_COMPANY = 0x0ee8;
const MAKER_TYPE_AT = 18;
// How many combinations of length and byte the line shows; the rest are
// counted together.
const MAKER_LINE_MAX = 8;

// The manufacturer data of an advertisement as a Buffer, or null. Homey
// gives a Buffer (homey-docs, wireless/bluetooth.md); a list of bytes or a
// Buffer in JSON form is taken too.
function makerData(advertisement) {
  const raw = advertisement ? advertisement.manufacturerData : null;
  if (!raw || typeof raw !== 'object') return null;
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array || Array.isArray(raw)) return Buffer.from(raw);
  if (raw.type === 'Buffer' && Array.isArray(raw.data)) return Buffer.from(raw.data);
  return null;
}

// The data for MAKER_COMPANY (in bytes 0 and 1, low byte first), or null.
function companyData(advertisement) {
  const data = makerData(advertisement);
  return data && data.length >= 2 && data.readUInt16LE(0) === MAKER_COMPANY ? data : null;
}

const byteText = (value) => `0x${value.toString(16).padStart(2, '0')}`;

// The line for the advertisements of one scan, without "pair: ".
function scanMakerLine(advertisements) {
  const seen = new Set();
  const counts = new Map();
  for (const advertisement of Array.isArray(advertisements) ? advertisements : []) {
    const data = companyData(advertisement);
    if (!data) continue;
    const id = advertisement.uuid;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const typeByte = data.length > MAKER_TYPE_AT ? data[MAKER_TYPE_AT] : -1;
    const key = `${data.length}:${typeByte}`;
    const count = counts.get(key);
    if (count) count.nodes += 1;
    else counts.set(key, { length: data.length, typeByte, nodes: 1 });
  }
  if (!counts.size) return 'SG Smart 3.0 nodes in the scan: none';
  const sorted = [...counts.values()].sort((a, b) => b.nodes - a.nodes || a.length - b.length || a.typeByte - b.typeByte);
  const shown = sorted.slice(0, MAKER_LINE_MAX).map(({ length, typeByte, nodes }) => `${nodes} with ${length} bytes and `
    + `${typeByte < 0 ? `no byte ${MAKER_TYPE_AT}` : `byte ${MAKER_TYPE_AT} ${byteText(typeByte)}`}`);
  const rest = sorted.slice(MAKER_LINE_MAX);
  if (rest.length) {
    shown.push(`and ${rest.reduce((sum, { nodes }) => sum + nodes, 0)} more in ${rest.length} other combination(s)`);
  }
  return `SG Smart 3.0 nodes in the scan (whether they are in this home is not known): ${shown.join(', ')}`;
}

module.exports = {
  MAKER_COMPANY, MAKER_LINE_MAX, MAKER_TYPE_AT, companyData, makerData, scanMakerLine,
};
