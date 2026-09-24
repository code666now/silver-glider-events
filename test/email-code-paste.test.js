const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const emailCodeInput = require('../public/js/email-code-input');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

function fakeCodeInput() {
  const dispatched = [];
  class FakeEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = Boolean(options.bubbles);
    }
  }
  return {
    dispatched,
    input: {
      value: '',
      matches: selector => selector === '[data-email-code]',
      ownerDocument: { defaultView: { Event:FakeEvent } },
      dispatchEvent: event => dispatched.push(event)
    }
  };
}

test('emailed code normalization removes visual separators', () => {
  assert.equal(emailCodeInput.digits('549 218'), '549218');
  assert.equal(emailCodeInput.digits('549\u00a0218'), '549218');
  assert.equal(emailCodeInput.digits('549-218'), '549218');
});

test('complete emailed codes are normalized before maxlength can truncate pasted separators', () => {
  for (const pasted of ['549 218', '549\u00a0218', '549-218']) {
    const { input, dispatched } = fakeCodeInput();
    let prevented = false;
    const handled = emailCodeInput.handlePaste({
      target: input,
      clipboardData: { getData: type => type === 'text/plain' ? pasted : '' },
      preventDefault() { prevented = true; }
    });

    assert.equal(handled, true);
    assert.equal(prevented, true);
    assert.equal(input.value, '549218');
    assert.deepEqual(dispatched.map(event => [event.type, event.bubbles]), [['input', true]]);
  }
});

test('paste handling leaves partial or unrelated input to the browser', () => {
  const { input, dispatched } = fakeCodeInput();
  input.value = '12';
  let prevented = false;
  const handled = emailCodeInput.handlePaste({
    target: input,
    clipboardData: { getData: () => '34-5' },
    preventDefault() { prevented = true; }
  });

  assert.equal(handled, false);
  assert.equal(prevented, false);
  assert.equal(input.value, '12');
  assert.deepEqual(dispatched, []);

  input.matches = () => false;
  const unmarkedPaste = emailCodeInput.handlePaste({
    target: input,
    clipboardData: { getData: () => '549 218' },
    preventDefault() { prevented = true; }
  });
  assert.equal(unmarkedPaste, false);
  assert.equal(input.value, '12');
  assert.deepEqual(dispatched, []);
});

test('input fallback keeps at most six digits for autofill and non-paste entry', () => {
  const { input } = fakeCodeInput();
  input.value = ' 54-92 18 extra ';
  assert.equal(emailCodeInput.handleInput({ target:input }), true);
  assert.equal(input.value, '549218');
  assert.equal(emailCodeInput.handleInput({ target:input }), false);
});

test('every emailed six-digit code surface opts into the shared paste behavior', () => {
  const surfaces = [
    ['src/views/login.html', 'id="code"'],
    ['src/views/host-public.html', 'id="follow-code"'],
    ['public/js/public-event.js', 'data-code-input'],
    ['src/views/settings-v2.html', 'id="identity-code"'],
    ['src/views/admin-login.html', 'id="admin-code"'],
    ['public/js/admin-step-up.js', 'id="admin-step-up-code"'],
    ['src/views/admin-accounts.html', 'id="delete-account-code"']
  ];

  for (const [relativePath, marker] of surfaces) {
    const source = read(relativePath);
    const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const input = source.match(new RegExp(`<input[^>]*${escapedMarker}[^>]*>`))?.[0] || '';
    assert.ok(input, `${relativePath} should contain the expected code input`);
    assert.match(input, /data-email-code/);
    assert.match(input, /inputmode="numeric"/);
    assert.match(input, /autocomplete="one-time-code"/);
    assert.match(input, /maxlength="6"/);
  }
});

test('each code-entry page loads the shared handler before its consumer script', () => {
  const inlineViews = [
    'src/views/login.html',
    'src/views/host-public.html',
    'src/views/admin-login.html'
  ];
  for (const relativePath of inlineViews) {
    assert.match(read(relativePath), /<script src="\/js\/email-code-input\.js"><\/script>\s*<script>/);
  }

  const scriptPairs = [
    ['src/views/event-public.html', 'public-event'],
    ['src/views/event-public-flyer.html', 'public-event'],
    ['src/views/settings-v2.html', 'api'],
    ['src/views/admin-team.html', 'admin-step-up'],
    ['src/views/admin-accounts.html', 'admin-accounts']
  ];
  for (const [relativePath, consumer] of scriptPairs) {
    const source = read(relativePath);
    assert.ok(
      source.indexOf('/js/email-code-input.js') < source.indexOf(`/js/${consumer}.js`),
      `${relativePath} should load paste support before ${consumer}.js`
    );
  }
});

test('SMS and private-event code inputs do not opt into email paste handling', () => {
  const excludedInputs = [
    ['src/views/login.html', 'id="phone-code"'],
    ['src/views/account-verify-change.html', 'id="identity-phone-code"'],
    ['src/views/secret-show.html', 'id="secret-code"']
  ];

  for (const [relativePath, marker] of excludedInputs) {
    const source = read(relativePath);
    const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const input = source.match(new RegExp(`<input[^>]*${escapedMarker}[^>]*>`))?.[0] || '';
    assert.ok(input, `${relativePath} should contain the expected non-email code input`);
    assert.doesNotMatch(input, /data-email-code/);
  }

  assert.match(
    read('public/js/settings.js'),
    /toggleAttribute\('data-email-code', identityDialogMode !== 'add-phone'\)/
  );
});
