/* Admin → Events → event details → Safety.
   Super Admins can remove an image from public access or hide the whole
   event, and undo either. Every action asks for a reason and an explicit
   confirmation. Other admins see the same information read-only. */
(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
  const when = value => {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
  };
  const ACTION_LABELS = {
    remove_image: 'Removed',
    restore_image: 'Restored',
    retry_image: 'Retried removal of',
    hide_event: 'Hid the event',
    unhide_event: 'Unhid the event'
  };
  const STORAGE_LABELS = {
    private: 'Off the public internet',
    failed: 'Removed from the page, but the file is still reachable. Retry.',
    pending: 'Removing…',
    not_applicable: 'Not stored by Silver Glider, removed from the page',
    public: 'Restored'
  };

  function storageNote(removal) {
    if (removal.restoredAt) return `Restored ${when(removal.restoredAt)}${removal.restoredBy ? ` by ${removal.restoredBy}` : ''}`;
    return STORAGE_LABELS[removal.storageState] || '';
  }

  function render(root, eventId, { canModerate = false, onChange = () => {} } = {}) {
    let state = null;
    let pending = null; // { kind, field?, removalId?, label }
    let busy = false;

    async function load(focusSelector) {
      root.setAttribute('aria-busy', 'true');
      try {
        state = await api(`/api/admin/events/${encodeURIComponent(eventId)}/moderation`);
        draw();
        if (focusSelector) root.querySelector(focusSelector)?.focus();
      } catch (error) {
        root.innerHTML = `<p class="admin-safety-error" role="alert">${esc(error.message || 'Safety controls could not load.')}</p>`;
      } finally {
        root.setAttribute('aria-busy', 'false');
      }
    }

    function confirmPanel() {
      if (!pending) return '';
      const needsReason = pending.kind === 'remove' || pending.kind === 'hide';
      const copy = {
        remove: `Remove the ${pending.label.toLowerCase()} from public view? The page shows its placeholder instead. RSVPs stay. You can restore it later.`,
        hide: 'Hide this event from the public? Its page, links and reminders stop. RSVPs and records stay, and the organizer can’t change or republish it. You can unhide it later.',
        unhide: 'Unhide this event? It returns to how it was before it was hidden.',
        restore: `Restore the ${pending.label.toLowerCase()}? It becomes public again wherever it was removed, unless the organizer has already replaced it.`
      }[pending.kind];
      const button = { remove: 'Remove image', hide: 'Hide event', unhide: 'Unhide event', restore: 'Restore image' }[pending.kind];
      return `
        <form class="admin-safety-confirm" id="safety-confirm" aria-labelledby="safety-confirm-copy">
          <p id="safety-confirm-copy">${esc(copy)}</p>
          ${needsReason ? `
            <label class="admin-safety-reason">
              <span>Reason (internal, never shown to the organizer)</span>
              <textarea class="sg-textarea" id="safety-reason" maxlength="500" rows="2" required minlength="3"></textarea>
            </label>` : ''}
          <p class="admin-safety-error" id="safety-confirm-error" role="alert"></p>
          <div class="admin-safety-confirm-actions">
            <button class="sg-btn sg-btn-ghost" type="button" id="safety-cancel">Cancel</button>
            <button class="sg-btn ${pending.kind === 'remove' || pending.kind === 'hide' ? 'sg-btn-danger' : 'sg-btn-primary'}" type="submit" id="safety-submit">${esc(button)}</button>
          </div>
        </form>`;
    }

    function draw() {
      const { event, images, removals, history } = state;
      const statusLine = event.hidden
        ? `<p class="admin-safety-status is-hidden"><strong>Hidden from the public</strong> since ${esc(when(event.hiddenAt))}${event.hiddenBy ? ` by ${esc(event.hiddenBy)}` : ''}. Reason: ${esc(event.hiddenReason || '—')}</p>`
        : '';
      const imageList = images.length
        ? `<ul class="admin-safety-images">${images.map(image => `
            <li>
              <a href="${esc(image.url)}" target="_blank" rel="noopener noreferrer" class="admin-safety-thumb">
                <img src="${esc(image.url)}" alt="${esc(image.label)}" loading="lazy">
              </a>
              <span>${esc(image.label)}</span>
              ${canModerate ? `<button class="sg-btn sg-btn-danger admin-safety-small" type="button" data-remove="${esc(image.field)}" data-label="${esc(image.label)}">Remove</button>` : ''}
            </li>`).join('')}</ul>`
        : '<p class="admin-safety-muted">No images on this event right now.</p>';
      const removalList = removals.length
        ? `<h4>Removed images</h4><ul class="admin-safety-removals">${removals.map(removal => `
            <li>
              <div>
                <strong>${esc(removal.label)}</strong>
                <span>${esc(when(removal.removedAt))}${removal.removedBy ? ` · ${esc(removal.removedBy)}` : ''}${removal.eventCount > 1 ? ` · on ${removal.eventCount} events` : ''}</span>
                <span>Reason: ${esc(removal.reason)}</span>
                <span class="admin-safety-storage is-${esc(removal.restoredAt ? 'public' : removal.storageState)}">${esc(storageNote(removal))}</span>
              </div>
              ${canModerate && !removal.restoredAt ? `
                <div class="admin-safety-row-actions">
                  ${removal.storageState === 'failed' || removal.storageState === 'pending' ? `<button class="sg-btn sg-btn-ghost admin-safety-small" type="button" data-retry="${removal.id}">Retry</button>` : ''}
                  <button class="sg-btn sg-btn-ghost admin-safety-small" type="button" data-restore="${removal.id}" data-label="${esc(removal.label)}">Restore</button>
                </div>` : ''}
            </li>`).join('')}</ul>`
        : '';
      const historyList = history.length
        ? `<details class="admin-safety-history"><summary>History (${history.length})</summary><ul>${history.map(item => `
            <li>${esc(when(item.at))} · ${esc(item.admin || 'Admin')} · ${esc(ACTION_LABELS[item.action] || item.action)}${item.label ? ` ${esc(item.label.toLowerCase())}` : ''}${item.reason ? ` — ${esc(item.reason)}` : ''}</li>`).join('')}</ul></details>`
        : '';
      const hideButton = !canModerate ? ''
        : event.hidden
          ? '<button class="sg-btn sg-btn-ghost" type="button" data-unhide>Unhide event</button>'
          : (event.status === 'published' || event.status === 'cancelled')
            ? '<button class="sg-btn sg-btn-danger" type="button" data-hide>Hide event</button>'
            : '';
      root.innerHTML = `
        <h3 id="admin-safety-title" tabindex="-1">Safety</h3>
        ${statusLine}
        ${imageList}
        ${hideButton ? `<div class="admin-safety-event-actions">${hideButton}</div>` : ''}
        ${canModerate ? '' : '<p class="admin-safety-muted">Only Super Admins can remove images or hide events.</p>'}
        ${confirmPanel()}
        ${removalList}
        ${historyList}`;
      bind();
    }

    function bind() {
      root.querySelectorAll('[data-remove]').forEach(button => button.addEventListener('click', () => {
        open({ kind: 'remove', field: button.dataset.remove, label: button.dataset.label });
      }));
      root.querySelectorAll('[data-restore]').forEach(button => button.addEventListener('click', () => {
        open({ kind: 'restore', removalId: Number(button.dataset.restore), label: button.dataset.label });
      }));
      root.querySelectorAll('[data-retry]').forEach(button => button.addEventListener('click', () => retry(button)));
      root.querySelector('[data-hide]')?.addEventListener('click', () => open({ kind: 'hide', label: 'event' }));
      root.querySelector('[data-unhide]')?.addEventListener('click', () => open({ kind: 'unhide', label: 'event' }));
      const form = root.querySelector('#safety-confirm');
      if (form) {
        form.addEventListener('submit', submit);
        root.querySelector('#safety-cancel').addEventListener('click', () => { pending = null; draw(); root.querySelector('#admin-safety-title')?.focus(); });
      }
    }

    function open(action) {
      if (busy) return;
      pending = action;
      draw();
      (root.querySelector('#safety-reason') || root.querySelector('#safety-submit'))?.focus();
    }

    async function retry(button) {
      if (busy) return;
      busy = true;
      button.disabled = true;
      try {
        await api(`/api/admin/image-removals/${encodeURIComponent(button.dataset.retry)}/retry`, { method: 'POST', body: {} });
        await load();
      } catch (error) {
        button.disabled = false;
        root.querySelector('#admin-safety-title')?.insertAdjacentHTML('afterend',
          `<p class="admin-safety-error" role="alert">${esc(error.message || 'Retry failed. Try again in a moment.')}</p>`);
      } finally {
        busy = false;
      }
    }

    async function submit(formEvent) {
      formEvent.preventDefault();
      if (busy || !pending) return;
      const errorBox = root.querySelector('#safety-confirm-error');
      const reasonBox = root.querySelector('#safety-reason');
      const reason = reasonBox ? reasonBox.value.trim() : '';
      if (reasonBox && reason.length < 3) {
        errorBox.textContent = 'Add a short reason (at least 3 characters).';
        reasonBox.focus();
        return;
      }
      const submitButton = root.querySelector('#safety-submit');
      busy = true;
      submitButton.disabled = true;
      submitButton.textContent = 'Working…';
      const id = encodeURIComponent(eventId);
      const request = {
        remove: [`/api/admin/events/${id}/images/remove`, { field: pending.field, reason, confirm: true }],
        hide: [`/api/admin/events/${id}/hide`, { reason, confirm: true }],
        unhide: [`/api/admin/events/${id}/unhide`, { confirm: true }],
        restore: [`/api/admin/image-removals/${encodeURIComponent(pending.removalId)}/restore`, { confirm: true }]
      }[pending.kind];
      try {
        const result = await api(request[0], { method: 'POST', body: request[1] });
        const kind = pending.kind;
        pending = null;
        await load('#admin-safety-title');
        if (kind === 'remove' && result.storageState === 'failed') {
          root.querySelector('#admin-safety-title')?.insertAdjacentHTML('afterend',
            '<p class="admin-safety-error" role="alert">The image is off the page, but the file could not be made private. Use Retry below.</p>');
        }
        onChange(kind, result);
      } catch (error) {
        errorBox.textContent = error.message || 'That didn’t work. Try again.';
        submitButton.disabled = false;
        submitButton.textContent = { remove: 'Remove image', hide: 'Hide event', unhide: 'Unhide event', restore: 'Restore image' }[pending.kind];
      } finally {
        busy = false;
      }
    }

    root.innerHTML = '<p class="admin-safety-muted">Loading safety controls…</p>';
    load();
  }

  window.adminEventSafety = { render };
})();
