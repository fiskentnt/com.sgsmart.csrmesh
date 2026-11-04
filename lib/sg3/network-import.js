'use strict';

// Imports a Bluetooth Mesh network export: a Mesh Configuration Database
// (nRF Mesh, and the Telink SDK inside the SG app keeps its network in the
// same format) or a ThingOS .connect file. The checks and their order are
// HA's, so an export HA takes is taken here, and one it refuses is refused
// with the same reason:
//
//    1. JSON at all (invalid_json)            6. a nodes list (it may be empty)
//    2. a JSON object                          7. provisioner nodes left out
//    3. netKeys[0] and appKeys[0] objects      8. each node parsed, a broken one skipped
//    4. their keys hex                         9. an error if every node was broken
//    5. every appKeys[] entry                 10. name, UUID, key indexes, ivIndex
//
// Added here: keys must be 16 bytes (step 4); a missing ivIndex is unknown
// (null), not 0, since a network made by the SG app has none and is rarely at
// 0; and the addresses of skipped provisioner nodes and the provisioners'
// unicast ranges are kept, so Homey can keep clear of them when it picks its
// own address. HA's Häfele-only parts (tos_groups, output names) are left out.
//
// After frekarlsen/ha-sg-smart-mesh, commit c00c73a,
// custom_components/bluetooth_mesh/config_flow.py (_parse) and
// src/btmesh/network_model.py (MIT, see ../sigmesh/LICENSE-MIT).

const { k3 } = require('../sigmesh/crypto');

const UNICAST_MIN = 0x0001;
const UNICAST_MAX = 0x7fff;
const MODEL_SG_VENDOR = 0x0ee80000;
// SG battery buttons (Smart Switch, Switch DK, the Wireless wheel): they send
// and are never paired to, so they are not dimmers.
const SG_SWITCH_PIDS = new Set([0xaf, 0xb0, 0xb1]);

class ImportError extends Error {
  // `code` is 'invalid_json', 'invalid_export' or, for the key fields,
  // 'invalid_net_key' / 'invalid_app_key'. `detail` names the JSON field in
  // the export's own (English) words, as HA leaves it.
  constructor(code, detail) {
    super(detail);
    this.code = code;
    this.detail = detail;
  }
}

function fail(detail) {
  throw new ImportError('invalid_export', detail);
}

// Hex as Python's bytes.fromhex takes it: pairs of hex digits, spaces allowed
// between them. Buffer.from(…, 'hex') would stop quietly at a bad character.
function hexToBytes(value) {
  const compact = value.replace(/\s+/g, '');
  if (!/^([0-9a-fA-F]{2})*$/.test(compact)) return null;
  return Buffer.from(compact, 'hex');
}

function hexBytes(entry, key, label) {
  const value = entry[key];
  if (typeof value !== 'string') fail(`missing or non-string '${label}'`);
  const bytes = hexToBytes(value);
  if (bytes === null) fail(`'${label}' is not valid hex`);
  return bytes;
}

function keyBytes(entry, label) {
  const bytes = hexBytes(entry, 'key', label);
  if (bytes.length !== 16) fail(`'${label}' must be 16 bytes, got ${bytes.length}`);
  return bytes;
}

function asInt(value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value)) fail(`'${label}' must be an integer, got ${JSON.stringify(value)}`);
  return value;
}

function hexInt(value, label) {
  if (typeof value !== 'string') fail(`missing or non-string '${label}'`);
  if (!/^\s*(0x)?[0-9a-fA-F]+\s*$/i.test(value)) fail(`'${label}' is not valid hex: ${JSON.stringify(value)}`);
  return parseInt(value, 16);
}

