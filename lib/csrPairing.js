'use strict';

const { NODE_NAME } = require('./csrmesh');
const { NAME_LISTEN_MS, NAME_REQUEST_MIN_MS, SEARCH_LISTEN_MS } = require('./CsrNetwork');
const { csrDriverFor, csrProductForName, shortUuid } = require('./sgProducts');

// Pairing in sg_mesh (the rotary dimmers) and sg_pill (the Pill family): the
// same views in both, and for SG's later CSRmesh products (2.5.0, a trial)
// the same findings. A search scans for their Bluetooth names and asks the
// mesh for names (FF10, lib/CsrNetwork.js): only an FF11 answer brings the
// mesh id, so only a product that has answered can be added.

// How long FF10 may take to get out when bridge.send has to connect first
// (lib/MeshBridge.js; test/csr.test.js checks the sum against its constants).
// One connect round is at most CONNECT_WINDOW_MS (20 s: a connect that
// answers and drops within 15 s, then RETRY_STRONG_AFTER_MS), a connect after
// the hang-up (CONNECT_AFTER_HANGUP_TIMEOUT_MS, 20 s) and GATT ready
// (MAX_READY_AGE_MS, 14 s): 54 s. A send makes two, on the cached
// advertisement and then in recovery, with find() and discover() between them
// (about 10 s each), after a status link has settled (about 3 s), and the
// write (about 1 s): 132 s. Past this FF10 is late. bridge.send may still go
// on, as it tries a command again until TX_GIVE_UP_MS (30 s) has passed.
const FF10_WITHIN_MS = 135 * 1000;
// Homey's scan takes about 10 s; it has no duration to set.
const SCAN_MS = 10 * 1000;
// The whole search: the scan, FF10, the listening and a margin. Past this the
// scan itself has hung, and the search has failed, so the loading view never
// waits for good.
const SEARCH_LIMIT_MS = SCAN_MS + FF10_WITHIN_MS + SEARCH_LISTEN_MS + 7 * 1000;

// search(), or an error once SEARCH_LIMIT_MS has passed.
function withinLimit(homey, search) {
  return new Promise((resolve, reject) => {
    const timer = homey.setTimeout(
      () => reject(new Error(`no result in ${SEARCH_LIMIT_MS / 1000} s`)), SEARCH_LIMIT_MS,
    );
    search().then(resolve, reject).finally(() => homey.clearTimeout(timer));
  });
}

// The pairing of both drivers: the guide (pair/guide.html), then Homey's
// loading view while search() runs, and always on to the list (Athom:
// the-basics/devices/pairing/system-views/loading.md). Errors go to the list,
// which shows them (devices-list.md): thrown from the loading view, one kept
// it spinning in the mobile app. The list is named, not nextView as in
// Athom's example: at home nextView went on from the guide, so the loading
// view came again, and the second nextView went nowhere, in both drivers
// (2.5.0 test, 2026-10-30; showView is in
// advanced/custom-views/custom-pairing-views.md, Back-end API). Each step is
// logged. list(result) is the driver's own list: { devices }, with why, a
// word for the log, when it is empty on purpose; or { error, text }, a word
// for the log and the one text the list shows.
// Each search lets the held link go and makes a status poll wait from before
// its scan (pauseForScan below), and they come back when the pairing is done:
// once the list has been answered, or when the pairing is closed, then after
// the search is over (its scan, and FF10 and the listening after it, which
// sg_pill always sends). A newer search takes its own pause before the older
// one ends, so nothing comes back between them. lib/MeshBridge.js ends a
// pause by itself after PAIRING_PAUSE_MAX_MS. Homey calls disconnect when the
// pairing is closed (Athom: the-basics/devices/pairing.md, shown there for
// repair; seen for pairing at home on 31.10).
function pairInLoadingView(driver, session, { search, list }) {
  let shown = null;
  let searching = null;
  let endPause = null; // ends the pause of the latest search
  const pairingDone = (why) => {
    const end = endPause;
    endPause = null;
    if (end) end(why);
  };
  const pausedSearch = () => withinLimit(driver.homey, async () => {
    const end = await pauseForScan(driver);
    if (endPause) endPause('a newer search');
    endPause = end;
    return search();
  });
  session.setHandler('showView', async (view) => {
    driver.log(`pair: showView ${view}`);
    shown = view;
    if (view !== 'loading') return;
    const current = pausedSearch();
    searching = current;
    await current.catch(() => {});
    if (searching !== current || shown !== 'loading') {
      driver.log(`pair: not to the list, ${searching !== current ? 'a newer search runs' : `${shown} shows`}`);
      return;
    }
    driver.log('pair: to the list');
    try {
      await session.showView('list_devices');
    } catch (err) {
      driver.error(`pair: to the list failed: ${err.message || err}`);
      throw err;
    }
    driver.log('pair: to the list done');
  });
  session.setHandler('list_devices', async () => {
    driver.log(`pair: list_devices${searching ? '' : ', no search yet'}`);
    try {
      const result = await (searching || pausedSearch()).catch((err) => {
        driver.error(`pair: search failed: ${err.message || err}`);
        driver.log('pair: list_devices: error failed');
        throw new Error(driver.homey.__('pair.csr.failed'));
      });
      const {
        devices, error, text, why,
      } = list(result);
      if (error) {
        driver.log(`pair: list_devices: error ${error}`);
        throw new Error(text);
      }
      driver.log(`pair: list_devices: ${devices.length} device(s)${why ? `, ${why}` : ''}`);
      return devices;
    } finally {
      pairingDone('list answered');
    }
  });
  session.setHandler('disconnect', async () => {
    driver.log(`pair: closed${endPause ? '' : ', nothing paused'}`);
    Promise.resolve(searching).catch(() => {}).then(() => pairingDone('pairing closed'));
  });
}

