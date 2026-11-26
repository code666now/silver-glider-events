(function initTransportation() {
  renderNav('');
  addSkipLink();
  const el = id => document.getElementById(id);
  const form = el('rollout-form');
  const toggle = el('rollout-enabled');
  const save = el('rollout-save');
  const badge = el('rollout-state');
  const blocker = el('rollout-reason');
  const refreshRollout = el('rollout-refresh');
  const rolloutFeedback = el('rollout-feedback');
  const rolloutDraft = el('rollout-draft');
  const refreshAnalytics = el('analytics-refresh');
  const analyticsFeedback = el('analytics-feedback');
  const analyticsPanel = el('transportation-analytics');
  const metrics = el('transportation-metrics');
  const breakdown = el('transportation-breakdown');
  const countsNote = el('analytics-counts-note');
  const metricFields = ['pageOpens', 'emailPlannerVisits', 'busClicks', 'uberClicks', 'lyftClicks', 'repeatOpens'];
  let rollout = null;
  let canManage = false;
  let rolloutBusy = false;
  let refreshRequired = false;
  let analyticsBusy = false;

  function feedback(node, message, isError = false) {
    node.classList.toggle('is-error', isError);
    node.textContent = message;
  }

  function paintControls() {
    const changed = rollout && toggle.checked !== rollout.requested;
    const blockedEnable = toggle.checked && !rollout?.allowed;
    form.hidden = !rollout || !canManage;
    toggle.disabled = rolloutBusy || refreshRequired || !canManage || (!rollout?.allowed && !rollout?.requested);
    save.disabled = toggle.disabled || !changed || blockedEnable;
    rolloutDraft.hidden = !changed || !canManage || refreshRequired;
    if (!rolloutBusy) save.textContent = changed ? (toggle.checked ? 'Turn on citywide' : 'Turn off citywide') : 'Save rollout';
  }

  function applyRollout(data) {
    const result = data?.rollout;
    if (!result || typeof result.enabled !== 'boolean' || typeof result.allowed !== 'boolean' ||
        typeof result.requested !== 'boolean' || typeof data.canManage !== 'boolean') throw new Error('Unconfirmed rollout status');
    rollout = result;
    canManage = data.canManage;
    refreshRequired = false;
    toggle.checked = result.requested;
    badge.textContent = result.enabled ? 'On' : (result.allowed ? 'Off' : 'Off · Not ready');
    badge.dataset.state = result.enabled ? 'on' : 'off';
    blocker.textContent = result.allowed ? '' : (result.reason || 'Citywide coverage isn’t ready to turn on.');
    blocker.hidden = result.allowed;
    const savedOnButBlocked = result.requested && !result.enabled;
    el('rollout-saved-note').hidden = !savedOnButBlocked;
    toggle.setAttribute('aria-describedby', savedOnButBlocked ? 'rollout-description rollout-saved-note' : 'rollout-description');
    el('rollout-permission').hidden = canManage;
    refreshRollout.hidden = result.allowed;
    paintControls();
  }

  async function loadRollout() {
    if (rolloutBusy) return;
    const wasRefreshing = document.activeElement === refreshRollout;
    rolloutBusy = true;
    refreshRollout.disabled = true;
    paintControls();
    feedback(rolloutFeedback, 'Checking rollout status…');
    try {
      applyRollout(await api('/api/admin/transportation/rollout', { cache: 'no-store' }));
      feedback(rolloutFeedback, '');
    } catch (_) {
      refreshRequired = true;
      if (!rollout) badge.textContent = 'Status unavailable';
      feedback(rolloutFeedback, 'Couldn’t confirm the current rollout status. Try refreshing.', true);
      refreshRollout.hidden = false;
    } finally {
      rolloutBusy = false;
      refreshRollout.disabled = false;
      paintControls();
      if (wasRefreshing && refreshRollout.hidden) {
        if (!toggle.disabled) toggle.focus();
        else {
          badge.tabIndex = -1;
          badge.focus();
        }
      }
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!rollout || save.disabled) return;
    const enabled = toggle.checked;
    rolloutBusy = true;
    paintControls();
    save.textContent = 'Saving…';
    feedback(rolloutFeedback, 'Saving the rollout setting…');
    try {
      applyRollout(await api('/api/admin/transportation/rollout', { method: 'PATCH', body: { enabled } }));
      feedback(rolloutFeedback, rollout.enabled ? 'Citywide coverage is on.' : 'Citywide coverage is off.');
    } catch (_) {
      refreshRequired = true;
      feedback(rolloutFeedback, 'Couldn’t confirm the change. Refresh rollout status before trying again.', true);
      refreshRollout.hidden = false;
    } finally {
      rolloutBusy = false;
      paintControls();
      if (refreshRequired) refreshRollout.focus();
      else toggle.focus();
    }
  });
  toggle.addEventListener('change', paintControls);
  refreshRollout.addEventListener('click', loadRollout);

  const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
  const numberFormat = new Intl.NumberFormat('en-US');
  function count(value) {
    return value != null && Number.isFinite(Number(value)) ? numberFormat.format(Number(value)) : '—';
  }

  function appendCell(row, value, { heading = false, numeric = false, note } = {}) {
    const cell = document.createElement(heading ? 'th' : 'td');
    cell.textContent = value;
    if (heading) cell.scope = 'row';
    if (numeric) cell.className = 'transportation-numeric';
    if (note) {
      const small = document.createElement('small');
      small.textContent = note;
      cell.appendChild(small);
    }
    row.appendChild(cell);
  }

  function eventDate(value) {
    const date = new Date(`${String(value || '').slice(0, 10)}T12:00:00.000Z`);
    return Number.isNaN(date.getTime()) ? '' : dateFormat.format(date);
  }

  function renderTable(kind, entries) {
    const rows = el(`transportation-${kind}-rows`);
    rows.replaceChildren();
    for (const entry of entries) {
      const row = document.createElement('tr');
      if (kind === 'events') {
        appendCell(row, entry.title || 'Untitled event', { heading: true, note: eventDate(entry.eventDate) });
        appendCell(row, entry.hostName || 'Host');
      } else {
        appendCell(row, entry.name || 'Host', { heading: true });
        appendCell(row, count(entry.eventCount), { numeric: true });
      }
      for (const field of metricFields) appendCell(row, count(entry[field]), { numeric: true });
      rows.appendChild(row);
    }
    el(`transportation-${kind}-scroll`).hidden = entries.length === 0;
    el(`transportation-${kind}-empty`).hidden = entries.length !== 0;
  }

  async function loadAnalytics() {
    if (analyticsBusy) return;
    analyticsBusy = true;
    refreshAnalytics.disabled = true;
    analyticsPanel.setAttribute('aria-busy', 'true');
    feedback(analyticsFeedback, 'Loading transportation activity…');
    try {
      const { summary, events, hosts } = await api('/api/admin/transportation/analytics', { cache: 'no-store' });
      if (!summary || !Array.isArray(events) || !Array.isArray(hosts)) throw new Error('Unconfirmed transportation activity');
      metrics.querySelectorAll('[data-metric]').forEach(node => { node.textContent = count(summary[node.dataset.metric]); });
      renderTable('events', events);
      renderTable('hosts', hosts);
      metrics.hidden = false;
      countsNote.hidden = false;
      breakdown.hidden = false;
      feedback(analyticsFeedback, '');
    } catch (_) {
      metrics.hidden = true;
      countsNote.hidden = true;
      breakdown.hidden = true;
      feedback(analyticsFeedback, 'Transportation activity couldn’t be loaded. Try refreshing.', true);
    } finally {
      analyticsBusy = false;
      refreshAnalytics.disabled = false;
      analyticsPanel.setAttribute('aria-busy', 'false');
    }
  }

  refreshAnalytics.addEventListener('click', loadAnalytics);
  loadRollout();
  loadAnalytics();
})();
