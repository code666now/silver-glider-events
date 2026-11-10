const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/js/legal-acceptance.js'), 'utf8');
const template = fs.readFileSync(path.join(root, 'src/views/legal-acceptance.html'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public/css/legal-acceptance.css'), 'utf8');

function element(initial = {}) {
  const listeners = {};
  const attributes = new Map();
  return {
    checked: false, disabled: false, hidden: false, textContent: '', focused: false,
    ...initial,
    listeners,
    addEventListener(type, callback) { listeners[type] = callback; },
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    focus() { this.focused = true; }
  };
}

function mount(options = {}) {
  const form = element();
  form.querySelector = selector => selector === '[name="next"]' ? { value: options.next || '/events/123/edit' } : null;
  const checkbox = element();
  const label = element({ textContent: 'Agree and continue' });
  const spinner = element({ hidden: true });
  const submit = element();
  submit.querySelector = selector => selector === '.legal-review-spinner' ? spinner : label;
  const status = element();
  const error = element({ hidden: !options.error, textContent: options.error || '' });
  const nodes = {
    'legal-review-form': form, 'legal-review-accepted': checkbox, 'legal-review-submit': submit,
    'legal-review-status': status, 'legal-review-error': error
  };
  const windowListeners = {};
  const navigations = [];
  const sandbox = {
    document: { getElementById: id => options.missing === id ? null : nodes[id] },
    window: {
      addEventListener: (name, callback) => { windowListeners[name] = callback; },
      location: {
        replace: url => { navigations.push(url); },
        reload: () => assert.fail('Never reload a potentially POST-rendered review error')
      }
    },
    fetch: () => assert.fail('The enhancement must not send an acceptance request itself'),
    localStorage: { setItem: () => assert.fail('Acceptance must not be trusted to local storage') }
  };
  vm.runInNewContext(source, sandbox);
  const dispatchSubmit = () => {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    form.listeners.submit(event);
    return event;
  };
  return { form, checkbox, submit, label, spinner, status, error, windowListeners, dispatchSubmit, navigations };
}

test('legal review enhancement requires a deliberate checkbox before enabling continue', () => {
  const ui = mount();
  assert.equal(ui.checkbox.checked, false);
  assert.equal(ui.submit.disabled, true);
  assert.equal(ui.status.textContent, '');
  ui.checkbox.checked = true;
  ui.checkbox.listeners.change();
  assert.equal(ui.submit.disabled, false);
  ui.checkbox.checked = false;
  ui.checkbox.listeners.change();
  assert.equal(ui.submit.disabled, true);
});

test('unchecked scripted submission is blocked and restores focus to the checkbox', () => {
  const ui = mount();
  const event = ui.dispatchSubmit();
  assert.equal(event.defaultPrevented, true);
  assert.equal(ui.checkbox.focused, true);
  assert.equal(ui.form.getAttribute('aria-busy'), null);
  assert.equal(ui.label.textContent, 'Agree and continue');
});

test('valid agreement uses native POST and prevents duplicate submits without removing checkbox data', () => {
  const ui = mount();
  ui.checkbox.checked = true;
  ui.checkbox.listeners.change();
  assert.equal(ui.dispatchSubmit().defaultPrevented, false);
  assert.equal(ui.form.getAttribute('aria-busy'), 'true');
  assert.equal(ui.submit.getAttribute('aria-busy'), 'true');
  assert.equal(ui.submit.disabled, true);
  assert.equal(ui.checkbox.disabled, false);
  assert.equal(ui.checkbox.checked, true);
  assert.equal(ui.label.textContent, 'Saving…');
  assert.equal(ui.spinner.hidden, false);
  assert.equal(ui.status.textContent, 'Saving your agreement.');
  assert.equal(ui.dispatchSubmit().defaultPrevented, true);
});

test('normal pageshow restores loading state without automatically submitting, accepting or reloading', () => {
  const ui = mount();
  ui.checkbox.checked = true;
  ui.dispatchSubmit();
  ui.windowListeners.pageshow({ persisted: false });
  assert.equal(ui.form.getAttribute('aria-busy'), null);
  assert.equal(ui.submit.getAttribute('aria-busy'), null);
  assert.equal(ui.submit.disabled, false);
  assert.equal(ui.label.textContent, 'Agree and continue');
  assert.equal(ui.spinner.hidden, true);
  assert.equal(ui.status.textContent, '');
  ui.checkbox.checked = false;
  ui.windowListeners.pageshow({ persisted: false });
  assert.equal(ui.submit.disabled, true);
  assert.deepEqual(ui.navigations, []);
});

test('BFCache restoration checks acceptance using a fresh review GET, never replaying a POST', () => {
  const ui = mount();
  ui.checkbox.checked = true;
  ui.dispatchSubmit();
  ui.windowListeners.pageshow({ persisted: true });
  assert.deepEqual(ui.navigations, ['/account/review?next=%2Fevents%2F123%2Fedit']);
  assert.equal(ui.form.getAttribute('aria-busy'), null);
  assert.equal(ui.label.textContent, 'Agree and continue');
  assert.equal(ui.spinner.hidden, true);
  assert.equal(ui.status.textContent, '');
});

test('server-rendered errors receive focus and require new deliberate agreement to retry', () => {
  const ui = mount({ error: 'We couldn’t save your agreement. Please try again.' });
  assert.equal(ui.error.focused, true);
  assert.equal(ui.error.hidden, false);
  assert.equal(ui.checkbox.checked, false);
  assert.equal(ui.submit.disabled, true);
  assert.equal(mount().error.focused, false);
});

test('enhancement is safe when not mounted on its review form', () => {
  assert.doesNotThrow(() => mount({ missing: 'legal-review-form' }));
});

test('review markup is no-title, accessible, progressive and independent of marketing consent', () => {
  assert.doesNotMatch(template, /<h[1-6]\b/i);
  assert.match(template, /Please review our/);
  assert.match(template, /I agree to the/);
  assert.match(template, /and acknowledge the/);
  assert.match(template, /<form[^>]+action="\/legal\/accept"[^>]+method="post"/);
  const checkbox = template.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0] || '';
  assert.match(checkbox, /name="accepted"/);
  assert.match(checkbox, /value="true"/);
  assert.match(checkbox, /\brequired\b/);
  assert.doesNotMatch(checkbox, /\bchecked\b/);
  const button = template.match(/<button[^>]*id="legal-review-submit"[^>]*>/)?.[0] || '';
  assert.doesNotMatch(button, /\bdisabled\b/);
  assert.match(template, /<form[^>]+action="\/legal\/logout"[^>]+method="post"/);
  assert.match(template, /id="legal-review-error"[^>]*role="alert"[^>]*tabindex="-1"/);
  assert.match(template, /id="legal-review-status"[^>]*role="status"/);
  assert.equal((template.match(/target="_blank" rel="noopener"/g) || []).length, 4);
  assert.doesNotMatch(template, /name="(?:marketing|emailOptIn|smsOptIn|subscribe)"/i);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
  assert.match(styles, /max-width:\s*360px/);
  assert.match(styles, /:focus-visible/);
});

test('visible review copy exactly matches the stored wording snapshot', () => {
  const legal = fs.readFileSync(path.join(root, 'src/lib/legal-acceptance.js'), 'utf8');
  const text = html => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const snapshot = constant => legal.match(new RegExp(`const ${constant} = '([^']+)';`))[1];
  const intro = template.match(/<p[^>]*id="legal-review-intro"[^>]*>([\s\S]*?)<\/p>/)[1];
  const agreement = template.match(/<label[^>]*for="legal-review-accepted"[^>]*>([\s\S]*?)<\/label>/)[1];
  const button = template.match(/<span data-legal-review-submit-label>([^<]+)<\/span>/)[1];
  assert.equal(text(intro), snapshot('REVIEW_INTRO'));
  assert.equal(text(agreement), snapshot('REVIEW_WORDING'));
  assert.equal(text(button), snapshot('REVIEW_BUTTON'));
});
