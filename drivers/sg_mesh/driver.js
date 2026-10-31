'use strict';

const Homey = require('homey');
const { NODE_NAME, meshIdFromName } = require('../../lib/csrmesh');
const {
  foundNote, laterDevice, laterFindings, laterNodes, pairInLoadingView, withStates,
} = require('../../lib/csrPairing');
const { csrDriverFor, csrProductForName } = require('../../lib/sgProducts');
const SGMeshDevice = require('../../lib/SGDeviceBase');
const SGCsrDevice = require('../../lib/SGCsrDevice');

// 16-bit form of a service UUID as Homey gives it (with or without dashes).
// Only a Bluetooth base UUID has one; any other UUID is kept whole, so a
// vendor UUID that happens to hold fef1 is not counted as CSRmesh.
function shortUuid(uuid) {
  const s = String(uuid || '').toLowerCase().replace(/-/g, '');
  const base = /^0000([0-9a-f]{4})00001000800000805f9b34fb$/.exec(s);
  return base ? base[1] : s;
}

function serviceDataList(adv) {
  if (Array.isArray(adv.serviceData)) return adv.serviceData;
  return Object.entries(adv.serviceData || {}).map(([uuid, data]) => ({ uuid, data }));
}

function hexOf(data) {
  if (Buffer.isBuffer(data)) return data.toString('hex');
  if (typeof data === 'string') return data.toLowerCase();
  try { return Buffer.from(data || []).toString('hex'); } catch (err) { return ''; }
}

// SG nodes send service data 02FA, named or not. Its first bytes are 10 and,
// probably, the home's location id (see lib/sgProtocol.js), which differs from
// home to home, so only the 02FA itself is checked.
function hasSgData(adv) {
  return serviceDataList(adv).some((s) => shortUuid(s.uuid) === '02fa');
}

function isEmpty(adv) {
  return !String(adv.localName || '').trim()
    && !(adv.serviceUuids || []).length
    && !serviceDataList(adv).length
    && !hexOf(adv.manufacturerData);
}

// A peripheral seen more than once counts once, with what any sighting showed.
function scanPeripherals(advertisements) {
  const peripherals = new Map();
  for (const adv of advertisements) {
    const uuids = (adv.serviceUuids || []).map(shortUuid);
    const p = peripherals.get(adv.uuid) || { empty: true, connectable: false, rssi: -Infinity };
    p.named = p.named || NODE_NAME.test(String(adv.localName || '').trim());
    p.sg = p.sg || p.named || hasSgData(adv);
    p.csrmesh = p.csrmesh || uuids.includes('fef1');
    p.sigMesh = p.sigMesh || uuids.some((u) => u === '1827' || u === '1828');
    p.connectable = p.connectable || adv.connectable !== false;
    p.empty = p.empty && isEmpty(adv);
    const rssi = Number(adv.rssi);
    if (Number.isFinite(rssi) && rssi < 0) p.rssi = Math.max(p.rssi, rssi);
    const data02fa = serviceDataList(adv).find((d) => shortUuid(d.uuid) === '02fa');
    if (data02fa && !p.data02fa) p.data02fa = hexOf(data02fa.data).slice(0, 32);
    peripherals.set(adv.uuid, p);
  }
  return peripherals;
}

// One log line per pairing search: counts only, no addresses or node names.
function scanSummary(peripherals, advertisements, candidates, addedIds, seconds) {
  const all = [...peripherals.values()];
  const sg = all.filter((p) => p.sg);
  const notConnectable = sg.filter((p) => !p.connectable).length;
  const withoutName = sg.filter((p) => p.connectable && !p.named).length;
  const withName = sg.length - notConnectable - withoutName;
  const added = candidates.filter(([localName]) => addedIds.has(localName)).length;
  const rssi = sg.map((p) => p.rssi).filter(Number.isFinite);
  const signal = rssi.length ? ` SG signal ${Math.min(...rssi)} to ${Math.max(...rssi)} dB.` : '';
  return `pair: scan ${seconds.toFixed(1)} s, ${advertisements.length} advertisement(s) from ${all.length} device(s).`
    + ` Mesh: ${all.filter((p) => p.csrmesh).length} CSRmesh, ${all.filter((p) => p.sigMesh).length} Bluetooth Mesh.`
    + ` SG: ${sg.length} (${withName} with name, ${withoutName} without name, ${notConnectable} not connectable),`
    + ` ${all.filter((p) => p.empty).length} empty.`
    + ` Listed ${candidates.length - added}, already added ${added}.${signal}`;
}

// The 02FA service data of each SG node, strongest first and numbered, with
// no address or name: it tells SG device types apart.
function sgNodesLine(peripherals) {
  const strength = (p) => (Number.isFinite(p.rssi) ? p.rssi : -999);
  const sg = [...peripherals.values()].filter((p) => p.sg).sort((a, b) => strength(b) - strength(a));
  if (!sg.length) return 'pair: SG nodes: none';
  const shown = sg.slice(0, 10).map((p, i) => `${i + 1}: 02FA ${p.data02fa || '-'}, `
    + `${Number.isFinite(p.rssi) ? `${p.rssi} dB` : 'no signal'}, `
    + `${p.connectable ? (p.named ? 'named' : 'no name') : 'not connectable'}`);
  return `pair: SG nodes: ${shown.join('; ')}${sg.length > 10 ? `; and ${sg.length - 10} more` : ''}`;
}

