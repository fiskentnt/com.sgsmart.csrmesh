'use strict';

const { NODE_NAME } = require('./csrmesh');
const { lastFour } = require('./lastFour');
const {
  DIRECT_MAX, NAME_LISTEN_MS, NAME_REQUEST_MIN_MS, SEARCH_LISTEN_MS,
} = require('./CsrNetwork');
const {
  RECALLED_PREFIXES, TYPE_PREFIXES, csrDriverFor, csrProductForName, csrProductForType, driverForType, familyForType,
  shortUuid,
} = require('./sgProducts');
const { cleanName } = require('./account');

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
// With fake devices (lib/fakeDevices.js, only in a run with `homey app run`)
// the fake network is searched at the same time, and its devices for this
// driver come after the list (withFakes), also when the search itself fails.
function pairInLoadingView(driver, session, { search, list }) {
  let shown = null;
  let searching = null;
  let endPause = null; // ends the pause of the latest search
  const fakes = driver.homey.app && driver.homey.app.fakes;
  const pairingDone = (why) => {
    const end = endPause;
    endPause = null;
    if (end) end(why);
  };
  const realSearch = () => withinLimit(driver.homey, async () => {
    const end = await pauseForScan(driver);
    if (endPause) endPause('a newer search');
    endPause = end;
    return search();
  });
  const pausedSearch = () => {
    if (!fakes) return realSearch();
    const fakeSearch = fakes.search(driver).catch((err) => {
      driver.error(`pair: fake search failed: ${err.message || err}`);
      return [];
    });
    const real = realSearch().then((result) => ({ result }), (err) => ({ err }));
    return Promise.all([real, fakeSearch]).then(([{ result, err }, fakeDevices]) => {
      if (!err) return { ...result, fakeDevices };
      if (!fakeDevices.length) throw err;
      driver.error(`pair: search failed: ${err.message || err}`);
      return { searchFailed: true, fakeDevices };
    });
  };
  // The guide asks which text its point 4 has (pair/guide.html).
  session.setHandler('account', async () => guidePoint(driver));
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
      const listed = result && result.searchFailed
        ? { error: 'search failed', text: driver.homey.__('pair.csr.failed') } : list(result);
      const {
        devices, error, text, why,
      } = result && result.fakeDevices ? withFakes(listed, result.fakeDevices) : listed;
      // Devices of the SG account for this driver that did not answer
      // (quietInAccount): counted when there is nothing to add, as Homey's
      // list has no room for a text next to the devices; counted in the log.
      const quiet = result && Array.isArray(result.quiet) ? result.quiet : [];
      const quietHeard = result && Number.isInteger(result.quietHeard) ? result.quietHeard : 0;
      if (quiet.length) driver.log(`pair: ${quiet.length} device(s) in the SG account did not answer`);
      if (quiet.length && (error || devices.length === 0)) {
        const said = quietText(driver, quiet.length, quietHeard, error ? text : '');
        driver.log(`pair: list_devices: error ${error || 'none to add'}, and the SG account's that did not answer`);
        throw new Error(error ? `${text} ${said}` : said);
      }
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

// A driver's list with the fake devices after it. A list that has none of
// its own (an error, with the text it would show) shows them alone; why
// says so for the log.
function withFakes(listed, fakeDevices) {
  if (!fakeDevices.length) return listed;
  const own = listed.error ? [] : listed.devices;
  const instead = listed.error ? `, in place of: ${listed.error}` : '';
  return { devices: [...own, ...fakeDevices], why: `${fakeDevices.length} fake${instead}${listed.why ? `, ${listed.why}` : ''}` };
}

// FF10 within FF10_WITHIN_MS: 'out', 'late', or 'not out' when it was not
// delivered. CsrNetwork sends at most one in NAME_REQUEST_MIN_MS and then
// sends none; one that went out that recently on a link that listened counts
// as out ('recent'), as its answers are coming (read from CsrNetwork, which
// has no getter for it). One whose link did not listen brought no answers,
// so it does not count.
function nameRequestWithin(driver, csr, driverId) {
  const last = csr._lastListeningNameRequestAt;
  if (Number.isFinite(last) && Date.now() - last < NAME_REQUEST_MIN_MS) return Promise.resolve('recent');
  return new Promise((resolve) => {
    const timer = driver.homey.setTimeout(() => resolve('late'), FF10_WITHIN_MS);
    // Its link listens for the FF11 answers, also when it is not held.
    csr.requestNames({
      asked: true, listenMs: NAME_LISTEN_MS, direct: true, forDriver: driverId,
    }).then((sent) => resolve(sent ? 'out' : 'not out'), (err) => {
      driver.error(`pair: FF10 failed: ${err.message || err}`);
      resolve('not out');
    }).finally(() => driver.homey.clearTimeout(timer));
  });
}

// The guide's point 4 (pair/guide.html), as { fetched, password }: the key
// under pair.guide, the same in the four drivers that search. With the
// account module and an account fetched: fetch again after new devices
// (fetchAgain). Otherwise where the password can come from while none is
// fetched (passwordAccount), and 1234 (password) with one fetched but no
// module.
function guidePoint(driver) {
  const account = driver.homey.app && driver.homey.app.account;
  const fetched = !!(account && account.fetched());
  const available = !!(account && typeof account.available === 'function' && account.available());
  if (available && fetched) return { fetched, password: 'fetchAgain' };
  return { fetched, password: fetched ? 'password' : 'passwordAccount' };
}

// Before the scan of a pairing search, in both drivers: the held link is let
// go and a status poll waits (lib/MeshBridge.js, pauseForScan) until the
// pairing is done (pairInLoadingView). A held SG Smart 3.0 link is let go
// too (app.js, sg3PauseForScan): its dimmers come from the SG account, but
// a held link may make the scan miss other devices, as a held first
// generation link did. Returns the function that ends them, with why for
// the log; a no-op without anything that can pause.
async function pauseForScan(driver) {
  const app = driver.homey.app;
  const ends = [];
  const bridge = app && app.bridge;
  if (bridge && typeof bridge.pauseForScan === 'function') {
    try {
      ends.push(await bridge.pauseForScan('pairing scan'));
    } catch (err) {
      driver.error(`pair: could not let the link go before the scan: ${err.message || err}`);
    }
  }
  if (app && typeof app.sg3PauseForScan === 'function') {
    try {
      const end = await app.sg3PauseForScan('pairing scan');
      if (typeof end === 'function') ends.push(end);
    } catch (err) {
      driver.error(`pair: could not let the SG Smart 3.0 link go before the scan: ${err.message || err}`);
    }
  }
  return (why) => {
    for (const end of ends) end(why);
  };
}

// The FF11 answers for a search, after its scan, in both drivers: FF10, then
// SEARCH_LISTEN_MS of answers, as CsrNetwork.search, but FF10 has
// FF10_WITHIN_MS. Late or not out, there is no listening: the nodes heard
// before are what there is, and the log says why. { nodes, out }: every node
// heard since the app started, newest first, and whether FF10 got out. The
// FF10 to one device at a time goes to driverId's devices in the SG account
// and to the devices heard (CsrNetwork.requestNames, forDriver).
async function laterNodes(driver, driverId) {
  const { csr } = driver.homey.app;
  const started = Date.now();
  const ff10 = await nameRequestWithin(driver, csr, driverId);
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
// three characters (@ND, @SC and so on), which tell the products apart, and
// of the data only its last four characters (lastFour), so nothing in it
// that could name a node goes to the log. The location id a first
// generation dimmer has in it is in the log's other lines. An SG node has an
// SG name or 02FA data; a node seen more than once counts once.
function sgNodesLine(advertisements) {
  const dataOf = (adv) => {
    const list = Array.isArray(adv.serviceData) ? adv.serviceData
      : Object.entries(adv.serviceData || {}).map(([uuid, data]) => ({ uuid, data }));
    const found = list.find((s) => shortUuid(s.uuid) === '02fa');
    if (!found) return null;
    if (typeof found.data === 'string') return found.data.toLowerCase();
    try { return Buffer.from(found.data || []).toString('hex'); } catch (err) { return null; }
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
  const shown = sg.slice(0, 10).map((n, i) => `${i + 1}: 02FA ${n.data ? lastFour(n.data) : '-'}, `
    + `${Number.isFinite(n.rssi) ? `${n.rssi} dB` : 'no signal'}, `
    + `${n.connectable ? (n.name || 'no name') : 'not connectable'}`);
  return `pair: SG nodes: ${shown.join('; ')}${sg.length > 10 ? `; and ${sg.length - 10} more` : ''}`;
}

// Every SG product a search found, by name: from the scan, from the FF11
// answers, or both. A node without a known product is left out, unless
// typeFor (accountFindings) gives its type in the SG account and the type
// a product: then it is taken as that product.
function laterFindings(advertisements, nodes, typeFor = () => null) {
  const byName = new Map();
  for (const adv of advertisements) {
    const name = String(adv.localName || '').trim().toUpperCase();
    const product = csrProductForName(name);
    if (product) {
      byName.set(name, {
        name, product, rssi: adv.rssi, scanned: true,
      });
    }
  }
  for (const node of nodes) {
    const product = node.product || csrProductForType(typeFor(node.meshId));
    if (!product) continue;
    byName.set(node.name, {
      ...byName.get(node.name), name: node.name, product, node, ...(node.product ? {} : { byType: true }),
    });
  }
  return [...byName.values()];
}

const hex4 = (value) => `0x${value.toString(16).padStart(4, '0')}`;

// One line per search: how the FF11 answers meet the names the scan saw, as
// laterFindings has put them together. Counts only, no name or id.
function ff11CountLine(found) {
  const answers = found.filter((f) => f.node);
  const inScan = answers.filter((f) => f.scanned).length;
  const scanOnly = found.filter((f) => !f.node && f.scanned).length;
  return `pair: FF11 answers ${answers.length}, ${inScan} of them in the scan; ${scanOnly} name(s) in the scan without FF11`;
}

// What a type in the SG account is, for the log.
function typeText(type) {
  const family = familyForType(type);
  if (family === 'gen1') return 'first generation';
  if (family === 'sg3') return 'SG Smart 3.0';
  const product = csrProductForType(type);
  return product ? `${product.name} ${product.generation}` : 'not known here';
}

// A log line for each node whose type in the SG account (typeFor) is not the
// product its prefix says. The prefix decides; the line says so.
function typeDisagreements(nodes, typeFor) {
  const lines = [];
  for (const node of nodes) {
    const type = typeFor(node.meshId);
    if (!node.product || type === null || type === undefined) continue;
    const byType = csrProductForType(type);
    if (byType && byType.name === node.product.name && byType.generation === node.product.generation) continue;
    lines.push(`pair: ${hex4(node.meshId)} ${node.product.prefix} is ${node.product.name} ${node.product.generation} by its name, `
      + `type ${type} (${typeText(type)}) in the SG account; the name decides`);
  }
  return lines;
}

// The findings of a search with the SG account (lib/account.js), when
// one is fetched: laterFindings with each node's type, and the disagreements
// in the log.
function accountFindings(driver, advertisements, nodes) {
  const account = driver.homey.app && driver.homey.app.account;
  const typeFor = account && account.fetched() ? (meshId) => account.typeFor(meshId) : () => null;
  for (const line of typeDisagreements(nodes, typeFor)) driver.log(line);
  return laterFindings(advertisements, nodes, typeFor);
}

// device with the name its mesh id has in the SG account (lib/account.js,
// nameFor) when there is one, else device as it is: also without an account,
// when the mesh id is in more than one home, or when anything fails, so the
// name never stops a pairing. The log says that a name was taken, by mesh
// id, never the name.
function named(driver, device, meshId) {
  try {
    const account = driver.homey.app && driver.homey.app.account;
    if (!account || !account.fetched() || !Number.isInteger(meshId)) return device;
    const name = cleanName(account.nameFor(meshId));
    if (!name) return device;
    driver.log(`pair: ${hex4(meshId)} named as in the SG account`);
    return { ...device, name };
  } catch (err) {
    try {
      driver.error(`pair: no name from the SG account (${(err && err.name) || 'error'})`);
    } catch (logErr) { /* the name never stops a pairing */ }
    return device;
  }
}

// The pairing text for count devices of the SG account that did not answer,
// heard of them heard in the mesh since the app started (quietHeardCount):
// how many, not their names. With some not heard, how many Homey has not
// found yet, and "try again closer"; with none heard, "try again closer"
// alone; with all heard, search again. "Try again closer" is left out when
// the text before already says it (as "No dimmers found" does). Over
// DIRECT_MAX, a search asks only some of them directly, so the text says the
// next search tries the next ones. The app's texts are in English and
// Norwegian.
const SAYS_CLOSER = /try again closer|prøv igjen nærmere/i;
function quietText(driver, count, heard = 0, before = '') {
  const { __ } = driver.homey;
  const one = count === 1;
  const notFound = count - Math.min(Math.max(heard, 0), count);
  const closer = !SAYS_CLOSER.test(before);
  const said = [one ? __('pair.account.quietOne') : __('pair.account.quietMany', { count })];
  if (notFound === 0) {
    if (count <= DIRECT_MAX) said.push(__('pair.account.searchAgain'));
  } else if (notFound < count) {
    said.push(__('pair.account.notFound', { count: notFound }));
    if (closer) said.push(__('pair.account.closerMany'));
  } else if (closer) {
    said.push(__(one ? 'pair.account.closerOne' : 'pair.account.closerMany'));
  }
  if (count > DIRECT_MAX) said.push(__('pair.account.next'));
  return said.join(' ');
}

// The devices of the SG account that the driver driverId adds by their
// type, but that have not answered: no FF11 from their mesh id since the
// app started, and not in heard (the first generation dimmers a scan saw),
// and not added here. A recalled plug is left out, and so is an uncertain
// device (lib/account.js): its id does not say which one it is. Each with
// its product and address; the pairing text counts them (quietText). As
// { meshId, text } here, and as the texts alone in quietInAccount.
function quietDevices(driver, driverId, heard = []) {
  const { app } = driver.homey;
  const account = app && app.account;
  if (!account || !account.fetched()) return [];
  const answered = new Set([...heard, ...(app.csr && app.csr.nodes ? app.csr.nodes.keys() : [])]);
  for (const device of app._devices()) {
    if (typeof device.getCsrMeshId === 'function') answered.add(device.getCsrMeshId());
    else if (typeof device.getMeshId === 'function') answered.add(device.getMeshId());
  }
  const named = new Map();
  for (const device of account.devices()) {
    if (device.certain === false || driverForType(device.type) !== driverId || answered.has(device.meshId)) continue;
    if (RECALLED_PREFIXES.includes(TYPE_PREFIXES[device.type])) continue;
    const product = familyForType(device.type) === 'gen1' ? 'LEDDim Smart' : csrProductForType(device.type).name;
    const address = device.meshId.toString(16).toUpperCase().padStart(4, '0');
    named.set(device.meshId, { meshId: device.meshId, text: driver.homey.__('pair.account.device', { product, address }) });
  }
  return [...named.values()];
}

function quietInAccount(driver, driverId, heard = []) {
  return quietDevices(driver, driverId, heard).map((device) => device.text);
}

// How many of quietInAccount's devices were heard in the mesh since the app
// started, with any frame (app.heardSinceStart).
function quietHeardCount(driver, driverId, heard = []) {
  const { app } = driver.homey;
  return quietDevices(driver, driverId, heard).filter((device) => app.heardSinceStart(device.meshId)).length;
}

// For the pairing line, counts only: how many findings did not answer FF10
// (noAnswer), and of the SG account's devices for driverId that did not
// answer (quietDevices, with heard as there), how many were heard in the
// mesh since the app started, with any frame (app.heardSinceStart). A
// noAnswer finding has only its Bluetooth name and a frame only a mesh id, so
// without the SG account the second is not known. '' when there is nothing.
function noAnswerText(driver, driverId, found, heard = []) {
  const noAnswer = found.filter((f) => f.state === 'noAnswer').length;
  const { app } = driver.homey;
  const account = app && app.account;
  if (!account || !account.fetched()) return noAnswer ? ` (noAnswer ${noAnswer}; heard: not known without the SG account)` : '';
  const quiet = quietDevices(driver, driverId, heard);
  if (!noAnswer && !quiet.length) return '';
  const heardCount = quietHeardCount(driver, driverId, heard);
  return ` (noAnswer ${noAnswer}; ${heardCount} of the SG account's ${quiet.length} that did not answer heard in the mesh since the start)`;
}

// The text for a list with nothing to add when the scan saw devices of
// driverId that did not answer FF10 (noAnswer), the SG account module is in
// this build and no account is fetched: they may not know the network
// password, and the login in the app settings fetches it
// (pair.csr.noAnswerLogin). Else null: with an account fetched, or without
// the module, the list is as before.
function loginHint(driver, found, driverId) {
  const account = driver.homey.app && driver.homey.app.account;
  if (!account || typeof account.available !== 'function' || !account.available() || account.fetched()) return null;
  if (!found.some((f) => f.driver === driverId && f.state === 'noAnswer')) return null;
  return driver.homey.__('pair.csr.noAnswerLogin');
}

// Each finding with its state for the driver driverId: add, added, noAnswer
// (no FF11, so no mesh id), elsewhere (the other driver adds it, f.driver),
// notYet (no driver adds it in this version) or recalled (no driver adds it,
// RECALLED_PREFIXES).
function withStates(found, driverId, addedIds) {
  return found.map((f) => {
    const driver = csrDriverFor(f.product);
    let state = 'add';
    if (RECALLED_PREFIXES.includes(f.product.prefix)) state = 'recalled';
    else if (driver !== driverId) state = driver ? 'elsewhere' : 'notYet';
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

// A thermostat to add, named like "HeatReg Smart 1A2B", with the
// capabilities its driver gives it.
function thermostatDevice(f) {
  return {
    name: `${f.product.name} ${f.name.slice(3)}`,
    data: { id: f.name },
    store: {
      meshId: f.node.meshId,
      prefix: f.product.prefix,
      kind: f.product.kind,
      ...(f.node.location ? { locationId: f.node.location } : {}),
    },
  };
}

// What a driver says when it found nothing of its own: that, and the
// products another driver adds, with what to do. sg_mesh and sg_pill say it
// in one sentence when the other of the two adds them all ("No LEDDim Smart
// Pill found, but found LEDDim Smart. Go back and select ..."); otherwise
// "none" comes first, then one sentence for each driver that adds some of
// them (GO_TO).
const NOTHING_OF_OURS = {
  sg_mesh: { none: 'pair.found.noDimmer', other: 'pair.found.noDimmerButPill', otherDriver: 'sg_pill' },
  sg_pill: { none: 'pair.found.noPill', other: 'pair.found.noPillButDimmer', otherDriver: 'sg_mesh' },
  sg_din: { none: 'pair.found.noDin' },
  sg_plug: { none: 'pair.found.noPlug' },
  sg_thermostat: { none: 'pair.found.noThermostat' },
};
const GO_TO = {
  sg_mesh: 'pair.found.goToDimmer',
  sg_pill: 'pair.found.goToPill',
  sg_din: 'pair.found.goToDin',
  sg_plug: 'pair.found.goToPlug',
  sg_thermostat: 'pair.found.goToThermostat',
};

// What the list says when the search found nothing that driverId adds, not
// even one without an answer: the products found that other drivers add,
// then those that cannot be added yet, by product name only, then that a
// recalled one is recalled and cannot be added (pair.found.recalled).
// "None found" is left out when driverId would have added the recalled one.
// Empty when it found something of its own, or nothing at all. Homey's list
// shows only devices that can be added, or a text instead
// (devices-list.md), so a recalled one found next to one that can be added
// is only in the log. __ is Homey's translation, with tokens.
function foundNote(found, __, driverId) {
  if (found.some((f) => f.driver === driverId && f.state !== 'recalled')) return '';
  const products = (list) => [...new Set(list.map((f) => f.product.name))].join(', ');
  const elsewhere = found.filter((f) => f.state === 'elsewhere');
  const notYet = found.filter((f) => f.state === 'notYet');
  const recalled = found.filter((f) => f.state === 'recalled');
  const own = NOTHING_OF_OURS[driverId];
  const drivers = [...new Set(elsewhere.map((f) => f.driver))];
  const sentences = [];
  if (drivers.length === 1 && drivers[0] === own.otherDriver) {
    sentences.push(__(own.other, { products: products(elsewhere) }));
  } else if (elsewhere.length || notYet.length || recalled.length) {
    if (!recalled.some((f) => f.driver === driverId)) sentences.push(__(own.none));
    for (const driver of drivers) {
      sentences.push(__(GO_TO[driver], { products: products(elsewhere.filter((f) => f.driver === driver)) }));
    }
  }
  if (notYet.length) sentences.push(__('pair.found.notYet', { products: products(notYet) }));
  if (recalled.length) sentences.push(__('pair.found.recalled'));
  return sentences.join(' ');
}

module.exports = {
  FF10_WITHIN_MS, SCAN_MS, SEARCH_LIMIT_MS,
  accountFindings, ff11CountLine, foundNote, guidePoint, laterDevice, laterFindings, laterNodes, loginHint, named, noAnswerText, pairInLoadingView,
  pauseForScan, quietHeardCount, quietInAccount,
  sgNodesLine, thermostatDevice, typeDisagreements, withStates,
};
