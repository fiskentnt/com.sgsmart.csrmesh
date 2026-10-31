'use strict';

const {
  decryptPayload, makePacket, NODE_NAME, verifyPacket,
} = require('./csrmesh');
const {
  ADDR_DEVICES, MCP_DATA_BLOCK, OP_DATA_HEARTBEAT, addrBytes, parseGen1Status,
} = require('./sgProtocol');
const { canBeBridge, isCsrmeshAdvertisement } = require('./sgProducts');

const SERVICE_UUID = '0000fef100001000800000805f9b34fb';
const CHAR_8003 = 'c4edc0009daf11e3800300025b000b00';
const CHAR_8004 = 'c4edc0009daf11e3800400025b000b00';

const CONNECT_WINDOW_MS = 20000;
const CONNECT_TIMEOUT_MS = 12000; // hard cap on a single adv.connect() so a hung connect can't wedge recovery
// Right after a dimmer hung up, Homey 13.5.2 took 16 s for one connect and gave
// up on another after 30 s, while one made half a minute later took 2-5 s. In
// the first minute after a hang-up a connect may take this long.
const CONNECT_AFTER_HANGUP_TIMEOUT_MS = 20000;
const AFTER_HANGUP_WINDOW_MS = 60000;
const RETRY_DELAY_MS = 1200;
const POST_CONNECT_DELAY_MS = 250;
// Keep a successfully prepared GATT link alive very briefly after the desired
// queue drains. Homey capability updates often arrive a few hundred ms apart;
// this lets them share the same SG connection without a full disconnect/reconnect.
// This is NOT a heartbeat or persistent BLE connection.
const TX_IDLE_LINGER_MS = 400;
const LOW_HIGH_GAP_MS = 25;
// How CSRmesh writes a packet over GATT: one this long or shorter to 8004
// alone; a longer one, its first this many bytes to 8003 and the rest to
// 8004, which ends it. A short packet written to 8003 alone never got through
// (FF10, FF04 and the group get are 20 bytes; A0 and the heartbeat are 27).
const GATT_PART_MAX = 20;
// SG Gen1 often drops the GATT link around 9.5–10 s after connect.
// Never START another packet once the current link is this old.
const MAX_TX_CONN_AGE_MS = 7000;
// A connection that only becomes GATT-ready this late is already in the danger
// zone. Never start user payload on it; recycle it before writing byte one.
const MAX_READY_AGE_MS = 14000; // this radio's getService legitimately takes 6-8s; don't reject slow-but-successful links
const GLOBAL_RECOVERY_COOLDOWN_MS = 5000;
// Without a held link, status polling is how Homey learns about changes made
// at the wall switch. The poll subscribes to 8003/8004, and so does a link
// for a request that wants an answer (listenMs); a link for commands does
// not. Each poll is a short connect/listen/disconnect cycle, but one in flight
// delays a concurrent command, and the mesh notifications it takes in
// measurably slow GATT discovery (median 1432ms quiet vs 1921ms under load).
// Five minutes keeps the tiles converging without crowding interactive use.
const STATUS_POLL_MS = 300000;
// How long each link that listens is checked for a wrong network password,
// and how many such links, and failed frames in all, it takes before the
// dimmers show a warning (see _startKeyCheck).
const KEY_CHECK_MS = 30000;
const KEY_CHECK_LINKS = 2;
const KEY_CHECK_FAILURES = 3;
// One recovery round for the whole desired-TX queue. If it fails, retain only
// the latest desired values and leave BLE alone for 5 seconds before the
// worker tries again. Do not let each queued device start its own recovery.
const RECOVERY_DISCOVER_ATTEMPTS = 1;
// A BleAdvertisement is a snapshot from one scan, but connect() only hands its
// uuid to Homey: on Homey Pro (2026), 13.5.1, advertisements up to 226 s old
// connected every time. Keep them a little longer than the 5-minute status
// poll that refreshes them, so a command never has to wait for a find() scan
// (about 10 s).
const ADV_CACHE_TTL_MS = 360000;
// While the best node still answers, a node this much weaker is not worth a
// try: right after the strong node hung up, a weak one connected slowly or
// not at all, with the radio tied up for 12 s.
const WEAK_FALLBACK_DB = 10;
// A node that answered the connect but then dropped the link gets one more try
// after this pause, before any other node.
const RETRY_STRONG_AFTER_MS = 5000;
// A command that cannot be written is tried again on a new link until it is
// delivered, a newer value replaces it, or this much time has passed.
const TX_GIVE_UP_MS = 30000;
// A dimmer hangs up about ten seconds after the start of the last heartbeat; a
// command does not count. This app sends one every three seconds, counted
// from the previous one and never skipped; one may wait for the command being
// written, which has taken up to 5 s.
const HEARTBEAT_MS = 3000;
// Signal strength (RSSI) comes only from scans the app makes anyway, never a
// scan for signal alone: with "Keep dimmers connected" from the hourly scan,
// which also sees the linked bridge; without it, from a fresh find() or
// discover() before a connect. Not from cached advertisements, whose RSSI can
// be hours old. updateRssi() is not used: Homey 13.5.2 answers it with
// "Invalid Event: updateRssi".
// Without "Keep dimmers connected": after a command the link is held this long,
// so the next command skips the connect that otherwise costs seconds.
const KEEP_ALIVE_MS = 60000;
// With "Keep dimmers connected": the link to the bridge is held all the time,
// with notifications on, so status from the wall switch arrives at once and
// no status poll is needed.
const HELD_LINK_RETRY_MS = [1000, 5000, 10000, 30000];
// setTimeout-safe stand-in for "for as long as the link is wanted".
const HELD_LINK_MS = 3600000;
// One scan an hour while the link is held keeps the choice of bridge and the
// cached advertisements fresh. A scan does not break the held link.
const HELD_LINK_RESCAN_MS = 3600000;
const HELD_LINK_SUMMARY_MS = 60000;
// Decoding the notifications may cost this much per minute. Above it the app
// gives up the held link until it is restarted, as a guard for Homey's CPU.
const HELD_LINK_DECODE_LIMIT_MS = 5000;
// A pairing pause (pauseForScan) ends by itself after this long, so the held
// link and the status poll always come back: the longest pairing search
// (lib/csrPairing.js, SEARCH_LIMIT_MS, 160 s) and 20 s for the list.
const PAIRING_PAUSE_MAX_MS = 180000;

class MeshBridge {
  constructor(app) {
    this.app = app;
    this.homey = app.homey;
    this._peripheral = null;
    this._connecting = null;
    this._char8003 = null;
    this._char8004 = null;
    this._notifySubscribed = false;
    // Until when a link that sent a request must stay to hear the answer.
    this._listenUntil = 0;
    // Every characteristic we hold a live notification subscription on. Homey
    // requires unsubscribeFromNotifications() before disconnecting, and it
    // throws once the peripheral is gone, so we unsubscribe pro-actively.
    this._subscribedChars = [];
    this._notifyGeneration = 0;
    // Teardown in flight. A new connect must never start while the radio is
    // still being released, or Homey ends up with two overlapping links.
    this._disconnecting = null;
    this._shuttingDown = false;
    this._lastRxHex = null;
    this._lastRxAt = 0;
    this._disconnectTimer = null;
    this._disconnectPeripheral = null;
    this._disconnectListener = null;
    this._queue = Promise.resolve();
    // Restore automatic bridge selection. Keep the last good RSSI-selected node
    // across restarts, but allow _candidates() to move to another SG node when
    // it is clearly stronger (8 dB hysteresis).
    this._preferredUuid = this.homey.settings.get('bridgeUuid') || null;
    // Keep the actual advertisement objects from the last BLE scan. Homey's
    // discover() scan can take ~10s; user TX should not pay that cost again
    // when we already have a recently seen preferred SG node.
    this._advCache = new Map();
    // Last @NDxxxx name seen per peripheral; see _nodeNameFor().
    this._nameByUuid = new Map();
    // Last name seen per peripheral that may be a bridge; see _bridgeNameFor().
    this._bridgeNameByUuid = new Map();

    this._connNo = 0;
    this._connStartedAt = 0;
    this._sendNo = 0;
    this._stage = 'idle';
    this._bridgeLocalName = null;
    this._bridgeNodeId = null;
    // Commands always have priority over background status polling.
    // _txPending includes queued + active user commands.
    this._txPending = 0;
    this._statusGeneration = 0;
    this._connectingPurpose = null;
    // Background status is best-effort. Keep it away from interactive TX.
    this._lastTxAt = 0;
    // Only one preferred-bridge recovery may run at a time. Any callers that
    // arrive while it is running await the same promise instead of starting
    // their own discovery/reconnect cascade.
    this._txRecoveryPromise = null;
    this._txRecoveryCooldownUntil = 0;
    this._txRecoveryCooldownPromise = null;
    // App-wide latest-wins generations. Queued commands for the same logical
    // target become stale as soon as a newer target arrives.
    this._latestTxGeneration = new Map();
    // Latest-wins scheduler. There is at most one pending payload per logical
    // target (sofa/spisebord/group). A failed BLE attempt does not explode into
    // a chain of rejected queued commands; the newest desired value remains
    // pending and the worker retries it after a short cooldown.
    this._desiredTx = new Map();
    this._txWorkerPromise = null;
    // Keep-alive: when the last user command was sent, and the heartbeat timer.
    this._lastUserTxAt = 0;
    this._heartbeatTimer = null;
    this._heartbeats = 0;
    this._heartbeatChain = null;
    // Commands and heartbeats are written one packet at a time, in the order
    // they ask: a heartbeat due while a command is being written goes right
    // after it, before the next command.
    this._writeLane = Promise.resolve();
    // "Keep dimmers connected": the held link and its bookkeeping.
    this._held = false;
    this._heldGaveUp = false;
    this._heldTimer = null;
    this._heldRescanTimer = null;
    this._heldSummaryTimer = null;
    this._heldFailures = 0;
    this._heldUpAt = 0;
    this._heldDownAt = 0;
    this._heldUpMs = 0;
    this._heldWindowAt = 0;
    this._heldLinks = 0;
    this._heldDrops = 0;
    this._heartbeatsTotal = 0;
    this._decodeCalls = 0;
    this._decodeMs = 0;
    this._rxMacFailures = 0;
    // Last status logged per mesh id, so a held link logs changes only.
    this._loggedLevel = new Map();
    // Whether status can be read at all: links that heard only frames that
    // failed the check, and those frames (see _startKeyCheck).
    this._keyCheckTimer = null;
    this._keyCheckDone = false;
    this._keyCheckLinks = 0;
    this._keyCheckFailures = 0;
    this._keyCheckLinkFailures = 0;
    // Pairing pauses running (pauseForScan), and whether a status poll waited
    // for them.
    this._scanPauses = 0;
    this._pollWaitedForScan = false;
  }

  // Verbose BLE/GATT tracing. Off unless the user turns it on in app settings.
  log(...a) { if (this.homey.settings.get('debugLogging') === true) this.app.log('[MeshBridge]', ...a); }
  error(...a) { this.app.error('[MeshBridge]', ...a); }
  _sleep(ms) { return new Promise((r) => this.homey.setTimeout(r, ms)); }

