const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderRsvpConfirmationEmail } = require('../src/lib/mailer');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const HOST_LINK = '/login?next=%2Fevents%2Fnew';

test('guests are invited to host right after they RSVP, in both presentations', () => {
  for (const template of ['src/views/event-public.html', 'src/views/event-public-flyer.html']) {
    const view = read(template);
    const success = view.slice(view.indexOf('id="success-state"'), view.indexOf('id="full-state"'));
    assert.match(success, new RegExp(`<a class="host-your-own" href="${HOST_LINK.replace(/[?]/g, '\\?')}">Host your own event →</a>`));
    const answered = view.slice(view.indexOf('id="returning-rsvp-answer"'), view.indexOf('id="returning-rsvp-error"'));
    assert.match(answered, /class="host-your-own"/);
    // Only after an answer: never on the unanswered ask or the RSVP form.
    const ask = view.slice(view.indexOf('id="returning-rsvp-ask"'), view.indexOf('id="returning-rsvp-answer"'));
    assert.doesNotMatch(ask, /host-your-own/);
    const form = view.slice(view.indexOf('id="rsvp-form-box"'), view.indexOf('id="success-state"'));
    assert.doesNotMatch(form, /host-your-own/);
  }
  assert.match(read('public/css/brand.css'), /\.host-your-own \{/);
});

test('RSVP confirmation emails end with a quiet host invitation', () => {
  process.env.APP_URL = 'https://silvergliderevents.com';
  const base = {
    title: 'Halloween Party', slug: 'halloween-party', event_date: '2030-10-31', start_time: '20:00',
    venue_name: 'Test Hall', venue_address: '1 Test Way', comments_enabled: false, artwork_accent_color: '#1CC5BE'
  };
  const rsvp = { first_name: 'Lucas', manage_token: 'private-token', wants_reminders: true };
  for (const presentation_mode of ['standard', 'flyer']) {
    const html = renderRsvpConfirmationEmail({
      event: { ...base, presentation_mode, flyer_image_url: presentation_mode === 'flyer' ? 'https://res.cloudinary.com/demo/image/upload/flyer.jpg' : null },
      rsvp
    });
    assert.match(html, /href="https:\/\/silvergliderevents\.com\/login\?next=%2Fevents%2Fnew"/);
    assert.match(html, /Host your own event &rarr;/);
    // It sits after the event's own call to action, in the footer.
    assert.ok(html.indexOf('Host your own event') > html.indexOf('Powered by Silver Glider'));
  }
});
