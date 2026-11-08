'use strict';

// A link whose proxy filter is not confirmed (lib/sg3/bridge.js,
// openOnNode): waited for FILTER_WAIT_MS (1 s), then the link is let go and,
// once Homey has let it go, the same node is connected once more before
// anything else; a second link without a filter is not tried again. As the
// three times in the logs (2026-11-06, 2026-11-07, 2026-11-08) when nothing
// came on a link that came up just after a connect that failed. Against the
// fake Homey and a simulated node; the specification's sample keys.

const test = require('node:test');
const assert = require('node:assert/strict');

const { FILTER_WAIT_MS } = require('../../lib/sg3/bridge');
const { Sg3Controller } = require('../../lib/sg3/controller');
const { SimulatedSgNode } = require('./simulated-node');
const { advert, fakeHomey } = require('./fake-homey');

const hex = (s) => Buffer.from(s, 'hex');
const NET_KEY = '7dd7364cd842ad18c17c2b820c84c3d6';
const APP_KEY = '63964771734fbd76e3b40519d1d94a48';
const NETWORK = { netKey: NET_KEY, appKey: APP_KEY, addresses: [0x0003] };

// The node's advertisement; on the first deaf.left links nothing written
// reaches the node, so no filter is confirmed (the node still sends its
// beacon). Each connect is counted in order with Homey's disconnects.
function setUp(deafLinks) {
  const node = new SimulatedSgNode({ netKey: hex(NET_KEY), appKey: hex(APP_KEY), address: 0x0003, on: true, level: 40, statusGroup: 0xffff });
  const deaf = { left: deafLinks };
  const homey = fakeHomey({
    adverts: (calls) => {
      const ad = advert(node, { calls });
      const connect = ad.connect.bind(ad);
      ad.connect = async () => {
        calls.order.push('connect');
        const peripheral = await connect();
        if (deaf.left > 0) {
          deaf.left -= 1;
          const getService = peripheral.getService;
          peripheral.getService = async (uuid) => {
            const service = await getService(uuid);
            return {
              discoverCharacteristics: async (...args) => (await service.discoverCharacteristics(...args))
                .map((c) => (typeof c.write === 'function' ? { ...c, write: async () => {} } : c)),
            };
          };
        }
        return peripheral;
      };
      return [ad];
    },
  });
  homey.devices.push(0x0003);
  const logs = [];
  const controller = new Sg3Controller({
    homey, network: NETWORK, deviceAddresses: () => homey.devices, held: () => ({ held: false, why: 'by the test' }),
    log: (line) => logs.push(line), randomInt: () => 0, lingerMs: 20, pollMs: 600000, pollRetryMs: 600000,
  });
  controller.bridge = controller.createBridge();
  controller.bridge.filterWaitMs = 50;
  return { homey, node, logs, controller };
}

test('1 s for the proxy filter by default', () => {
  assert.equal(FILTER_WAIT_MS, 1000);
  const controller = new Sg3Controller({ homey: fakeHomey(), network: NETWORK, log: () => {} });
  assert.equal(controller.createBridge().filterWaitMs, 1000);
  controller.stopSummary();
});

test('no filter on the first link: let go, the same node once more after Homey let it go, and the status is read; one scan', async (context) => {
  const t = setUp(1);
  context.after(() => t.controller.stop());
  await t.controller.pollStatus();
  assert.ok(t.logs.includes('no proxy filter on …xy-a within 0.1 s: let go, the same node once more'), t.logs.join('\n'));
  assert.ok(t.logs.some((line) => /^0x0003 status: on 40 after/.test(line)), t.logs.join('\n'));
  assert.equal(t.homey.calls.discover, 1, 'no second scan');
  const order = t.homey.calls.order.filter((what) => what === 'connect' || what === 'disconnect');
  assert.deepEqual(order.slice(0, 3), ['connect', 'disconnect', 'connect'], 'the second connect after Homey let the first go');
  assert.ok(!t.logs.some((line) => /did not answer|failed: proxy filter/.test(line)), t.logs.join('\n'));
});

test('no filter on the second link either: no third, and the round fails as before', async (context) => {
  const t = setUp(2);
  context.after(() => t.controller.stop());
  await t.controller.pollStatus();
  assert.equal(t.homey.calls.order.filter((what) => what === 'connect').length, 2);
  assert.ok(t.logs.some((line) => /^status round: proxy filter not confirmed within 50 ms$/.test(line)), t.logs.join('\n'));
});
