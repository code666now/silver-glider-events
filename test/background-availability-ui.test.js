const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const catalog = require('../public/js/event-backgrounds');

const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const settled = () => new Promise(resolve => setImmediate(resolve));
const availability = () => catalog.options.map(option => ({
  ...option, active: !['halloween', 'last-guest'].includes(option.key),
  alwaysAvailable: ['adaptive', 'midnight', 'plaster'].includes(option.key)
}));

class Element {
  constructor(tag = 'div', document = null) {
    this.tagName = tag.toUpperCase(); this.document = document;
    this.children = []; this.dataset = {}; this.style = {}; this.listeners = {};
    this.attributes = {}; this.hidden = false; this.disabled = false; this.textContent = '';
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  click() { return this.listeners.click?.({ target: this }); }
  focus() { if (this.document) this.document.activeElement = this; }
  querySelector() { return this.label || null; }
}

function adminFixture({ capability = true, get, patch } = {}) {
  const nodes = new Map();
  const document = { activeElement: null, createElement: tag => new Element(tag, document), getElementById: id => {
    if (!nodes.has(id)) nodes.set(id, new Element('div', document));
    return nodes.get(id);
  } };
  const calls = [];
  const context = {
    document, renderNav() {}, addSkipLink() {}, Map, Set,
    window: { SGEventBackgrounds: catalog, adminShellSession: Promise.resolve({ capabilities: { manageBackgrounds: capability } }) },
    api: async (url, options = {}) => {
      calls.push({ url, options });
      if (options.method === 'PATCH') return patch ? patch(url, options) : { background: { key: url.split('/').pop(), active: options.body.active } };
      return get ? get() : { backgrounds: availability() };
    }
  };
  vm.runInNewContext(source('public/js/admin-backgrounds.js'), context);
  const cards = () => nodes.get('backgrounds-grid').children;
  const parts = key => {
    const card = cards().find(item => item.children[0].dataset.theme === key);
    const body = card.children[1];
    return { card, toggle: body.children[1].children[1], badge: body.children[0].children[1], status: body.children[2], retry: body.children[3] };
  };
  return { nodes, calls, document, cards, parts };
}

test('background manager shows all static previews with pinned core defaults and truthful states', async () => {
  const fixture = adminFixture();
  await settled();
  assert.equal(fixture.cards().length, catalog.options.length);
  assert.equal(fixture.parts('halloween').toggle.getAttribute('aria-checked'), 'false');
  assert.equal(fixture.parts('halloween').badge.textContent, 'Inactive');
  assert.equal(fixture.parts('midnight').toggle, undefined);
  assert.equal(fixture.parts('adaptive').toggle, undefined);
  assert.equal(fixture.parts('plaster').toggle, undefined);
  assert.match(fixture.nodes.get('backgrounds-summary').textContent, /backgrounds available to hosts/);
  for (const card of fixture.cards()) {
    for (const child of card.children[0].children) assert.equal(child.tagName, 'IMG');
  }
});

test('background switch saves only once while pending and preserves focus and confirmed state', async () => {
  let resolveSave;
  const fixture = adminFixture({ patch: () => new Promise(resolve => { resolveSave = resolve; }) });
  await settled();
  const { toggle, card } = fixture.parts('halloween');
  toggle.focus();
  const first = toggle.click();
  toggle.click();
  assert.equal(fixture.calls.filter(call => call.options.method === 'PATCH').length, 1);
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  assert.equal(toggle.getAttribute('aria-disabled'), 'true');
  assert.equal(card.getAttribute('aria-busy'), 'true');
  assert.equal(fixture.document.activeElement, toggle);
  resolveSave({ background: { key: 'halloween', active: true } });
  await first;
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
  assert.equal(toggle.getAttribute('aria-disabled'), 'false');
  assert.equal(fixture.document.activeElement, toggle);
  assert.equal(fixture.parts('halloween').card, card);
});

test('failed background changes stay unconfirmed and retry the requested state', async () => {
  let attempts = 0;
  const fixture = adminFixture({ patch: async (url, options) => {
    attempts += 1;
    if (attempts === 1) throw new Error('Connection lost');
    return { background: { key: 'halloween', active: options.body.active } };
  } });
  await settled();
  const { toggle, status, retry } = fixture.parts('halloween');
  await toggle.click();
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  assert.equal(status.getAttribute('role'), 'alert');
  assert.match(status.textContent, /couldn’t confirm/);
  assert.equal(retry.hidden, false);
  retry.click();
  await settled();
  assert.equal(fixture.document.activeElement, toggle);
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
  assert.equal(retry.hidden, true);
});

test('support users and failed catalog loads never receive editable background controls', async () => {
  const support = adminFixture({ capability: false });
  const failed = adminFixture({ get: () => { throw new Error('Unavailable'); } });
  await settled();
  assert.equal(support.calls.length, 0);
  assert.equal(support.cards().length, 0);
  assert.equal(failed.cards().length, 0);
  assert.equal(support.nodes.get('backgrounds-error').hidden, false);
  assert.equal(failed.nodes.get('backgrounds-error').hidden, false);
  assert.equal(failed.nodes.get('backgrounds-grid').getAttribute('aria-busy'), 'false');
});

function ownerFixture({ get = async () => ({ backgrounds: availability() }) } = {}) {
  const nodes = new Map();
  const document = { activeElement: null };
  const choices = catalog.options.map(option => {
    const button = new Element('button');
    button.dataset.ownerTheme = option.key;
    button.label = new Element('span');
    button.label.dataset.standardLabel = option.label;
    button.label.dataset.flyerLabel = option.flyerLabel || option.label;
    return button;
  });
  const context = vm.createContext({
    saved: { backgroundTheme: 'halloween' }, draft: { backgroundTheme: 'halloween', presentationMode: 'standard' },
    availableThemeKeys: null, themeAvailabilityLoading: false, themeKeys: catalog.keys,
    document: Object.assign(document, { querySelectorAll: () => choices }),
    $: id => { if (!nodes.has(id)) nodes.set(id, new Element('div', document)); return nodes.get(id); },
    request: get
  });
  const code = source('public/js/event-owner-editor.js');
  vm.runInContext(code.slice(code.indexOf('  function themeIsAvailable('), code.indexOf('  function isDirty(')), context);
  return { choices, nodes, context, document, choice: key => choices.find(button => button.dataset.ownerTheme === key) };
}

test('owner picker retains only its saved inactive background and removes it after replacement saves', async () => {
  const fixture = ownerFixture();
  await settled();
  assert.equal(fixture.choice('halloween').hidden, false);
  assert.match(fixture.choice('halloween').label.textContent, /Current background/);
  assert.equal(fixture.choice('last-guest').hidden, true);
  assert.equal(fixture.choice('midnight').hidden, false);
  vm.runInContext("draft.backgroundTheme = 'midnight'; updateThemeAvailability();", fixture.context);
  assert.equal(fixture.choice('halloween').hidden, false, 'unsaved replacement can still be undone');
  vm.runInContext("saved.backgroundTheme = 'midnight'; updateThemeAvailability();", fixture.context);
  assert.equal(fixture.choice('halloween').hidden, true, 'saved replacement cannot reselect inactive original');
});

test('owner availability failure preserves current design without offering the full catalog', async () => {
  const fixture = ownerFixture({ get: async () => { throw new Error('Offline'); } });
  await settled();
  assert.deepEqual(fixture.choices.filter(button => !button.hidden).map(button => button.dataset.ownerTheme), ['halloween']);
  assert.equal(fixture.nodes.get('owner-theme-retry').hidden, false);
  assert.equal(fixture.nodes.get('owner-theme-availability').getAttribute('role'), 'alert');
  assert.equal(fixture.context.draft.backgroundTheme, 'halloween');
});

test('background availability retry keeps focus on a visible status instead of hiding the focused control', async () => {
  let attempts = 0;
  const fixture = ownerFixture({ get: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Offline');
    return { backgrounds: availability() };
  } });
  await settled();
  const retry = fixture.nodes.get('owner-theme-retry');
  retry.focus();
  await retry.click();
  assert.equal(retry.hidden, true);
  assert.equal(fixture.document.activeElement, fixture.nodes.get('owner-theme-availability'));
  assert.equal(fixture.choice('midnight').hidden, false);
});

