(function (factory) {
  const reminder = factory();
  if (typeof module === 'object' && module.exports) module.exports = reminder;
  else reminder.mount(document.querySelector('[data-getting-home]'), window);
})(function () {
  'use strict';

  const MANAGED = {
    pending: ['Ride text scheduled', 'One text is scheduled for this event.'],
    sending: ['Ride text in progress', 'The text is being submitted and can no longer be canceled.'],
    sent: ['Ride text submitted', 'The text was accepted by the messaging provider.'],
    failed: ['Ride text not sent', 'Check the transit schedule before you leave.'],
    cancelled: ['Ride text canceled', 'No text will be sent for this request.'],
    unknown: ['Ride text status unknown', 'We could not verify the send. We will not send another text for this event.']
  };
  const ERRORS = {
    'consent-required': 'Check the box if you want one text for this event.',
    'schedule-changed': 'The ride time changed. Check the schedule again before requesting a text.',
    'budget-exhausted': 'Ride text slots are full. You can still plan your ride here.',
    'not-eligible': 'This RSVP can no longer request a ride text.',
    'already-requested': 'There is already a ride text request for this event.',
    'verification-required': 'This pilot uses a verified US phone already on file.',
    'identity-required': 'Sign in with an existing account to request the optional text.',
    'opted-out': 'Texts are turned off for your verified phone.',
    unavailable: 'Ride texts are unavailable right now.'
  };
  const isTime = value => Number.isSafeInteger(value) && value > 0 && value <= 8.64e15;

  function schedulePayload(detail, consent) {
    const { plan, selection } = detail || {};
    if (consent !== true || plan?.status !== 'scheduled' || plan.timing !== 'scheduled'
        || !isTime(plan.proposedReminderAt) || !selection || typeof selection !== 'object') return null;
    return { selection, expectedReminderAt: plan.proposedReminderAt, consent: true };
  }

  function reminderTime(value, timeZone = 'America/Los_Angeles') {
    if (!isTime(value)) return '';
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone, weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
      }).format(value);
    } catch {
      return '';
    }
  }

  function mount(root, win) {
    if (!root) return;
    const slug = /^\/e\/([a-z0-9-]{1,120})\/getting-home\/?$/i.exec(win.location.pathname)?.[1];
    if (!slug) return;
    const api = `/api/public/events/${slug}/getting-home/reminder`;
    const get = key => root.querySelector(`#gh-reminder-${key}`);
    const offer = get('offer');
    const form = get('form');
    if (!offer || !form) return;
    const management = get('management');
    const announcement = get('announcement');
    const cancelButton = get('cancel');
    const submitButton = get('submit');
    const consent = get('consent');
    const requirement = get('requirement');
    const signin = get('signin');
    const preview = root.querySelector('#gh-text-helper');
    signin.href = `/login?next=${encodeURIComponent(`/e/${slug}/getting-home`)}`;
    let detail = null;
    let receipt = { status: 'unavailable' };
    let busy = false;

    const managedState = status => Object.prototype.hasOwnProperty.call(MANAGED, status);
    const canReschedule = () => receipt.canRequest === true && ['available', 'cancelled'].includes(receipt.status);
    const tell = value => { announcement.textContent = value; };

    function render() {
      const ready = Boolean(schedulePayload(detail, true));
      const reason = ['identity-required', 'verification-required', 'opted-out'].includes(receipt.status) ? receipt.status : '';
      const showForm = ready && canReschedule();
      offer.hidden = !ready || (!showForm && !reason);
      form.hidden = !showForm;
      requirement.hidden = !ready || !reason;
      requirement.textContent = reason ? ERRORS[reason] : '';
      signin.hidden = !ready || reason !== 'identity-required';
      management.hidden = !managedState(receipt.status);
      cancelButton.hidden = !(receipt.status === 'pending' && receipt.canCancel === true);
      if (!management.hidden) {
        const [title, description] = MANAGED[receipt.status];
        get('title').textContent = title;
        const time = receipt.status === 'pending' ? reminderTime(receipt.reminderAt, detail?.plan?.timezone || receipt.timezone) : '';
        get('description').textContent = time ? `One text at ${time}. Checking a different route here will not change it.` : description;
      }
      if (preview) preview.textContent = receipt.status === 'pending'
        ? 'A ride text is already scheduled for this event. This preview will not change it.'
        : '30 minutes before you need to leave. This preview does not schedule a text.';
    }

    async function readReceipt() {
      const response = await win.fetch(api, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) return;
      const state = await response.json();
      if (state && typeof state.status === 'string') {
        receipt = state;
        render();
      }
    }

    async function update(method, payload) {
      if (busy) return;
      const button = method === 'POST' ? submitButton : cancelButton;
      busy = true;
      button.setAttribute('aria-disabled', 'true');
      tell(method === 'POST' ? 'Setting your ride reminder…' : 'Canceling your ride reminder…');
      try {
        const response = await win.fetch(api, {
          method, credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        const next = await response.json();
        if (!response.ok) {
          const code = next.code || next.status;
          if (code === 'schedule-changed' || code === 'consent-required') {
            consent.checked = false;
            if (code === 'schedule-changed') detail = null;
            render();
            if (code === 'schedule-changed') root.querySelector('#gh-check')?.focus();
          }
          if (['identity-required', 'verification-required', 'opted-out', 'unavailable', 'not-eligible'].includes(code)) {
            receipt = { status: code };
            render();
            if (code === 'identity-required' && !signin.hidden) signin.focus();
            else root.querySelector('#gh-results-title')?.focus();
          }
          tell(Object.prototype.hasOwnProperty.call(ERRORS, code) ? ERRORS[code] : 'We could not update the ride text right now. Try again.');
          return;
        }
        if (!next || !managedState(next.status)) throw new Error('Missing ride text status');
        receipt = next;
        consent.checked = false;
        render();
        tell('');
        get('title').focus();
        if (receipt.status === 'cancelled') await readReceipt().catch(() => {});
      } catch {
        // An interrupted reply does not mean the server failed. Read the
        // current receipt before offering an action again.
        await readReceipt().catch(() => {});
        tell('We could not confirm that change. Check your ride reminder status before trying again.');
      } finally {
        busy = false;
        button.removeAttribute('aria-disabled');
      }
    }

    root.addEventListener('getting-home:plan', event => {
      detail = event.detail || null;
      consent.checked = false;
      if (!busy) tell('');
      render();
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!canReschedule()) return;
      const payload = schedulePayload(detail, consent.checked);
      if (payload) update('POST', payload);
    });
    cancelButton.addEventListener('click', () => {
      if (receipt.status === 'pending' && receipt.canCancel === true) update('DELETE', {});
    });
    readReceipt().catch(() => {}); // A failed optional service never hides transit.
  }

  return { mount, schedulePayload, reminderTime };
});
