'use strict';

const { TYPE_PREFIXES } = require('./sgProducts');

// Which warning a later device or a thermostat shows while the app has no
// location id to send its commands with (lib/SGCsrDevice.js,
// lib/SGThermostatDevice.js): 'noHome' (log in with the SG account) while the
// account module (lib/account.js) is in this build and no account is
// fetched, 'notInHome' (add it in the SG app, then fetch again) when one is,
// and 'waitingForStatus', as before, in a build without the module. The
// first generation dimmers keep their own (lib/SGDeviceBase.js).
function noLocationKey(account) {
  if (!account || typeof account.available !== 'function' || !account.available()) return 'waitingForStatus';
  return account.fetched() ? 'notInHome' : 'noHome';
}

// A device's home's location id in the SG account, or null: only in a home
// without a first generation dimmer in Homey, and only when the account has
// this mesh id as one device in the homes the app speaks with, of the
// product with this prefix (TYPE_PREFIXES), with one location id
// (lib/account.js, deviceLocations and typeInNetwork). Not from a home the
// last fetch did not have ("Fetch again" after it was removed in the SG
// app), kept from before only for its keys. The device itself
// leaves it out when it said in an FF11 that it is in no home.
function accountLocationFor(app, meshId, prefix) {
  if (!app || typeof app.dimmerCount !== 'function' || app.dimmerCount() !== 0) return null;
  const { account } = app;
  if (!account || typeof account.deviceLocations !== 'function' || typeof account.typeInNetwork !== 'function') return null;
  if (TYPE_PREFIXES[account.typeInNetwork(meshId, { fetchedOnly: true })] !== prefix) return null;
  const location = account.deviceLocations({ fetchedOnly: true }).get(meshId);
  return Number.isInteger(location) ? location : null;
}

// Whether a device said in an FF11 that it is in no home (location id 0):
// kept in its store (saidNoHome), so it holds after a restart, and set when
// the device is added after such an FF11 (lib/csrPairing.js). Read once at
// the start (noHomeAtStart); noteNoHome takes each FF11 from the device and
// gives what holds now: true for location id 0, false for another one, which
// clears the store too. The SG account's location id is not used for a
// device while it holds (assumed: a device in no home says 0, not tried).
function noHomeAtStart(device) {
  return device.getStoreValue('saidNoHome') === true;
}

function noteNoHome(device, location) {
  const stored = device.getStoreValue('saidNoHome') === true;
  if (!Number.isInteger(location)) return stored;
  if (location === 0) {
    if (!stored) device.setStoreValue('saidNoHome', true).catch(() => {});
    return true;
  }
  if (stored) device.setStoreValue('saidNoHome', false).catch(() => {});
  return false;
}

module.exports = {
  accountLocationFor, noHomeAtStart, noLocationKey, noteNoHome,
};