function first(data, field) {
  const entries = data[field];
  if (!Array.isArray(entries) || entries.length === 0) fail(`connect document has no '${field}' entry`);
  if (!isObject(entries[0])) fail(`'${field}[0]' is not an object`);
  return entries[0];
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeUuid(value) {
  return String(value === undefined || value === null ? '' : value).replace(/-/g, '').toUpperCase();
}

// tos_devices[0].name, tos_node.type, or the plain name of a Mesh
// Configuration Database node, else "".
function nodeName(raw) {
  const devices = raw.tos_devices;
  if (Array.isArray(devices) && devices.length > 0 && isObject(devices[0])) {
    if (typeof devices[0].name === 'string' && devices[0].name) return devices[0].name;
  }
  if (isObject(raw.tos_node) && typeof raw.tos_node.type === 'string' && raw.tos_node.type) return raw.tos_node.type;
  if (typeof raw.name === 'string' && raw.name) return raw.name;
  return '';
}

// modelId: 4 hex digits for a SIG model, 8 for a vendor model (company << 16 | model).
function parseModel(raw) {
  if (!isObject(raw)) fail('element model entry is not an object');
  const bind = raw.bind === undefined ? [] : raw.bind;
  if (!Array.isArray(bind)) fail(`'bind' must be a list, got ${JSON.stringify(bind)}`);
  const subscribe = raw.subscribe === undefined ? [] : raw.subscribe;
  if (!Array.isArray(subscribe)) fail(`'subscribe' must be a list, got ${JSON.stringify(subscribe)}`);
  return {
    modelId: hexInt(raw.modelId, 'models[].modelId'),
    bind: bind.map((b) => asInt(b, 'models[].bind[]')),
    subscribe: subscribe.map((a) => hexInt(a, 'models[].subscribe[]')),
  };
}

// An element's unicast is the node's base unicast plus its index (§3.4.2).
function parseElement(baseUnicast, raw) {
  if (!isObject(raw)) fail('element entry is not an object');
  const index = asInt(raw.index === undefined ? 0 : raw.index, 'elements[].index');
  const models = raw.models === undefined ? [] : raw.models;
  if (!Array.isArray(models)) fail(`element 'models' must be a list, got ${JSON.stringify(models)}`);
  return { index, unicast: baseUnicast + index, models: models.map(parseModel) };
}

function parseNode(raw) {
  if (!isObject(raw)) fail('node entry is not an object');
  const unicast = hexInt(raw.unicastAddress, 'nodes[].unicastAddress');
  const deviceKey = hexBytes(raw, 'deviceKey', 'nodes[].deviceKey');
  // A node not configured yet has no composition: no cid, no elements. It is
  // kept, since its device key is what configuring it needs.
  const cid = raw.cid ? hexInt(raw.cid, 'nodes[].cid') : 0;
  // Informational only: a malformed PID must not cost the whole network.
  let pid = 0;
  try {
    pid = raw.pid ? hexInt(raw.pid, 'nodes[].pid') : 0;
  } catch (err) {
    pid = 0;
  }
  const rawElements = raw.elements === undefined ? [] : raw.elements;
  if (!Array.isArray(rawElements)) fail(`node 'elements' must be a list, got ${JSON.stringify(rawElements)}`);
  return {
    uuid: String(raw.UUID === undefined ? '' : raw.UUID),
    unicast,
    deviceKey,
    cid,
    pid,
    name: nodeName(raw),
    elements: rawElements.map((e) => parseElement(unicast, e)),
  };
}

// The unicast ranges the provisioners hand out from. Malformed entries are
// skipped: this only helps pick our address, it is not the network.
function provisionerRanges(provisioners) {
  const ranges = [];
  for (const provisioner of provisioners) {
    if (!isObject(provisioner) || !Array.isArray(provisioner.allocatedUnicastRange)) continue;
    for (const range of provisioner.allocatedUnicastRange) {
      try {
        const low = hexInt(range.lowAddress, 'lowAddress');
        const high = hexInt(range.highAddress, 'highAddress');
        if (low <= high) ranges.push([low, high]);
      } catch (err) {
        // skipped
      }
    }
  }
  return ranges;
}

// A decoded export object to the network. Throws ImportError('invalid_export').
function networkFromObject(data) {
  if (!isObject(data)) fail('connect document must be a JSON object');

  const netKeyEntry = first(data, 'netKeys');
  const appKeyEntry = first(data, 'appKeys');
  const netKey = keyBytes(netKeyEntry, 'netKeys[0].key');
  keyBytes(appKeyEntry, 'appKeys[0].key');
  const appKeys = data.appKeys.map((entry, position) => {
    if (!isObject(entry)) fail(`'appKeys[${position}]' is not an object`);
    return {
      index: asInt(entry.index === undefined ? 0 : entry.index, `appKeys[${position}].index`),
      key: keyBytes(entry, `appKeys[${position}].key`),
      name: String(entry.name === undefined ? '' : entry.name),
    };
  });

  const rawNodes = data.nodes;
  if (!Array.isArray(rawNodes)) fail("connect document has no 'nodes' list");

  // A Mesh Configuration Database lists the provisioner itself as a node (nRF
  // Mesh; the SG app's Telink SDK as well). Its UUID is the one in
  // provisioners[]: left out, but its address is remembered.
  const provisioners = Array.isArray(data.provisioners) ? data.provisioners : [];
  const provisionerUuids = new Set(provisioners.filter(isObject).map((p) => normalizeUuid(p.UUID)).filter(Boolean));
  const reservedAddresses = [];
  const nodes = [];
  const skipped = [];
  for (const raw of rawNodes) {
    if (isObject(raw) && provisionerUuids.has(normalizeUuid(raw.UUID))) {
      try {
        reservedAddresses.push(hexInt(raw.unicastAddress, 'unicastAddress'));
      } catch (err) {
        // no address to keep clear of
      }
      continue;
    }
    try {
      nodes.push(parseNode(raw));
    } catch (err) {
      if (!(err instanceof ImportError)) throw err;
      skipped.push(`${isObject(raw) && raw.UUID ? raw.UUID : '?'}: ${err.detail}`);
    }
  }
  if (skipped.length > 0 && nodes.length === 0) {
    // Importing an empty network would look like success and show nothing.
    fail(`no usable node in the connect export: ${skipped.join('; ')}`);
  }

  return {
    name: String(data.meshName === undefined ? '' : data.meshName),
    uuid: String(data.meshUUID === undefined ? '' : data.meshUUID),
    netKey,
    netKeyIndex: asInt(netKeyEntry.index === undefined ? 0 : netKeyEntry.index, 'netKeys[0].index'),
    appKeyIndex: asInt(appKeyEntry.index === undefined ? 0 : appKeyEntry.index, 'appKeys[0].index'),
    appKeys,
    ivIndex: data.ivIndex === undefined ? null : asInt(data.ivIndex, 'ivIndex'),
    nodes,
    skipped,
    reservedAddresses,
    reservedRanges: provisionerRanges(provisioners),
  };
}

// The pasted text to the network. Throws ImportError.
function parseNetworkExport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new ImportError('invalid_json', err.message);
  }
  return networkFromObject(data);
}

