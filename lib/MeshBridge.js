'use strict';

const { decryptPayload, NODE_NAME } = require('./csrmesh');

const SERVICE_UUID = '0000fef100001000800000805f9b34fb';
const CHAR_8003 = 'c4edc0009daf11e3800300025b000b00';
const CHAR_8004 = 'c4edc0009daf11e3800400025b000b00';

const CONNECT_WINDOW_MS = 20000;
const CONNECT_TIMEOUT_MS = 12000; // hard cap on a single adv.connect() so a hung connect can't wedge recovery
const RETRY_DELAY_MS = 1200;
const POST_CONNECT_DELAY_MS = 250;
// Keep a successfully prepared GATT link alive very briefly after the desired
// queue drains. Homey capability updates often arrive a few hundred ms apart;
// this lets them share the same SG connection without a full disconnect/reconnect.
// This is NOT a heartbeat or persistent BLE connection.
const TX_IDLE_LINGER_MS = 400;
const LOW_HIGH_GAP_MS = 25;
// SG Gen1 often drops the GATT link around 9.5–10 s after connect.
// Never START another packet once the current link is this old.
const MAX_TX_CONN_AGE_MS = 7000;
// A connection that only becomes GATT-ready this late is already in the danger
// zone. Never start user payload on it; recycle it before writing byte one.
const MAX_READY_AGE_MS = 14000; // this radio's getService legitimately takes 6-8s; don't reject slow-but-successful links
const GLOBAL_RECOVERY_COOLDOWN_MS = 5000;
// Status polling is the only way Homey learns about changes made at the wall
// switch: only the poll subscribes to 8003/8004, TX connections never do.
// Each poll is a short connect/listen/disconnect cycle, but one in flight
// delays a concurrent command, and the mesh notifications it takes in
// measurably slow GATT discovery (median 1432ms quiet vs 1921ms under load).
// Five minutes keeps the tiles converging without crowding interactive use.
const DEFAULT_STATUS_POLL_MS = 300000;
// One recovery round for the whole desired-TX queue. If it fails, retain only
// the latest desired values and leave BLE alone for 5 seconds before the
// worker tries again. Do not let each queued device start its own recovery.
const RECOVERY_DISCOVER_ATTEMPTS = 1;
// A BleAdvertisement is a snapshot from one scan. Connecting to a stale one
// yields "Peripheral Not Found" and leaves the radio in a worse state than a
// fresh scan would, so cached advertisements expire.
const ADV_CACHE_TTL_MS = 60000;

