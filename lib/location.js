'use strict';

// The home's location id, learned from a dimmer's status (see sgProtocol).
// The first one heard is taken at once. A learned one changes only when
// another comes CHANGE_AFTER times in a row, without the learned one in
// between: a dimmer paired again in another SG home sends its new one every
// time, while another home's dimmer that happens to have the same id does not
// take over.
const CHANGE_AFTER = 3;

// state is { value, other, count }: the learned location id (or null), and
// another one heard count times in a row since. Returns the next state and
// what the status meant: 'learned' (the first), 'changed', 'same' (the learned
// one again), 'other' (another one, not taken yet) or 'invalid'.
function learnLocation(state, location) {
  const current = state || { value: null, other: null, count: 0 };
  if (!Number.isInteger(location) || location < 0 || location > 0xffff) return { state: current, outcome: 'invalid' };
  if (current.value === null) return { state: { value: location, other: null, count: 0 }, outcome: 'learned' };
  if (location === current.value) return { state: { value: location, other: null, count: 0 }, outcome: 'same' };
  const count = current.other === location ? current.count + 1 : 1;
  if (count >= CHANGE_AFTER) return { state: { value: location, other: null, count: 0 }, outcome: 'changed' };
  return { state: { value: current.value, other: location, count }, outcome: 'other' };
}

// A status not taken because its location id is another than the stored
// one (outcome 'other', before CHANGE_AFTER in a row change it): the line to
// log (what: "status FF05", "FF3D" and the like), with how many in a row and
// no id, or null when it is not to be logged. The same line at most once in
// windowMs, and at most perWindow lines in it, the limits lib/CsrNetwork.js
// logs one sender with; seen (a Map kept by the device) holds the lines
// logged in the window.
function otherLocationLine(seen, state, what, now, { windowMs, perWindow }) {
  for (const [text, at] of seen) if (now - at >= windowMs) seen.delete(text);
  const line = `${what} not taken: another location id than the stored one `
    + `(${state.count} of ${CHANGE_AFTER} in a row)`;
  if (seen.has(line) || seen.size >= perWindow) return null;
  seen.set(line, now);
  return line;
}

module.exports = { CHANGE_AFTER, learnLocation, otherLocationLine };
