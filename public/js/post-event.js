(function postEventModule(root, factory) {
  const moduleApi = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = moduleApi;
  if (root) root.SgePostEvent = moduleApi;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createPostEventModule() {
  const TERMINAL_STATUSES = new Set(['sent', 'partial_failed', 'failed']);
  const ACTIVE_STATUSES = new Set(['pending', 'processing']);
  const STATUS_POLL_LIMIT = 15;
  const STATUS_POLL_DELAY = 2000;

  function count(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
  }

  function countLabel(value, singular, plural = `${singular}s`) {
    const total = count(value);
    return `${total.toLocaleString('en-US')} ${total === 1 ? singular : plural}`;
  }

  function normalizeThankYou(value = {}) {
    return {
      subject: String(value.subject || ''),
      message: String(value.message || ''),
      includeFollow: Boolean(value.includeFollow),
      eligibleCount: count(value.eligibleCount),
      canIncludeFollow: Boolean(value.canIncludeFollow),
      status: ['draft', 'pending', 'processing', 'sent', 'partial_failed', 'failed'].includes(value.status)
        ? value.status
        : 'draft',
      batchId: value.batchId || null,
      completedAt: value.completedAt || null,
      sentCount: count(value.sentCount),
      failedCount: count(value.failedCount),
      skippedCount: count(value.skippedCount),
      recipientCount: count(value.recipientCount)
    };
  }

  function normalizeState(value = {}) {
    const stats = value.stats || {};
    return {
      ended: Boolean(value.ended),
      stats: {
        rsvpSubmissions: count(stats.rsvpSubmissions),
        additionalGuests: count(stats.additionalGuests),
        markedGoing: count(stats.markedGoing),
        returning: count(stats.returning),
        newFaces: count(stats.newFaces),
        comments: count(stats.comments)
      },
      draw: value.draw && Number.isInteger(Number(value.draw.estimatedTurnout))
        ? { estimatedTurnout: count(value.draw.estimatedTurnout), updatedAt: value.draw.updatedAt || null }
        : null,
      thankYou: normalizeThankYou(value.thankYou)
    };
  }

  function deliveryStatus(thankYou) {
    const state = normalizeThankYou(thankYou);
    const accepted = state.sentCount;
    const skipped = state.skippedCount ? ` · ${state.skippedCount.toLocaleString('en-US')} skipped` : '';
    if (state.status === 'pending') {
      return {
        title: 'Your thank-you is queued.',
        copy: `${countLabel(state.recipientCount, 'message')} queued for the email provider. This does not claim inbox delivery.`
      };
    }
    if (state.status === 'processing') {
      return {
        title: 'Your thank-you is on its way.',
        copy: `${countLabel(state.recipientCount, 'message')} ${state.recipientCount === 1 ? 'is' : 'are'} being handed to the email provider.`
      };
    }
    if (state.status === 'sent') {
      return {
        title: accepted ? 'Your thank-you is on its way.' : 'No thank-yous were accepted.',
        copy: accepted
          ? `${countLabel(accepted, 'message')} accepted by the email provider${skipped}. Provider acceptance is not the same as inbox delivery.`
          : `The email provider accepted 0 messages${skipped}. Nothing is shown as delivered.`
      };
    }
    if (state.status === 'partial_failed') {
      return {
        title: state.completedAt ? 'Some thank-yous could not be sent.' : 'Some thank-yous need another try.',
        copy: state.completedAt
          ? `${accepted.toLocaleString('en-US')} accepted by the email provider · ${state.failedCount.toLocaleString('en-US')} failed${skipped}.`
          : `${accepted.toLocaleString('en-US')} accepted by the email provider${skipped}. Remaining eligible messages will retry.`
      };
    }
    if (state.status === 'failed') {
      return {
        title: 'The thank-you could not be sent.',
        copy: `${state.failedCount.toLocaleString('en-US')} ${state.failedCount === 1 ? 'message needs' : 'messages need'} attention. Nothing here is shown as delivered.`
      };
    }
    return null;
  }

  function create({ eventId, request, notify, openGuests } = {}) {
    if (typeof document === 'undefined') return null;
    if (!eventId || typeof request !== 'function') throw new Error('Post-event experience needs an event and request helper');

    const byId = id => document.getElementById(id);
    const dialog = byId('post-event-thank-dialog');
    if (!dialog) return null;

    let eventRecord = null;
    let state = normalizeState();
    let previewToken = '';
    let previewHtml = '';
    let currentPanel = 'edit';
    let restoreFocus = null;
    let statusPollTimer = null;
    let statusPollAttempts = 0;

    function setText(id, value) {
      const node = byId(id);
      if (node) node.textContent = value;
    }

    function setBusy(button, busy, label) {
      if (!button) return;
      if (busy) {
        button.dataset.previousLabel = button.textContent;
        button.textContent = label;
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
      } else {
        button.textContent = button.dataset.previousLabel || button.textContent;
        delete button.dataset.previousLabel;
        button.disabled = false;
        button.removeAttribute('aria-busy');
      }
    }

    function formBody() {
      return {
        subject: byId('post-event-thank-subject').value.trim(),
        message: byId('post-event-thank-message').value.trim(),
        includeFollow: Boolean(byId('post-event-include-follow').checked && state.thankYou.canIncludeFollow)
      };
    }

    function clearError() {
      const node = byId('post-event-dialog-error');
      node.hidden = true;
      node.textContent = '';
    }

    function showError(message) {
      const node = byId('post-event-dialog-error');
      node.textContent = message || 'Something went wrong. Nothing was sent.';
      node.hidden = false;
    }

    function invalidatePreview() {
      previewToken = '';
      previewHtml = '';
      byId('post-event-preview-tab').disabled = true;
      if (currentPanel === 'preview') showPanel('edit');
    }

    function showPanel(panel, { focus = true } = {}) {
      currentPanel = panel === 'preview' && previewToken ? 'preview' : 'edit';
      const previewing = currentPanel === 'preview';
      byId('post-event-edit-panel').hidden = previewing;
      byId('post-event-preview-panel').hidden = !previewing;
      byId('post-event-edit-tab').setAttribute('aria-selected', String(!previewing));
      byId('post-event-preview-tab').setAttribute('aria-selected', String(previewing));
      byId('post-event-dialog-back').textContent = previewing ? 'Back to edit' : 'Cancel';
      byId('post-event-dialog-next').textContent = previewing
        ? `Send to ${countLabel(state.thankYou.eligibleCount, 'guest')}`
        : 'Preview email';
      if (focus) {
        window.requestAnimationFrame(() => {
          const target = previewing ? byId('post-event-preview-panel') : byId('post-event-thank-subject');
          target?.focus({ preventScroll: true });
        });
      }
    }

    function renderDeliveryState() {
      const status = deliveryStatus(state.thankYou);
      const hasHistory = Boolean(status);
      if (hasHistory) currentPanel = 'status';
      byId('post-event-edit-panel').hidden = hasHistory;
      byId('post-event-preview-panel').hidden = true;
      byId('post-event-dialog-tabs').hidden = hasHistory;
      byId('post-event-send-status').hidden = !hasHistory;
      byId('post-event-dialog-next').hidden = hasHistory;
      byId('post-event-dialog-back').textContent = hasHistory ? 'Close' : 'Cancel';
      if (status) {
        setText('post-event-send-status-title', status.title);
        setText('post-event-send-status-copy', status.copy);
      }
    }

    function shouldPollStatus() {
      return ACTIVE_STATUSES.has(state.thankYou.status)
        || (state.thankYou.status === 'partial_failed' && !state.thankYou.completedAt);
    }

    function stopStatusPolling() {
      if (statusPollTimer) window.clearTimeout(statusPollTimer);
      statusPollTimer = null;
      statusPollAttempts = 0;
    }

    function scheduleStatusPoll({ reset = false } = {}) {
      if (reset) stopStatusPolling();
      if (!dialog.open || !shouldPollStatus() || statusPollTimer) return;
      if (statusPollAttempts >= STATUS_POLL_LIMIT) {
        const current = deliveryStatus(state.thankYou);
        if (current) setText('post-event-send-status-copy', `${current.copy} Refresh this page later for the latest provider status.`);
        return;
      }
      statusPollTimer = window.setTimeout(async () => {
        statusPollTimer = null;
        statusPollAttempts += 1;
        try {
          const result = await request(`/api/events/${encodeURIComponent(eventId)}/post-event`);
          render(result);
          renderDeliveryState();
        } catch (_) {
          // The saved batch is still safe. A later poll or page refresh can recover its status.
        }
        scheduleStatusPoll();
      }, STATUS_POLL_DELAY);
    }

    function hydrateEditor() {
      const thankYou = state.thankYou;
      setText('post-event-thank-event', eventRecord?.title || 'Your event');
      setText('post-event-eligible-count', thankYou.eligibleCount.toLocaleString('en-US'));
      byId('post-event-thank-subject').value = thankYou.subject;
      byId('post-event-thank-message').value = thankYou.message;
      byId('post-event-include-follow').checked = thankYou.canIncludeFollow && thankYou.includeFollow;
      byId('post-event-include-follow').disabled = !thankYou.canIncludeFollow;
      setText('post-event-follow-copy', thankYou.canIncludeFollow
        ? 'Shown only to guests who separately agreed to emails from you.'
        : 'Available when eligible guests have separate permission for emails from you.');
      byId('post-event-preview-tab').disabled = !previewToken;
      byId('post-event-dialog-tabs').hidden = false;
      byId('post-event-dialog-next').hidden = false;
      byId('post-event-send-status').hidden = true;
      renderDeliveryState();
    }

    function renderDraw() {
      const draw = state.draw;
      byId('post-event-turnout').value = draw ? String(draw.estimatedTurnout) : '';
      byId('post-event-draw-form').hidden = Boolean(draw);
      byId('post-event-draw-status').hidden = !draw;
      if (draw) {
        setText('post-event-draw-status-copy', `${state.stats.markedGoing.toLocaleString('en-US')} marked going · ${draw.estimatedTurnout.toLocaleString('en-US')} estimated turnout`);
      }
    }

    function render(nextState) {
      state = normalizeState(nextState);
      if (!state.ended) {
        byId('lifecycle-recap').setAttribute('aria-busy', 'false');
        setText('post-event-loading', 'Your private recap will be available after this event ends.');
        byId('post-event-loading').hidden = false;
        byId('post-event-stats').hidden = true;
        byId('post-event-draw-form').hidden = true;
        byId('post-event-draw-status').hidden = true;
        byId('post-event-actions').hidden = true;
        if (dialog.open) closeDialog();
        return;
      }
      const statIds = {
        rsvpSubmissions: 'post-event-rsvp-submissions',
        additionalGuests: 'post-event-additional-guests',
        markedGoing: 'post-event-marked-going',
        returning: 'post-event-returning',
        newFaces: 'post-event-new-faces',
        comments: 'post-event-comments'
      };
      for (const [key, id] of Object.entries(statIds)) setText(id, state.stats[key].toLocaleString('en-US'));
      setText('post-event-marked-going-copy', `${countLabel(state.stats.markedGoing, 'person', 'people')} marked going.`);
      setText('post-event-guest-discovery-copy', state.stats.returning || state.stats.newFaces
        ? `${countLabel(state.stats.returning, 'returning RSVP')} · ${countLabel(state.stats.newFaces, 'first-time RSVP')}`
        : 'Open Familiar Faces to see everyone connected to this event.');

      const thankYou = state.thankYou;
      const thankStatus = deliveryStatus(thankYou);
      setText('post-event-thank-copy', thankStatus
        ? thankStatus.title
        : thankYou.eligibleCount
          ? `Review a personal note for ${countLabel(thankYou.eligibleCount, 'eligible guest')}.`
          : 'No guests are currently eligible under your email consent settings.');
      byId('post-event-thank-guests').disabled = !thankStatus && thankYou.eligibleCount === 0;

      byId('post-event-loading').hidden = true;
      byId('post-event-stats').hidden = false;
      byId('post-event-actions').hidden = false;
      byId('lifecycle-recap').setAttribute('aria-busy', 'false');
      renderDraw();
      hydrateEditor();
    }

    async function load(record = eventRecord) {
      eventRecord = record || eventRecord;
      const result = await request(`/api/events/${encodeURIComponent(eventId)}/post-event`);
      render(result);
      return state;
    }

    function renderUnavailable(record) {
      eventRecord = record || eventRecord;
      byId('lifecycle-recap').setAttribute('aria-busy', 'false');
      setText('post-event-loading', 'Your RSVP summary is still available above. The private post-event record could not load; try refreshing this page.');
      byId('post-event-loading').hidden = false;
      byId('post-event-stats').hidden = true;
      byId('post-event-draw-form').hidden = true;
      byId('post-event-draw-status').hidden = true;
      byId('post-event-actions').hidden = true;
    }

    function closeDialog() {
      if (dialog.open) dialog.close();
    }

    function openDialog() {
      restoreFocus = document.activeElement;
      clearError();
      invalidatePreview();
      hydrateEditor();
      if (!ACTIVE_STATUSES.has(state.thankYou.status) && !TERMINAL_STATUSES.has(state.thankYou.status)) {
        showPanel('edit', { focus: false });
      }
      dialog.showModal();
      window.requestAnimationFrame(() => {
        const target = ACTIVE_STATUSES.has(state.thankYou.status) || TERMINAL_STATUSES.has(state.thankYou.status)
          ? byId('post-event-send-status')
          : byId('post-event-thank-subject');
        target?.focus({ preventScroll: true });
      });
      scheduleStatusPoll({ reset: true });
    }

    async function saveDraw(event) {
      event.preventDefault();
      const input = byId('post-event-turnout');
      const raw = input.value.trim();
      const estimate = Number(raw);
      input.setCustomValidity('');
      if (!raw || !Number.isInteger(estimate) || estimate < 0) {
        input.setCustomValidity('Enter a whole number of zero or more.');
        input.reportValidity();
        return;
      }

      const button = byId('post-event-save-draw');
      setBusy(button, true, 'Saving…');
      try {
        const result = await request(`/api/events/${encodeURIComponent(eventId)}/post-event/turnout`, {
          method: 'PATCH', body: { estimatedTurnout: estimate }
        });
        state.draw = result.draw || result;
        renderDraw();
        byId('post-event-draw-status').focus({ preventScroll: true });
        notify?.('Your private turnout estimate was saved');
      } catch (error) {
        notify?.(error.message || 'Could not save the turnout estimate');
      } finally {
        setBusy(button, false);
      }
    }

    async function createPreview() {
      const subject = byId('post-event-thank-subject');
      const message = byId('post-event-thank-message');
      if (!subject.reportValidity() || !message.reportValidity()) return;
      const body = formBody();
      if (!body.subject || !body.message) return;

      const button = byId('post-event-dialog-next');
      setBusy(button, true, 'Building preview…');
      clearError();
      try {
        const saved = await request(`/api/events/${encodeURIComponent(eventId)}/post-event/thank-you`, {
          method: 'PUT', body
        });
        state.thankYou = normalizeThankYou(saved.thankYou || saved);
        const preview = await request(`/api/events/${encodeURIComponent(eventId)}/post-event/thank-you/preview`, {
          method: 'POST', body
        });
        previewToken = String(preview.previewToken || '');
        previewHtml = String(preview.html || '');
        state.thankYou.eligibleCount = count(preview.eligibleCount);
        byId('post-event-preview-frame').srcdoc = previewHtml;
        setText('post-event-preview-count', countLabel(state.thankYou.eligibleCount, 'eligible recipient'));
        byId('post-event-preview-tab').disabled = !previewToken;
        showPanel('preview');
      } catch (error) {
        showError(error.message || 'The preview could not be created. Nothing was sent.');
      } finally {
        setBusy(button, false);
        if (currentPanel === 'preview') {
          button.textContent = `Send to ${countLabel(state.thankYou.eligibleCount, 'guest')}`;
        }
      }
    }

    async function sendThankYou() {
      if (!previewToken) {
        showPanel('edit');
        showError('Preview the current message before sending.');
        return;
      }
      const button = byId('post-event-dialog-next');
      setBusy(button, true, 'Queuing…');
      clearError();
      try {
        const result = await request(`/api/events/${encodeURIComponent(eventId)}/post-event/thank-you/send`, {
          method: 'POST', body: { previewToken }
        });
        state.thankYou = normalizeThankYou(result.thankYou || result);
        previewToken = '';
        previewHtml = '';
        render(state);
        renderDeliveryState();
        byId('post-event-send-status').focus({ preventScroll: true });
        notify?.('Your thank-you was queued with the email provider');
        scheduleStatusPoll({ reset: true });
      } catch (error) {
        if (error.status === 409) {
          try { await load(eventRecord); } catch (_) {}
          if (state.thankYou.status !== 'draft') {
            renderDeliveryState();
            scheduleStatusPoll({ reset: true });
            byId('post-event-send-status').focus({ preventScroll: true });
          } else {
            showPanel('edit', { focus: false });
            showError('The guest list or message changed. Review the current count and preview again before sending.');
            byId('post-event-thank-subject').focus({ preventScroll: true });
          }
        } else {
          showError(error.message || 'The thank-you could not be queued. Nothing was sent.');
        }
      } finally {
        setBusy(button, false);
      }
    }

    byId('post-event-draw-form').addEventListener('submit', saveDraw);
    byId('post-event-edit-draw').addEventListener('click', () => {
      byId('post-event-draw-status').hidden = true;
      byId('post-event-draw-form').hidden = false;
      byId('post-event-turnout').focus();
    });
    byId('post-event-see-guests').addEventListener('click', () => openGuests?.());
    byId('post-event-thank-guests').addEventListener('click', openDialog);
    byId('post-event-thank-close').addEventListener('click', closeDialog);
    byId('post-event-edit-tab').addEventListener('click', () => showPanel('edit'));
    byId('post-event-preview-tab').addEventListener('click', () => showPanel('preview'));
    byId('post-event-back-to-edit').addEventListener('click', () => showPanel('edit'));
    byId('post-event-dialog-back').addEventListener('click', () => {
      if (currentPanel === 'preview') showPanel('edit');
      else closeDialog();
    });
    byId('post-event-thank-form').addEventListener('submit', event => {
      event.preventDefault();
      if (currentPanel === 'preview') sendThankYou();
      else if (currentPanel === 'edit') createPreview();
    });
    for (const id of ['post-event-thank-subject', 'post-event-thank-message', 'post-event-include-follow']) {
      byId(id).addEventListener('input', invalidatePreview);
      byId(id).addEventListener('change', invalidatePreview);
    }
    dialog.addEventListener('click', event => {
      if (event.target === dialog) closeDialog();
    });
    dialog.addEventListener('close', () => {
      stopStatusPolling();
      if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
      restoreFocus = null;
      clearError();
    });

    return { load, renderUnavailable, openDialog, state: () => state };
  }

  return { create, normalizeState, normalizeThankYou, deliveryStatus, countLabel };
});
