renderNav('');

const overview = {
  total: document.getElementById('overview-total'),
  suspended: document.getElementById('overview-suspended'),
  hosts: document.getElementById('overview-hosts'),
  active: document.getElementById('overview-active'),
  operators: document.getElementById('overview-operators'),
  teamCard: document.getElementById('overview-team-card'),
  metrics: document.querySelector('.admin-overview-metrics')
};

function overviewNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('en-US') : '—';
}

async function loadAccountMetrics() {
  try {
    const data = await api('/api/admin/accounts?limit=1');
    const summary = data.summary || {};
    overview.total.textContent = overviewNumber(summary.total);
    overview.suspended.textContent = overviewNumber(summary.suspended);
    overview.hosts.textContent = overviewNumber(summary.host_pages ?? summary.hosts ?? summary.host_count);
    overview.active.textContent = overviewNumber(summary.active_30_days ?? summary.active_in_30_days ?? summary.recently_active);
  } catch (_) {
    overview.total.textContent = '—';
    overview.suspended.textContent = '—';
    overview.hosts.textContent = '—';
    overview.active.textContent = '—';
  }
}

async function loadTeamMetric() {
  const session = await window.adminShellSession.catch(() => null);
  if (!session?.capabilities?.manageOperators) return;
  overview.teamCard.hidden = false;
  try {
    const data = await api('/api/admin/operators?limit=1');
    const operators = data.operators || [];
    const active = data.summary?.active ?? data.activeCount ?? data.active_count ?? operators.filter(operator => operator.status !== 'disabled').length;
    overview.operators.textContent = overviewNumber(active);
  } catch (_) {
    overview.operators.textContent = '—';
  }
}

Promise.allSettled([loadAccountMetrics(), loadTeamMetric()]).then(() => {
  overview.metrics.setAttribute('aria-busy', 'false');
});
