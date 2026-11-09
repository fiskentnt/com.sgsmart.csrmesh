'use strict';

const { decryptPayload, verifyPacket } = require('./csrmesh');
const { parseExt, parseGen1Status } = require('./sgProtocol');
const { shortUuid } = require('./sgProducts');

// The mesh frames in a pairing scan's advertisements, for the log only: one
// line per scan with counts, never a mesh id, a location id or an address.
// A node is assumed to send the mesh packets it sends and passes on as
// advertisements too, each a whole frame in FEF1 service data (seq, source,
// encrypted payload, MAC, TTL), from an address of its own per packet; not
// tried, nor whether Homey's scan gives that service data. A packet passed on
// by another node differs in its TTL only, so it counts once. Each one is
// checked with the network key, once, at most MAX_CHECKED per scan, so a busy
// mesh costs no more than that.

const MAX_CHECKED = 300;
// As MeshBridge reads a frame: seq(3) source(2) payload(4 to 24) MAC(8) TTL(1).
const FRAME_MIN = 18;
const FRAME_MAX = 38;
// This app's own address: a frame from it is not a sender of the home.
const OWN_ADDRESS = 0x8000;
// The messages whose data starts with the home's location id.
const WITH_LOCATION = new Set([0xff03, 0xff04, 0xff05, 0xff08, 0xff10, 0xff11, 0xff3c, 0xff3d, 0xff3e, 0xff42, 0xff50, 0xff5c, 0xff5d]);
// Kinds named in the line; the rest count as other.
const MAX_KINDS = 8;

function bytesOf(data) {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return /^[0-9a-f]*$/i.test(data) && data.length % 2 === 0 ? Buffer.from(data, 'hex') : null;
  try {
    return Buffer.from(data || []);
  } catch {
    return null;
  }
}

function fef1Data(adv) {
  const list = Array.isArray(adv && adv.serviceData) ? adv.serviceData
    : Object.entries((adv && adv.serviceData) || {}).map(([uuid, data]) => ({ uuid, data }));
  const found = list.find((s) => s && shortUuid(s.uuid) === 'fef1');
  return found ? bytesOf(found.data) : null;
}

// What a frame read with the key is: { kind, location } (location 0 when it
// carries none).
function readFrame(key, frame) {
  const plain = decryptPayload(key, frame.subarray(0, 3), frame.subarray(3, 5), frame.subarray(5, frame.length - 9));
  const gen1 = parseGen1Status(plain);
  if (gen1) return { kind: '73F7', location: gen1.location };
  const ext = parseExt(plain);
  if (!ext) return { kind: 'other', location: 0 };
  const location = WITH_LOCATION.has(ext.opcode) && ext.data.length >= 2 ? ext.data.readUInt16BE(0) : 0;
  return { kind: ext.opcode.toString(16).toUpperCase().padStart(4, '0'), location };
}

// The log line for a scan's advertisements, with the network key (a Buffer),
// or without one.
function meshAdvertsLine(advertisements, key) {
  const head = 'pair: mesh frames in advertisements (log only):';
  const frames = new Map();
  let withData = 0;
  let notFrame = 0;
  for (const adv of advertisements || []) {
    const data = fef1Data(adv);
    if (!data) continue;
    withData += 1;
    if (data.length < FRAME_MIN || data.length > FRAME_MAX) {
      notFrame += 1;
      continue;
    }
    const same = data.subarray(0, data.length - 1).toString('hex');
    if (!frames.has(same)) frames.set(same, data);
  }
  if (!withData) return `${head} none with FEF1 data`;
  const counted = `${head} ${withData} with FEF1 data${notFrame ? `, ${notFrame} not a frame` : ''}, ${frames.size} distinct`;
  if (!Buffer.isBuffer(key)) return `${counted}, no key to check them with`;
  const checked = [...frames.values()].slice(0, MAX_CHECKED);
  const senders = new Set();
  const locations = new Set();
  const kinds = new Map();
  let read = 0;
  for (const frame of checked) {
    let ok = false;
    try {
      ok = verifyPacket(key, frame);
    } catch {
      ok = false;
    }
    if (!ok) continue;
    read += 1;
    const src = frame.readUInt16LE(3);
    if (src !== OWN_ADDRESS) senders.add(src);
    let what;
    try {
      what = readFrame(key, frame);
    } catch {
      what = { kind: 'other', location: 0 };
    }
    if (what.location > 0) locations.add(what.location);
    kinds.set(what.kind, (kinds.get(what.kind) || 0) + 1);
  }
  const named = [...kinds.entries()].filter(([kind]) => kind !== 'other').sort(([a], [b]) => a.localeCompare(b));
  const shown = named.slice(0, MAX_KINDS);
  const other = (kinds.get('other') || 0) + named.slice(MAX_KINDS).reduce((sum, [, n]) => sum + n, 0);
  const list = [...shown.map(([kind, n]) => `${kind} ${n}`), ...(other ? [`other ${other}`] : [])];
  const cap = frames.size > MAX_CHECKED ? ` (at most ${MAX_CHECKED})` : '';
  return `${counted}, ${checked.length} checked${cap}, ${read} read with the network key, ${checked.length - read} not; `
    + `${senders.size} sender(s), ${locations.size} location id(s)${list.length ? `; ${list.join(', ')}` : ''}`;
}

// The line for a driver's pairing scan, with the app's network key. Never
// throws: a pairing goes on whatever happens here.
function meshAdvertsLineFor(driver, advertisements) {
  try {
    const { app } = driver.homey;
    const key = app && typeof app.getNetworkKey === 'function' ? app.getNetworkKey() : null;
    return meshAdvertsLine(advertisements, key);
  } catch (err) {
    return `pair: mesh frames in advertisements (log only): not counted (${(err && err.name) || 'error'})`;
  }
}

module.exports = { MAX_CHECKED, meshAdvertsLine, meshAdvertsLineFor };
