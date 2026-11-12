'use strict';

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

module.exports = { noLocationKey };
