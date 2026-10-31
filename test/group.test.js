'use strict';

// The group (2.5.0): its members are first generation dimmers only. A device
// of a later generation in the same driver (sg_mesh) has getCsrMeshId and no
// getMeshId; it is not offered when the group is set up, and never becomes a
// member, also not for a group with no stored members. Made-up ids.
// Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const fake = require('./helpers/fake-homey');

fake.install();

const SGGroupDevice = require('../drivers/sg_group/device');
const SGGroupDriver = require('../drivers/sg_group/driver');

// A first generation dimmer as the group sees it, with its requests recorded.
function gen1(id, asked) {
  const name = `@ND${id.toString(16).toUpperCase()}`;
  return {
    getMeshId: () => id, getLocationId: () => 0x1234, getData: () => ({ id: name }), getName: () => name,
    _lastAppliedLevel: 0, _lastDim: 1, _request: (level) => asked.push([name, level]),
  };
}

// A later generation dimmer in the same driver: no getMeshId.
function later(asked) {
  return {
    getCsrMeshId: () => 0x0124, getData: () => ({ id: '@SD5E6F' }), getName: () => '@SD5E6F',
    _request: (level) => asked.push(['@SD5E6F', level]),
  };
}

function homeyWith(devices) {
  const drivers = { sg_mesh: { getDevices: () => devices } };
  return fake.fakeHomey({}, { drivers: { getDriver: (id) => drivers[id] } });
}

async function group(devices, store = {}) {
  const device = new SGGroupDevice({ homey: homeyWith(devices), store, name: 'group' });
  await device.onInit();
  return device;
}

test('setting up a group: only first generation dimmers are offered, all ticked; repair keeps the choice', async () => {
  const asked = [];
  const devices = [gen1(0x1a2b, asked), later(asked), gen1(0x3c4d, asked)];
  const driver = new SGGroupDriver({ homey: homeyWith(devices) });
  const handlers = {};
  await driver.onPair({ setHandler: (name, fn) => { handlers[name] = fn; } });
  assert.deepEqual(await handlers.list_dimmers(), {
    dimmers: [{ id: '@ND1A2B', name: '@ND1A2B', selected: true }, { id: '@ND3C4D', name: '@ND3C4D', selected: true }],
    repair: false,
  });
  await driver.onRepair({ setHandler: (name, fn) => { handlers[name] = fn; } }, { getMemberIds: () => ['@ND3C4D', '@SD5E6F'] });
  assert.deepEqual((await handlers.list_dimmers()).dimmers.map((d) => [d.id, d.selected]),
    [['@ND1A2B', false], ['@ND3C4D', true]]);
});

test('members: a later generation dimmer never is one, with or without stored members', async () => {
  const asked = [];
  const devices = [gen1(0x1a2b, asked), later(asked), gen1(0x3c4d, asked)];
  const all = await group(devices);
  assert.deepEqual(all._members().map((m) => m.getData().id), ['@ND1A2B', '@ND3C4D']);
  const chosen = await group(devices, { members: ['@ND3C4D', '@SD5E6F'] });
  assert.deepEqual(chosen._members().map((m) => m.getData().id), ['@ND3C4D']);
});

test('a level goes to the first generation dimmers only, and their status shows, with a later one in the driver', async () => {
  const asked = [];
  const devices = [gen1(0x1a2b, asked), later(asked), gen1(0x3c4d, asked)];
  const device = await group(devices);
  device._fanOut(60);
  assert.deepEqual(asked, [['@ND1A2B', 60], ['@ND3C4D', 60]]);
  assert.ok(device.logs.some((line) => line.includes('passed to 2 of 2 dimmer(s)')));

  devices[0]._lastAppliedLevel = 40;
  device.applyMeshStatus('1a2b', 40);
  device.applyMeshStatus('3c4d', 0);
  device.applyMeshStatus('0124', 80);
  assert.equal(device.getCapabilityValue('dim'), 0.4);
  assert.equal(device.getCapabilityValue('onoff'), true);
  assert.deepEqual(device.errors, []);
});