test('advanced picker filters choices, preserves saved inactive theme and fails closed on retry errors', async () => {
  let offline = false;
  const nodes = new Map();
  const choices = catalog.options.map(option => {
    const button = new Element('button'); button.dataset.theme = option.key; return button;
  });
  const context = vm.createContext({
    EventBackgrounds: catalog,
    document: { querySelectorAll: () => choices },
    $: id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); },
    api: async () => { if (offline) throw new Error('Offline'); return { backgrounds: availability() }; },
    refreshThemeLabels() {}
  });
  const form = source('public/js/event-form.js');
  vm.runInContext(form.slice(form.indexOf('const THEMES ='), form.indexOf('function themeLabel(')), context);
  await vm.runInContext("savedBackgroundTheme = 'halloween'; loadThemeAvailability();", context);
  assert.equal(choices.find(button => button.dataset.theme === 'halloween').hidden, false);
  assert.equal(choices.find(button => button.dataset.theme === 'halloween').dataset.currentBackground, 'true');
  assert.equal(choices.find(button => button.dataset.theme === 'last-guest').style.display, 'none');
  offline = true;
  await vm.runInContext('loadThemeAvailability();', context);
  assert.deepEqual(choices.filter(button => !button.hidden).map(button => button.dataset.theme), ['halloween']);
  assert.equal(nodes.get('theme-availability-retry').hidden, false);
});

test('advanced editor availability fails closed and stale choices refresh without replacing the design', () => {
  const form = source('public/js/event-form.js');
  assert.match(form, /if \(touched && !themeIsAvailable\(key\)\) return/);
  assert.match(form, /return key === savedBackgroundTheme \|\| availableThemeKeys\?\.has\(key\) === true/);
  assert.match(form, /sw\.hidden = true/);
  assert.match(form, /swatch\.style\.display = swatch\.hidden \? 'none' : ''/);
  assert.match(form, /err\.code === 'background_unavailable'\) loadThemeAvailability/);
  assert.match(form, /savedBackgroundTheme = data\.event\?\.background_theme \|\| body\.background_theme/);
  assert.match(source('public/js/event-owner-editor.js'), /error\.code === 'background_unavailable'\) loadThemeAvailability/);
  assert.match(source('public/js/flyer-preview.js'), /const data = await load\(true\)/);
  assert.match(source('public/js/flyer-preview.js'), /error\.code === 'background_unavailable'[\s\S]*await showLooks\(error\.message\)/);
});

test('background manager keeps accessibility landmarks, touch targets and scoped mobile layout', () => {
  const view = source('src/views/admin-backgrounds.html');
  const css = source('public/css/admin-backgrounds.css');
  const shell = source('public/js/admin-shell.js');
  assert.match(view, /<main id="main-content" tabindex="-1">/);
  assert.match(view, /role="alert"/);
  assert.match(view, /id="backgrounds-summary" role="status"/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /@media \(max-width: 540px\)/);
  assert.match(shell, /backgroundsLink\.hidden = capabilities\.manageBackgrounds !== true/);
});
