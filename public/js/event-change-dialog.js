(() => {
  function value(source, camel, snake) {
    return source?.[camel] ?? source?.[snake] ?? '';
  }

  function formatDate(raw) {
    const dateValue = String(raw || '').slice(0, 10);
    const date = new Date(`${dateValue}T00:00:00Z`);
    return Number.isNaN(date.getTime())
      ? dateValue
      : date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  }

  function formatTime(raw) {
    const [hours, minutes] = String(raw || '').slice(0, 5).split(':').map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return String(raw || '');
    return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours >= 12 ? 'PM' : 'AM'}`;
  }

  function formatLocation(name, address) {
    const parts = window.SGLocation?.displayParts
      ? window.SGLocation.displayParts(name, address)
      : { name: String(name || '').trim(), address: String(address || '').trim() };
    return [parts.name, parts.address].filter(Boolean).join(' — ') || 'Location not specified';
  }

  function compare(current, next) {
    const changes = [];
    const currentDate = String(value(current, 'eventDate', 'event_date')).slice(0, 10);
    const nextDate = String(value(next, 'eventDate', 'event_date')).slice(0, 10);
    if (currentDate !== nextDate) changes.push({ label: 'Date', before: formatDate(currentDate), after: formatDate(nextDate) });

    const currentTime = String(value(current, 'startTime', 'start_time')).slice(0, 5);
    const nextTime = String(value(next, 'startTime', 'start_time')).slice(0, 5);
    if (currentTime !== nextTime) changes.push({ label: 'Start time', before: formatTime(currentTime), after: formatTime(nextTime) });

    const currentLocation = formatLocation(value(current, 'venueName', 'venue_name'), value(current, 'venueAddress', 'venue_address'));
    const nextLocation = formatLocation(value(next, 'venueName', 'venue_name'), value(next, 'venueAddress', 'venue_address'));
    if (currentLocation !== nextLocation) changes.push({ label: 'Location', before: currentLocation, after: nextLocation });
    return changes;
  }

  function buildDialog({ mode, count, changes }) {
    const isCancel = mode === 'cancel';
    const hasGuests = count > 0;
    const guestLabel = `${count} ${count === 1 ? 'guest' : 'guests'}`;
    const dialog = document.createElement('dialog');
    dialog.className = 'event-change-dialog';
    dialog.setAttribute('aria-labelledby', 'event-change-dialog-title');
    const list = !isCancel && changes.length
      ? `<div class="event-change-list">${changes.map(change => `<div class="event-change-row"><strong>${escapeHtml(change.label)}</strong><span><s>${escapeHtml(change.before)}</s><b aria-hidden="true">→</b><em>${escapeHtml(change.after)}</em></span></div>`).join('')}</div>`
      : '';
    dialog.innerHTML = `<form method="dialog" class="event-change-card">
      <p class="event-change-kicker">${isCancel ? 'Cancel event' : 'Important update'}</p>
      <h2 id="event-change-dialog-title">${isCancel ? (hasGuests ? `Tell ${guestLabel}?` : 'Cancel this event?') : `Notify ${guestLabel}?`}</h2>
      <p class="event-change-intro">${isCancel
        ? 'The public page will show that this event was cancelled.'
        : 'These changes may affect their plans.'}</p>
      ${list}
      <p class="event-change-note">${hasGuests
        ? 'One automated email will be sent to each confirmed RSVP. Replies are not monitored.'
        : 'There are no confirmed guests to notify.'}</p>
      <div class="event-change-actions">
        <button class="event-change-primary" value="${hasGuests ? 'notify' : 'without'}">${isCancel ? (hasGuests ? `Cancel & notify ${guestLabel}` : 'Cancel event') : `Save & notify ${guestLabel}`}</button>
        ${hasGuests ? `<button class="event-change-secondary" value="without">${isCancel ? 'Cancel without email' : 'Save without email'}</button>` : ''}
        <button class="event-change-tertiary" value="cancel">${isCancel ? 'Keep event' : 'Keep editing'}</button>
      </div>
    </form>`;
    return dialog;
  }

  function escapeHtml(input) {
    return String(input ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function confirmChoice({ mode = 'update', count = 0, changes = [] }) {
    if (!count && mode === 'update') return Promise.resolve('without');
    return new Promise(resolve => {
      const dialog = buildDialog({ mode, count, changes });
      const finish = choice => {
        dialog.remove();
        resolve(choice || 'cancel');
      };
      dialog.addEventListener('close', () => finish(dialog.returnValue), { once: true });
      dialog.addEventListener('cancel', event => {
        event.preventDefault();
        dialog.close('cancel');
      });
      document.body.appendChild(dialog);
      dialog.showModal();
    });
  }

  window.SGEEventChanges = {
    compare,
    confirmUpdate: options => confirmChoice({ ...options, mode: 'update' }),
    confirmCancellation: options => confirmChoice({ ...options, mode: 'cancel' })
  };
})();
