const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const settingsSource = read('public/js/settings.js');
const preferenceScript = settingsSource.slice(settingsSource.indexOf('const followerEmailSetting'), settingsSource.indexOf("api('/api/auth/me').then"));

function settingsHarness(api) {
  const entries = new Map();
  function get(id) {
    if (entries.has(id)) return entries.get(id);
    const classes = new Set();
    const attributes = new Map();
    const listeners = new Map();
    const entry = {
      hidden: true, checked: false, textContent: '', classes, attributes,
      classList: { add: key => classes.add(key), remove: key => classes.delete(key) },
      setAttribute: (key, value) => attributes.set(key, value),
      removeAttribute: key => attributes.delete(key),
      addEventListener: (name, listener) => listeners.set(name, listener),
      fire: (name, event) => listeners.get(name)(event)
    };
    entries.set(id, entry);
    return entry;
  }
  const context = vm.createContext({ settingsElement: get, api });
  vm.runInContext(preferenceScript, context);
  return { load: () => vm.runInContext('loadFollowerEmailSetting()', context), get };
}

test('Messaging follower-email switch uses the server preference and stays hidden when unavailable', async () => {
  for (const available of [false, true]) {
    const h = settingsHarness(async () => ({ available, enabled: true }));
    await h.load();
    assert.equal(h.get('settings-follower-email').hidden, !available);
    assert.equal(h.get('settings-follower-email-enabled').checked, available);
  }
  const view = read('src/views/settings-v2.html');
  assert.match(view, /type="checkbox" id="settings-follower-email-enabled" role="switch" aria-labelledby="settings-follower-email-label"/);
  assert.match(view, /Email my followers when I publish a public event/);
  assert.match(view, /id="settings-follower-email-status" role="status" aria-atomic="true"/);
});

test('Messaging guards duplicate preference saves, restores on failure, and confirms after success', async () => {
  let rejectSave;
  let called = 0;
  const h = settingsHarness(async (url, options) => {
    assert.equal(url, '/api/settings/follower-email');
    if (options.method !== 'PATCH') return { available: true, enabled: true };
    assert.equal(options.body.enabled, false);
    if (++called === 1) return new Promise((resolve, reject) => { rejectSave = reject; });
    return { available: true, enabled: false };
  });
  await h.load();
  const input = h.get('settings-follower-email-enabled');
  const status = h.get('settings-follower-email-status');
  input.checked = false;
  const save = input.fire('change');
  assert.equal(input.attributes.get('aria-disabled'), 'true');
  assert.equal(status.textContent, 'Saving…');
  let prevented = false;
  input.fire('click', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  await input.fire('change');
  assert.equal(called, 1);
  rejectSave(new Error('Network error'));
  await save;
  assert.equal(input.checked, true);
  assert.equal(status.classes.has('error'), true);
  assert.match(status.textContent, /couldn’t save/);
  assert.equal(input.attributes.has('aria-disabled'), false);
  input.checked = false;
  await input.fire('change');
  assert.equal(input.checked, false);
  assert.equal(status.classes.has('error'), false);
  assert.equal(status.textContent, 'Preference saved.');
});

test('owner draft and direct creation publish from accessible checkboxes with event visibility guards', () => {
  const owner = read('public/js/event-owner-editor.js');
  const create = read('public/js/event-form.js');
  assert.match(read('src/lib/event-owner-editor.js'), /event\.status === 'draft' \? `<label[^>]+id="owner-follower-email-option" hidden>/);
  assert.match(owner, /!autoFollowerEmailEnabled \|\| draft\.visibility !== 'public' \|\| draft\.secretShowEnabled/);
  assert.match(owner, /\/publish`, \{ method: 'POST', body: \{ skip_follower_email: skipFollowerEmail \}/);
  assert.match(read('src/views/event-form.html'), /id="create-skip-follower-email" type="checkbox" aria-labelledby="create-skip-follower-email-label"/);
  assert.match(create, /!autoFollowerEmailEnabled \|\| visibility !== 'public' \|\| \$\('secret_show_enabled'\)\.checked/);
  assert.match(create, /if \(!editId && !adminEditorMode\) body\.skip_follower_email = skipFollowerEmail/);
  assert.match(create, /api\('\/api\/events', \{ method: 'POST', body \}\)/);
});
