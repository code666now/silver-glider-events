const EVENT = JSON.parse(document.getElementById('event-data').textContent);
const $ = id => document.getElementById(id);

const icsUrl = `/e/${EVENT.slug}/calendar.ics`;
$('cal-btn').href = icsUrl;
$('success-cal').href = icsUrl;
$('qr-img').src = `/e/${EVENT.slug}/qr.png`;

function show(stateId) {
  ['cta-state', 'rsvp-form-box', 'success-state', 'full-state', 'cancelled-state']
    .forEach(id => { $(id).style.display = id === stateId ? 'block' : 'none'; });
  // Success card has its own share/calendar buttons — drop the page-level pair
  document.querySelector('.wrap > .actions').style.display =
    stateId === 'success-state' ? 'none' : 'flex';
}

if (EVENT.status === 'cancelled') show('cancelled-state');
else if (EVENT.isFull) show('full-state');

$('rsvp-cta').addEventListener('click', () => {
  show('rsvp-form-box');
  $('first_name').focus();
});

$('rsvp-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('rsvp-submit');
  btn.disabled = true;
  btn.textContent = 'Confirming…';
  try {
    const res = await fetch(`/api/public/events/${EVENT.slug}/rsvp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        first_name: $('first_name').value.trim(),
        last_name: $('last_name').value.trim(),
        email: $('email').value.trim(),
        phone: $('phone').value.trim() || null,
        wants_reminders: $('wants_reminders').checked,
        organizer_optin: $('organizer_optin').checked
      })
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data.error === 'full') return show('full-state');
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    if (data.alreadyRsvpd) $('success-sub').textContent = "You were already on the list — we've re-sent your confirmation.";
    show('success-state');
  } catch (err) {
    const el = $('rsvp-error');
    el.textContent = err.message;
    el.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Confirm RSVP';
  }
});

async function share() {
  const url = location.origin + `/e/${EVENT.slug}`;
  if (navigator.share) {
    try { await navigator.share({ title: EVENT.title, url }); return; } catch (_) { /* cancelled */ }
  } else {
    await navigator.clipboard.writeText(url);
    const btn = $('share-btn');
    const orig = btn.textContent;
    btn.textContent = 'Link copied';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  }
}
$('share-btn').addEventListener('click', share);
$('success-share').addEventListener('click', share);