// The keys alone (the SG app has no export) as the smallest export the same
// import takes: no nodes, no ivIndex. Only the key fields are checked here,
// with their own error codes; the rest is the import's job.
function buildExportFromKeys({ netKey, appKey }) {
  const check = (value, code) => {
    const bytes = typeof value === 'string' ? hexToBytes(value) : null;
    if (bytes === null || bytes.length !== 16) throw new ImportError(code, 'must be 32 hex digits');
    return bytes.toString('hex').toUpperCase();
  };
  return JSON.stringify({
    meshName: 'SG Smart 3.0',
    netKeys: [{ index: 0, key: check(netKey, 'invalid_net_key') }],
    appKeys: [{ index: 0, boundNetKey: 0, key: check(appKey, 'invalid_app_key') }],
    provisioners: [],
    nodes: [],
  });
}

// ---------------------------------------------------------------- reading the network

// The Network ID nodes advertise, k3(NetKey), as hex. Not secret.
function networkId(network) {
  return k3(network.netKey).toString('hex');
}

// meshUUID, else the Network ID: a stable identity for "the same network".
function identifier(network) {
  return network.uuid || networkId(network);
}

// Every element address the export accounts for.
function unicastAddresses(network) {
  return new Set(network.nodes.flatMap((node) => node.elements.map((element) => element.unicast)));
}

// `preferred` if nothing owns it, else the next one down. Sending from an
// address a node (or a phone) already uses is fatal in silence: its peers
// drop everything as replays. Addresses inside a provisioner's range are
// avoided too, since that provisioner may hand them to a new node; if every
// address is inside one, the ranges give way (HA's rule then).
function freeUnicast(network, preferred = UNICAST_MAX) {
  if (!Number.isInteger(preferred) || preferred < UNICAST_MIN || preferred > UNICAST_MAX) {
    fail(`0x${Number(preferred).toString(16)} is not a unicast address (0x0001-0x7fff)`);
  }
  const taken = unicastAddresses(network);
  for (const address of network.reservedAddresses) taken.add(address);
  const inRange = (a) => network.reservedRanges.some(([low, high]) => a >= low && a <= high);
  for (const avoidRanges of [true, false]) {
    for (let candidate = preferred; candidate >= UNICAST_MIN; candidate -= 1) {
      if (!taken.has(candidate) && !(avoidRanges && inRange(candidate))) return candidate;
    }
  }
  return fail('the export leaves no free unicast address');
}

// AppKey indexes bound to `modelIds`, the most bound first.
function boundAppKeyIndexes(network, modelIds) {
  const wanted = new Set(modelIds);
  const counts = new Map();
  for (const node of network.nodes) {
    for (const element of node.elements) {
      for (const model of element.models) {
        if (!wanted.has(model.modelId)) continue;
        for (const index of model.bind) counts.set(index, (counts.get(index) || 0) + 1);
      }
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([index]) => index);
}

// The AppKey the models are bound to: a node drops a message under any other
// key without a word. Falls back to the first key.
function appKeyForModels(network, modelIds) {
  const held = new Map(network.appKeys.map((key) => [key.index, key]));
  for (const index of boundAppKeyIndexes(network, modelIds)) {
    if (held.has(index)) return held.get(index);
  }
  return network.appKeys[0];
}

// Nodes with the SG vendor model, buttons and wheels left out.
function sgDimmerNodes(network) {
  return network.nodes.filter((node) => (
    node.elements.some((e) => e.models.some((m) => m.modelId === MODEL_SG_VENDOR)) && !SG_SWITCH_PIDS.has(node.pid)
  ));
}

module.exports = {
  ImportError,
  MODEL_SG_VENDOR,
  appKeyForModels,
  boundAppKeyIndexes,
  buildExportFromKeys,
  freeUnicast,
  identifier,
  networkFromObject,
  networkId,
  parseNetworkExport,
  sgDimmerNodes,
  unicastAddresses,
};