class MeshBridge {
  constructor(app) {
    this.app = app;
    this.homey = app.homey;
    this._peripheral = null;
    this._connecting = null;
    this._char8003 = null;
    this._char8004 = null;
    this._notifySubscribed = false;
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

  _rxFeed(buf) {
    const now = Date.now();
    if (!this._rxAccum || (now - (this._rxAccumAt || 0)) > 300) this._rxAccum = Buffer.alloc(0);
    this._rxAccum = Buffer.concat([this._rxAccum, buf]).subarray(-64);
    this._rxAccumAt = now;
    if (this._rxDecodeTimer) this.homey.clearTimeout(this._rxDecodeTimer);
    this._rxDecodeTimer = this.homey.setTimeout(() => this._rxDecode(this._rxAccum), 220);
  }

  _rxDecode(frame) {
    try {
      if (!frame || frame.length < 14) return;
      // All devices on one CSRmesh network share a key; take it from a paired device.
      const key = this.app.getNetworkKey();
      for (let start = 0; start <= Math.max(0, frame.length - 14); start += 1) {
        for (let end = frame.length; end >= start + 14; end -= 1) {
          const b = frame.subarray(start, end);
          const seq = b.subarray(0, 3);
          const src = b.subarray(3, 5);
          const payload = b.subarray(5, b.length - 9);
          if (payload.length < 4 || payload.length > 24) continue;
          const chex = decryptPayload(key, seq, src, payload).toString('hex');
          // Real SG status frame: 73 f7 f2 e7 <idHi idLo> 01 00 00 03 <level 0..64>
          const m = chex.match(/73f7f2e7([0-9a-f]{4})0100000(?:0|3)([0-9a-f]{2})/);
          if (m) {
            const level = parseInt(m[2], 16);
            if (level >= 0 && level <= 100) {
              const statusId = m[1].toLowerCase();
              const duplicateInPoll = this._statusSeen && this._statusSeen.has(statusId);
              if (!duplicateInPoll) {
                this._status(`STATUS id=0x${statusId} level=${level}`);
                if (typeof this._onStatus === 'function') this._onStatus(statusId, level);
              }

              if (this._statusWanted && this._statusWanted.has(statusId)) {
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
                    // while a Homey/Apple command is queued or being transmitted.
                    if (this._txPending > 0) return;
                    if (this.isActive()) this._disconnect('paired-status-complete').catch((e) => {
                      this.error(`paired-status disconnect failed: ${e.message || e}`);
                    });
                  }, 0);
                }
              }
              return;
            }
          }
        }
      }
    } catch (e) { /* ignore */ }
  }

  _cacheAdv(uuid, adv) { this._advCache.set(uuid, { adv, at: Date.now() }); }

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

  // DIAGNOSTIC listen mode: hold a connection open and re-establish it whenever
  // it drops, so we hear inbound 8003/8004 traffic continuously while the user
  // changes the lights physically.
  startStatus(handler) {
    this._onStatus = handler;
    this._statusRunning = false;
    const interval = this._statusPollMs();
    this._status(interval > 0
      ? `status polling enabled (interval ${interval}ms, first poll immediate)`
      : 'status polling disabled');
    if (interval <= 0) return;
    // Do not wait 30 seconds after app startup before the first status attempt.
    // BLE connect/subscription/RX behavior below is intentionally unchanged from v1.0.1.
    this._scheduleStatusPoll(500);
  }

  refreshStatusPolling() {
    // Invalidate any poll already in progress and cancel its next timer.
    // A BLE connect already in flight cannot be cancelled by Homey, but the
    // generation guard prevents that old poll from continuing/retrying.
    this._statusGeneration += 1;
    if (this._statusTimer) {
      this.homey.clearTimeout(this._statusTimer);
      this._statusTimer = null;
    }

    const interval = this._statusPollMs();
    this._status(interval > 0
      ? `status interval changed live to ${interval}ms; scheduling poll`
      : 'status polling disabled live');

    if (interval > 0) {
      // Apply the new setting immediately; no app restart required.
      this._scheduleStatusPoll(250);
    }
  }

  _statusPollMs() {
    // Robust default: only an explicit sane value (>= 5000 ms) overrides the
    // default. A stored blank / garbage value can no longer switch status off;
    // only an explicit 0 does. Polling competes with commands for the single
    // radio and adds mesh traffic that slows GATT discovery down, so the
    // default is deliberately infrequent.
    const raw = this.homey.settings.get('statusPollMs');
    if (raw === 0 || raw === '0') return 0;
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 5000) return v;
    return DEFAULT_STATUS_POLL_MS;
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

    // Never start a background BLE session while the user is actively using
    // the lights. Homey's adv.connect() cannot be cancelled once it is in
    // flight, so avoiding collisions is more reliable than trying to pre-empt
    // a pending connect.
    const quietMs = 15000;
    const sinceTx = this._lastTxAt ? Date.now() - this._lastTxAt : quietMs;
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
      const elapsed = Date.now() - startedAt;
      const nextIn = Math.max(1000, interval - elapsed);
      this._scheduleStatusPoll(nextIn);
    }
  }

  _status(...a) {
    if (this.homey.settings.get('loggingEnabled') !== false) this.app.log('[SG status]', ...a);
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
        const result = await this._sendNow(entry.packet, { txKey, isCurrent });
        if (result && result.superseded) {
          // A newer value already replaced this entry; leave the replacement.
          continue;
        }
        if (isCurrent()) {
          this._desiredTx.delete(txKey);
          entry.resolve({ ok: true });
        }
      } catch (err) {
        if (!isCurrent()) continue;

        if (err && err.code === 'SG_RECOVERY_FAILED') {
          // Circuit breaker for the ENTIRE desired queue. Keep the latest value
          // for every target, stop all BLE activity for 5 seconds, then let one
          // worker make one new recovery round. No per-device retry storm.
          this.error(`TX recovery round failed; retaining latest queue and cooling down ${GLOBAL_RECOVERY_COOLDOWN_MS}ms: ${err.message || err}`);
          await this._enterTxRecoveryCooldown();
          continue;
        }

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

    const sg = advs
      .filter((a) => NODE_NAME.test(String(a.localName || '').trim()) && a.connectable !== false)
      .sort((a, b) => (Number(b.rssi) || -999) - (Number(a.rssi) || -999));

    // Cache fresh advertisement objects for the command fast-path. This is the
    // key latency fix: later TX can call connect() immediately instead of doing
    // another full discover() scan first.
    for (const adv of sg) this._cacheAdv(adv.uuid, adv);

    if (!sg.length) return [];

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
      this._status(`bridge selected by RSSI: ${chosen.localName} ${chosen.rssi} dBm`);
    }

    // Try the RSSI-selected node first, then the remaining nodes strongest-first
    // as fallbacks for this connection attempt. A fallback success does NOT
    // replace the preferred bridge.
    return [chosen, ...sg.filter((a) => a.uuid !== chosen.uuid)];
  }

  async _findPreferredAdvertisement(label = 'preferred') {
    if (!this._preferredUuid) return null;
    try {
      await this._releaseRadio('find');
      const adv = await this.homey.ble.find(this._preferredUuid);
      if (adv && adv.connectable !== false) {
        this._cacheAdv(adv.uuid, adv);
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
    const preempted = () => abortOnTx && this._txPending > 0;
    const preemptError = () => {
      const e = new Error('Status connection pre-empted by user TX');
      e.code = 'SG_STATUS_PREEMPTED';
      return e;
    };
    // Status listening needs notifications; user TX does not. Skipping the
    // notification subscriptions on a cold TX connection removes a slow and
    // failure-prone GATT step before the first write.
    const needNotifications = options.needNotifications !== false;
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
            this._status(`${purpose === 'status' ? 'STATUS' : 'TX'} fast bridge: ${cached.localName || cached.uuid} (cached advertisement)`);
          } else {
            // First ask Homey for the already-known preferred UUID. find()
            // is normally much cheaper than a full discover() and also gives
            // us a fresh BleAdvertisement object after a stale cached object.
            let refreshed = await this._findPreferredAdvertisement(
              `${purpose === 'status' ? 'STATUS' : 'TX'} preferred`
            );
            preferredRefreshTried = true;
            if (!refreshed) {
              let advs = [];
              try {
                advs = await this._scan('discover');
              } catch (err) {
                this.error(`discover refresh failed: ${err.message || err}`);
              }
              const sg = advs.filter((a) => NODE_NAME.test(String(a.localName || '').trim()) && a.connectable !== false);
              for (const adv of sg) this._cacheAdv(adv.uuid, adv);
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
              this._status(`${purpose === 'status' ? 'STATUS' : 'TX'} refreshed bridge: ${refreshed.localName || refreshed.uuid}`);
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

        for (const adv of cands) {
          if (Date.now() >= deadline) break;
          if (preempted()) throw preemptError();
          try {
            this._stage = 'connecting';
            this.log(`CONN begin via ${adv.localName} (${adv.uuid}) rssi=${adv.rssi}`);

            const peripheral = await this._connectWithTimeout(adv, CONNECT_TIMEOUT_MS);
            this._peripheral = peripheral;
            this._cacheAdv(adv.uuid, adv);

            this._bridgeLocalName = String(adv.localName || '');
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
              this.error(
                `REMOTE DISCONNECT #${myConnNo} t=+${elapsed}ms ` +
                `stage=${this._stage}`
              );

              if (this._peripheral === peripheral) {
                this._peripheral = null;
                this._char8003 = null;
                this._char8004 = null;
                this._notifySubscribed = false;
                // The peripheral is already gone, so unsubscribing would throw;
                // Homey releases the subscriptions with the connection. Just
                // drop our references so the next link starts clean.
                this._subscribedChars = [];
                this._notifyGeneration += 1;
              }
              this._stage = 'disconnected';
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

  async _recoverPreferredTxConnection() {
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

          sg = advs.filter((a) =>
            NODE_NAME.test(String(a.localName || '').trim()) && a.connectable !== false
          );
          for (const adv of sg) this._cacheAdv(adv.uuid, adv);
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
              needNotifications: false,
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

  async _ensureTxConnected() {
    // First separate interactive TX from any background status GATT setup.
    // This fixes the case where OFF arrived during subscribe-8004 and then
    // waited forever on the cancelled status _connecting promise.
    await this._preemptStatusForTx();

    // Guard 1: never START another complete CSRmesh packet on an already-old
    // ready connection. This is only checked between packets.
    if (this._peripheral && this._char8003 && this._char8004
      && this._elapsed() >= MAX_TX_CONN_AGE_MS) {
      this._status(`TX bridge age ${this._elapsed()}ms; rolling connection before next packet`);
      await this._disconnect('tx-aged-before-next-packet');
    }

    // Fast path means cached advertisement ONLY. If there is no cached object,
    // go straight to the single shared recovery round instead of making a
    // hidden discover() here and then another discover() in recovery.
    const cachedPreferred = this._preferredUuid
      ? this._cachedAdv(this._preferredUuid)
      : null;

    if (cachedPreferred) {
      try {
        await this._ensureConnected({
          fastPreferred: true,
          needNotifications: false,
          purpose: 'tx',
          pinPreferred: true,
          singleRound: true,
        });
      } catch (err) {
        this.error(`TX cached connect failed; handing recovery to owner: ${err.message || err}`);
        await this._recoverPreferredTxConnection();
      }
    } else {
      this._status('TX no cached preferred advertisement; handing queue to recovery owner');
      await this._recoverPreferredTxConnection();
    }

    // Guard 2 (new in 1.0.26): measure again AFTER service/characteristic
    // discovery. Logs show getService can consume 6–7 seconds. Such a link can
    // look "ready" but is already too old to trust for the first 8003 write.
    if (this._peripheral && this._char8003 && this._char8004
      && this._elapsed() >= MAX_READY_AGE_MS) {
      const age = this._elapsed();
      this._status(`TX GATT ready too late at ${age}ms; recycling before payload`);
      await this._disconnect('tx-ready-too-old');
      await this._recoverPreferredTxConnection();

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

  _cancelIdleDisconnect() {
    if (!this._disconnectTimer) return;
    this.homey.clearTimeout(this._disconnectTimer);
    this._disconnectTimer = null;
    this.log('TX idle disconnect cancelled by new command');
  }

  _scheduleIdleDisconnect(reason = 'tx-idle') {
    this._cancelIdleDisconnect();
    const connNo = this._connNo;
    this.log(`TX queue empty; lingering ${TX_IDLE_LINGER_MS}ms before disconnect #${connNo}`);
    this._disconnectTimer = this.homey.setTimeout(() => {
      this._disconnectTimer = null;
      if (this._txPending > 0 || this._desiredTx.size > 0) return;
      if (!this.isActive() || connNo !== this._connNo) return;
      this._disconnect(reason).catch((err) => this.error(`${reason} disconnect failed: ${err.message || err}`));
    }, TX_IDLE_LINGER_MS);
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
      // down, and unsubscribing throws once it is already gone.
      for (const characteristic of subscribed) {
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

    for (const timer of ['_statusTimer', '_disconnectTimer', '_rxDecodeTimer']) {
      if (this[timer]) {
        this.homey.clearTimeout(this[timer]);
        this[timer] = null;
      }
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
    const first = packet.subarray(0, 20);
    const rest = packet.subarray(20);

    this.log(
      `TX#${sendNo} PACKET queued len=${packet.length} ` +
      `first=${first.length} rest=${rest.length} hex=${packet.toString('hex')}`
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
        await this._ensureTxConnected();

        // Discovery/recovery can take many seconds. If a newer target arrived
        // while we were waiting, never transmit this obsolete packet.
        if (!isCurrent()) {
          this.log(`TX#${sendNo} superseded after connect/recovery`);
          return { superseded: true };
        }

        await this._writeFragment(
          attempt === 1 ? '8003' : '8003-retry',
          this._char8003,
          first,
          sendNo
        );
        firstWritten = true;

        if (rest.length) {
          this._stage = `TX#${sendNo}:gap`;
          this.log(`TX#${sendNo} GAP ${LOW_HIGH_GAP_MS}ms BEGIN t=+${this._elapsed()}ms`);
          await this._sleep(LOW_HIGH_GAP_MS);
          this.log(`TX#${sendNo} GAP END t=+${this._elapsed()}ms`);
          await this._writeFragment(
            attempt === 1 ? '8004' : '8004-retry',
            this._char8004,
            rest,
            sendNo
          );
        }

        this._stage = attempt === 1
          ? `TX#${sendNo}:complete`
          : `TX#${sendNo}:complete-after-retry`;
        this.log(
          attempt === 1
            ? `TX#${sendNo} COMPLETE #${this._connNo} t=+${this._elapsed()}ms`
            : `TX#${sendNo} COMPLETE after retry #${this._connNo} t=+${this._elapsed()}ms`
        );
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
