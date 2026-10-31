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

module.exports = { CHANGE_AFTER, learnLocation };
