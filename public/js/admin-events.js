renderNav('');

const adminEvents = {
  form: document.getElementById('event-filters'),
  search: document.getElementById('event-search'),
  host: document.getElementById('event-host'),
  status: document.getElementById('event-status'),
  timing: document.getElementById('event-timing'),
  visibility: document.getElementById('event-visibility'),
  admission: document.getElementById('event-admission'),
  archived: document.getElementById('event-archived'),
  more: document.getElementById('event-more-filters'),
  moreCount: document.getElementById('event-more-count'),
  clear: document.getElementById('event-clear'),
  summary: document.getElementById('event-results-summary'),
  loading: document.getElementById('events-loading'),
  error: document.getElementById('events-error'),
  errorMessage: document.getElementById('events-error-message'),
  retry: document.getElementById('events-retry'),
  empty: document.getElementById('events-empty'),
  emptyClear: document.getElementById('events-empty-clear'),
  list: document.getElementById('events-list'),
  rows: document.getElementById('events-rows'),
  pagination: document.getElementById('events-pagination'),
  previous: document.getElementById('events-previous'),
  next: document.getElementById('events-next'),
  pageLabel: document.getElementById('events-page-label'),
  dialog: document.getElementById('event-detail'),
  dialogClose: document.getElementById('event-detail-close'),
  dialogTitle: document.getElementById('event-detail-title'),
  dialogEyebrow: document.getElementById('event-detail-eyebrow'),
  dialogHost: document.getElementById('event-detail-host'),
  dialogGrid: document.getElementById('event-detail-grid'),
  dialogActions: document.getElementById('event-detail-actions'),
  editorNote: document.getElementById('event-editor-note')
};

const adminEventState = {
  page: 1,
  events: [],
  pagination: null,
  request: null,
  searchTimer: null,
  canManageDoneForYou: false,
  trigger: null
};
const adminEventMobileFilters = window.matchMedia('(max-width: 680px)');

function adminEventEsc(value) {
  return sgEscapeHtml(value == null ? '' : value);
}

function adminEventDate(value) {
  const date = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'Date unavailable';
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'
  });
}

function adminEventTime(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  if (!match) return '';
  const hour = Number(match[1]);
  const minute = match[2];
  return `${hour % 12 || 12}:${minute} ${hour >= 12 ? 'PM' : 'AM'}`;
}

function adminEventStatus(event) {
  if (event.status === 'cancelled') return { label: 'Cancelled', tone: 'cancelled' };
  if (event.status === 'draft') return { label: 'Draft', tone: 'draft' };
  return { label: event.is_past ? 'Published' : 'Live', tone: 'live' };
}

function adminEventVisibility(event) {
  if (event.secret_show_enabled) return 'Secret show';
  return event.visibility === 'private' ? 'Private link' : 'Public';
}

function adminEventAdmission(value) {
  if (value === 'silver_glider_tickets') return 'Silver Glider';
  if (['external_tickets', 'paid', 'donation', 'door', 'vip'].includes(value)) return 'External tickets';
  return 'Free RSVP';
}

function adminEventHasFilters() {
  return [adminEvents.search, adminEvents.host, adminEvents.status, adminEvents.timing,
    adminEvents.visibility, adminEvents.admission, adminEvents.archived].some(control => control.value);
}

function adminEventUpdateMoreFilters() {
  const active = [adminEvents.timing, adminEvents.visibility, adminEvents.admission,
    adminEvents.archived].filter(control => control.value).length;
  adminEvents.moreCount.textContent = active ? `${active} active` : '';
}

function adminEventParams() {
  const params = new URLSearchParams();
  for (const control of [adminEvents.search, adminEvents.host, adminEvents.status,
    adminEvents.timing, adminEvents.visibility, adminEvents.admission, adminEvents.archived]) {
    const value = control.value.trim();
    if (value) params.set(control.name, value);
  }
  if (adminEventState.page > 1) params.set('page', String(adminEventState.page));
  return params;
}

