'use strict';

// The virtual clock of the test helpers (test/helpers/fake-homey.js,
// virtualTimers): timers run in time order as the clock is advanced, with
// the promises between them settled.
// Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { fakeHomey, virtualTimers } = require('./helpers/fake-homey');

const START = 1_700_000_000_000;

test('timers run in time order, not in the order they were set, each at its own time; the clock ends at the end', async () => {
  const clock = virtualTimers({ start: START });
  const ran = [];
  clock.setTimeout(() => ran.push(['c', clock.now() - START]), 300);
  clock.setTimeout(() => ran.push(['a', clock.now() - START]), 100);
  clock.setTimeout(() => ran.push(['b', clock.now() - START]), 200);
  await clock.advance(250);
  assert.deepEqual(ran, [['a', 100], ['b', 200]]);
  assert.equal(clock.now() - START, 250);
  await clock.advance(50);
  assert.deepEqual(ran, [['a', 100], ['b', 200], ['c', 300]]);
  assert.equal(clock.pending.size, 0);
});

test('two due at the same time run in the order they were set', async () => {
  const clock = virtualTimers();
  const ran = [];
  for (const name of ['first', 'second', 'third']) clock.setTimeout(() => ran.push(name), 500);
  await clock.advance(500);
  assert.deepEqual(ran, ['first', 'second', 'third']);
});

test('a timer set by another runs in the same advance when it is due within it, and waits when it is not', async () => {
  const clock = virtualTimers({ start: START });
  const ran = [];
  clock.setTimeout(() => {
    ran.push(clock.now() - START);
    clock.setTimeout(() => ran.push(clock.now() - START), 600);
    clock.setTimeout(() => ran.push(clock.now() - START), 2000);
  }, 220);
  await clock.advance(1000);
  assert.deepEqual(ran, [220, 820]);
  await clock.advance(1220);
  assert.deepEqual(ran, [220, 820, 2220]);
});

test('the promises between timers are settled: a chain that waits for one timer and then sets the next runs to its end', async () => {
  const clock = virtualTimers({ start: START });
  const wait = (ms) => new Promise((resolve) => clock.setTimeout(resolve, ms));
  const at = [];
  const chain = (async () => {
    for (let i = 0; i < 3; i += 1) {
      await wait(220);
      at.push(clock.now() - START);
    }
  })();
  await clock.advance(700);
  await chain;
  assert.deepEqual(at, [220, 440, 660]);
});

test('clearTimeout removes a timer; setInterval repeats until clearInterval', async () => {
  const clock = virtualTimers({ start: START });
  const ran = [];
  const gone = clock.setTimeout(() => ran.push('gone'), 100);
  clock.clearTimeout(gone);
  const every = clock.setInterval(() => ran.push(clock.now() - START), 300);
  await clock.advance(1000);
  assert.deepEqual(ran, [300, 600, 900]);
  clock.clearInterval(every);
  await clock.advance(1000);
  assert.deepEqual(ran, [300, 600, 900]);
});

test('as fakeHomey\'s extra, the clock\'s timers are the ones the code sets', async () => {
  const clock = virtualTimers();
  const homey = fakeHomey(null, clock);
  let ran = false;
  homey.setTimeout(() => { ran = true; }, 50);
  assert.equal(clock.pending.size, 1);
  await clock.advance(50);
  assert.equal(ran, true);
});
