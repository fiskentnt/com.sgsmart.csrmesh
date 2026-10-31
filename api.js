'use strict';

module.exports = {
  // GET /api/app/com.sgsmart.csrmesh/log-view, for "Show log" on the settings
  // page: a short summary and the latest lines of the app's log, with
  // Bluetooth addresses, UUIDs and device names hidden (see app.logView).
  async getLogView({ homey }) {
    try {
      return await homey.app.logView();
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
  },
};