function adminEventSyncUrl(params) {
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}`);
}

function adminEventEnableFilters(enabled) {
  for (const control of [adminEvents.host, adminEvents.status, adminEvents.timing,
    adminEvents.visibility, adminEvents.admission, adminEvents.archived]) control.disabled = !enabled;
}

function adminEventSetLoading(loading) {
  adminEvents.loading.hidden = !loading;
  adminEvents.list.setAttribute('aria-busy', String(loading));
  if (loading) {
    adminEvents.error.hidden = true;
    adminEvents.empty.hidden = true;
    adminEvents.list.hidden = true;
    adminEvents.pagination.hidden = true;
    adminEvents.summary.textContent = 'Loading events…';
  }
}

function adminEventRenderHosts(hosts) {
  const selected = adminEvents.host.value;
  adminEvents.host.innerHTML = `<option value="">All hosts</option>${hosts.map(host =>
    `<option value="${host.id}">${adminEventEsc(host.name)} (${Number(host.event_count || 0)})</option>`
  ).join('')}`;
  adminEvents.host.value = selected;
}

function adminEventRenderRows(events) {
  adminEvents.rows.innerHTML = events.map(event => {
    const status = adminEventStatus(event);
    const visibility = adminEventVisibility(event);
    const venue = event.venue_name || 'Venue not set';
    return `<button class="admin-event-row" type="button" data-event-id="${event.id}" aria-label="Open ${adminEventEsc(event.title)} details">
      <span class="admin-event-main"><strong>${adminEventEsc(event.title)}</strong><small>${adminEventEsc(venue)}${event.archived_at ? '<b class="admin-event-archive-mark">Archived</b>' : ''}</small></span>
      <span class="admin-event-host"><strong>${adminEventEsc(event.host_name)}</strong><small>${event.owner_user_id ? `User ID ${event.owner_user_id}` : 'Legacy account'}</small></span>
      <span class="admin-event-date"><strong>${adminEventDate(event.event_date)}</strong><small>${adminEventTime(event.start_time)}</small></span>
      <span class="admin-event-status"><i class="admin-event-badge ${status.tone}">${status.label}</i></span>
      <span class="admin-event-visibility"><i class="admin-event-badge ${visibility === 'Public' ? 'public' : ''}">${adminEventEsc(visibility)}</i></span>
      <span class="admin-event-admission"><i class="admin-event-badge">${adminEventEsc(adminEventAdmission(event.admission_type))}</i></span>
      <span class="admin-event-rsvps">${Number(event.rsvp_count || 0).toLocaleString('en-US')}</span>
      <span class="admin-event-open" aria-hidden="true">›</span>
    </button>`;
  }).join('');
  adminEvents.rows.querySelectorAll('[data-event-id]').forEach(button => {
    button.addEventListener('click', () => adminEventOpenDetail(Number(button.dataset.eventId), button));
  });
}

function adminEventRenderPagination(pagination) {
  const total = Number(pagination.total || 0);
  const start = total ? ((pagination.page - 1) * pagination.per_page) + 1 : 0;
  const end = Math.min(total, pagination.page * pagination.per_page);
  adminEvents.summary.textContent = total === 1 ? '1 event' : `${total.toLocaleString('en-US')} events`;
  adminEvents.pageLabel.textContent = `${start.toLocaleString('en-US')}–${end.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`;
  adminEvents.previous.disabled = !pagination.has_previous;
  adminEvents.next.disabled = !pagination.has_next;
  adminEvents.pagination.hidden = total === 0 || (!pagination.has_previous && !pagination.has_next);
}

async function adminEventLoad() {
  adminEventState.request?.abort();
  const controller = new AbortController();
  adminEventState.request = controller;
  adminEventSetLoading(true);
  adminEventEnableFilters(false);
  const params = adminEventParams();
  adminEventSyncUrl(params);
  try {
    const [data, session] = await Promise.all([
      api(`/api/admin/events${params.toString() ? `?${params}` : ''}`, { signal: controller.signal }),
      window.adminShellSession.catch(() => null)
    ]);
    if (controller.signal.aborted) return;
    adminEventState.events = data.events || [];
    adminEventState.pagination = data.pagination;
    adminEventState.canManageDoneForYou = session?.capabilities?.manageDoneForYou === true;
    adminEventRenderHosts(data.hosts || []);
    adminEventRenderRows(adminEventState.events);
    adminEventRenderPagination(data.pagination || { page: 1, per_page: 25, total: 0 });
    adminEventUpdateMoreFilters();
    adminEvents.clear.hidden = !adminEventHasFilters();
    adminEvents.empty.hidden = adminEventState.events.length > 0;
    adminEvents.list.hidden = adminEventState.events.length === 0;
  } catch (error) {
    if (error.name === 'AbortError') return;
    adminEvents.errorMessage.textContent = error.message || 'Try again in a moment.';
    adminEvents.error.hidden = false;
    adminEvents.summary.textContent = 'Events unavailable';
  } finally {
    if (adminEventState.request === controller) {
      adminEventState.request = null;
      adminEventSetLoading(false);
      adminEventEnableFilters(true);
    }
  }
}

function adminEventDetailCell(label, value) {
  return `<div class="admin-event-detail-cell"><span>${adminEventEsc(label)}</span><strong>${adminEventEsc(value)}</strong></div>`;
}

function adminEventOpenDetail(id, trigger) {
  const event = adminEventState.events.find(item => Number(item.id) === Number(id));
  if (!event) return;
  adminEventState.trigger = trigger;
  const status = adminEventStatus(event);
  adminEvents.dialogEyebrow.textContent = `Event #${event.id}${event.archived_at ? ' · Archived' : ''}`;
  adminEvents.dialogTitle.textContent = event.title;
  adminEvents.dialogHost.textContent = event.host_name;
  adminEvents.dialogGrid.innerHTML = [
    ['Date', `${adminEventDate(event.event_date)}${adminEventTime(event.start_time) ? ` · ${adminEventTime(event.start_time)}` : ''}`],
    ['Time zone', event.timezone || 'Not available'],
    ['Status', status.label],
    ['Timing', event.is_past ? 'Past' : 'Upcoming'],
    ['Visibility', adminEventVisibility(event)],
    ['Admission', adminEventAdmission(event.admission_type)],
    ['Confirmed RSVPs', Number(event.rsvp_count || 0).toLocaleString('en-US')],
    ['Venue', event.venue_name || 'Not set']
  ].map(([label, value]) => adminEventDetailCell(label, value)).join('');

  const actions = [];
  if (event.status !== 'draft' && event.slug) {
    actions.push(`<a class="sg-btn sg-btn-ghost" href="/e/${encodeURIComponent(event.slug)}" target="_blank" rel="noopener">Preview</a>`);
  }
  if (event.host_slug) {
    actions.push(`<a class="sg-btn sg-btn-ghost" href="/h/${encodeURIComponent(event.host_slug)}" target="_blank" rel="noopener">Host Page</a>`);
  }
  if (event.owner_user_id) {
    actions.push(`<a class="sg-btn sg-btn-ghost" href="/admin/accounts?q=${encodeURIComponent(event.owner_user_id)}">Account</a>`);
  }
  const editable = event.status === 'draft' && event.done_for_you_client_id && adminEventState.canManageDoneForYou;
  if (editable) {
    actions.push('<button class="sg-btn sg-btn-primary" id="event-continue-setup" type="button">Continue setup</button>');
  }
  adminEvents.dialogActions.innerHTML = actions.join('');
  adminEvents.editorNote.hidden = true;
  if (event.status === 'draft' && !editable) {
    adminEvents.editorNote.textContent = event.done_for_you_client_id
      ? 'This draft requires a dedicated Done For You administrator.'
      : 'This is an owner-managed draft. Admin editing is available only through an audited Done For You workspace.';
    adminEvents.editorNote.hidden = false;
  }
  if (editable) {
    document.getElementById('event-continue-setup').addEventListener('click', eventObject => {
      adminEventContinueSetup(event, eventObject.currentTarget);
    });
  }
  adminEvents.dialog.showModal();
}

