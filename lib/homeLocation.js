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
// (lib/account.js, deviceLocations and typeInNetwork). The device itself
// leaves it out when it said in an FF11 that it is in no home.
function accountLocationFor(app, meshId, prefix) {
  if (!app || typeof app.dimmerCount !== 'function' || app.dimmerCount() !== 0) return null;
  const { account } = app;
  if (!account || typeof account.deviceLocations !== 'function' || typeof account.typeInNetwork !== 'function') return null;
  if (TYPE_PREFIXES[account.typeInNetwork(meshId)] !== prefix) return null;
  const location = account.deviceLocations().get(meshId);
  return Number.isInteger(location) ? location : null;
}

module.exports = { accountLocationFor, noLocationKey };
