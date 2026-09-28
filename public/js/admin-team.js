renderNav('');

const teamState = { operators: [], selected: null, currentOperatorId: null };
const teamList = document.getElementById('team-list');
const teamEmpty = document.getElementById('team-empty');
const teamSearch = document.getElementById('team-search');
const teamSummary = document.querySelector('.admin-team-summary');
const addDialog = document.getElementById('add-operator-dialog');
const manageDialog = document.getElementById('manage-operator-dialog');

function teamValue(item, keys, fallback = null) {
  for (const key of keys) if (item?.[key] !== undefined && item?.[key] !== null) return item[key];
  return fallback;
}

function normalizeOperator(item) {
  return {
    ...item,
    id: Number(teamValue(item, ['id', 'operatorId', 'operator_id'])),
    email: String(teamValue(item, ['email'], '')),
    role: teamValue(item, ['role'], 'support') === 'super_admin' ? 'super_admin' : 'support',
    status: teamValue(item, ['status'], 'active') === 'disabled' ? 'disabled' : 'active',
    lastLoginAt: teamValue(item, ['lastLoginAt', 'last_login_at']),
    createdAt: teamValue(item, ['createdAt', 'created_at'])
  };
}

function teamDate(value) {
  if (!value) return 'Not yet';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not yet' : date.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

function operatorStatus(operator) {
  if (operator.status === 'disabled') return ['Disabled', 'disabled'];
  if (!operator.lastLoginAt) return ['Invited', 'invited'];
  return ['Active', ''];
}

function roleLabel(role) {
  return role === 'super_admin' ? 'Super Admin' : 'Support';
}

function renderTeamSummary() {
  const active = teamState.operators.filter(operator => operator.status === 'active');
  document.getElementById('team-active').textContent = active.length.toLocaleString('en-US');
  document.getElementById('team-super').textContent = active.filter(operator => operator.role === 'super_admin').length.toLocaleString('en-US');
  document.getElementById('team-support').textContent = active.filter(operator => operator.role === 'support').length.toLocaleString('en-US');
  teamSummary.setAttribute('aria-busy', 'false');
}

function renderTeam() {
  const query = teamSearch.value.trim().toLowerCase();
  const filtered = teamState.operators.filter(operator => !query || operator.email.toLowerCase().includes(query) || roleLabel(operator.role).toLowerCase().includes(query));
  teamList.setAttribute('aria-busy', 'false');
  teamList.classList.remove('admin-skeleton-stack');
  teamEmpty.hidden = filtered.length > 0;
  teamList.innerHTML = filtered.map(operator => {
    const [status, statusClass] = operatorStatus(operator);
    const isYou = operator.id === teamState.currentOperatorId;
    return `<article class="admin-team-row">
      <div class="admin-team-person"><strong>${sgEscapeHtml(operator.email)}</strong><span>${isYou ? 'You · ' : ''}Operator ID ${sgEscapeHtml(operator.id)}</span></div>
      <div class="admin-team-role"><strong>${sgEscapeHtml(roleLabel(operator.role))}</strong><span>${operator.role === 'super_admin' ? 'Full admin control' : 'Customer support access'}</span></div>
      <div class="admin-team-login"><strong>${sgEscapeHtml(teamDate(operator.lastLoginAt))}</strong><span>${operator.lastLoginAt ? 'Last sign-in' : `Added ${teamDate(operator.createdAt)}`}</span></div>
      <span class="admin-team-status ${statusClass}">${status}</span>
      <button class="sg-btn sg-btn-ghost admin-team-manage" type="button" data-manage-operator="${operator.id}">Manage</button>
    </article>`;
  }).join('');
  teamList.querySelectorAll('[data-manage-operator]').forEach(button => button.addEventListener('click', () => openManageOperator(button.dataset.manageOperator)));
}

async function loadTeam() {
  teamList.setAttribute('aria-busy', 'true');
  try {
    const session = await window.adminShellSession.catch(() => null);
    teamState.currentOperatorId = Number(session?.operator?.id) || null;
    const data = await api('/api/admin/operators');
    teamState.operators = (data.operators || data.adminOperators || data.admin_operators || []).map(normalizeOperator);
    renderTeamSummary();
    renderTeam();
    teamSearch.disabled = false;
  } catch (error) {
    ['team-active', 'team-super', 'team-support'].forEach(id => { document.getElementById(id).textContent = '—'; });
    teamSummary.setAttribute('aria-busy', 'false');
    teamList.setAttribute('aria-busy', 'false');
    teamList.classList.remove('admin-skeleton-stack');
    teamList.innerHTML = `<div class="admin-load-error"><strong>Team access could not be loaded.</strong><p>${sgEscapeHtml(error.message || '')}</p><button class="sg-btn sg-btn-ghost" id="retry-team" type="button">Try again</button></div>`;
    document.getElementById('retry-team').addEventListener('click', loadTeam);
  }
}

function setTeamError(id, message = '') {
  document.getElementById(id).textContent = message;
}

function validReason(id) {
  const field = document.getElementById(id);
  const value = field.value.trim();
  if (value.length < 8) {
    field.focus();
    return '';
  }
  return value;
}

async function withTeamStepUp(targetKey, work) {
  await adminStepUp.run({
    action: 'operator_manage',
    targetKey,
    title: 'Confirm this team change',
    description: 'Enter the fresh six-digit code sent to your administrator email. The proof is used once for this action.'
  });
  return work();
}

function openAddOperator() {
  document.getElementById('add-operator-form').reset();
  setTeamError('add-operator-error');
  addDialog.showModal();
  requestAnimationFrame(() => document.getElementById('operator-email').focus());
}

async function submitAddOperator(event) {
  event.preventDefault();
  const email = document.getElementById('operator-email').value.trim().toLowerCase();
  const role = document.getElementById('operator-role').value;
  const reason = validReason('operator-reason');
  if (!reason) return setTeamError('add-operator-error', 'Add a reason of at least 8 characters.');
  const button = document.getElementById('submit-add-operator');
  button.disabled = true;
  setTeamError('add-operator-error');
  try {
    await withTeamStepUp(`new:${email}`, () => api('/api/admin/operators', { method: 'POST', body: { email, role, reason } }));
    addDialog.close();
    toast(`${email} can now verify their inbox and sign in.`);
    await loadTeam();
  } catch (error) {
    if (error.code !== 'step_up_cancelled') setTeamError('add-operator-error', error.message || 'Operator access could not be added.');
  } finally { button.disabled = false; }
}

function openManageOperator(id) {
  const operator = teamState.operators.find(item => item.id === Number(id));
  if (!operator) return;
  teamState.selected = operator;
  document.getElementById('manage-operator-title').textContent = 'Manage operator';
  document.getElementById('manage-operator-email').textContent = operator.email;
  document.getElementById('manage-operator-role').value = operator.role;
  document.getElementById('manage-operator-reason').value = '';
  setTeamError('manage-operator-error');
  const isSelf = operator.id === teamState.currentOperatorId;
  document.getElementById('manage-operator-self-note').hidden = !isSelf;
  document.getElementById('manage-operator-role').disabled = isSelf;
  document.getElementById('save-operator-role').disabled = isSelf;
  document.getElementById('revoke-operator-sessions').disabled = isSelf;
  const toggle = document.getElementById('toggle-operator-status');
  toggle.disabled = isSelf;
  toggle.textContent = operator.status === 'disabled' ? 'Reactivate access' : 'Remove access';
  toggle.className = `sg-btn ${operator.status === 'disabled' ? 'sg-btn-ghost' : 'sg-btn-danger'}`;
  manageDialog.showModal();
  requestAnimationFrame(() => (isSelf ? document.getElementById('cancel-manage-operator') : document.getElementById('manage-operator-role')).focus());
}

async function runManageMutation(work, successMessage, button) {
  const reason = validReason('manage-operator-reason');
  if (!reason) {
    setTeamError('manage-operator-error', 'Add a reason of at least 8 characters for the audit record.');
    return;
  }
  button.disabled = true;
  setTeamError('manage-operator-error');
  try {
    await withTeamStepUp(`operator:${teamState.selected.id}`, () => work(reason));
    manageDialog.close();
    toast(successMessage);
    await loadTeam();
  } catch (error) {
    if (error.code !== 'step_up_cancelled') setTeamError('manage-operator-error', error.message || 'Operator access could not be changed.');
  } finally { button.disabled = false; }
}

function submitOperatorRole(event) {
  event.preventDefault();
  if (!teamState.selected) return;
  const role = document.getElementById('manage-operator-role').value;
  if (role === teamState.selected.role) {
    setTeamError('manage-operator-error', 'Choose a different role, or cancel.');
    return;
  }
  const button = document.getElementById('save-operator-role');
  runManageMutation(
    reason => api(`/api/admin/operators/${encodeURIComponent(teamState.selected.id)}`, { method: 'PATCH', body: { role, reason } }),
    `${teamState.selected.email} is now ${roleLabel(role)}.`,
    button
  );
}

function revokeOperatorSessions(event) {
  if (!teamState.selected) return;
  runManageMutation(
    reason => api(`/api/admin/operators/${encodeURIComponent(teamState.selected.id)}/revoke-sessions`, { method: 'POST', body: { reason } }),
    `${teamState.selected.email} was signed out everywhere.`,
    event.currentTarget
  );
}

function toggleOperatorStatus(event) {
  if (!teamState.selected) return;
  const status = teamState.selected.status === 'disabled' ? 'active' : 'disabled';
  runManageMutation(
    reason => api(`/api/admin/operators/${encodeURIComponent(teamState.selected.id)}`, { method: 'PATCH', body: { status, reason } }),
    status === 'active' ? `${teamState.selected.email} can sign in again.` : `${teamState.selected.email} no longer has admin access.`,
    event.currentTarget
  );
}

document.getElementById('open-add-operator').addEventListener('click', openAddOperator);
document.getElementById('cancel-add-operator').addEventListener('click', () => addDialog.close());
document.getElementById('add-operator-form').addEventListener('submit', submitAddOperator);
document.getElementById('cancel-manage-operator').addEventListener('click', () => manageDialog.close());
document.getElementById('manage-operator-form').addEventListener('submit', submitOperatorRole);
document.getElementById('revoke-operator-sessions').addEventListener('click', revokeOperatorSessions);
document.getElementById('toggle-operator-status').addEventListener('click', toggleOperatorStatus);
teamSearch.addEventListener('input', renderTeam);
[addDialog, manageDialog].forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); }));

loadTeam();