async function adminEventContinueSetup(event, button) {
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = 'Opening…';
  try {
    const data = await api(`/api/admin/done-for-you/${encodeURIComponent(event.done_for_you_client_id)}/editor-workspaces`, {
      method: 'POST', body: { eventId: event.id }
    });
    location.assign(data.redirect);
  } catch (error) {
    button.disabled = false;
    button.textContent = previous;
    adminEvents.editorNote.textContent = error.message || 'This draft could not be opened.';
    adminEvents.editorNote.hidden = false;
  }
}

function adminEventCloseDetail() {
  adminEvents.dialog.close();
  adminEventState.trigger?.focus({ preventScroll: true });
  adminEventState.trigger = null;
}

function adminEventClearFilters() {
  for (const control of [adminEvents.search, adminEvents.host, adminEvents.status, adminEvents.timing,
    adminEvents.visibility, adminEvents.admission, adminEvents.archived]) control.value = '';
  adminEventState.page = 1;
  adminEvents.more.open = !adminEventMobileFilters.matches;
  adminEventUpdateMoreFilters();
  adminEventLoad();
}

function adminEventReadUrl() {
  const params = new URLSearchParams(location.search);
  for (const control of [adminEvents.search, adminEvents.host, adminEvents.status, adminEvents.timing,
    adminEvents.visibility, adminEvents.admission, adminEvents.archived]) {
    const value = params.get(control.name) || '';
    if (control === adminEvents.host && value && ![...control.options].some(option => option.value === value)) {
      control.add(new Option('Selected host', value));
    }
    control.value = value;
  }
  adminEventState.page = Math.max(1, Number(params.get('page')) || 1);
  adminEventUpdateMoreFilters();
  const hasMoreFilters = [adminEvents.timing, adminEvents.visibility, adminEvents.admission,
    adminEvents.archived].some(control => control.value);
  adminEvents.more.open = hasMoreFilters || !adminEventMobileFilters.matches;
}