// LEDDim Smart, the rotary dimmer: the first generation (@NDxxxx, the mesh id
// in the name) and, a trial in 2.5.0, the later generations (lib/sgProducts.js,
// ROTARY_PREFIXES), which need an FF11 answer for their mesh id.
class SGMeshDriver extends Homey.Driver {
  // The class of a device, before it starts (Athom: wireless/zigbee.md, and
  // Driver#onMapDeviceClass in the SDK reference: a temporary device, one
  // tick, nothing async). data.id cannot change after pairing: the @ND name of
  // a first generation dimmer, which every dimmer added before 2.5.0 has, or
  // the name of a later generation rotary dimmer. Anything else, and any
  // error, gets the first generation class, as before 2.5.0.
  onMapDeviceClass(device) {
    try {
      const id = String((device.getData() || {}).id || '');
      if (csrDriverFor(csrProductForName(id)) === 'sg_mesh') return SGCsrDevice;
    } catch (err) {
      // the first generation class
    }
    return SGMeshDevice;
  }

  // The guide, then Homey's loading view while this searches, and on to the
  // list, as in sg_pill (lib/csrPairing.js).
  async onPair(session) {
    pairInLoadingView(this, session, { search: () => this._search(), list: (result) => this._listFrom(result) });
  }

  // No dimmer found: the general advice, or, when no rotary dimmer was found
  // at all, a note on what was found instead (lib/csrPairing.js). All found
  // already added: an empty list, so Homey says itself that no new devices
  // were found, which reads better under its fixed heading than a text of
  // ours (Athom: devices-list.md, "when no devices are found, return an empty
  // array"). Homey filters out the added ones in the other lists itself.
  _listFrom({ devices, reason, note }) {
    if (reason === 'none') return { error: 'none', text: note || this.homey.__('pair.noDimmersFound') };
    if (reason === 'allAdded') return { devices: [], why: 'all added' };
    return { devices };
  }

  // One pairing search: the same scan, log lines and comparison with the
  // dimmers already added as before 2.4.0. Returns { devices, reason, note },
  // where reason is 'none' (no dimmer found), 'allAdded' or null (something
  // new), and note says what was found instead of a rotary dimmer, or is
  // empty.
  async _search() {
    const started = Date.now();
    let advertisements;
    try {
      advertisements = await this.homey.ble.discover();
    } catch (err) {
      this.error(`pair: scan failed after ${((Date.now() - started) / 1000).toFixed(1)} s: ${err.message || err}`);
      throw err;
    }
    const seconds = (Date.now() - started) / 1000;

    // A mesh node repeats its advertisement; keep the strongest sighting of each.
    const byName = new Map();
    for (const adv of advertisements) {
      const localName = String(adv.localName || '').trim().toUpperCase();
      if (!NODE_NAME.test(localName)) continue;
      if (adv.connectable === false) continue;

      const previous = byName.get(localName);
      if (!previous || Number(adv.rssi ?? -999) > Number(previous.rssi ?? -999)) {
        byName.set(localName, adv);
      }
    }

    const candidates = [...byName.entries()]
      .sort(([, a], [, b]) => Number(b.rssi ?? -999) - Number(a.rssi ?? -999));

    const addedIds = new Set(this.getDevices().map((device) => String((device.getData() || {}).id || '').toUpperCase()));
    const peripherals = scanPeripherals(advertisements);
    this.log(scanSummary(peripherals, advertisements, candidates, addedIds, seconds));
    this.log(sgNodesLine(peripherals));

    // Devices are listed as "LEDDim Smart 1A2B", from the name they
    // broadcast; the user renames them in Homey after pairing. data.id is that
    // stable broadcast identity, which is also what Homey uses to filter out
    // already-paired devices. A dimmer whose status has been heard brings its
    // location id; any other learns it from its first status (see
    // SGDeviceBase).
    const devices = candidates.map(([localName, adv]) => {
      const location = this.homey.app.locationFor ? this.homey.app.locationFor(meshIdFromName(localName)) : null;
      return {
        name: `LEDDim Smart ${localName.slice(3)}`,
        data: { id: localName },
        store: {
          peripheralUuid: adv.uuid,
          address: adv.address || '',
          localName,
          ...(location === null ? {} : { locationId: location }),
        },
      };
    });

    // The later generations: an FF10 only when the scan saw an SG name that
    // is not @ND, so a home with first generation dimmers only gets nothing
    // new on the radio.
    const later = laterFindings(advertisements, []).length ? await this._later(advertisements, addedIds) : [];
    devices.push(...later.filter((f) => f.state === 'add').map((f) => laterDevice(f)));
    // No rotary dimmer at all: what was found instead (lib/csrPairing.js).
    const note = candidates.length ? '' : foundNote(later, (key, tokens) => this.homey.__(key, tokens), 'sg_mesh');
    const dimmers = candidates.length + later.filter((f) => f.state === 'add' || f.state === 'added').length;

    if (!dimmers) return { devices, reason: 'none', note };
    if (devices.every((device) => addedIds.has(device.data.id))) return { devices, reason: 'allAdded', note };
    return { devices, reason: null, note };
  }

  // The SG products after the first generation that the scan and the FF11
  // answers show, each with its state, and one log line with counts and
  // prefixes only, as sg_pill logs it. FF10 has the same deadline as in
  // sg_pill (lib/csrPairing.js, laterNodes); when it does not get out, the
  // first generation dimmers are listed all the same.
  async _later(advertisements, addedIds) {
    const { nodes } = await laterNodes(this);
    const found = withStates(laterFindings(advertisements, nodes), 'sg_mesh', addedIds);
    const states = found.map((f) => `${f.product.prefix} ${f.product.generation} ${f.product.kind} ${f.state}`);
    this.log(`pair: ${nodes.length} FF11 answer(s), ${found.length} SG device(s) after Gen1: ${states.join('; ')}`);
    return found;
  }
}

module.exports = SGMeshDriver;