  // Homey's adv.connect() has no cancel and can hang indefinitely on a bad
  // radio. Race it against a timeout so a stuck connect rejects and the caller
  // can retry, instead of leaving the recovery owner waiting forever.
  _connectWithTimeout(adv, ms) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = this.homey.setTimeout(() => {
        if (done) return;
        done = true;
        this.error(`CONN adv.connect() timed out after ${ms}ms`);
        reject(new Error(`connect timeout (${ms}ms)`));
      }, ms);
      adv.connect().then(
        (peripheral) => {
          if (done) {
            // Arrived after we gave up: drop it so it can't linger half-open.
            try { peripheral.disconnect().catch(() => {}); } catch (e) { /* ignore */ }
            return;
          }
          done = true;
          this.homey.clearTimeout(timer);
          resolve(peripheral);
        },
        (err) => {
          if (done) return;
          done = true;
          this.homey.clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  // One packet per 8004 notification. A packet comes the way _sendNow writes
  // one: its first 20 bytes on 8003 and the rest on 8004, or a short packet
  // on 8004 alone. So 8003 waits, and 8004 ends the packet, which is decoded
  // once, whole. No timer: how far apart the halves arrive does not matter.
  // onFrag sets _lastFragSrc just before it calls this. Only the last 8003
  // of the current subscription is kept; one whose 8004 never came is
  // replaced by the next.
  _rxFeed(buf) {
    if (this._lastFragSrc === '8003') {
      this._rxPending = { buf, generation: this._notifyGeneration };
      return;
    }
    const pending = this._rxPending && this._rxPending.generation === this._notifyGeneration ? this._rxPending.buf : null;
    this._rxPending = null;
    this._rxDecode(pending ? Buffer.concat([pending, buf]) : buf);
  }

  // Time spent decoding, for the CPU guard on the held link.
  _rxDecode(frame) {
    const startedAt = Date.now();
    try {
      this._rxDecodeFrame(frame);
    } finally {
      this._decodeCalls += 1;
      this._decodeMs += Date.now() - startedAt;
    }
  }

  // A whole packet: SEQ(3) source(2) payload(4 to 24) MAC(8) and one more
  // byte. Only a packet whose MAC is right is decrypted, once.
  _rxDecodeFrame(frame) {
    try {
      if (!frame || frame.length < 18 || frame.length > 38) return;
      // All devices on one CSRmesh network share a key; take it from a paired device.
      const key = this.app.getNetworkKey();
      if (!verifyPacket(key, frame)) {
        this._rxMacFailures += 1;
        this._keyCheckLinkFailures += 1;
        return;
      }
      const payload = frame.subarray(5, frame.length - 9);
      const plain = decryptPayload(key, frame.subarray(0, 3), frame.subarray(3, 5), payload);
      // An SG status frame, whatever the home's location id (see sgProtocol).
      const status = parseGen1Status(plain);
      if (status) {
        const { level, location } = status;
        if (!this._keyCheckDone) this._keyCheckRead();
        const statusId = status.id.toString(16).padStart(4, '0');
        const loc = `0x${location.toString(16).padStart(4, '0')}`;
        const duplicateInPoll = !this._held && this._statusSeen && this._statusSeen.has(statusId);
        if (!duplicateInPoll) {
          // A held link hears every dimmer about once a second; log changes only.
          if (!this._held || this._loggedLevel.get(statusId) !== `${level} ${loc}`) {
            this._status(`STATUS id=0x${statusId} level=${level} loc=${loc}`);
            this._loggedLevel.set(statusId, `${level} ${loc}`);
          }
          if (typeof this._onStatus === 'function') this._onStatus(statusId, level, location);
        }

        if (!this._held && this._statusWanted && this._statusWanted.has(statusId)) {
          this._statusSeen.add(statusId);
          if (!duplicateInPoll) {
            this._status(`paired status seen 0x${statusId} (${this._statusSeen.size}/${this._statusWanted.size})`);
          }
          if (this._statusWanted.size > 0
            && this._statusSeen.size >= this._statusWanted.size
            && !this._statusCompleteDisconnect) {
            this._statusCompleteDisconnect = true;
            this._status(`paired status complete (${this._statusSeen.size}/${this._statusWanted.size})`);
            this.homey.setTimeout(() => {
              // Never let background status handling tear down a connection
              // while a Homey/Apple command is queued or being transmitted,
              // or while the link still listens for the answer to a request
              // (it goes when that is over).
              if (this._txPending > 0 || this._listening()) return;
              if (this.isActive()) this._disconnect('paired-status-complete').catch((e) => {
                this.error(`paired-status disconnect failed: ${e.message || e}`);
              });
            }, 0);
          }
        }
        return;
      }
      // Anything else that decrypts goes to SG's later CSRmesh products
      // (lib/CsrNetwork.js); the first generation path above is unchanged.
      if (typeof this._onFrame === 'function') this._onFrame({ src: frame.readUInt16LE(3), plain });
    } catch (e) { /* ignore */ }
  }

  // The dimmers send their status by themselves, about once a second, so a
  // link that listens reads one within seconds. Each link is checked for up
  // to KEY_CHECK_MS, or until the next link listens. Frames that fail the
  // check and no status read, on KEY_CHECK_LINKS links and in at least
  // KEY_CHECK_FAILURES frames in all: the network password is probably wrong
  // (most likely "Network Isolation" in the SG app), and the dimmers show a
  // warning. One short link, or a few stray frames, is not enough. A link
  // with no frames at all is not counted, and any status read ends the check.
  _startKeyCheck() {
    if (this._keyCheckDone) return;
    if (this._keyCheckTimer) this._endKeyCheckLink();
    if (this._keyCheckDone) return;
    this._keyCheckLinkFailures = 0;
    this._keyCheckTimer = this.homey.setTimeout(() => this._endKeyCheckLink(), KEY_CHECK_MS);
  }

  _endKeyCheckLink() {
    if (this._keyCheckTimer) this.homey.clearTimeout(this._keyCheckTimer);
    this._keyCheckTimer = null;
    if (this._keyCheckDone) return;
    const failures = this._keyCheckLinkFailures;
    this._keyCheckLinkFailures = 0;
    if (failures === 0) {
      this._status('no status frames heard on this link; not a password problem, checking again on the next link');
      return;
    }
    this._keyCheckLinks += 1;
    this._keyCheckFailures += failures;
    if (this._keyCheckLinks < KEY_CHECK_LINKS || this._keyCheckFailures < KEY_CHECK_FAILURES) {
      this._status(`no status read on this link: ${failures} frame(s) failed the check (${this._keyCheckLinks} of `
        + `${KEY_CHECK_LINKS} links, ${this._keyCheckFailures} of ${KEY_CHECK_FAILURES} frames before a warning)`);
      return;
    }
    this._keyCheckDone = true;
    this._status(`no status could be read on ${this._keyCheckLinks} links: ${this._keyCheckFailures} frame(s) `
      + 'failed the check; the network password is probably wrong');
    if (typeof this.app.statusUnreadable === 'function') this.app.statusUnreadable();
  }

  // A status was read: the password is right, and the check is over.
  _keyCheckRead() {
    this._keyCheckDone = true;
    if (this._keyCheckTimer) this.homey.clearTimeout(this._keyCheckTimer);
    this._keyCheckTimer = null;
  }

  // A dimmer waits for its first status (just paired, or from before the
  // location id was learned): read status now rather than in five minutes.
  pollSoon() {
    if (this._held || this._statusRunning || this._shuttingDown) return;
    this._scheduleStatusPoll(2000);
  }

  // How long a link is still to listen for the answer to a request
  // (listenMs), or 0.
  listenLeftMs() {
    return Math.max(0, this._listenUntil - Date.now());
  }

  // A link that is subscribed and still listening for an answer.
  _listening() {
    return this._notifySubscribed && this.listenLeftMs() > 0;
  }

  _cacheAdv(uuid, adv) {
    this._advCache.set(uuid, { adv, at: Date.now() });
    const name = String((adv && adv.localName) || '').trim();
    if (NODE_NAME.test(name)) this._nameByUuid.set(uuid, name.toUpperCase());
  }

  // The @NDxxxx name of a node. Homey sometimes returns an advertisement with
  // no name at all, so fall back to the last name seen for that peripheral,
  // then to the name stored when the dimmer was paired.
  _nodeNameFor(adv) {
    const own = String((adv && adv.localName) || '').trim();
    if (NODE_NAME.test(own)) return own.toUpperCase();
    const seen = this._nameByUuid.get(adv && adv.uuid);
    if (seen) return seen;
    try {
      for (const device of this.app._devices()) {
        if (typeof device.getStoreValue !== 'function') continue;
        if (device.getStoreValue('peripheralUuid') !== (adv && adv.uuid)) continue;
        const paired = String(device.getStoreValue('localName') || '').trim();
        if (NODE_NAME.test(paired)) return paired.toUpperCase();
      }
    } catch (err) { /* no name is handled by the caller */ }
    return '';
  }

  // The name of a node that may be a bridge (lib/sgProducts.js, canBeBridge):
  // its own, or the last such name seen for that peripheral, as Homey
  // sometimes returns an advertisement without a name. '' when there is none.
  _bridgeNameFor(adv) {
    const own = String((adv && adv.localName) || '').trim().toUpperCase();
    if (canBeBridge(own)) {
      this._bridgeNameByUuid.set(adv.uuid, own);
      return own;
    }
    return this._bridgeNameByUuid.get(adv && adv.uuid) || '';
  }

  // The nodes a link may go through, strongest first: first generation dimmers
  // (@ND) when any can be reached, otherwise another SG node that advertises
  // the CSRmesh service (FEF1) under a name that may be a bridge
  // (sgProducts.canBeBridge), such as SG's later CSRmesh products (2.5.0).
  // Such a node gets no heartbeat: only the first generation is known to hang
  // up without one, and a later node is assumed not to need it (not tried).
  // So it carries commands and status but the link is not held, and the held
  // link never moves to one (_heldRescan keeps to @ND).
  _bridgeNodes(advs) {
    const connectable = (advs || []).filter((a) => a && a.connectable !== false);
    const gen1 = connectable.filter((a) => NODE_NAME.test(this._nodeNameFor(a)));
    const nodes = gen1.length ? gen1
      : connectable.filter((a) => isCsrmeshAdvertisement(a) && canBeBridge(this._bridgeNameFor(a)));
    return nodes.sort((a, b) => (Number(b.rssi) || -999) - (Number(a.rssi) || -999));
  }

  // Signal strength of the SG nodes a fresh scan returned, to their dimmer
  // devices.
  _reportScanSignal(sg) {
    for (const adv of sg) this.app.reportSignal(this._nodeNameFor(adv), adv.rssi);
  }

  _uncacheAdv(uuid) { this._advCache.delete(uuid); }

  _cachedAdv(uuid) {
    const entry = this._advCache.get(uuid);
    if (!entry) return null;
    if (Date.now() - entry.at > ADV_CACHE_TTL_MS) {
      this._advCache.delete(uuid);
      this.log(`cached advertisement for ${uuid} expired`);
      return null;
    }
    return entry.adv;
  }

  // Homey has one radio. Scanning while a peripheral is connected destabilises
  // it, so every scan releases the link first and waits for any teardown that
  // is already running.
  async _releaseRadio(label) {
    if (this._disconnecting) await this._disconnecting.catch(() => {});
    if (this._peripheral) {
      this.log(`releasing connection before ${label}`);
      await this._disconnect(`before-${label}`);
    }
  }

  async _scan(label) {
    await this._releaseRadio(label);
    return this.homey.ble.discover();
  }

  // A pairing search scans for nodes, and a node Homey is connected to does
  // not advertise: with the link held, the search found no dimmers (30.10 and
  // 31.10, "SG: 0"). So the held link is let go, after a connect or a write
  // under way, and a status poll waits. Both wait until the pairing is done,
  // not only the scan: lib/csrPairing.js ends the pause once the list has
  // been answered or the pairing is closed, and it ends by itself after
  // PAIRING_PAUSE_MAX_MS. A command sent meanwhile gets a link that is let go
  // as without the held link (_holding). Pauses that overlap end with the
  // last one. Returns the function that ends this one, with why for the log;
  // calling it more than once does nothing.
  async pauseForScan(label = 'pairing scan') {
    this._scanPauses += 1;
    const startedAt = Date.now();
    let ended = false;
    let limit = null;
    const end = (why = 'pairing done') => {
      if (ended) return;
      ended = true;
      if (limit) this.homey.clearTimeout(limit);
      this._scanPauses = Math.max(0, this._scanPauses - 1);
      if (this._scanPauses > 0 || this._shuttingDown) return;
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      if (this._held) {
        this._status(`pairing pause over after ${seconds}s (${why}): the held link comes back`);
        // A link a command opened meanwhile is the held link from now on.
        if (this._disconnectTimer) this._cancelIdleDisconnect('as the link is held again');
        this._pollWaitedForScan = false;
        this._scheduleHeld(1000);
      } else {
        this._status(`pairing pause over after ${seconds}s (${why}): status polling goes on`);
        if (this._pollWaitedForScan) {
          this._pollWaitedForScan = false;
          this._scheduleStatusPoll(2000);
        }
      }
    };
    limit = this.homey.setTimeout(() => {
      limit = null;
      end(`limit of ${PAIRING_PAUSE_MAX_MS / 1000}s`);
    }, PAIRING_PAUSE_MAX_MS);
    this._statusGeneration += 1; // a poll in flight stops at its next check
    const up = !!(this._peripheral || this._connecting);
    if (this._connecting) await this._connecting.catch(() => {});
    await this._writeLane.catch(() => {});
    await this._releaseRadio(label);
    this._status(`pairing pause: ${up ? `${this._held ? 'held link' : 'link'} let go` : 'no link up'}; `
      + `${this._held ? 'the held link' : 'status polling'} waits until the pairing is done`);
    return end;
  }

  _elapsed() { return this._connStartedAt ? Date.now() - this._connStartedAt : 0; }

  getBridgeLocalName() {
    return this._bridgeLocalName;
  }

  getBridgeNodeId() {
    return this._bridgeNodeId;
  }

  isActive() {
    return !!this._peripheral || !!this._connecting || !!this._disconnecting;
  }

  // Every decrypted frame that is not a first generation status, with the
  // sender from the packet header: { src, plain }.
  onFrame(handler) {
    this._onFrame = handler;
  }

  // Status comes one of two ways. With "Keep dimmers connected" the link to
  // the bridge is held with notifications on, so every change is heard at
  // once. Without it, a status poll every five minutes connects, listens for a
  // few seconds and lets go.
  startStatus(handler) {
    this._onStatus = handler;
    this._statusRunning = false;
    // The dimmers are not initialised yet when the app starts, and the default
    // depends on how many there are.
    this._modeTimer = this.homey.setTimeout(() => {
      this._modeTimer = null;
      this.applyMode();
    }, 3000);
  }

  // The user's choice, or by default on with two or more dimmers (the SG phone
  // app can still reach another one) and off with a single dimmer. Never
  // without a first generation dimmer, whatever the choice: the link is held
  // through one, with its heartbeat.
  _keepConnected() {
    if (this.app.dimmerCount() === 0) return false;
    const choice = this.homey.settings.get('keepConnected');
    if (choice === true || choice === false) return choice;
    return this.app.dimmerCount() >= 2;
  }

  // Start or stop the held link to match the setting. Called at start, when
  // the setting changes and when a dimmer is added or deleted.
  applyMode() {
    if (this._shuttingDown) return;
    const want = this._keepConnected() && !this._heldGaveUp;
    if (want && !this._held) {
      this._startHeld();
    } else if (!want && this._held) {
      this._stopHeld('setting off');
    } else if (!want && !this._statusTimer && !this._statusRunning) {
      this._status(`status polling every ${STATUS_POLL_MS / 60000} min, first poll now`);
      this._scheduleStatusPoll(500);
    }
  }

  _statusPollMs() {
    return STATUS_POLL_MS;
  }

  // A command is queued or being written.
  _txBusy() {
    return !!this._txWorkerPromise || this._txPending > 0 || this._desiredTx.size > 0;
  }

  // "Keep dimmers connected" on: stop polling and hold a link to the bridge.
  _startHeld() {
    this._held = true;
    this._statusGeneration += 1; // a poll in flight stops at its next check
    if (this._statusTimer) {
      this.homey.clearTimeout(this._statusTimer);
      this._statusTimer = null;
    }
    // Nothing left over from polling: its bookkeeping, its keep-alive timer,
    // its decode time, or a link opened without notifications and heartbeat.
    // A command being written is left to finish; the held tick then replaces
    // its link.
    this._statusWanted = null;
    this._statusSeen = null;
    this._statusCompleteDisconnect = true;
    this._cancelIdleDisconnect();
    this._decodeCalls = 0;
    this._decodeMs = 0;
    if (this.isActive() && !this._txBusy()) {
      this._disconnect('held-link-start').catch((err) => this.error(`release before holding failed: ${err.message || err}`));
    }
    this._status('keep dimmers connected: holding the link to the bridge, status live');
    this._heldWindowAt = Date.now();
    this._heldSummaryTimer = this.homey.setInterval(() => this._logHeldSummary(), HELD_LINK_SUMMARY_MS);
    this._heldRescanTimer = this.homey.setTimeout(() => this._heldRescan(), HELD_LINK_RESCAN_MS);
    this._scheduleHeld(1000);
  }

  // Off again (or given up): let go of the link and poll as before.
  _stopHeld(why) {
    this._held = false;
    this._status(`keep dimmers connected off (${why}); status polling every ${STATUS_POLL_MS / 60000} min`);
    for (const timer of ['_heldTimer', '_heldRescanTimer']) {
      if (this[timer]) {
        this.homey.clearTimeout(this[timer]);
        this[timer] = null;
      }
    }
    if (this._heldSummaryTimer) {
      this.homey.clearInterval(this._heldSummaryTimer);
      this._heldSummaryTimer = null;
    }
    this._heldUpAt = 0;
    this._heldDownAt = 0;
    this._stopHeartbeat();
    if (this.isActive()) {
      this._disconnect('held-link-off').catch((err) => this.error(`release failed: ${err.message || err}`));
    }
    this._scheduleStatusPoll(5000);
  }

  _scheduleHeld(delayMs) {
    if (this._shuttingDown || !this._held || this._heldTimer) return;
    this._heldTimer = this.homey.setTimeout(() => {
      this._heldTimer = null;
      this._heldTick().catch((err) => this.error(`held link: ${err.message || err}`));
    }, delayMs);
  }

  // Once a second: connect when the link is down and the radio is free.
  async _heldTick() {
    if (this._shuttingDown || !this._held) return;
    const up = !!(this._peripheral && this._char8003 && this._char8004 && this._notifySubscribed);
    if (!up && this._heldUpAt) {
      this._heldUpMs += Date.now() - Math.max(this._heldUpAt, this._heldWindowAt);
      this._heldUpAt = 0;
      this._heldDownAt = Date.now();
      this._heldDrops += 1;
    }
    if (up && !this._heldUpAt && this._scanPauses === 0) {
      // A command opened the link first; count it all the same.
      this._heldUpAt = Date.now();
      this._heldLinks += 1;
      this._heldDownAt = 0;
    }
    if (this._scanPauses > 0) {
      // A pairing pause (pauseForScan): the held link comes back after it. A
      // link a command opened meanwhile is not held until then.
      this._scheduleHeld(1000);
      return;
    }
    if (up || this._connecting || this._disconnecting || this._txBusy()) {
      // A chain that ended on a failed heartbeat while the link stayed up
      // starts again; a running one is left alone.
      if (up && this._canHeartbeat()) this._startHeartbeat(this._connNo);
      this._scheduleHeld(1000);
      return;
    }
    if (this._peripheral) {
      // A link without notifications (opened before the link was held) is
      // let go now that the radio is free, and a held one opened in its place.
      await this._disconnect('held-link-needs-notifications');
      this._scheduleHeld(1000);
      return;
    }
    if (!this._heldDownAt) this._heldDownAt = Date.now();
    const startedAt = Date.now();
    try {
      // The preferred bridge first. After a few failures, a full scan picks
      // whichever node answers best now.
      const rescan = this._heldFailures >= 3 || !this._preferredUuid;
      await this._ensureConnected({
        fastPreferred: !rescan,
        pinPreferred: !rescan,
        singleRound: true,
        needNotifications: true,
        purpose: 'held',
      });
      this._heldFailures = 0;
      this._heldLinks += 1;
      this._heldUpAt = Date.now();
      this._status(
        `held link #${this._connNo} up via ${this._bridgeLocalName || this._preferredUuid}, ` +
        `${((Date.now() - this._heldDownAt) / 1000).toFixed(1)}s after it went down`
      );
      this._heldDownAt = 0;
      // The chain began with the link's first heartbeat; if that one failed,
      // a chain starts now with a heartbeat at once.
      this._startHeartbeat(this._connNo);
      this._scheduleHeld(1000);
    } catch (err) {
      const wait = HELD_LINK_RETRY_MS[Math.min(this._heldFailures, HELD_LINK_RETRY_MS.length - 1)];
      this._heldFailures += 1;
      this._status(`held link: attempt ${this._heldFailures} failed after ${Date.now() - startedAt}ms (${err.message || err}); next in ${wait / 1000}s`);
      this._scheduleHeld(wait);
    }
  }

  // Once an hour, a scan with the link left up, to keep the choice of bridge
  // and the cached advertisements fresh. Moves the link if another node has
  // become clearly stronger.
  async _heldRescan() {
    this._heldRescanTimer = null;
    if (this._shuttingDown || !this._held) return;
    try {
      const advs = await this.homey.ble.discover();
      const sg = advs
        .filter((a) => NODE_NAME.test(this._nodeNameFor(a)) && a.connectable !== false)
        .sort((a, b) => (Number(b.rssi) || -999) - (Number(a.rssi) || -999));
      for (const adv of sg) this._cacheAdv(adv.uuid, adv);
      this._reportScanSignal(sg);
      const linkedTo = this._peripheral ? this._preferredUuid : null;
      if (sg.length) {
        const chosen = this._pickBridge(sg);
        if (linkedTo && chosen.uuid !== linkedTo && this._held) {
          this._status(`held link: moving to ${this._nodeNameFor(chosen) || chosen.uuid}`);
          await this._disconnect('held-link-better-bridge');
        }
      }
      const nodes = sg.map((a) => `${this._nodeNameFor(a)} rssi=${a.rssi}`).join(', ');
      this.log(`held link: hourly scan found ${advs.length} advertisement(s), ${sg.length} SG node(s)${nodes ? `: ${nodes}` : ''}`);
    } catch (err) {
      this.error(`held link: hourly scan failed: ${err.message || err}`);
    } finally {
      if (this._held && !this._shuttingDown && !this._heldRescanTimer) {
        this._heldRescanTimer = this.homey.setTimeout(() => this._heldRescan(), HELD_LINK_RESCAN_MS);
      }
    }
  }

  // Verbose log once a minute; also the CPU guard.
  _logHeldSummary() {
    const now = Date.now();
    const windowMs = now - this._heldWindowAt;
    const upMs = this._heldUpMs + (this._heldUpAt ? now - Math.max(this._heldUpAt, this._heldWindowAt) : 0);
    this.log(
      `held link: last ${Math.round(windowMs / 1000)}s up ${Math.round(upMs / 1000)}s ` +
      `(${windowMs ? Math.round((100 * upMs) / windowMs) : 0}%), links ${this._heldLinks}, drops ${this._heldDrops}, ` +
      `heartbeats ${this._heartbeatsTotal}, decode ${this._decodeCalls} call(s) ${this._decodeMs}ms, `
      + `MAC failures ${this._rxMacFailures}`
    );
    const overLimit = this._held && this._decodeMs > HELD_LINK_DECODE_LIMIT_MS;
    const decodeMs = this._decodeMs;
    this._heldWindowAt = now;
    this._heldUpMs = 0;
    this._heldLinks = 0;
    this._heldDrops = 0;
    this._heartbeatsTotal = 0;
    this._decodeCalls = 0;
    this._decodeMs = 0;
    this._rxMacFailures = 0;
    if (overLimit) {
      this._heldGaveUp = true;
      this._stopHeld(`decoding used ${decodeMs}ms in a minute, over the ${HELD_LINK_DECODE_LIMIT_MS}ms limit; until the app restarts`);
    }
  }

  _scheduleStatusPoll(delayMs = null) {
    if (this._shuttingDown) return;
    if (this._statusTimer) this.homey.clearTimeout(this._statusTimer);
    const interval = this._statusPollMs();
    if (interval <= 0) return;
    const delay = delayMs == null ? interval : Math.max(0, Number(delayMs) || 0);
    this._statusTimer = this.homey.setTimeout(() => this._statusPollTick(), delay);
  }

  async _statusPollTick() {
    if (this._statusRunning) return;
    if (this._held) return; // the held link hears status live
    if (this._scanPauses > 0) {
      // A pairing pause (pauseForScan), which starts the poll again when it
      // ends, also at its limit.
      if (!this._pollWaitedForScan) this._status('poll deferred until the pairing is done');
      this._pollWaitedForScan = true;
      return;
    }

    // Never start a background BLE session while the user is actively using
    // the lights. Homey's adv.connect() cannot be cancelled once it is in
    // flight, so avoiding collisions is more reliable than trying to pre-empt
    // a pending connect.
    const quietMs = 15000;
    const sinceTx = this._lastTxAt ? Date.now() - this._lastTxAt : quietMs;
    // A held link does not listen, and a poll cannot open a second one.
    const heldMs = this._peripheral ? this._keepAliveLeftMs() : 0;
    if (heldMs > 0) {
      this._status(`poll deferred while the link is held (${heldMs}ms)`);
      this._scheduleStatusPoll(heldMs + 1000);
      return;
    }
    if (this._txPending > 0 || sinceTx < quietMs) {
      const deferMs = this._txPending > 0 ? 5000 : Math.max(1000, quietMs - sinceTx);
      this._status(`poll deferred for user TX (${deferMs}ms)`);
      this._scheduleStatusPoll(deferMs);
      return;
    }
    this._statusRunning = true;
    const startedAt = Date.now();
    const interval = this._statusPollMs();
    // A user command cancels this poll generation immediately. The command may
    // then reuse a ready BLE connection instead of waiting for the poll to end.
    const pollGeneration = this._statusGeneration;
    const cancelled = () => this._txPending > 0 || pollGeneration !== this._statusGeneration;
    const paired = typeof this.app.getPairedMeshIds === 'function'
      ? this.app.getPairedMeshIds()
      : [];
    this._statusWanted = new Set(paired.map((id) => String(id).toLowerCase()));
    this._statusSeen = new Set();
    this._statusCompleteDisconnect = false;
    try {
      if (cancelled()) return;

      const ids = [...this._statusWanted].map((id) => `0x${id}`).join(', ');
      this._status(`poll: listening for status (interval ${interval}ms, paired [${ids}])`);

      // One normal attempt, plus at most one retry. Any Homey/Apple command
      // pre-empts the background poll: no poll disconnect and no poll retry.
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (cancelled()) break;

        if (!this.isActive()) {
          await this._ensureConnected({
            needNotifications: true,
            abortOnTx: true,
            purpose: 'status',
            // Use the SAME RSSI + 8 dB hysteresis node selection as TX
            // (_candidates): prefer the current bridge, switch only when another
            // SG node is clearly stronger, and fall back to the strongest
            // reachable node when preferred is not visible. singleRound keeps it
            // to one pass so a background poll never loops on the radio.
            singleRound: true,
          });
          if (cancelled()) break;

          await this._sleep(6000);
          if (cancelled()) break;

          if (this.isActive()) {
            await this._disconnect(attempt === 1 ? 'status-poll' : 'status-poll-retry');
          }
        }

        if (cancelled()) break;

        const complete = this._statusWanted.size === 0
          || this._statusSeen.size >= this._statusWanted.size;
        if (complete || attempt === 2) break;

        const missing = [...this._statusWanted]
          .filter((id) => !this._statusSeen.has(id))
          .map((id) => `0x${id}`)
          .join(', ');
        this._status(`poll incomplete; retrying once for [${missing}]`);
        await this._sleep(1500);
      }
    } catch (e) {
      // A command may legitimately invalidate the poll's connection while it
      // is being pre-empted. Only report genuine background failures.
      if (!cancelled()) this.error(`status poll failed: ${e.message || e}`);
    } finally {
      this._statusRunning = false;
      // What this poll waited for counts only while it runs: on a later link
      // (one that listens for an answer) every status is used, and none ends it.
      this._statusWanted = null;
      this._statusSeen = null;
      const elapsed = Date.now() - startedAt;
      const nextIn = Math.max(1000, interval - elapsed);
      this._scheduleStatusPoll(nextIn);
    }
  }

  _status(...a) {
    this.app.log('[SG status]', ...a);
  }

  async ensureConnected() {
    await this._ensureConnected();
    return {
      localName: this._bridgeLocalName,
      nodeId: this._bridgeNodeId,
      connNo: this._connNo,
    };
  }

  send(packet, meta = {}) {
    this._cancelIdleDisconnect();
    this._lastUserTxAt = Date.now();
    const txKey = meta && meta.key ? String(meta.key) : null;

    // All current device/group call sites provide a logical key. Keep a tiny
    // fallback for any future unkeyed diagnostic call.
    if (!txKey) {
      this._txPending += 1;
      this._lastTxAt = Date.now();
      this._statusGeneration += 1;
      const run = async () => {
        try { return await this._sendNow(packet); }
        finally {
          this._txPending = Math.max(0, this._txPending - 1);
          if (this._txPending === 0 && this.isActive()) this._scheduleIdleDisconnect('tx-queue-empty');
        }
      };
      const queued = this._queue.then(run, run);
      this._queue = queued.catch(() => {});
      return queued;
    }

    const generation = (this._latestTxGeneration.get(txKey) || 0) + 1;
    this._latestTxGeneration.set(txKey, generation);
    this._lastTxAt = Date.now();
    this._statusGeneration += 1;

    // Resolve the older not-yet-finished request for this same target. The new
    // value is now the only one that matters.
    const previous = this._desiredTx.get(txKey);
    if (previous && typeof previous.resolve === 'function') {
      previous.resolve({ superseded: true });
    }

    let resolveOuter;
    const promise = new Promise((resolve) => { resolveOuter = resolve; });
    this._desiredTx.set(txKey, {
      key: txKey,
      packet: Buffer.from(packet),
      generation,
      level: meta.level,
      // A request that wants an answer (FF10, FFFF): its link listens this long.
      listenMs: Number(meta.listenMs) > 0 ? Number(meta.listenMs) : 0,
      queuedAt: Date.now(),
      resolve: resolveOuter,
    });
    this._txPending = Math.max(1, this._desiredTx.size);

    this._kickTxWorker();
    return promise;
  }

  _kickTxWorker() {
    if (this._txWorkerPromise || this._shuttingDown) return;
    this._txWorkerPromise = this._runDesiredTxWorker()
      .catch((err) => this.error(`TX desired worker failed: ${err.message || err}`))
      .finally(() => {
        this._txWorkerPromise = null;
        this._txPending = this._desiredTx.size;
        if (this._desiredTx.size) this._kickTxWorker();
      });
  }

  async _runDesiredTxWorker() {
    while (this._desiredTx.size) {
      // Map insertion order gives the other dimmer a turn after a failure. A
      // failed current entry is moved to the back instead of monopolising BLE.
      const [txKey, entry] = this._desiredTx.entries().next().value;
      const isCurrent = () => {
        const now = this._desiredTx.get(txKey);
        return !!now && now.generation === entry.generation
          && this._latestTxGeneration.get(txKey) === entry.generation;
      };

      if (!isCurrent()) {
        if (this._desiredTx.get(txKey) === entry) this._desiredTx.delete(txKey);
        continue;
      }

      try {
        const result = await this._sendNow(entry.packet, { txKey, isCurrent, listenMs: entry.listenMs });
        if (result && result.superseded) {
          // A newer value already replaced this entry; leave the replacement.
          continue;
        }
        if (isCurrent()) {
          this._desiredTx.delete(txKey);
          this._status(`TX ${txKey} done ${Date.now() - entry.queuedAt}ms after the command (link #${this._connNo}, ${Math.round(this._elapsed() / 1000)}s old)`);
          entry.resolve({ ok: true });
        }
      } catch (err) {
        if (!isCurrent()) continue;

        // A command is tried again on new links until it is delivered or a
        // newer value replaces it, but not for ever.
        const giveUp = () => {
          // A newer value that arrived meanwhile is left alone.
          if (!isCurrent() || Date.now() - entry.queuedAt <= TX_GIVE_UP_MS) return false;
          this.error(`TX ${txKey} given up after ${Math.round((Date.now() - entry.queuedAt) / 1000)}s: ${err.message || err}`);
          this._desiredTx.delete(txKey);
          entry.resolve({ failed: true });
          return true;
        };

        if (err && err.code === 'SG_RECOVERY_FAILED') {
          // Circuit breaker for the ENTIRE desired queue. Keep the latest value
          // for every target, stop all BLE activity for 5 seconds, then let one
          // worker make one new recovery round. No per-device retry storm.
          this.error(`TX recovery round failed; retaining latest queue and cooling down ${GLOBAL_RECOVERY_COOLDOWN_MS}ms: ${err.message || err}`);
          await this._enterTxRecoveryCooldown();
          giveUp();
          continue;
        }
        if (giveUp()) continue;

        // A normal mid-write ATT failure still gives the other dimmer a turn,
        // but the complete-packet retry is handled inside _sendNow.
        this.error(`TX latest value retained key=${txKey}: ${err.message || err}`);
        this._desiredTx.delete(txKey);
        this._desiredTx.set(txKey, entry);
        await this._sleep(500);
      }

      this._txPending = this._desiredTx.size;
    }

    this._txPending = 0;
    if (this.isActive()) this._scheduleIdleDisconnect('tx-desired-empty');
  }

  async _candidates() {
    // Pick the bridge from the SG advertisements we can actually hear now.
    // RSSI can jump a few dB from packet to packet, so keep the current bridge
    // unless another SG node is clearly stronger (8 dB hysteresis). This avoids
    // the old behaviour where the last successful GATT connection silently
    // became the permanent preferred bridge.
    let advs = [];
    try {
      advs = await this._scan('discover');
    } catch (err) {
      this.error(`discover failed: ${err.message || err}`);
    }

    // A known SG node can come back from a scan with no name at all; recognise
    // it by uuid as well, or the scan drops the strong bridge for a weak one.
    const sg = this._bridgeNodes(advs);

    // Cache fresh advertisement objects for the command fast-path. This is the
    // key latency fix: later TX can call connect() immediately instead of doing
    // another full discover() scan first.
    for (const adv of sg) this._cacheAdv(adv.uuid, adv);
    if (!this._held) this._reportScanSignal(sg);

    if (!sg.length) return [];

    const chosen = this._pickBridge(sg);

    // Try the RSSI-selected node first, then the remaining nodes strongest-first
    // as fallbacks for this connection attempt. A fallback success does NOT
    // replace the preferred bridge.
    return [chosen, ...sg.filter((a) => a.uuid !== chosen.uuid)];
  }

  // RSSI with 8 dB hysteresis: keep the current bridge unless another node is
  // clearly stronger. Stores the choice. `sg` is sorted strongest first.
  _pickBridge(sg) {
    const best = sg[0];
    const current = this._preferredUuid
      ? sg.find((a) => a.uuid === this._preferredUuid)
      : null;
    const bestRssi = Number(best.rssi);
    const currentRssi = current ? Number(current.rssi) : -999;
    const chosen = current && Number.isFinite(currentRssi)
      && (!Number.isFinite(bestRssi) || bestRssi < currentRssi + 8)
      ? current
      : best;

    if (chosen.uuid !== this._preferredUuid) {
      this._preferredUuid = chosen.uuid;
      this.homey.settings.set('bridgeUuid', chosen.uuid);
      // By name, also for a bridge that is not @ND, so the log says which one.
      const name = this._nodeNameFor(chosen) || this._bridgeNameFor(chosen);
      this._status(`bridge selected by RSSI: ${name || chosen.uuid} ${chosen.rssi} dBm`);
      this.app.bridgeChanged();
    }
    return chosen;
  }

  async _findPreferredAdvertisement(label = 'preferred') {
    if (!this._preferredUuid) return null;
    try {
      await this._releaseRadio('find');
      const adv = await this.homey.ble.find(this._preferredUuid);
      if (adv && adv.connectable !== false) {
        this._cacheAdv(adv.uuid, adv);
        if (!this._held) this._reportScanSignal([adv]);
        this._status(`${label} find(): ${adv.localName || adv.uuid} rssi=${adv.rssi}`);
        return adv;
      }
    } catch (err) {
      this.log(`${label} find() miss: ${err.message || err}`);
    }
    return null;
  }

  _assertConnectionAlive(peripheral, myConnNo, stage) {
    if (this._peripheral !== peripheral) {
      const err = new Error(`Peripheral disconnected during ${stage}`);
      err.code = 'SG_LINK_DROPPED';
      throw err;
    }
    if (myConnNo !== this._connNo) {
      const err = new Error(`Connection generation changed during ${stage}`);
      err.code = 'SG_LINK_DROPPED';
      throw err;
    }
  }

  async _ensureConnected(options = {}) {
    const fastPreferred = options.fastPreferred === true;
    const abortOnTx = options.abortOnTx === true;
    const preferredOnly = options.preferredOnly === true;
    const singleRound = options.singleRound === true;
    const pinPreferred = options.pinPreferred === true;
    const purpose = options.purpose || 'generic';
    const tag = purpose === 'status' ? 'STATUS' : purpose === 'held' ? 'HELD' : 'TX';
    const preempted = () => abortOnTx && this._txPending > 0;
    const preemptError = () => {
      const e = new Error('Status connection pre-empted by user TX');
      e.code = 'SG_STATUS_PREEMPTED';
      return e;
    };
    // Status listening needs notifications; user TX does not. Skipping the
    // notification subscriptions on a cold TX connection removes a slow and
    // failure-prone GATT step before the first write.
    const needNotifications = this._held || options.needNotifications !== false;
    if (this._disconnecting) await this._disconnecting.catch(() => {});
    if (this._shuttingDown) throw new Error('App is shutting down');
    if (this._peripheral && this._char8003 && this._char8004) {
      this.log(`CONN reuse #${this._connNo} t=+${this._elapsed()}ms stage=${this._stage}`);
      return;
    }
    if (this._connecting) return this._connecting;

    this._connectingPurpose = purpose;
    this._connecting = (async () => {
      const deadline = Date.now() + CONNECT_WINDOW_MS;
      let lastError = null;
      let fastCacheTried = false;
      let preferredRefreshTried = false;

      while (Date.now() < deadline) {
        if (preempted()) throw preemptError();
        let cands;
        if (fastPreferred && this._preferredUuid) {
          const cached = this._cachedAdv(this._preferredUuid);
          if (cached) {
            fastCacheTried = true;
            cands = [cached];
            this._status(`${tag} fast bridge: ${cached.localName || cached.uuid} (cached advertisement)`);
          } else {
            // First ask Homey for the already-known preferred UUID. find()
            // is normally much cheaper than a full discover() and also gives
            // us a fresh BleAdvertisement object after a stale cached object.
            let refreshed = await this._findPreferredAdvertisement(
              `${tag} preferred`
            );
            preferredRefreshTried = true;
            if (!refreshed) {
              let advs = [];
              try {
                advs = await this._scan('discover');
              } catch (err) {
                this.error(`discover refresh failed: ${err.message || err}`);
              }
              const sg = this._bridgeNodes(advs);
              for (const adv of sg) this._cacheAdv(adv.uuid, adv);
              if (!this._held) this._reportScanSignal(sg);
              refreshed = sg.find((a) => a.uuid === this._preferredUuid) || null;
              // Preferred node not visible this round. Background status reaches
              // both lamps through ANY node (it is a mesh), so fall back to the
              // strongest reachable SG node instead of failing the whole poll.
              if (!refreshed && purpose === 'status' && sg.length) {
                const bestSg = [...sg]
                  .sort((a, b) => (Number(b.rssi) || -999) - (Number(a.rssi) || -999))[0];
                if (bestSg) {
                  refreshed = bestSg;
                  this._status(`STATUS fallback bridge: ${bestSg.localName || bestSg.uuid} rssi=${bestSg.rssi}`);
                }
              }
            }
            cands = refreshed ? [refreshed] : [];
            fastCacheTried = true;
            if (refreshed) {
              this._status(`${tag} refreshed bridge: ${refreshed.localName || refreshed.uuid}`);
            }
          }
        } else if (pinPreferred && fastCacheTried) {
          cands = [];
        } else {
          cands = await this._candidates();
        }

        if (preferredOnly && cands.length) {
          const preferred = this._preferredUuid
            ? cands.find((a) => a.uuid === this._preferredUuid)
            : null;
          cands = [preferred || cands[0]];
        }

        if (preempted()) throw preemptError();

        if (!cands.length) {
          lastError = new Error(pinPreferred
            ? 'Preferred SG bridge unavailable'
            : 'No SG bridge node in range');
          if (pinPreferred || singleRound) break;
          await this._sleep(RETRY_DELAY_MS);
          continue;
        }

        // While the best node answers, skip nodes that are much weaker, and give
        // the best one more try after it dropped the link.
        const bestRssi = Number(cands[0] && cands[0].rssi);
        const bestRssiKnown = Number.isFinite(bestRssi) && bestRssi < 0;
        let bestAnswered = false;
        let bestRetried = false;
        for (let i = 0; i < cands.length; i += 1) {
          const adv = cands[i];
          if (Date.now() >= deadline) break;
          if (preempted()) throw preemptError();
          const rssi = Number(adv.rssi);
          if (i > 0 && bestAnswered && bestRssiKnown && Number.isFinite(rssi) && rssi < 0
            && rssi < bestRssi - WEAK_FALLBACK_DB) {
            this._status(`skipping ${this._nodeNameFor(adv) || adv.uuid} (${rssi} dBm): more than ${WEAK_FALLBACK_DB} dB weaker than a bridge that still answers`);
            continue;
          }
          let answered = false;
          try {
            this._stage = 'connecting';
            this.log(`CONN begin via ${adv.localName} (${adv.uuid}) rssi=${adv.rssi}`);

            const sinceHangup = Date.now() - (this._hangupAt || 0);
            const connectMs = sinceHangup < AFTER_HANGUP_WINDOW_MS ? CONNECT_AFTER_HANGUP_TIMEOUT_MS : CONNECT_TIMEOUT_MS;
            const peripheral = await this._connectWithTimeout(adv, connectMs);
            answered = true;
            if (i === 0) bestAnswered = true;
            this._peripheral = peripheral;
            this._cacheAdv(adv.uuid, adv);

            this._bridgeLocalName = this._nodeNameFor(adv);
            const nodeMatch = this._bridgeLocalName.match(/@ND([0-9A-Fa-f]{4})/);
            this._bridgeNodeId = nodeMatch ? parseInt(nodeMatch[1], 16) : null;

            this._connNo += 1;
            this._connStartedAt = Date.now();
            const myConnNo = this._connNo;
            this._stage = 'connected';
            this.log(`CONN connected #${myConnNo} t=+0ms`);

            // Homey can reuse the same BlePeripheral/EventEmitter object across
            // reconnects. Remove our previous disconnect listener before adding
            // the new one; otherwise listeners accumulate and Node eventually
            // raises MaxListenersExceededWarning.
            this._removeDisconnectListener();
            const onDisconnect = () => {
              if (myConnNo !== this._connNo || this._peripheral !== peripheral) return;
              this._disconnectPeripheral = null;
              this._disconnectListener = null;
              const elapsed = this._connStartedAt ? Date.now() - this._connStartedAt : -1;
              this._hangupAt = Date.now();
              this.error(
                `REMOTE DISCONNECT #${myConnNo} t=+${elapsed}ms ` +
                `stage=${this._stage}`
              );

              // The dimmer hung up. The SDK tidies up inside the app but does not
              // tell Homey's core, which keeps the peripheral marked as in use
              // by this app until disconnect() is called. Call it.
              if (this._peripheral === peripheral) {
                this._disconnect('remote-hangup').catch((err) => {
                  this.error(`disconnect after hang-up failed: ${err.message || err}`);
                });
              }
            };
            this._disconnectPeripheral = peripheral;
            this._disconnectListener = onDisconnect;
            peripheral.once('disconnect', onDisconnect);

            // If a user command arrived while a background status connect was
            // in flight, stop here before spending the rest of the node's short
            // ~10s GATT lifetime on status service discovery. TX will reconnect
            // immediately using the cached preferred bridge.
            if (preempted()) {
              await this._disconnect('status-preempted-after-connect');
              throw preemptError();
            }

            await this._sleep(POST_CONNECT_DELAY_MS);
            if (preempted()) {
              await this._disconnect('status-preempted-before-service');
              throw preemptError();
            }

            this._stage = 'get-service';
            this.log(`GATT getService FEF1 #${myConnNo} t=+${this._elapsed()}ms`);
            const service = await peripheral.getService(SERVICE_UUID);
            this._assertConnectionAlive(peripheral, myConnNo, 'service discovery');
            if (!service) throw new Error('FEF1 service not found');
            if (preempted()) {
              await this._disconnect('status-preempted-after-service');
              throw preemptError();
            }
            this.log(`GATT gotService FEF1 #${myConnNo} t=+${this._elapsed()}ms`);

            this._stage = 'discover-chars';
            this.log(`GATT discover 8003/8004 #${myConnNo} t=+${this._elapsed()}ms`);
            const chars = await service.discoverCharacteristics([CHAR_8003, CHAR_8004]);
            this._assertConnectionAlive(peripheral, myConnNo, 'characteristic discovery');
            this._char8003 = chars.find((c) => c.uuid === CHAR_8003);
            this._char8004 = chars.find((c) => c.uuid === CHAR_8004);
            if (!this._char8003 || !this._char8004) {
              throw new Error('CSRmesh characteristics 8003/8004 missing');
            }
            if (preempted()) {
              await this._disconnect('status-preempted-after-chars');
              throw preemptError();
            }
            this.log(
              `GATT chars ready #${myConnNo} t=+${this._elapsed()}ms ` +
              `8003=${this._char8003.uuid} 8004=${this._char8004.uuid}`
            );

            // The dimmer counts its ten seconds from the connect, and
            // subscribing can take another second or more, so on a held link,
            // on one opened for a request that listens for an answer, and on a
            // status poll's link, the first heartbeat goes now, before the
            // subscription. On a held or listening link the chain starts here
            // and _sendNow writes no second one (_heartbeatConnNo). A status
            // poll's link gets this one only, which keeps it for the poll's
            // few seconds; a command sent on it later starts its own chain.
            const listening = needNotifications && (purpose === 'tx' || purpose === 'tx-recovery');
            const kept = this._held || listening;
            if ((kept || purpose === 'status') && this._canHeartbeat()) {
              if (kept) this._heartbeatConnNo = myConnNo;
              await this._writeHeartbeat().catch((err) => {
                this.log(`first heartbeat failed #${myConnNo}: ${err.message || err}`);
              });
              // The chain starts here, also if that one failed on a live link.
              if (kept && this._peripheral && myConnNo === this._connNo) this._startHeartbeat(myConnNo);
            }

            if (needNotifications && !this._notifySubscribed) {
              try {
                this._stage = 'subscribe-8004';
                const generation = ++this._notifyGeneration;
                this.log(`GATT subscribe 8004 BEGIN #${myConnNo} t=+${this._elapsed()}ms`);
                const onFrag = (src, data) => {
                  if (generation !== this._notifyGeneration) return;
                  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
                  const hex = buf.toString('hex');
                  const key = src + ':' + hex;
                  if (key === this._lastFragKey) { this._fragRepeat = (this._fragRepeat || 0) + 1; return; }
                  if (this._lastFragKey && this._fragRepeat) {
                    this.log(`RX ${this._lastFragSrc} (x${this._fragRepeat + 1} repeats collapsed)`);
                  }
                  this._lastFragKey = key; this._lastFragSrc = src; this._fragRepeat = 0;
                  this.log(`RX ${src} #${myConnNo} t=+${this._elapsed()}ms len=${buf.length} hex=${hex} CHANGED`);
                  this._rxFeed(buf);
                };
                await this._char8004.subscribeToNotifications((d) => onFrag('8004', d));
                this._subscribedChars.push(this._char8004);
                this._assertConnectionAlive(peripheral, myConnNo, '8004 notification subscription');
                this._notifySubscribed = true;
                this.log(`GATT subscribe 8004 OK #${myConnNo} t=+${this._elapsed()}ms`);
                this._startKeyCheck();

                // 8003 notification support is diagnostic only. Its failure is
                // harmless, but a physical disconnect while trying it is not.
                try {
                  await this._char8003.subscribeToNotifications((d) => onFrag('8003', d));
                  this._subscribedChars.push(this._char8003);
                  this._assertConnectionAlive(peripheral, myConnNo, '8003 diagnostic subscription');
                  this.log(`GATT subscribe 8003 OK (diag) #${myConnNo}`);
                } catch (e) {
                  if (this._peripheral !== peripheral) throw e;
                  this.log(`GATT subscribe 8003 not supported (diag): ${e.message || e}`);
                }
              } catch (err) {
                this.error(
                  `GATT subscribe 8004 FAIL #${myConnNo} t=+${this._elapsed()}ms: ` +
                  `${err.message || err}`
                );
                // Status without a live 8004 subscription is not a usable
                // connection. Do not fall through and falsely log CONN ready.
                throw err;
              }
            }

            // TX may arrive while subscribeToNotifications() is in flight.
            // Re-check here as well; otherwise a cancelled STATUS setup could
            // still mark itself ready after TX has already torn it down.
            if (preempted()) {
              if (this.isActive()) await this._disconnect('status-preempted-after-subscribe');
              throw preemptError();
            }

            this._assertConnectionAlive(peripheral, myConnNo, 'connection setup');
            this._stage = 'ready';
            // How long this link took to become usable; see _ensureTxConnected().
            this._readyAgeMs = this._elapsed();
            this.log(`CONN ready #${myConnNo} t=+${this._elapsed()}ms via ${adv.localName}`);
            return;
          } catch (err) {
            lastError = err;
            // If a cached advertisement failed before a usable connection was
            // established, discard it. The next complete-packet retry will do
            // one fresh discovery for this same preferred bridge only.
            if (fastPreferred && this._preferredUuid && adv.uuid === this._preferredUuid) {
              const cached = this._cachedAdv(this._preferredUuid);
              if (cached === adv) this._uncacheAdv(this._preferredUuid);
            }
            if (err && err.code === 'SG_STATUS_PREEMPTED') {
              if (this.isActive()) await this._disconnect('status-preempted');
              throw err;
            }
            this.error(
              `CONN attempt failed t=+${this._elapsed()}ms stage=${this._stage}: ` +
              `${err.message || err}`
            );
            await this._disconnect('connect-failure');
            if (i === 0 && answered && !bestRetried && Date.now() + RETRY_STRONG_AFTER_MS < deadline) {
              bestRetried = true;
              this._status(`${this._nodeNameFor(adv) || adv.uuid} answered but dropped the link; one more try in ${RETRY_STRONG_AFTER_MS / 1000}s`);
              for (let waited = 0; waited < RETRY_STRONG_AFTER_MS && !preempted(); waited += 250) {
                await this._sleep(250);
              }
              i -= 1;
              continue;
            }
            if (!singleRound) await this._sleep(RETRY_DELAY_MS);
          }
        }

        // Background status gets one preferred-node connection attempt. TX is
        // different: if its cached preferred advertisement failed, allow exactly
        // one fresh discovery of that SAME preferred bridge before giving up.
        // This lets one queued command repair a stale cache while every command
        // behind it simply waits for that recovery and can reuse the connection.
        if (singleRound) break;
        if (pinPreferred && preferredRefreshTried) break;
      }
      throw lastError || new Error('Could not establish CSRmesh bridge');
    })();

    try {
      return await this._connecting;
    } finally {
      this._connecting = null;
      this._connectingPurpose = null;
    }
  }


  async _enterTxRecoveryCooldown() {
    const now = Date.now();
    this._txRecoveryCooldownUntil = Math.max(
      this._txRecoveryCooldownUntil || 0,
      now + GLOBAL_RECOVERY_COOLDOWN_MS
    );

    if (this.isActive()) {
      try { await this._disconnect('tx-global-recovery-cooldown'); }
      catch (err) { this.error(`TX cooldown disconnect failed: ${err.message || err}`); }
    }

    if (this._txRecoveryCooldownPromise) return this._txRecoveryCooldownPromise;

    this._txRecoveryCooldownPromise = (async () => {
      while (Date.now() < this._txRecoveryCooldownUntil) {
        await this._sleep(Math.max(1, this._txRecoveryCooldownUntil - Date.now()));
      }
      this._status('TX global recovery cooldown ended; retrying latest desired queue');
    })();

    try {
      await this._txRecoveryCooldownPromise;
    } finally {
      this._txRecoveryCooldownPromise = null;
    }
  }

  async _recoverPreferredTxConnection({ listen = false } = {}) {
    if (this._txRecoveryPromise) {
      this.log('TX recovery: waiting for existing recovery owner');
      return this._txRecoveryPromise;
    }

    this._txRecoveryPromise = (async () => {
      let lastError = null;

      if (this.isActive()) {
        await this._disconnect('tx-recovery-start');
      }

      if (this._preferredUuid) this._uncacheAdv(this._preferredUuid);

      for (let attempt = 1; attempt <= RECOVERY_DISCOVER_ATTEMPTS; attempt += 1) {
        this.log(`TX recovery owner: preferred find/discovery ${attempt}/${RECOVERY_DISCOVER_ATTEMPTS}`);
        let preferred = await this._findPreferredAdvertisement('TX recovery');
        let sg = preferred ? [preferred] : [];

        if (!preferred) {
          let advs = [];
          try {
            advs = await this._scan('discover');
          } catch (err) {
            lastError = err;
            this.error(`TX recovery discover ${attempt} failed: ${err.message || err}`);
          }

          sg = this._bridgeNodes(advs);
          for (const adv of sg) this._cacheAdv(adv.uuid, adv);
          if (!this._held) this._reportScanSignal(sg);
          preferred = this._preferredUuid
            ? sg.find((a) => a.uuid === this._preferredUuid)
            : null;
        }

        // Fall back to the strongest reachable SG node whenever the preferred
        // node is not visible right now (either never stored, or stored but
        // currently out of range). It is a mesh: any node reaches both lamps,
        // so TX must not fail just because one specific node went quiet. This
        // also updates the preferred pin to the node we can actually hear.
        if (!preferred && sg.length) {
          sg.sort((a, b) => (Number(b.rssi) || -999) - (Number(a.rssi) || -999));
          preferred = sg[0];
          if (preferred.uuid !== this._preferredUuid) {
            this._preferredUuid = preferred.uuid;
            this.homey.settings.set('bridgeUuid', preferred.uuid);
            this._status(`TX recovery fallback to strongest reachable: ${preferred.localName || preferred.uuid} rssi=${preferred.rssi}`);
            this.app.bridgeChanged();
          }
        }

        if (!preferred) {
          lastError = new Error('Preferred SG bridge unavailable');
        } else {
          this._cacheAdv(preferred.uuid, preferred);
          this._status(`TX recovery found bridge: ${preferred.localName || preferred.uuid} rssi=${preferred.rssi}`);
          try {
            // One connection attempt only. Recovery itself owns any further
            // discovery retries so _ensureConnected cannot start a second scan.
            await this._ensureConnected({
              fastPreferred: true,
              needNotifications: listen,
              purpose: 'tx-recovery',
              pinPreferred: true,
              singleRound: true,
            });
            if (this._elapsed() >= MAX_READY_AGE_MS) {
              const age = this._elapsed();
              this._status(`TX recovery GATT ready too late at ${age}ms; rejecting link`);
              await this._disconnect('tx-recovery-ready-too-old');
              throw new Error(`SG recovery GATT ready too late (${age}ms)`);
            }
            return;
          } catch (err) {
            lastError = err;
            this._uncacheAdv(preferred.uuid);
            this.error(`TX recovery connect ${attempt} failed: ${err.message || err}`);
          }
        }

      }

      const failure = lastError || new Error('Could not recover preferred SG bridge');
      failure.code = 'SG_RECOVERY_FAILED';
      throw failure;
    })();

    try {
      return await this._txRecoveryPromise;
    } finally {
      this._txRecoveryPromise = null;
    }
  }

  async _preemptStatusForTx() {
    // A Homey command must never inherit or await an in-flight STATUS GATT
    // setup as if it were a TX connection. Homey cannot cancel adv.connect(),
    // getService() or subscribeToNotifications(), so invalidate the status
    // generation, tear down any peripheral that already exists, then wait for
    // the old status _connecting promise to settle and be cleared. Only after
    // that may TX establish/reuse its own connection. The desired TX queue is
    // untouched while this happens, so OFF/latest-wins values cannot be lost.
    if (!this._connecting || this._connectingPurpose !== 'status') return;

    const statusConnecting = this._connecting;
    this._statusGeneration += 1;
    this._status('TX pre-empting in-flight status connection; waiting for status connect to settle');

    if (this._peripheral) {
      try {
        await this._disconnect('tx-preempt-status-connecting');
      } catch (err) {
        this.error(`TX status pre-emption disconnect failed: ${err.message || err}`);
      }
    }

    try {
      await statusConnecting;
    } catch (err) {
      // SG_STATUS_PREEMPTED / disconnect errors are expected here. TX owns the
      // next connection attempt, so do not turn them into a user-command error.
    }

    // _connecting is the inner connection promise; the outer _ensureConnected
    // finally block clears it immediately after that promise settles. Yield a
    // few ticks so TX cannot accidentally receive the just-cancelled promise.
    for (let i = 0; i < 50 && this._connecting === statusConnecting; i += 1) {
      await this._sleep(10);
    }
    if (this._connecting === statusConnecting) {
      // Defensive escape hatch. The status generation is already invalid and
      // any peripheral has been disconnected, so this stale owner must not
      // block interactive TX indefinitely.
      this.error('TX pre-emption: stale status _connecting owner did not clear; releasing it');
      this._connecting = null;
      this._connectingPurpose = null;
    }
  }

  async _ensureTxConnected({ listen = false } = {}) {
    // First separate interactive TX from any background status GATT setup.
    // This fixes the case where OFF arrived during subscribe-8004 and then
    // waited forever on the cancelled status _connecting promise.
    await this._preemptStatusForTx();

    // Guard 1: never START another complete CSRmesh packet on an already-old
    // ready connection. This is only checked between packets. A link that is
    // subscribed and still listening for an answer is not rolled: rolling it
    // loses the answers for certain, while a bridge that hangs up loses them
    // only if it does, and then goes to the usual recovery.
    if (this._peripheral && this._char8003 && this._char8004
      && (this._keepAliveMs() === 0 || !this._canHeartbeat())
      && this._elapsed() >= MAX_TX_CONN_AGE_MS && !this._listening()) {
      this._status(`TX bridge age ${this._elapsed()}ms; rolling connection before next packet`);
      await this._disconnect('tx-aged-before-next-packet');
    }
    // A request that wants an answer needs a link that listens, subscribed
    // from the start as for a status poll. One opened for commands does not
    // listen, so it goes first.
    if (listen && this._peripheral && !this._notifySubscribed) {
      await this._disconnect('tx-needs-notifications');
    }

    // Fast path means cached advertisement ONLY. If there is no cached object,
    // go straight to the single shared recovery round instead of making a
    // hidden discover() here and then another discover() in recovery.
    const cachedPreferred = this._preferredUuid
      ? this._cachedAdv(this._preferredUuid)
      : null;

    if (this._peripheral && this._char8003 && this._char8004) {
      // Already connected and usable. The advertisement cache only matters for
      // connecting; a held link outlives it, and must not be torn down to go
      // looking for a dimmer we are talking to.
      this.log(`CONN reuse #${this._connNo} t=+${this._elapsed()}ms (held link)`);
    } else if (cachedPreferred) {
      try {
        await this._ensureConnected({
          fastPreferred: true,
          needNotifications: listen,
          purpose: 'tx',
          pinPreferred: true,
          singleRound: true,
        });
      } catch (err) {
        this.error(`TX cached connect failed; handing recovery to owner: ${err.message || err}`);
        await this._recoverPreferredTxConnection({ listen });
      }
    } else {
      this._status('TX no cached preferred advertisement; handing queue to recovery owner');
      await this._recoverPreferredTxConnection({ listen });
    }

    // Guard 2 (new in 1.0.26): measure again AFTER service/characteristic
    // discovery. Logs show getService can consume 6–7 seconds. Such a link can
    // look "ready" but is already too old to trust for the first 8003 write.
    // With keep-alive on, a link is reused long after it became ready, so its
    // age says nothing; what matters is how long it took to get ready.
    const held = this._keepAliveMs() > 0 && this._canHeartbeat();
    const readyAge = held ? (this._readyAgeMs || 0) : this._elapsed();
    if (this._peripheral && this._char8003 && this._char8004
      && readyAge >= MAX_READY_AGE_MS) {
      const age = readyAge;
      this._status(`TX GATT ready too late at ${age}ms; recycling before payload`);
      await this._disconnect('tx-ready-too-old');
      await this._recoverPreferredTxConnection({ listen });

      // Recovery itself can also return a link whose GATT setup was too slow.
      // Reject it without writing; the latest-wins worker keeps the desired
      // value and retries later instead of burning a doomed packet/retry chain.
      if (!this._peripheral || !this._char8003 || !this._char8004
        || this._elapsed() >= MAX_READY_AGE_MS) {
        const badAge = this._elapsed();
        if (this.isActive()) await this._disconnect('tx-recovery-ready-too-old');
        throw new Error(`SG bridge GATT ready too late (${badAge}ms)`);
      }
    }
  }

  _cancelIdleDisconnect(why = 'by new command') {
    if (!this._disconnectTimer) return;
    this.homey.clearTimeout(this._disconnectTimer);
    this._disconnectTimer = null;
    this.log(`TX idle disconnect cancelled ${why}`);
  }

  // The link is held: "Keep dimmers connected" is on, and no pairing pause
  // (pauseForScan) runs.
  _holding() {
    return this._held && this._scanPauses === 0;
  }

  _keepAliveMs() {
    return this._holding() ? HELD_LINK_MS : KEEP_ALIVE_MS;
  }

  // How much longer the link is to be held after the last user command.
  // The heartbeat names the node it is sent through. Without that name it is
  // noise the dimmer ignores, and a link cannot be held.
  _canHeartbeat() {
    return !!this._bridgeLocalName && Number.isInteger(this._bridgeNodeId);
  }

  _keepAliveLeftMs() {
    if (this._holding()) return this._peripheral && this._canHeartbeat() ? HELD_LINK_MS : 0;
    const keep = this._keepAliveMs();
    if (!keep || !this._lastUserTxAt) return 0;
    if (this._peripheral && !this._canHeartbeat()) return 0;
    // A first generation bridge listening for an answer is kept alive until
    // the answer can have come, whatever is left of the keep-alive.
    return Math.max(0, this._lastUserTxAt + keep - Date.now(), this._listenUntil - Date.now());
  }

  _scheduleIdleDisconnect(reason = 'tx-idle') {
    this._cancelIdleDisconnect();
    const connNo = this._connNo;
    // The held link is never let go after a command; the heartbeat goes on.
    // During a pairing pause a command's link is let go as without it.
    if (this._holding()) {
      if (this._peripheral && this._canHeartbeat()) this._startHeartbeat(connNo);
      return;
    }
    const held = this._keepAliveLeftMs();
    // A link that sent a request stays until its answer can have come.
    const listening = Math.max(0, this._listenUntil - Date.now());
    const linger = Math.max(TX_IDLE_LINGER_MS, held, listening);
    if (held > 0) this._startHeartbeat(connNo);
    this.log(`TX queue empty; lingering ${linger}ms before disconnect #${connNo}`);
    this._disconnectTimer = this.homey.setTimeout(() => {
      this._disconnectTimer = null;
      if (this._txPending > 0 || this._desiredTx.size > 0) return;
      if (!this.isActive() || connNo !== this._connNo) return;
      if (held > 0) this._status(`keep-alive over; releasing link #${connNo} after ${Math.round(this._elapsed() / 1000)}s and ${this._heartbeats} heartbeat(s)`);
      this._disconnect(reason).catch((err) => this.error(`${reason} disconnect failed: ${err.message || err}`));
    }, linger);
  }

  _stopHeartbeat() {
    this._heartbeatChain = null;
    if (!this._heartbeatTimer) return;
    this.homey.clearTimeout(this._heartbeatTimer);
    this._heartbeatTimer = null;
  }

  // One heartbeat every HEARTBEAT_MS, counted from the start of the previous
  // one, for as long as this link is held. Never skipped: the dimmers do not
  // count a command as a sign of life, and hang up about 10 s after the last
  // heartbeat. A command being written finishes first (see _inWriteLane).
  _startHeartbeat(connNo) {
    // A beat waiting behind a command still belongs to the running chain.
    if (this._heartbeatChain && this._heartbeatChain.connNo === connNo) return;
    this._stopHeartbeat();
    const chain = { connNo };
    this._heartbeatChain = chain;
    this._heartbeats = 0;
    this._status(`keep-alive: holding link #${connNo} for ${Math.round(this._keepAliveLeftMs() / 1000)}s`);

    const end = () => {
      if (this._heartbeatChain === chain) this._heartbeatChain = null;
    };
    const current = () => this._heartbeatChain === chain && !this._shuttingDown
      && connNo === this._connNo && !!this._peripheral;

    const beat = async () => {
      this._heartbeatTimer = null;
      if (!current() || !this._char8003 || !this._char8004 || this._keepAliveLeftMs() <= 0) {
        end();
        return;
      }
      let startedAt;
      try {
        startedAt = await this._writeHeartbeat();
        this._heartbeats += 1;
        // About every ten minutes.
        if (this._heartbeats % 200 === 0) {
          this._status(`keep-alive: link #${connNo} alive ${Math.round(this._elapsed() / 1000)}s, ${this._heartbeats} heartbeats`);
        }
      } catch (err) {
        // The link is gone or going. The next command reconnects as usual.
        this._status(`keep-alive: heartbeat failed on link #${connNo} after ${Math.round(this._elapsed() / 1000)}s: ${err.message || err}`);
        end();
        return;
      }
      if (!current()) {
        end();
        return;
      }
      this._heartbeatTimer = this.homey.setTimeout(beat, Math.max(0, HEARTBEAT_MS - (Date.now() - startedAt)));
    };

    // Not right on top of the one a new link was opened with.
    const since = Date.now() - (this._lastHeartbeatAt || 0);
    this._heartbeatTimer = this.homey.setTimeout(beat, Math.max(0, HEARTBEAT_MS - since));
  }

  // Runs one packet write after the ones already waiting. A failed write does
  // not hold up the next.
  _inWriteLane(write) {
    const run = this._writeLane.then(write, write);
    this._writeLane = run.catch(() => {});
    return run;
  }

  // The heartbeat a first generation dimmer keeps the link for: CC 40 <two
  // letters of the bridge's name> <bridge id> and four zero bytes, to the
  // address every dimmer listens on.
  async _writeHeartbeat() {
    const name = String(this._bridgeLocalName || '');
    const nodeId = this._bridgeNodeId || 0;
    const data = Buffer.from([
      ...addrBytes(ADDR_DEVICES), MCP_DATA_BLOCK, OP_DATA_HEARTBEAT, 0x40,
      name.charCodeAt(1) & 0xff, name.charCodeAt(2) & 0xff,
      (nodeId >> 8) & 0xff, nodeId & 0xff, 0x00, 0x00, 0x00, 0x00,
    ]);
    const packet = makePacket(this.app.getNetworkKey(), this.app.nextSeq(), data);
    const char8003 = this._char8003;
    const char8004 = this._char8004;
    const connNo = this._connNo;
    // Returns when the write started, which the next beat counts from.
    let startedAt = 0;
    await this._inWriteLane(async () => {
      // It may have waited behind a command on a link that is gone now.
      if (connNo !== this._connNo || !this._peripheral) throw new Error('link gone before the heartbeat');
      startedAt = Date.now();
      await char8003.write(packet.subarray(0, 20));
      await this._sleep(LOW_HIGH_GAP_MS);
      await char8004.write(packet.subarray(20));
    });
    this._lastHeartbeatAt = startedAt;
    this._heartbeatsTotal += 1;
    return startedAt;
  }

  _removeDisconnectListener() {
    const peripheral = this._disconnectPeripheral;
    const listener = this._disconnectListener;
    this._disconnectPeripheral = null;
    this._disconnectListener = null;
    if (!peripheral || !listener) return;
    try {
      if (typeof peripheral.off === 'function') peripheral.off('disconnect', listener);
      else if (typeof peripheral.removeListener === 'function') peripheral.removeListener('disconnect', listener);
    } catch (err) {
      this.error(`disconnect-listener cleanup failed: ${err.message || err}`);
    }
  }

  async _disconnect(reason = 'local') {
    // A teardown already in flight owns the radio; joining it is the only safe
    // thing to do. Starting a second one races the first to disconnect().
    if (this._disconnecting) return this._disconnecting.catch(() => {});

    if (this._disconnectTimer) {
      this.homey.clearTimeout(this._disconnectTimer);
      this._disconnectTimer = null;
    }
    this._stopHeartbeat();

    // Capture and invalidate synchronously, so nothing can reuse this link
    // while it is being released.
    const peripheral = this._peripheral;
    const subscribed = this._subscribedChars;
    const connNo = this._connNo;
    const elapsed = this._elapsed();

    this._removeDisconnectListener();
    this.log(`LOCAL DISCONNECT request #${connNo} t=+${elapsed}ms reason=${reason} stage=${this._stage}`);
    this._stage = `local-disconnect:${reason}`;

    this._notifyGeneration += 1;
    this._peripheral = null;
    this._char8003 = null;
    this._char8004 = null;
    this._notifySubscribed = false;
    this._subscribedChars = [];

    if (!peripheral && !subscribed.length) return undefined;

    // isActive() reports true for the whole teardown, so _ensureConnected and
    // the status poll wait instead of opening a second connection.
    this._disconnecting = (async () => {
      // Homey wants notification subscriptions released before the link goes
      // down, and unsubscribing throws once it is already gone. After a
      // hang-up there is nothing left to release.
      for (const characteristic of (reason === 'remote-hangup' ? [] : subscribed)) {
        if (!characteristic || typeof characteristic.unsubscribeFromNotifications !== 'function') continue;
        try {
          await characteristic.unsubscribeFromNotifications();
          this.log(`GATT unsubscribe ${characteristic.uuid === CHAR_8003 ? '8003' : '8004'} OK #${connNo}`);
        } catch (err) {
          this.error(`GATT unsubscribe FAIL #${connNo}: ${err.message || err}`);
        }
      }

      if (!peripheral) return;
      try {
        await peripheral.disconnect();
        this.log(`LOCAL DISCONNECT done #${connNo}`);
      } catch (err) {
        if (reason === 'remote-hangup') {
          // Expected: the dimmer is gone already, and Homey says so. The
          // advertisement is still good for the next connect; keep it.
          this.log(`LOCAL DISCONNECT after hang-up #${connNo}: ${err.message || err}`);
          return;
        }
        this.error(`LOCAL DISCONNECT call failed #${connNo}: ${err.message || err}`);
        if (/Peripheral Not Found/i.test(String(err.message || err)) && this._preferredUuid) {
          this._uncacheAdv(this._preferredUuid);
          this.log('cleared stale preferred advertisement after Peripheral Not Found');
        }
      }
    })();

    try {
      return await this._disconnecting;
    } finally {
      this._disconnecting = null;
    }
  }

  // Called when the app is stopped or updated. Homey's BLE stack lives outside
  // the app process, so a connection left open here survives an app restart and
  // can only be cleared by rebooting Homey. Always hand the radio back.
  async shutdown() {
    this._shuttingDown = true;
    this._statusGeneration += 1;

    for (const timer of ['_statusTimer', '_disconnectTimer', '_rxDecodeTimer', '_heartbeatTimer', '_heldTimer', '_heldRescanTimer', '_modeTimer', '_keyCheckTimer']) {
      if (this[timer]) {
        this.homey.clearTimeout(this[timer]);
        this[timer] = null;
      }
    }
    if (this._heldSummaryTimer) {
      this.homey.clearInterval(this._heldSummaryTimer);
      this._heldSummaryTimer = null;
    }

    this._desiredTx.clear();
    this._txPending = 0;

    // Let an in-flight connect settle; we cannot disconnect what we do not
    // hold yet, and Homey offers no way to cancel adv.connect().
    if (this._connecting) await this._connecting.catch(() => {});

    if (this._peripheral || this._subscribedChars.length) {
      await this._disconnect('app-unload').catch(() => {});
    }
    if (this._disconnecting) await this._disconnecting.catch(() => {});

    this._advCache.clear();
    this.app.log('[MeshBridge] radio released on shutdown');
  }

  async _writeFragment(charName, characteristic, data, sendNo) {
    const hex = data.toString('hex');
    const begin = Date.now();
    this._stage = `TX#${sendNo}:${charName}:write`;
    this.log(
      `TX#${sendNo} ${charName} BEGIN #${this._connNo} ` +
      `t=+${this._elapsed()}ms len=${data.length} hex=${hex}`
    );

    try {
      await characteristic.write(data);
      const took = Date.now() - begin;
      this._stage = `TX#${sendNo}:${charName}:ok`;
      this.log(
        `TX#${sendNo} ${charName} OK #${this._connNo} ` +
        `t=+${this._elapsed()}ms write=${took}ms`
      );
    } catch (err) {
      const took = Date.now() - begin;
      this._stage = `TX#${sendNo}:${charName}:fail`;
      this.error(
        `TX#${sendNo} ${charName} FAIL #${this._connNo} ` +
        `t=+${this._elapsed()}ms write=${took}ms: ${err.message || err}`
      );
      throw err;
    }
  }

  async _sendNow(packet, tx = {}) {
    const sendNo = ++this._sendNo;
    const first = packet.length > GATT_PART_MAX ? packet.subarray(0, GATT_PART_MAX) : null;
    const last = first ? packet.subarray(GATT_PART_MAX) : packet;

    this.log(
      `TX#${sendNo} PACKET queued len=${packet.length} ` +
      `to=${first ? `8003(${first.length})+8004(${last.length})` : `8004(${last.length})`} ` +
      `hex=${packet.toString('hex')}`
    );

    // One initial attempt + exactly one complete-packet retry. SG nodes can
    // drop the GATT link between 8003 and 8004. Retrying only when 8003 had NOT
    // been written left those commands lost; always rebuild the GATT transfer
    // from fragment 1 on a fresh connection after any write failure.
    const isCurrent = typeof tx.isCurrent === 'function' ? tx.isCurrent : () => true;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let firstWritten = false;
      try {
        if (!isCurrent()) {
          this.log(`TX#${sendNo} superseded before attempt ${attempt}`);
          return { superseded: true };
        }
        // Command path uses the cached preferred advertisement first. A recent
        // status scan has already populated it, avoiding the ~10s discover().
        await this._ensureTxConnected({ listen: tx.listenMs > 0 });

        // Discovery/recovery can take many seconds. If a newer target arrived
        // while we were waiting, never transmit this obsolete packet.
        if (!isCurrent()) {
          this.log(`TX#${sendNo} superseded after connect/recovery`);
          return { superseded: true };
        }

        // A dimmer counts its ten seconds from the connect, and a slow GATT
        // setup can use eight of them. On a new link that is to be held, the
        // heartbeat therefore goes first.
        if (this._keepAliveMs() > 0 && this._canHeartbeat() && this._heartbeatConnNo !== this._connNo) {
          this._heartbeatConnNo = this._connNo;
          const connNo = this._connNo;
          await this._writeHeartbeat().catch((err) => {
            this._status(`keep-alive: first heartbeat failed on link #${connNo}: ${err.message || err}`);
          });
          // The chain starts here, not when the queue is empty: a burst of
          // commands can take longer than the dimmer waits. Also if that
          // heartbeat failed on a link that is still up.
          if (this._peripheral && connNo === this._connNo) this._startHeartbeat(connNo);
        }

        // Never between the two fragments of a heartbeat, nor a heartbeat
        // between these two.
        await this._inWriteLane(async () => {
          if (first) {
            await this._writeFragment(
              attempt === 1 ? '8003' : '8003-retry',
              this._char8003,
              first,
              sendNo
            );
            firstWritten = true;
            this._stage = `TX#${sendNo}:gap`;
            this.log(`TX#${sendNo} GAP ${LOW_HIGH_GAP_MS}ms BEGIN t=+${this._elapsed()}ms`);
            await this._sleep(LOW_HIGH_GAP_MS);
            this.log(`TX#${sendNo} GAP END t=+${this._elapsed()}ms`);
          }
          await this._writeFragment(
            attempt === 1 ? '8004' : '8004-retry',
            this._char8004,
            last,
            sendNo
          );
        });

        this._stage = attempt === 1
          ? `TX#${sendNo}:complete`
          : `TX#${sendNo}:complete-after-retry`;
        this.log(
          attempt === 1
            ? `TX#${sendNo} COMPLETE #${this._connNo} t=+${this._elapsed()}ms`
            : `TX#${sendNo} COMPLETE after retry #${this._connNo} t=+${this._elapsed()}ms`
        );
        if (tx.listenMs > 0) this._listenUntil = Math.max(this._listenUntil, Date.now() + tx.listenMs);
        // No delayed keepalive. send()'s finally disconnects when the queue
        // is empty so the whole Homey burst rides one short connection.
        return;
      } catch (err) {
        const msg = err.message || String(err);
        this.error(
          `TX#${sendNo} ABORT attempt=${attempt}/2 firstWritten=${firstWritten} ` +
          `conn=#${this._connNo} t=+${this._elapsed()}ms stage=${this._stage}: ${msg}`
        );

        await this._disconnect(`tx${sendNo}-attempt${attempt}-failure`);

        if (!isCurrent()) {
          this.log(`TX#${sendNo} superseded after failure; no retry`);
          return { superseded: true };
        }
        // A failed shared recovery is already the queue-level failure. Do NOT
        // immediately start another packet retry/recovery cycle for this same
        // device; the desired worker retains all latest values and applies the
        // global 5-second circuit breaker.
        if (err && err.code === 'SG_RECOVERY_FAILED') throw err;
        if (attempt === 2) throw err;
        this._status(`TX#${sendNo} failed; retrying complete packet once`);
        await this._sleep(150);
      }
    }
  }

}

module.exports = MeshBridge;
