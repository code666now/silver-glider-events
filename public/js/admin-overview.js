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

// The four loop numbers. Each shows the raw counts, so a small denominator is
// obvious rather than hidden behind a percentage.
async function loadTraction() {
  const panel = document.querySelector('.admin-traction');
  const set = (id, value, note) => {
    document.getElementById(id).textContent = value;
    document.getElementById(`${id}-note`).textContent = note;
  };
  const share = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '—');
  try {
    const { traction } = await api('/api/admin/traction');
    const hosts = Number(traction.hosts_with_event) || 0;
    const second = Number(traction.hosts_with_second_event) || 0;
    const gap = traction.median_days_to_second_event;
    const gapNote = gap == null
      ? 'No second events yet'
      : (gap === 0 ? 'Usually the same day' : `Typically ${gap} day${gap === 1 ? '' : 's'} apart`);
    set('traction-second', `${second} of ${hosts}`, gapNote);

    const sent = Number(traction.invites_sent) || 0;
    const answered = Number(traction.invites_answered) || 0;
    set('traction-invites', `${answered} of ${sent}`, `${share(answered, sent)} of invitations`);

    const rsvps = Number(traction.rsvps_total) || 0;
    const returning = Number(traction.rsvps_returning) || 0;
    set('traction-returning', `${returning} of ${rsvps}`, `${share(returning, rsvps)} had been before`);

    const invited = Number(traction.artists_invited) || 0;
    const claimed = Number(traction.artists_claimed) || 0;
    const declined = Number(traction.artists_declined) || 0;
    set('traction-claims', `${claimed} of ${invited}`,
      declined ? `${share(claimed, invited)} claimed · ${declined} said not me` : `${share(claimed, invited)} claimed`);
  } catch (_) {
    for (const id of ['traction-second', 'traction-invites', 'traction-returning', 'traction-claims']) {
      document.getElementById(id).textContent = '—';
      document.getElementById(`${id}-note`).textContent = 'Could not be loaded';
    }
  } finally {
    panel.setAttribute('aria-busy', 'false');
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

async function loadWelcomeTextCosts() {
  const session = await window.adminShellSession.catch(() => null);
  if (!session?.capabilities?.manageOperators) return;
  const panel = document.getElementById('admin-texting-costs');
  const refresh = document.getElementById('texting-cost-refresh');
  panel.hidden = false;
  panel.setAttribute('aria-busy', 'true');
  refresh.disabled = true;
  const set = (id, value) => { document.getElementById(id).textContent = value; };
  try {
    const { campaign, costs } = await api('/api/admin/sms-welcome-costs');
    const submitted = Number(costs.acceptedTexts) || 0;
    const recorded = Number(costs.recordedTexts) || 0;
    const pending = Number(costs.pendingTexts) || 0;
    const unknownAcceptance = Number(costs.unknownAcceptanceTexts) || 0;
    const nonUsd = Number(costs.nonUsdTexts) || 0;
    const amount = costs.recordedUsdCost;
    // Neither a missing provider price nor an uncertain send is a zero-cost text.
    set('texting-cost-amount', submitted === 0 && unknownAcceptance === 0 ? '$0.00' : amount == null ? (pending || unknownAcceptance ? 'Pending' : 'No USD total') :
      new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD',
        minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(Number(amount)));
    const coverage = submitted === 0
      ? (unknownAcceptance ? '' : 'No complimentary texts have been submitted yet.')
      : `${overviewNumber(recorded)} of ${overviewNumber(submitted)} texts have USD charges recorded.` +
        (pending ? ` ${overviewNumber(pending)} awaiting provider pricing.` : '') +
        (nonUsd ? ` ${overviewNumber(nonUsd)} priced in another currency, excluded from this USD total.` : '');
    set('texting-cost-coverage', (coverage + (unknownAcceptance
      ? ` ${overviewNumber(unknownAcceptance)} texts awaiting provider acceptance confirmation.` : '')).trim());
    set('texting-cost-hosts', overviewNumber(campaign.claims));
    set('texting-cost-granted', overviewNumber(campaign.creditsGranted));
    set('texting-cost-used', overviewNumber(submitted));
    set('texting-cost-remaining', overviewNumber(campaign.creditsRemaining));
    set('texting-cost-campaign', `Welcome campaign ${campaign.enabled ? 'enabled' : 'paused'} · ${overviewNumber(campaign.claims)} of ${overviewNumber(campaign.cap)} claims used.` +
      (Number(campaign.claims) >= Number(campaign.cap) ? ' No welcome claims available.' : ''));
    const asOf = new Date(costs.asOf);
    set('texting-cost-updated', Number.isNaN(asOf.getTime()) ? '' : `Totals as of ${asOf.toLocaleString()}. Provider charges can arrive later; refresh does not send messages.`);
  } catch (_) {
    for (const id of ['texting-cost-amount', 'texting-cost-hosts', 'texting-cost-granted', 'texting-cost-used', 'texting-cost-remaining']) set(id, '—');
    set('texting-cost-coverage', 'Texting costs could not be loaded. Try refreshing.');
    set('texting-cost-campaign', '');
    set('texting-cost-updated', '');
  } finally {
    panel.setAttribute('aria-busy', 'false');
    refresh.disabled = false;
  }
}

document.getElementById('texting-cost-refresh').addEventListener('click', loadWelcomeTextCosts);
loadWelcomeTextCosts();

Promise.allSettled([loadAccountMetrics(), loadTeamMetric(), loadTraction()]).then(() => {
  overview.metrics.setAttribute('aria-busy', 'false');
});

window.adminShellSession.then(session => {
  const shortcut = document.getElementById('overview-done-for-you');
  if (shortcut) shortcut.hidden = session?.capabilities?.manageDoneForYou !== true;
}).catch(() => {});
