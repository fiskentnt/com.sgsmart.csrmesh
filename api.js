'use strict';

// Web API for the settings page, SG Smart 3.0 only. The 3.0 controller, and
// lib/sg3 with it, is created only by an import, or when a network has been
// imported before; a status request otherwise answers without loading it.

function controller(homey, create = Boolean(homey.settings.get('sg3Network'))) {
  return homey.app.sg3({ create });
}

module.exports = {
  async getSg3Status({ homey }) {
    const sg3 = controller(homey);
    return sg3 ? sg3.status() : { configured: false };
  },

  async importSg3({ homey, body }) {
    return controller(homey, true).importNetwork(body || {});
  },

  async removeSg3({ homey }) {
    const sg3 = controller(homey);
    return sg3 ? sg3.removeNetwork() : { ok: true };
  },

  async setSg3Advanced({ homey, body }) {
    const sg3 = controller(homey);
    return sg3 ? sg3.setAdvanced(body || {}) : { error: 'not_configured' };
  },
};