// FF10 within FF10_WITHIN_MS: 'out', 'late', or 'not out' when it was not
// delivered. CsrNetwork sends at most one in NAME_REQUEST_MIN_MS and then
// sends none; one that went out that recently on a link that listened counts
// as out ('recent'), as its answers are coming (read from CsrNetwork, which
// has no getter for it). One whose link did not listen brought no answers,
// so it does not count.
function nameRequestWithin(driver, csr) {
  const last = csr._lastListeningNameRequestAt;
  if (Number.isFinite(last) && Date.now() - last < NAME_REQUEST_MIN_MS) return Promise.resolve('recent');
  return new Promise((resolve) => {
    const timer = driver.homey.setTimeout(() => resolve('late'), FF10_WITHIN_MS);
    // Its link listens for the FF11 answers, also when it is not held.
    csr.requestNames({ asked: true, listenMs: NAME_LISTEN_MS }).then((sent) => resolve(sent ? 'out' : 'not out'), (err) => {
      driver.error(`pair: FF10 failed: ${err.message || err}`);
      resolve('not out');
    }).finally(() => driver.homey.clearTimeout(timer));
  });
}

// Before the scan of a pairing search, in both drivers: the held link is let
// go and a status poll waits (lib/MeshBridge.js, pauseForScan) until the
// pairing is done (pairInLoadingView). Returns the function that ends it,
// with why for the log; a no-op without a bridge that can pause.
async function pauseForScan(driver) {
  const bridge = driver.homey.app && driver.homey.app.bridge;
  if (!bridge || typeof bridge.pauseForScan !== 'function') return () => {};
  try {
    return await bridge.pauseForScan('pairing scan');
  } catch (err) {
    driver.error(`pair: could not let the link go before the scan: ${err.message || err}`);
    return () => {};
  }
}

// The FF11 answers for a search, after its scan, in both drivers: FF10, then
// SEARCH_LISTEN_MS of answers, as CsrNetwork.search, but FF10 has
// FF10_WITHIN_MS. Late or not out, there is no listening: the nodes heard
// before are what there is, and the log says why. { nodes, out }: every node
// heard since the app started, newest first, and whether FF10 got out.
async function laterNodes(driver) {
  const { csr } = driver.homey.app;
  const started = Date.now();
  const ff10 = await nameRequestWithin(driver, csr);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const out = ff10 === 'out' || ff10 === 'recent';
  if (ff10 === 'out') driver.log(`pair: FF10 out after ${seconds} s`);
  else if (ff10 === 'recent') driver.log(`pair: FF10 out less than ${NAME_REQUEST_MIN_MS / 1000} s ago, none now`);
  else if (ff10 === 'late') driver.error(`pair: FF10 not out in ${FF10_WITHIN_MS / 1000} s, no listening`);
  else driver.error(`pair: FF10 not delivered after ${seconds} s, no listening`);
  if (out) await new Promise((resolve) => driver.homey.setTimeout(resolve, SEARCH_LISTEN_MS));
  return { nodes: [...csr.nodes.values()].sort((a, b) => b.seenAt - a.seenAt), out };
}

