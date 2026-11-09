'use strict';

// The time from a command to the device's first status, for the log: one
// line per command that is written, always on. MeshBridge.send gives the
// times of the command with its result (timing): how long it waited in the
// queue, how the bridge was found (a link already up, a cached
// advertisement, find() or a scan), the connect and the write. The device
// adds the time from the write to its first status after it, or says that
// none came in NO_STATUS_MS, or that the next command was written first. A
// command replaced in the queue before it is written has no timing, and so
// no line. The line has no address, name, mesh id or location id.

const NO_STATUS_MS = 15000;

// The line for a command's timing and how it ended: { statusMs } after a
// status, { next: true } when the next command was written first, else none
// came in NO_STATUS_MS.
function timingLine(timing, { statusMs = null, next = false } = {}) {
  const parts = [];
  if (timing.queueMs > 0) parts.push(`waited ${timing.queueMs} ms`);
  if (timing.reused && !timing.attempts) {
    parts.push('link reused');
  } else {
    if (timing.cached) parts.push('cached advertisement');
    if (timing.finds) parts.push(`find ${timing.findMs} ms`);
    if (timing.scans) parts.push(`scan ${timing.scanMs} ms`);
    parts.push(`connect ${timing.connectMs} ms${timing.attempts > 1 ? ` (${timing.attempts} attempts)` : ''}`);
  }
  parts.push(`write ${timing.writeMs} ms`);
  if (Number.isFinite(statusMs)) {
    parts.push(`status ${statusMs} ms after the write`, `${timing.toWriteMs + statusMs} ms in all`);
  } else if (next) {
    parts.push('no status before the next command');
  } else {
    parts.push(`no status in ${NO_STATUS_MS / 1000} s`);
  }
  return `command to status: ${parts.join(', ')}`;
}

// A device's command waiting for its first status: sent() with the result of
// MeshBridge.send, status() when a status from the device comes, stop() when
// the device goes. Logs through device.log.
class CommandTimer {
  constructor(device) {
    this.device = device;
    this._pending = null;
    this._timer = null;
  }

  sent(result) {
    if (!result || !result.ok || !result.timing) return;
    if (this._pending) this._end({ next: true });
    this._pending = result.timing;
    this._timer = this.device.homey.setTimeout(() => {
      this._timer = null;
      this._end({});
    }, NO_STATUS_MS);
  }

  status() {
    if (!this._pending) return;
    this._end({ statusMs: Math.max(0, Date.now() - this._pending.writtenAt) });
  }

  stop() {
    if (this._timer) this.device.homey.clearTimeout(this._timer);
    this._timer = null;
    this._pending = null;
  }

  _end(how) {
    const timing = this._pending;
    this.stop();
    if (timing) this.device.log(timingLine(timing, how));
  }
}

module.exports = { CommandTimer, NO_STATUS_MS, timingLine };
