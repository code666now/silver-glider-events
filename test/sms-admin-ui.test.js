const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('welcome cost card is hidden by default, capability-gated and pending-price aware', () => {
  const html = read('src/views/admin-overview.html');
  const script = read('public/js/admin-overview.js');
  const route = read('src/routes/admin.js');
  assert.match(html, /id="admin-texting-costs"[^>]+hidden/);
  assert.match(script, /async function loadWelcomeTextCosts[\s\S]*capabilities\?\.manageOperators/);
  assert.match(route, /get\('\/api\/admin\/sms-welcome-costs', requireSuperAdmin/);
  assert.match(script, /amount == null \? \(pending \|\| unknownAcceptance \? 'Pending' : 'No USD total'\)/);
  assert.match(html, /Pending charges are not counted as zero/);
  assert.match(html, /Claimed credits are not money spent/);
  assert.match(script, /Texting costs could not be loaded/);
  assert.match(script, /refresh\.disabled = false/);
  assert.match(script, /Welcome campaign \$\{campaign.enabled \? 'enabled' : 'paused'\}/);
  assert.match(script, /Number\(campaign.claims\) >= Number\(campaign.cap\) \? ' No welcome claims available.'/);
  assert.doesNotMatch(read('public/css/admin-overview.css'), /--sg-text-muted/);
});

test('cost amount distinguishes unknown provider pricing from fully priced non-USD messages', async () => {
  const script = read('public/js/admin-overview.js');
  const loader = script.slice(script.indexOf('async function loadWelcomeTextCosts()'),
    script.indexOf("document.getElementById('texting-cost-refresh').addEventListener"));
  for (const [costs, expected, campaignOverrides = {}] of [
    [{ acceptedTexts: 0, recordedUsdCost: null, pendingTexts: 0 }, '$0.00'],
    [{ acceptedTexts: 3, recordedUsdCost: null, pendingTexts: 3 }, 'Pending'],
    [{ acceptedTexts: 3, recordedUsdCost: null, pendingTexts: 0, nonUsdTexts: 3 }, 'No USD total'],
    [{ acceptedTexts: 3, recordedUsdCost: null, pendingTexts: 1, nonUsdTexts: 2 }, 'Pending'],
    [{ acceptedTexts: 3, recordedUsdCost: 0, pendingTexts: 0, recordedTexts: 3 }, '$0.00'],
    [{ acceptedTexts: 0, recordedUsdCost: null, pendingTexts: 0, unknownAcceptanceTexts: 2 }, 'Pending'],
    [{ acceptedTexts: 3, recordedUsdCost: null, pendingTexts: 0, nonUsdTexts: 3, unknownAcceptanceTexts: 1 }, 'Pending'],
    [{ acceptedTexts: 3, recordedUsdCost: 0.04, pendingTexts: 0, recordedTexts: 3, unknownAcceptanceTexts: 2 }, '$0.04'],
    [{ acceptedTexts: 0, recordedUsdCost: null, pendingTexts: 0 }, '$0.00', { claims: 200, cap: 200 }],
    [{ acceptedTexts: 0, recordedUsdCost: null, pendingTexts: 0 }, '$0.00', { enabled: false }]
  ]) {
    const nodes = new Map();
    const element = id => {
      if (!nodes.has(id)) nodes.set(id, { textContent: '', hidden: true, setAttribute() {} });
      return nodes.get(id);
    };
    const scope = {
      window: { adminShellSession: Promise.resolve({ capabilities: { manageOperators: true } }) },
      document: { getElementById: element },
      overviewNumber: value => String(Number(value || 0)),
      api: async () => ({ campaign: { claims: 1, creditsGranted: 50, creditsRemaining: 47, cap: 200, enabled: true, ...campaignOverrides },
        costs: { asOf: '2026-11-04T23:00:00.000Z', ...costs } })
    };
    vm.runInNewContext(loader, scope);
    await scope.loadWelcomeTextCosts();
    assert.equal(element('texting-cost-amount').textContent, expected);
    assert.equal(element('texting-cost-refresh').disabled, false);
    assert.match(element('texting-cost-campaign').textContent, campaignOverrides.enabled === false ? /Welcome campaign paused/ : /Welcome campaign enabled/);
    if (campaignOverrides.claims === 200) assert.match(element('texting-cost-campaign').textContent, /No welcome claims available/);
    if (costs.nonUsdTexts) assert.match(element('texting-cost-coverage').textContent, /another currency, excluded/);
    if (costs.unknownAcceptanceTexts) {
      assert.match(element('texting-cost-coverage').textContent, /texts awaiting provider acceptance confirmation/);
      assert.doesNotMatch(element('texting-cost-coverage').textContent, /No complimentary texts have been submitted yet/);
    }
  }
});