// The 02FA service data of each SG node a scan saw, strongest first and
// numbered, as sg_mesh logs it, with no address: of the name only its first
// three characters (@ND, @SC and so on), which tell the products apart. For a
// first generation dimmer the data holds the home's location id; whether the
// later products send it is what the line is for. An SG node has an SG name
// or 02FA data; a node seen more than once counts once.
function sgNodesLine(advertisements) {
  const dataOf = (adv) => {
    const list = Array.isArray(adv.serviceData) ? adv.serviceData
      : Object.entries(adv.serviceData || {}).map(([uuid, data]) => ({ uuid, data }));
    const found = list.find((s) => shortUuid(s.uuid) === '02fa');
    if (!found) return null;
    if (typeof found.data === 'string') return found.data.toLowerCase().slice(0, 32);
    try { return Buffer.from(found.data || []).toString('hex').slice(0, 32); } catch (err) { return null; }
  };
  const nodes = new Map();
  for (const adv of advertisements) {
    const name = String(adv.localName || '').trim().toUpperCase();
    const sgName = NODE_NAME.test(name) || csrProductForName(name) ? name.slice(0, 3) : null;
    const data = dataOf(adv);
    const node = nodes.get(adv.uuid) || { name: null, data: null, rssi: -Infinity, connectable: false };
    node.name = node.name || sgName;
    node.data = node.data || data;
    node.connectable = node.connectable || adv.connectable !== false;
    const rssi = Number(adv.rssi);
    if (Number.isFinite(rssi) && rssi < 0) node.rssi = Math.max(node.rssi, rssi);
    nodes.set(adv.uuid, node);
  }
  const sg = [...nodes.values()].filter((n) => n.name || n.data)
    .sort((a, b) => (Number.isFinite(b.rssi) ? b.rssi : -999) - (Number.isFinite(a.rssi) ? a.rssi : -999));
  if (!sg.length) return 'pair: SG nodes: none';
  const shown = sg.slice(0, 10).map((n, i) => `${i + 1}: 02FA ${n.data || '-'}, `
    + `${Number.isFinite(n.rssi) ? `${n.rssi} dB` : 'no signal'}, `
    + `${n.connectable ? (n.name || 'no name') : 'not connectable'}`);
  return `pair: SG nodes: ${shown.join('; ')}${sg.length > 10 ? `; and ${sg.length - 10} more` : ''}`;
}

// Every SG product a search found, by name: from the scan, from the FF11
// answers, or both. A node without a known product is left out.
function laterFindings(advertisements, nodes) {
  const byName = new Map();
  for (const adv of advertisements) {
    const name = String(adv.localName || '').trim().toUpperCase();
    const product = csrProductForName(name);
    if (product) byName.set(name, { name, product, rssi: adv.rssi });
  }
  for (const node of nodes) {
    if (!node.product) continue;
    byName.set(node.name, { ...byName.get(node.name), name: node.name, product: node.product, node });
  }
  return [...byName.values()];
}

// Each finding with its state for the driver driverId: add, added, noAnswer
// (no FF11, so no mesh id), elsewhere (the other driver adds it, f.driver) or
// notYet (no driver adds it in this version).
function withStates(found, driverId, addedIds) {
  return found.map((f) => {
    const driver = csrDriverFor(f.product);
    let state = 'add';
    if (driver !== driverId) state = driver ? 'elsewhere' : 'notYet';
    else if (!f.node) state = 'noAnswer';
    else if (addedIds.has(f.name)) state = 'added';
    return { ...f, driver, state };
  });
}

// The device to add, named like "LEDDim Smart Pill 1A2B": the generation is
// only in the log. It is a light, the driver's class; a product without
// dimming has onoff alone.
function laterDevice(f, { icons = false } = {}) {
  return {
    name: `${f.product.name} ${f.name.slice(3)}`,
    data: { id: f.name },
    capabilities: f.product.kind === 'onoff' ? ['onoff'] : ['onoff', 'dim'],
    // Relative to /drivers/<driver id>/assets/ (Athom: the-basics/devices/pairing.md).
    ...(icons && f.product.icon ? { icon: `/icons/${f.product.icon}.svg` } : {}),
    store: {
      meshId: f.node.meshId,
      prefix: f.product.prefix,
      kind: f.product.kind,
      tunableWhite: f.product.tunableWhite,
      ...(f.node.location ? { locationId: f.node.location } : {}),
    },
  };
}

// What a driver says when it found nothing of its own: that, and the
// products the other driver adds, with what to do ("No Pill found, but found
// LEDDim Smart. Go back and choose ..."), or only that.
const NOTHING_OF_OURS = {
  sg_mesh: { none: 'pair.found.noDimmer', other: 'pair.found.noDimmerButPill' },
  sg_pill: { none: 'pair.found.noPill', other: 'pair.found.noPillButDimmer' },
};

// What the list says when the search found nothing that driverId adds, not
// even one without an answer: the products found that the other driver adds,
// then those that cannot be added yet, by product name only. Empty when it
// found something of its own, or nothing at all. __ is Homey's translation,
// with tokens.
function foundNote(found, __, driverId) {
  if (found.some((f) => f.driver === driverId)) return '';
  const products = (list) => [...new Set(list.map((f) => f.product.name))].join(', ');
  const elsewhere = found.filter((f) => f.state === 'elsewhere');
  const notYet = found.filter((f) => f.state === 'notYet');
  const sentences = [];
  if (elsewhere.length) sentences.push(__(NOTHING_OF_OURS[driverId].other, { products: products(elsewhere) }));
  else if (notYet.length) sentences.push(__(NOTHING_OF_OURS[driverId].none));
  if (notYet.length) sentences.push(__('pair.found.notYet', { products: products(notYet) }));
  return sentences.join(' ');
}

module.exports = {
  FF10_WITHIN_MS, SCAN_MS, SEARCH_LIMIT_MS,
  foundNote, laterDevice, laterFindings, laterNodes, pairInLoadingView, sgNodesLine, withStates,
};