adminEvents.form.addEventListener('submit', event => {
  event.preventDefault();
  clearTimeout(adminEventState.searchTimer);
  adminEventState.page = 1;
  adminEventLoad();
});
adminEvents.search.addEventListener('input', () => {
  clearTimeout(adminEventState.searchTimer);
  adminEventState.searchTimer = setTimeout(() => {
    adminEventState.page = 1;
    adminEventLoad();
  }, 320);
});
for (const control of [adminEvents.host, adminEvents.status, adminEvents.timing,
  adminEvents.visibility, adminEvents.admission, adminEvents.archived]) {
  control.addEventListener('change', () => {
    adminEventState.page = 1;
    adminEventUpdateMoreFilters();
    adminEventLoad();
  });
}
adminEvents.clear.addEventListener('click', adminEventClearFilters);
adminEvents.emptyClear.addEventListener('click', adminEventClearFilters);
adminEvents.retry.addEventListener('click', adminEventLoad);
adminEvents.previous.addEventListener('click', () => {
  adminEventState.page -= 1;
  adminEventLoad();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
adminEvents.next.addEventListener('click', () => {
  adminEventState.page += 1;
  adminEventLoad();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
adminEvents.dialogClose.addEventListener('click', adminEventCloseDetail);
adminEvents.dialog.addEventListener('click', event => {
  if (event.target === adminEvents.dialog) adminEventCloseDetail();
});
adminEvents.dialog.addEventListener('cancel', event => {
  event.preventDefault();
  adminEventCloseDetail();
});
adminEventMobileFilters.addEventListener('change', event => {
  if (!event.matches) adminEvents.more.open = true;
  else if (![adminEvents.timing, adminEvents.visibility, adminEvents.admission,
    adminEvents.archived].some(control => control.value)) adminEvents.more.open = false;
});

adminEventReadUrl();
adminEventLoad();
