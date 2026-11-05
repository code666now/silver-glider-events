(function (root) {
  'use strict';

  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const labels = { ready: 'Ready', invalid: 'Needs attention', duplicate: 'Duplicate — skipped', already_connected: 'Already connected — skipped', opted_out: 'Unsubscribed — skipped' };

  function create({ eventId, api, canOpen = () => true, onPastGuests = () => {}, onQueued = () => {}, onImported = () => {}, onSelectionRemove = () => {} }) {
    const get = suffix => document.getElementById(`guest-import-${suffix}`);
    const dialog = get('dialog');
    if (!dialog || !root.SGGuestListParser) return null;
    const parser = root.SGGuestListParser;
    const path = `/api/events/${encodeURIComponent(eventId)}/guest-import`;
    const sections = ['input', 'mapping', 'review', 'preview', 'status'];
    let step = 'input';
    let mode = 'paste';
    let busy = false;
    let revision = 0;
    let returnFocus = null;
    let previousOverflow = '';
    let raw = '';
    let uploadRaw = '';
    let fileReady = false;
    let parsed = null;
    let rows = [];
    let review = null;
    let reviewedRows = [];
    let submission = null;
    let batchId = null;
    let status = null;
    let pollTimer = null;
    let pollCount = 0;
    let acceptedSeen = 0;
    let flow = 'import';
    let inviteSelection = null;

    function clearError() { get('error').hidden = true; get('error').replaceChildren(); }
    function showError(message, error) {
      const node = get('error');
      node.textContent = message || 'Something went wrong. Your list is still here.';
      if (error?.data?.code === 'email_verification_required') {
        const link = document.createElement('a');
        link.href = '/settings/account'; link.textContent = 'Open account settings';
        node.append(document.createTextNode(' '), link);
      }
      node.hidden = false;
      node.focus({ preventScroll: true });
      node.scrollIntoView({ block: 'nearest' });
    }
    function setBusy(value) {
      busy = value;
      dialog.setAttribute('aria-busy', String(value));
      get('close').disabled = value;
      get('back').disabled = value;
      get('next').disabled = value || (step === 'preview' && (!get('permission').checked || !review?.canSend));
      get('check-status').disabled = value;
      ['paste-tab', 'upload-tab', 'text', 'file', 'has-header', 'email-column', 'name-column', 'change-columns', 'permission'].forEach(name => { get(name).disabled = value; });
      get('rows').querySelectorAll('input,button').forEach(node => { node.disabled = value; });
    }
    function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }
    function show(next, { focus = true } = {}) {
      step = next;
      clearError();
      sections.forEach(name => { get(name).hidden = name !== next; });
      get('foot').hidden = false;
      get('next').hidden = next === 'status';
      get('back').textContent = next === 'status' ? 'Close' : next === 'input' ? 'Cancel' : 'Back';
      const headings = {
        input: ['Import guest list', 'Bring your own list', 'Add up to 100 people to review. Nothing has been sent.'],
        mapping: ['Import guest list', 'Match your columns', 'We only need an email. Names make the invitation personal.'],
        review: flow === 'import' ? ['Review your contacts', 'A quick check', 'Confirm to save valid contacts and select eligible people. No invitations are sent.'] : ['Review invitations', 'Your people, together', 'Familiar Faces and Contacts share one invitation list. Each person is counted once.'],
        preview: ['One last look', 'Your invitation', `${review?.summary?.ready || 0} ready to receive one email. Review it before sending.`],
        status: ['Invitation status', 'Your invitations', 'We’ll keep accepted, pending, and skipped messages separate.']
      };
      [get('kicker').textContent, get('title').textContent, get('intro').textContent] = headings[next];
      get('next').textContent = next === 'input' || next === 'mapping' ? 'Review list' : next === 'review' ? reviewButtonText() : `Send ${review?.summary?.ready || 0} invitations`;
      setBusy(busy);
      if (focus) { get('body').scrollTop = 0; get('title').focus({ preventScroll: true }); }
    }
    function invalidateReview() { review = null; reviewedRows = []; get('permission').checked = false; get('email-preview').srcdoc = ''; }
    function reviewButtonText() {
      if (flow === 'invite') return 'Preview invitation';
      if (!review) return 'Check changes';
      const count = review.summary.ready || 0;
      return count ? `Add & select ${count} ${count === 1 ? 'contact' : 'contacts'}` : 'Save valid contacts';
    }
    function setMode(next) {
      mode = next;
      get('paste-panel').hidden = mode !== 'paste';
      get('upload-panel').hidden = mode !== 'upload';
      get('paste-tab').setAttribute('aria-pressed', String(mode === 'paste'));
      get('upload-tab').setAttribute('aria-pressed', String(mode === 'upload'));
      clearError();
    }
    function summaryText(summary) {
      const values = [`${Number(summary.ready) || 0} ready`];
      if (summary.invalid) values.push(`${summary.invalid} need attention`);
      if (summary.duplicate) values.push(`${summary.duplicate} duplicate${summary.duplicate === 1 ? '' : 's'}`);
      if (summary.already_connected) values.push(`${summary.already_connected} already connected`);
      if (summary.opted_out) values.push(`${summary.opted_out} unsubscribed`);
      if (summary.existingContacts) values.push(`${summary.existingContacts} already in Contacts`);
      return values.join(' · ');
    }
    function renderRows() {
      get('review').querySelector('.guest-import-review-tools p').textContent = flow === 'import' ? 'Correct a detail or remove a row. Valid contacts are saved; only eligible people are selected.' : 'Remove anyone you do not want to invite. Ineligible or duplicate people are skipped.';
      get('summary').textContent = review ? summaryText(review.summary) : `${rows.length} people · Changes will be checked before preview.`;
      get('rows').innerHTML = rows.map((row, index) => `<div class="guest-import-row" data-row-index="${index}" data-status="${escape(row.status || 'unchecked')}">${flow === 'invite' ? `<div class="guest-import-recipient"><span><strong>${escape(row.name || row.email || 'Guest')}</strong><small>${escape(row.email || (row.source === 'contact' ? 'Contact' : 'Familiar Face'))}</small></span><button class="guest-import-remove" type="button" data-remove-row="${index}" aria-label="Remove ${escape(row.name || 'recipient')}">×</button></div>` : `<div class="guest-import-row-fields"><label>Name <span>(optional)</span><input class="sg-input" type="text" data-field="name" value="${escape(row.name)}" maxlength="120" autocomplete="off" aria-label="Name, row ${index + 1}"></label><label>Email<input class="sg-input" type="email" data-field="email" value="${escape(row.email)}" maxlength="254" inputmode="email" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="Email, row ${index + 1}" aria-invalid="${row.status === 'invalid'}"></label><button class="guest-import-remove" type="button" data-remove-row="${index}" aria-label="Remove row ${index + 1}">×</button></div>`}<p class="guest-import-row-status">${escape(row.message || labels[row.status] || 'Will be checked before preview')}</p></div>`).join('');
      get('change-columns').hidden = flow === 'invite' || !parsed?.sample;
      const limits = review?.limits;
      get('limit').textContent = flow === 'import' ? 'Valid contacts are kept privately for future events. Eligible people are added to your current selection; existing selections stay.' : limits ? `${limits.remaining24h} imported-contact invitations remaining in your rolling 24-hour limit.` : 'Sending limits help keep invitations reliable.';
    }
    function mappingOptions(columns, selected, allowNone) {
      return (allowNone ? '<option value="-1">No name column</option>' : '<option value="-1">Choose a column</option>') + columns.map((label, index) => `<option value="${index}"${index === selected ? ' selected' : ''}>${escape(label)}</option>`).join('');
    }
    function renderMapping() {
      get('has-header').checked = Boolean(parsed.mapping?.hasHeader);
      get('email-column').innerHTML = mappingOptions(parsed.columns, parsed.mapping?.emailColumn, false);
      get('name-column').innerHTML = mappingOptions(parsed.columns, parsed.mapping?.nameColumn, true);
      get('map-sample').innerHTML = `<table><caption class="sr-only">First rows in your list</caption><thead><tr>${parsed.columns.map(label => `<th scope="col">${escape(label)}</th>`).join('')}</tr></thead><tbody>${(parsed.sample || []).map(row => `<tr>${row.map(cell => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
    async function checkRows({ goToPreview = false } = {}) {
      if (flow === 'import' ? !rows.length : !inviteSelection?.faceIds?.length && !inviteSelection?.contactIds?.length) { showError('Select at least one person to continue.'); return; }
      const request = ++revision;
      const candidate = flow === 'import' ? { rows: rows.map(({ name, email }) => ({ name, email })) } : { faceIds: [...inviteSelection.faceIds], contactIds: [...inviteSelection.contactIds] };
      setBusy(true); get('next').textContent = 'Checking list…'; clearError();
      try {
        const data = await api(`${path}/preview`, { method: 'POST', body: candidate });
        if (request !== revision) return;
        if (!Array.isArray(data.rows) || !data.summary || typeof data.reviewToken !== 'string') throw new Error('The list could not be checked. Please try again.');
        reviewedRows = candidate;
        rows = data.rows.map(row => ({ ...row, name: row.name || '', email: row.email || '' }));
        review = data;
        get('permission').checked = false;
        renderRows();
        if (flow === 'invite' && goToPreview && data.summary.ready > 0 && data.canSend && typeof data.previewHtml === 'string') {
          get('subject').textContent = data.subject;
          show('preview');
          get('email-preview').srcdoc = data.previewHtml;
        } else {
          show('review');
          if (goToPreview && !data.canSend) showError(data.notice || (data.summary.ready ? 'This list is above your remaining sending allowance. Remove some ready rows or return after the limit resets.' : 'No invitations are ready. Correct an email or remove skipped rows to continue.'));
        }
      } catch (error) {
        if (request === revision) {
          if (step !== 'review') { renderRows(); show('review'); }
          showError(error.message || 'We could not check this list. Your entries are still here.', error);
        }
      } finally {
        if (request === revision) { setBusy(false); get('next').textContent = step === 'preview' ? `Send ${review?.summary.ready || 0} invitations` : reviewButtonText(); }
      }
    }
    async function parseInput(options) {
      const result = parser.parse(raw, { ...(mode === 'paste' ? { mode: 'emails' } : {}), ...options });
      if (result.error) { showError(result.error); return; }
      parsed = result;
      if (result.needsMapping) { renderMapping(); show('mapping'); if (options) showError('Choose an email column and a different name column, or no name column.'); return; }
      invalidateReview();
      rows = result.rows;
      await checkRows();
    }
    function renderStatus() {
      const counts = status || { queued: submission?.queued || 0, accepted: 0, failed: 0, skipped: submission?.skipped || 0, complete: false };
      const complete = counts.complete === true;
      const accepted = Math.max(0, Number(counts.accepted) || 0);
      const pending = Math.max(0, Number(counts.queued) || 0);
      const failed = Math.max(0, Number(counts.failed) || 0);
      const skipped = Math.max(0, Number(counts.skipped) || 0);
      get('status-mark').textContent = complete && !failed ? '✓' : complete ? '!' : '…';
      get('status-title').textContent = complete ? (failed ? 'Some invitations need attention' : accepted ? 'Your invitations are on their way' : 'No invitations confirmed') : 'Invitations are being processed';
      get('status-copy').textContent = `${accepted} accepted by the email provider · ${pending} pending · ${failed} failed · ${skipped} skipped.${failed ? ' Failed or uncertain deliveries are not automatically resent from this screen.' : ''}`;
      get('check-status').hidden = complete;
      get('check-status').textContent = 'Refresh status';
      get('next').hidden = !complete;
      get('next').textContent = 'Invite more guests';
      get('next').disabled = busy;
      if (accepted !== acceptedSeen || complete) { acceptedSeen = accepted; Promise.resolve(onQueued(submission?.body)).catch(() => {}); }
    }
    async function refreshStatus({ automatic = false } = {}) {
      if (!batchId || busy) return;
      stopPolling();
      if (!automatic) { clearError(); get('check-status').disabled = true; }
      try {
        const result = await api(`${path}/status/${encodeURIComponent(batchId)}`);
        if (typeof result.accepted !== 'number' || typeof result.complete !== 'boolean') throw new Error('Status is not available yet.');
        status = result;
        renderStatus();
        if (!result.complete && dialog.open && pollCount < 20) { pollCount += 1; pollTimer = setTimeout(() => refreshStatus({ automatic: true }), 3000); }
      } catch (_) {
        if (!automatic) showError('Status could not be refreshed. Nothing has been resent. You can check again.');
      } finally { get('check-status').disabled = false; }
    }
    async function sendSubmission() {
      if (busy || !dialog.open || !submission) return;
      setBusy(true); clearError(); get('next').textContent = 'Queuing invitations…';
      get('check-status').disabled = true;
      try {
        const result = await api(`${path}/send`, { method: 'POST', body: submission.body });
        if (result.ok !== true || !result.batchId || !Number.isInteger(result.queued)) throw new Error('The submission could not be confirmed.');
        batchId = result.batchId;
        submission.queued = result.queued; submission.skipped = result.skipped;
        show('status'); renderStatus();
        Promise.resolve(onQueued(submission.body)).catch(() => {});
      } catch (error) {
        const rejected = ['stale_preview', 'permission_required', 'no_recipients', 'daily_limit', 'rate_limited', 'event_unavailable', 'email_verification_required', 'account_unavailable', 'event_not_found', 'invalid_rows', 'invalid_selection', 'selection_limit', 'no_contacts'];
        if (rejected.includes(error?.data?.code)) {
          submission = null; invalidateReview(); renderRows(); show('review');
          showError(error.message || 'Please review the list again before sending.', error);
          return;
        }
        // The server may already have committed. Never create a new approval or
        // silently retry: the only recovery reuses this immutable review token.
        show('status');
        get('status-mark').textContent = '!';
        get('status-title').textContent = 'Let’s confirm that submission';
        get('status-copy').textContent = 'We did not receive a confirmed result. Check this same submission before starting another list.';
        get('check-status').hidden = false;
        get('check-status').textContent = 'Check submission';
        showError(error.message || 'We could not confirm the submission. Nothing will be retried automatically.', error);
      } finally {
        setBusy(false);
        if (batchId) refreshStatus();
      }
    }
    async function saveContacts() {
      if (!review || busy || !dialog.open || flow !== 'import') return;
      const body = { ...reviewedRows, reviewToken: review.reviewToken };
      setBusy(true); clearError(); get('next').textContent = 'Adding your contacts…';
      try {
        const result = await api(`${path}/contacts/import`, { method: 'POST', body });
        if (!Array.isArray(result.contacts) || !Array.isArray(result.selectedContactIds)) throw new Error('Contact import could not be confirmed. You can review and try again safely.');
        await onImported(result);
        rows = []; parsed = null; raw = ''; uploadRaw = ''; fileReady = false;
        get('text').value = ''; get('file').value = ''; invalidateReview();
        setBusy(false); close();
      } catch (error) {
        if (error?.data?.code === 'stale_preview') { invalidateReview(); renderRows(); }
        showError(error.message || 'Could not save your contacts. Your list is still here.', error);
      }
      finally { setBusy(false); get('next').textContent = reviewButtonText(); }
    }
    function close() { if (!busy) dialog.close(); }
    function open(trigger, { importMode = 'paste', invitation = null } = {}) {
      if (!canOpen() || dialog.open) return;
      returnFocus = trigger || document.activeElement;
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      dialog.showModal();
      if (!submission) {
        if (flow !== (invitation ? 'invite' : 'import')) { rows = []; invalidateReview(); }
        flow = invitation ? 'invite' : 'import';
        if (invitation) { inviteSelection = { faceIds: [...(invitation.faceIds || [])], contactIds: [...(invitation.contactIds || [])] }; rows = []; invalidateReview(); show('review'); checkRows(); }
        else { setMode(importMode); show(rows.length && flow === 'import' ? 'review' : 'input'); if (rows.length) renderRows(); }
      } else show('status');
      if (submission) { if (batchId) { renderStatus(); refreshStatus(); } else { get('status-title').textContent = 'Let’s confirm that submission'; get('check-status').hidden = false; get('check-status').textContent = 'Check submission'; } }
    }

    get('close').addEventListener('click', close);
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => { stopPolling(); document.body.style.overflow = previousOverflow; returnFocus?.focus({ preventScroll: true }); });
    get('paste-tab').addEventListener('click', () => setMode('paste'));
    get('upload-tab').addEventListener('click', () => setMode('upload'));
    get('text').addEventListener('input', () => { invalidateReview(); });
    get('file').addEventListener('change', async () => {
      const file = get('file').files?.[0];
      fileReady = false; uploadRaw = '';
      if (!file) return;
      const request = ++revision;
      clearError();
      if (file.size > parser.MAX_BYTES) { showError('Choose a CSV under 64 KB with up to 100 people.'); return; }
      if (!/\.(csv|tsv)$/i.test(file.name)) { showError('Choose a CSV file, or paste cells from your spreadsheet.'); return; }
      setBusy(true);
      try {
        const contents = await file.text();
        if (request !== revision) return;
        if (contents.includes('\uFFFD') || contents.includes('\0')) throw new Error('Save this file as UTF-8 CSV, or copy and paste its cells.');
        uploadRaw = contents; fileReady = true; invalidateReview();
        get('file-note').textContent = `${file.name} · Ready to review. Nothing has been sent.`;
      } catch (error) { showError(error.message || 'We could not read this file. Try pasting its cells.'); }
      finally { if (request === revision) setBusy(false); }
    });
    get('has-header').addEventListener('change', () => {
      parsed = parser.parse(raw, { hasHeader: get('has-header').checked, emailColumn: Number(get('email-column').value), nameColumn: Number(get('name-column').value) });
      if (parsed.error) showError(parsed.error); else renderMapping();
    });
    get('change-columns').addEventListener('click', () => { if (!busy && parsed) { renderMapping(); show('mapping'); } });
    get('rows').addEventListener('input', event => {
      const input = event.target.closest('[data-field]');
      const rowNode = input?.closest('[data-row-index]');
      if (!rowNode || busy) return;
      const row = rows[Number(rowNode.dataset.rowIndex)];
      if (!row || !['email', 'name'].includes(input.dataset.field)) return;
      row[input.dataset.field] = input.value; row.status = ''; row.message = '';
      invalidateReview(); clearError();
      rowNode.dataset.status = 'unchecked'; input.setAttribute('aria-invalid', 'false');
      rowNode.querySelector('.guest-import-row-status').textContent = 'Changes will be checked before preview';
      get('summary').textContent = `${rows.length} people · Changes will be checked before preview.`;
      get('next').textContent = reviewButtonText();
    });
    get('rows').addEventListener('click', event => {
      const button = event.target.closest('[data-remove-row]');
      if (!button || busy) return;
      const index = Number(button.dataset.removeRow);
      if (flow === 'invite') {
        const removed = rows[index];
        if (removed) {
          if (removed.source === 'contact') inviteSelection.contactIds = inviteSelection.contactIds.filter(id => String(id) !== String(removed.id));
          else inviteSelection.faceIds = inviteSelection.faceIds.filter(id => String(id) !== String(removed.id));
          onSelectionRemove(removed.selectionKey, removed.id);
        }
      }
      rows.splice(index, 1); invalidateReview(); renderRows();
      const nextRow = get('rows').querySelectorAll('[data-remove-row]');
      (nextRow[Math.min(index, nextRow.length - 1)] || get('back')).focus();
    });
    get('permission').addEventListener('change', () => setBusy(busy));
    get('back').addEventListener('click', () => {
      if (busy) return;
      if (step === 'status') { close(); return; }
      if (step === 'preview') { get('permission').checked = false; show('review'); return; }
      if (step === 'review' && flow === 'invite') { close(); return; }
      if (step === 'review' || step === 'mapping') { show('input'); return; }
      close();
    });
    get('next').addEventListener('click', async () => {
      if (busy || !dialog.open) return;
      if (step === 'status' && status?.complete) {
        stopPolling(); rows = []; parsed = null; raw = ''; uploadRaw = ''; fileReady = false;
        submission = null; batchId = null; status = null; pollCount = 0; acceptedSeen = 0;
        get('text').value = ''; get('file').value = ''; get('file-note').textContent = 'UTF-8 CSV · Up to 100 people · 64 KB maximum';
        invalidateReview(); setMode('paste'); close(); onPastGuests(); return;
      }
      if (step === 'input') {
        if (mode === 'paste') raw = get('text').value;
        else if (!get('file').files?.[0] || !fileReady) { showError('Choose a valid CSV file to continue.'); return; }
        else raw = uploadRaw;
        await parseInput();
      } else if (step === 'mapping') {
        await parseInput({ hasHeader: get('has-header').checked, emailColumn: Number(get('email-column').value), nameColumn: Number(get('name-column').value) });
      } else if (step === 'review') { if (flow === 'import' && review) await saveContacts(); else await checkRows({ goToPreview: flow === 'invite' }); }
      else if (step === 'preview' && review?.canSend && get('permission').checked && !submission) {
        submission = { body: { ...reviewedRows, reviewToken: review.reviewToken, permissionConfirmed: true } };
        await sendSubmission();
      }
    });
    get('check-status').addEventListener('click', () => batchId ? refreshStatus() : sendSubmission());
    return { open, openImport: (importMode, trigger) => open(trigger, { importMode }), openInvitations: (invitation, trigger) => open(trigger, { invitation }) };
  }
  root.SGGuestImport = { create };
})(window);
