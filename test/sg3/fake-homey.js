'use strict';

// A fake Homey for the 3.0 controller: settings, drivers, timers, and a ble
// whose advertisements lead to simulated SG nodes. Shared by the tests.

const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const hex = (s) => Buffer.from(s, 'hex');
const NETWORK_ID = '3ecaff672f673370';

function advert(node, { uuid = 'proxy-a', rssi = -60, networkId = NETWORK_ID, type = 0x00, fail = false, noService = false, calls }) {
  return {
    uuid,
    rssi,
    serviceData: [{ uuid: '00001828-0000-1000-8000-00805f9b34fb', data: Buffer.concat([Buffer.from([type]), hex(networkId)]) }],
    async connect() {
      calls.connect.push(uuid);
      if (fail) throw new Error('connect refused');
      const peripheral = new EventEmitter();
      const dataIn = { uuid: '00002add00001000800000805f9b34fb', write: (frame) => node.write(frame), properties: ['writeWithoutResponse'] };
      const dataOut = {
        uuid: '00002ade00001000800000805f9b34fb',
        subscribeToNotifications: async (callback) => { node.connect(callback); },
        unsubscribeFromNotifications: async () => { calls.order.push('unsubscribe'); },
        properties: ['notify'],
      };
      peripheral.getService = async (service) => {
        if (noService) throw new Error('service 1828 not found');
        assert.equal(service, '0000182800001000800000805f9b34fb');
        return { discoverCharacteristics: async () => [dataIn, dataOut] };
      };
      peripheral.disconnect = async () => { calls.order.push('disconnect'); };
      calls.peripherals.push(peripheral);
      return peripheral;
    },
  };
}

function fakeHomey({ adverts = () => [] } = {}) {
  const store = new Map();
  const devices = [];
  const calls = { discover: 0, connect: [], order: [], peripherals: [] };
  return {
    store,
    devices,
    calls,
    settings: {
      get: (key) => (store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : null),
      set: (key, value) => store.set(key, value),
      unset: (key) => store.delete(key),
    },
    ble: { discover: async () => { calls.discover += 1; return adverts(calls); } },
    drivers: { getDriver: () => ({ getDevices: () => devices }) },
    manifest: { version: '2.9.0' },
    setTimeout,
    clearTimeout,
    // A test that forgets stop() must not hang the run on the summary timer.
    setInterval: (fn, ms) => setInterval(fn, ms).unref(),
    clearInterval,
  };
}

module.exports = {
  NETWORK_ID,
  advert,
  fakeHomey,
};
