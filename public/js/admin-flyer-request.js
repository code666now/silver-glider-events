/* Human-reviewed Done For You flyer handoff. */

renderNav('');

const requestId = location.pathname.split('/').filter(Boolean).pop();
const detail = document.getElementById('flyer-request-detail');
const loading = document.getElementById('flyer-request-loading');
const errorPanel = document.getElementById('flyer-request-error');
const actionStatus = document.getElementById('flyer-request-action-status');
let state = null;

function esc(value) { return sgEscapeHtml(value); }
function label(value) {
  return ({
    submitted: 'Submitted', building: 'Building', ready_for_review: 'Ready for review',
    preview_sent: 'Preview sent', changes_requested: 'Changes requested',
    promoter_approved: 'Approved', published: 'Published', rejected: 'Rejected'
  })[String(value || '')] || 'Submitted';
}
function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

function renderMatch(lookup, request) {
  const root = document.getElementById('flyer-request-match');
  if (request.done_for_you_client_id) {
    root.innerHTML = `<div class="dfy-preflight success"><strong>Client connected</strong><p>This request is linked to the exact Done For You client and public page.</p><div class="dfy-preflight-links"><a href="/admin/done-for-you/${encodeURIComponent(request.done_for_you_client_id)}">Open client</a></div></div>`;
    return;
  }
  if (lookup.matched) {
    const account = lookup.account || {};
    root.innerHTML = `<div class="dfy-preflight success"><strong>Exact account match found</strong><p>This reuses the existing account. It does not merge accounts or sign in as the promoter.</p><dl><dt>Global User ID</dt><dd>${esc(lookup.expectedUserId)}</dd><dt>Name</dt><dd>${esc(account.name || 'Unnamed account')}</dd><dt>Public page</dt><dd>${esc(account.hostName || 'Not created yet')}</dd><dt>State</dt><dd>${esc(account.status || 'active')}</dd></dl></div>`;
  } else {
    root.innerHTML = '<div class="dfy-preflight success"><strong>No existing account found</strong><p>Starting setup creates one unclaimed account and public page. Contact details remain unverified until the promoter proves ownership.</p></div>';
  }
}

function actionButton(id, text, primary = false) {
  return `<button class="sg-btn ${primary ? 'sg-btn-primary' : 'sg-btn-ghost'}" id="${id}" type="button">${esc(text)}</button>`;
}

function renderWorkflow(request) {
  const root = document.getElementById('flyer-request-workflow');
  const steps = [];
  if (!request.done_for_you_client_id) {
    steps.push('<p>First, connect the exact account and prepare its public page.</p>');
    steps.push(actionButton('prepare-flyer-request', 'Prepare client and public page', true));
  } else if (!request.event_id) {
    steps.push('<p>The client is ready. Add the event basics; the submitted flyer will already be selected.</p>');
    steps.push(actionButton('open-flyer-editor', 'Start event draft', true));
  } else if (['building', 'changes_requested'].includes(request.status)) {
    steps.push(`<p><strong>${esc(request.event_title || 'Event draft')}</strong> is private and still being prepared.</p>`);
    steps.push(actionButton('open-flyer-editor', 'Continue editing', true));
    steps.push(actionButton('mark-flyer-ready', request.status === 'changes_requested' ? 'Fix complete — ready again' : 'Ready for Super Admin review'));
  } else if (request.status === 'ready_for_review') {
    steps.push('<p><strong>Ready for review.</strong> A Super Admin must inspect the real event page before any preview text can be sent.</p>');
    steps.push(actionButton('open-flyer-editor', 'Inspect draft'));
  } else if (request.event_id) {
    steps.push(`<p>The linked event is ${esc(label(request.status).toLowerCase())}. Later lifecycle actions appear here as they become available.</p>`);
  }
  root.innerHTML = steps.join('');
  document.getElementById('prepare-flyer-request')?.addEventListener('click', prepare);
  document.getElementById('open-flyer-editor')?.addEventListener('click', openEditor);
  document.getElementById('mark-flyer-ready')?.addEventListener('click', markReady);
}

function render(payload) {
  state = payload;
  const request = payload.request;
  document.title = `${request.host_name} flyer — Done For You — Silver Glider Events`;
  document.getElementById('flyer-request-title').textContent = request.host_name;
  document.getElementById('flyer-request-status').textContent = label(request.status);
  document.getElementById('flyer-request-status').className = `dfy-status-pill ${request.status}`;
  document.getElementById('flyer-request-subtitle').textContent = `Sent by ${request.submitter_name} · ${formatDate(request.created_at)}`;
  document.getElementById('flyer-request-image').src = request.flyer_url;
  document.getElementById('flyer-request-facts').innerHTML = `
    <div><dt>Contact</dt><dd>${esc(request.submitter_name)}</dd></div>
    <div><dt>Email</dt><dd>${esc(request.email)}</dd></div>
    <div><dt>Mobile</dt><dd>${esc(request.phone_e164)}</dd></div>
    <div><dt>Flyer artwork</dt><dd>${esc(request.artwork_credit || 'Not provided')}</dd></div>`;
  renderMatch(payload.lookup || {}, request);
  renderWorkflow(request);
  loading.hidden = true;
  errorPanel.hidden = true;
  detail.hidden = false;
}

async function load() {
  try {
    render(await api(`/api/admin/done-for-you/flyer-intake/${encodeURIComponent(requestId)}`));
  } catch (error) {
    loading.hidden = true;
    detail.hidden = true;
    errorPanel.hidden = false;
    errorPanel.innerHTML = `<strong>We couldn’t load this flyer request.</strong><p>${esc(error.message)}</p><button class="sg-btn sg-btn-ghost" id="retry-flyer-request" type="button">Try again</button>`;
    document.getElementById('retry-flyer-request').addEventListener('click', load);
  }
}

async function runAction(button, pendingText, request) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = pendingText;
  actionStatus.className = 'dfy-action-status';
  actionStatus.textContent = pendingText;
  try { return await request(); }
  catch (error) {
    actionStatus.className = 'dfy-action-status error';
    actionStatus.textContent = error.message;
    button.disabled = false;
    button.textContent = original;
    throw error;
  }
}

async function prepare(event) {
  try {
    await runAction(event.currentTarget, 'Preparing…', () => api(`/api/admin/done-for-you/flyer-intake/${encodeURIComponent(requestId)}/prepare`, {
      method: 'POST',
      body: { expectedUserId: state.lookup.expectedUserId == null ? null : Number(state.lookup.expectedUserId) }
    }));
    await load();
    actionStatus.textContent = 'Client and public page are ready.';
  } catch (_) {}
}

async function openEditor(event) {
  try {
    const result = await runAction(event.currentTarget, 'Opening editor…', () => api(`/api/admin/done-for-you/flyer-intake/${encodeURIComponent(requestId)}/editor-workspace`, { method: 'POST', body: {} }));
    location.assign(result.redirect);
  } catch (_) {}
}

async function markReady(event) {
  try {
    await runAction(event.currentTarget, 'Sending for review…', () => api(`/api/admin/done-for-you/flyer-intake/${encodeURIComponent(requestId)}/ready`, { method: 'POST', body: {} }));
    await load();
    actionStatus.textContent = 'Ready for Super Admin review.';
  } catch (_) {}
}

window.adminShellSession.then(session => {
  if (session?.capabilities?.manageDoneForYou !== true) return location.replace('/admin');
  return load();
}).catch(() => {});
