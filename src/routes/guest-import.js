const express = require('express');
const pool = require('../config/db');
const requireOrganizer = require('../middleware/requireOrganizer');
const { createRateLimiter, clientIp } = require('../lib/rate-limit');
const {
  MAX_ROWS, HOST_LIMIT, PERMISSION_VERSION, BUDGET_LOCK, GuestImportError, digest,
  normalizeRows, inputDigest, audienceDigest, signReview, readReview, loadContext,
  requireEligible, contextDigest, renderInvitation, classifyRows, summarize, budgetState, loadStatus,
  normalizeSelection, resolveSelection
} = require('../lib/guest-import');
const { queuePreviousGuestInvitationBatch } = require('../jobs/previous-guest-invitations');
const { invitationSelectionKey } = require('../lib/invitation-selection-key');

const router = express.Router();
router.use('/api/events/:id/guest-import', requireOrganizer, (_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});
const previewLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, rules: [
  { name: 'account', max: 30, key: value => value.account },
  { name: 'network', max: 90, key: value => value.ip }
] });
const sendLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, rules: [
  { name: 'account', max: 20, key: value => value.account },
  { name: 'network', max: 60, key: value => value.ip }
] });
const timer = setInterval(() => { previewLimiter.prune(); sendLimiter.prune(); }, 15 * 60 * 1000);
timer.unref?.();
function limit(limiter, req, res) {
  const result = limiter.consume({ account: req.organizer.id, ip: clientIp(req) });
  if (result.allowed) return true;
  res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
  res.status(429).json({ code: 'rate_limited', error: 'Please wait a little before trying again.' });
  return false;
}
function eventId(req) {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1 || String(id) !== req.params.id) {
    throw new GuestImportError(404, 'event_not_found', 'Event not found.');
  }
  return id;
}
function handleError(error, res) {
  if (error instanceof GuestImportError) {
    if (error.status === 429) res.setHeader('Retry-After', '86400');
    return res.status(error.status).json({ error: error.message, code: error.code,
      ...(error.code === 'email_verification_required' ? { verificationUrl: '/settings/account' } : {}) });
  }
  // Never include imported contacts, provider payloads, SQL, or signed tokens.
  console.error('[guest-import] request failed');
  return res.status(500).json({ error: 'Could not complete this request. Your list is still here.', code: 'server_error' });
}

router.post('/api/events/:id/guest-import/preview', async (req, res) => {
  if (!limit(previewLimiter, req, res)) return;
  try {
    const importing = Object.prototype.hasOwnProperty.call(req.body || {}, 'rows');
    const selection = importing ? null : normalizeSelection(req.body);
    const normalized = importing ? normalizeRows(req.body?.rows) : null;
    const context = requireEligible(await loadContext(pool, eventId(req), req.organizer.id), {
      requireEmail: importing || selection.contactIds.length > 0
    });
    const resolved = importing ? null : await resolveSelection(pool, context, selection);
    const rows = importing ? await classifyRows(pool, normalized, context) : resolved.rows;
    const summary = importing ? summarize(rows) : resolved.summary;
    const budget = await budgetState(pool, context);
    const preview = renderInvitation(context, rows.find(row => row.status === 'ready') || { name: '', email: '' }, { preview: true });
    const reviewToken = signReview({ eventId: context.event.id, organizerId: req.organizer.id,
      kind: importing ? 'import' : 'invitations', selectionHash: importing ? null : digest(selection),
      rowsHash: inputDigest(importing ? normalized : rows), audienceHash: audienceDigest(rows), contextHash: contextDigest(context) });
    const budgetCount = importing ? summary.ready : resolved.importedCount;
    // Past-guest addresses stay private; contacts are supplied by this host.
    let visibleRows = rows.map(row => {
      const { linkedUserId, email, ...safe } = row;
      return importing || row.source !== 'face' ? { ...safe, email } : safe;
    });
    if (importing) {
      const existing = new Map((await pool.query(
        'SELECT id,email FROM host_invitation_contacts WHERE organizer_id=$1 AND email=ANY($2::text[])',
        [req.organizer.id, rows.filter(row => row.status !== 'invalid').map(row => row.email)]
      )).rows.map(row => [row.email, String(row.id)]));
      visibleRows = visibleRows.map(row => ({ ...row, existingContact: existing.has(row.email) }));
      summary.existingContacts = [...existing].length;
    }
    res.json({ rows: visibleRows, summary, previewHtml: preview.html.replace(/href="[^"]*"/g, 'aria-disabled="true"'), subject: preview.subject, reviewToken,
      limits: { maxRows: MAX_ROWS, perHost24h: HOST_LIMIT, remaining24h: budget.hostRemaining },
      canSend: summary.ready > 0 && budgetCount <= budget.hostRemaining && budgetCount <= budget.globalRemaining,
      ...(budgetCount > budget.globalRemaining ? { notice: 'Invitations are temporarily at capacity. Please try again tomorrow.' } : {}) });
  } catch (error) { handleError(error, res); }
});

function contactDto(row, organizerId, canInvite) {
  return { id: String(row.id), name: row.name, email: row.email,
    selectionKey: invitationSelectionKey(organizerId, row.email, row.linkedUserId),
    eligible: canInvite && row.status === 'ready',
    reason: !canInvite ? 'Publish an upcoming event before inviting.' : row.message || '' };
}
function targetCanInvite(context) {
  const event = context.event;
  return event.status === 'published' && event.is_future && !event.archived_at && !event.secret_show_enabled;
}

router.get('/api/events/:id/guest-import/contacts', async (req, res) => {
  try {
    const context = await loadContext(pool, eventId(req), req.organizer.id);
    const search = String(req.query.search || '').trim().slice(0, 120);
    const pattern = search ? `%${search.replace(/[\\%_]/g, value => `\\${value}`)}%` : '';
    const offset = Math.max(0, Math.min(100000, Number.parseInt(req.query.offset, 10) || 0));
    const all = req.query.all === '1';
    const counts = (await pool.query(
      `SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE $2='' OR name ILIKE $2 OR email ILIKE $2)::int AS matching
         FROM host_invitation_contacts WHERE organizer_id=$1`, [req.organizer.id, pattern]
    )).rows[0];
    // Eligible count is computed in SQL, independent of pagination. All uses
    // that same boundary and never silently selects only the first page.
    const proven = `WITH proven AS (SELECT LOWER(TRIM(r.email)) AS email,MIN(proof.user_id) AS user_id
      FROM rsvps r JOIN events e ON e.id=r.event_id JOIN organizers proof ON proof.id=r.account_id
      WHERE e.organizer_id=$1 AND proof.user_id IS NOT NULL AND (r.user_id IS NULL OR r.user_id=proof.user_id)
      GROUP BY LOWER(TRIM(r.email)) HAVING COUNT(DISTINCT proof.user_id)=1)`;
    const eligibility = `NOT EXISTS (SELECT 1 FROM follower_optouts fo WHERE fo.organizer_id=c.organizer_id
        AND (LOWER(TRIM(fo.email))=c.email OR EXISTS (SELECT 1 FROM proven alias WHERE alias.email=LOWER(TRIM(fo.email)) AND alias.user_id=identity.user_id)))
      AND NOT EXISTS (SELECT 1 FROM rsvps r WHERE r.event_id=$3 AND r.status IN ('confirmed','cancelled')
        AND (LOWER(TRIM(r.email))=c.email OR r.user_id=identity.user_id
          OR EXISTS (SELECT 1 FROM organizers proof WHERE proof.id=r.account_id AND proof.user_id=identity.user_id)))
      AND NOT EXISTS (SELECT 1 FROM message_log ml WHERE ml.event_id=$3
        AND (LOWER(TRIM(ml.recipient))=c.email OR ml.recipient_user_id=identity.user_id
          OR EXISTS (SELECT 1 FROM proven alias WHERE alias.email=LOWER(TRIM(ml.recipient)) AND alias.user_id=identity.user_id))
        AND ml.message_type IN ('previous_guest_invite','announcement'))`;
    const eligibleCount = (await pool.query(
      `${proven} SELECT COUNT(*)::int AS count FROM host_invitation_contacts c LEFT JOIN proven identity ON identity.email=c.email
        WHERE c.organizer_id=$1 AND ($2='' OR c.name ILIKE $2 OR c.email ILIKE $2) AND ${eligibility}`,
      [req.organizer.id, pattern, context.event.id]
    )).rows[0].count;
    if (all && eligibleCount > MAX_ROWS) throw new GuestImportError(400, 'selection_limit', `Narrow your search to select no more than ${MAX_ROWS} contacts at once.`);
    const contacts = (await pool.query(
      `${proven} SELECT c.id,c.name,c.email FROM host_invitation_contacts c LEFT JOIN proven identity ON identity.email=c.email
        WHERE c.organizer_id=$1 AND ($2='' OR c.name ILIKE $2 OR c.email ILIKE $2)
          AND ($4::boolean=FALSE OR (${eligibility})) ORDER BY LOWER(c.name),c.id LIMIT $5 OFFSET $6`,
      [req.organizer.id, pattern, context.event.id, all, all ? MAX_ROWS : 48, all ? 0 : offset]
    )).rows;
    const classified = await classifyRows(pool, contacts.map(row => ({ ...row, status: 'ready', message: '' })), context);
    const canInvite = targetCanInvite(context);
    res.json({ contacts: classified.map(row => contactDto(row, req.organizer.id, canInvite)),
      total: counts.total, matchingTotal: counts.matching, eligibleCount: canInvite ? eligibleCount : 0,
      hasMore: !all && offset + contacts.length < counts.matching });
  } catch (error) { handleError(error, res); }
});

router.post('/api/events/:id/guest-import/contacts/import', async (req, res) => {
  if (!limit(previewLimiter, req, res)) return;
  let client;
  try {
    const normalized = normalizeRows(req.body?.rows);
    const review = readReview(req.body?.reviewToken);
    const id = eventId(req);
    if (!review || review.kind !== 'import' || review.eventId !== id || review.organizerId !== req.organizer.id ||
        review.expires <= Date.now() || review.rowsHash !== inputDigest(normalized)) {
      throw new GuestImportError(409, 'stale_preview', 'Review these contacts again before importing.');
    }
    client = await pool.connect();
    await client.query('BEGIN');
    const context = requireEligible(await loadContext(client, id, req.organizer.id, { lock: true }));
    const valid = normalized.filter(row => row.status !== 'invalid' && row.status !== 'duplicate');
    if (!valid.length) throw new GuestImportError(400, 'no_contacts', 'There are no valid contacts to import.');
    const saved = [];
    for (const row of valid) {
      const contact = (await client.query(
        `INSERT INTO host_invitation_contacts(organizer_id,email,name) VALUES ($1,$2,$3)
         ON CONFLICT (organizer_id,email) DO UPDATE
           SET name=CASE WHEN host_invitation_contacts.name='' THEN EXCLUDED.name ELSE host_invitation_contacts.name END,
               updated_at=NOW()
         RETURNING id,name,email`, [req.organizer.id, row.email, row.name]
      )).rows[0];
      saved.push({ ...contact, status: 'ready', message: '' });
    }
    const classified = await classifyRows(client, saved, context);
    const total = (await client.query('SELECT COUNT(*)::int AS count FROM host_invitation_contacts WHERE organizer_id=$1', [req.organizer.id])).rows[0].count;
    await client.query('COMMIT');
    const contacts = classified.map(row => contactDto(row, req.organizer.id, true));
    res.json({ ok: true, contacts, total, selectedContactIds: contacts.filter(contact => contact.eligible).map(contact => contact.id),
      saved: contacts.length, skipped: normalized.length - contacts.length });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    handleError(error, res);
  } finally { client?.release(); }
});

router.post('/api/events/:id/guest-import/past-selection', async (req, res) => {
  if (!limit(previewLimiter, req, res)) return;
  try {
    const context = requireEligible(await loadContext(pool, eventId(req), req.organizer.id), { requireEmail: false });
    const { resolveGuestImportPastFaces } = require('./events');
    const people = await resolveGuestImportPastFaces(pool, {
      eventId: context.event.id, organizerId: req.organizer.id,
      group: req.body?.group, sourceEventId: req.body?.sourceEventId, search: req.body?.search
    });
    res.json({ people: people.map(person => ({ id: person.id,
      name: person.name || `${person.first_name || ''} ${person.last_name || ''}`.trim(),
      selectionKey: person.selectionKey || invitationSelectionKey(req.organizer.id, person.email) })) });
  } catch (error) { handleError(error, res); }
});

router.post('/api/events/:id/guest-import/send', async (req, res) => {
  if (!limit(sendLimiter, req, res)) return;
  let client;
  let batchId;
  try {
    if (req.body?.permissionConfirmed !== true) {
      throw new GuestImportError(400, 'permission_required', 'Confirm you have permission to email this guest list.');
    }
    const selection = normalizeSelection(req.body);
    const review = readReview(req.body?.reviewToken);
    const id = eventId(req);
    if (!review || review.kind !== 'invitations' || review.organizerId !== req.organizer.id || review.eventId !== id || review.selectionHash !== digest(selection)) {
      throw new GuestImportError(409, 'stale_preview', 'Review this guest list again before sending.');
    }
    const approvalKey = digest(req.body.reviewToken);
    client = await pool.connect();
    await client.query('BEGIN');
    // Serializes host and global quota approval, including multiple targets.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [BUDGET_LOCK]);
    const context = await loadContext(client, id, req.organizer.id, { lock: true });
    const prior = (await client.query(
      `SELECT id,recipient_count,import_skipped_count FROM previous_guest_invitation_batches
        WHERE target_event_id=$1 AND import_approval_key=$2 AND source_kind='import'`, [id, approvalKey]
    )).rows[0];
    // Recover the original approval even after its review token expired. This
    // never requeues or expands a previously approved batch.
    if (prior) {
      await client.query('COMMIT');
      return res.status(202).json({ ok: true, alreadyApproved: true, batchId: String(prior.id),
        queued: prior.recipient_count, skipped: prior.import_skipped_count });
    }
    requireEligible(context, { requireEmail: selection.contactIds.length > 0 });
    if (review.expires <= Date.now() || review.contextHash !== contextDigest(context)) {
      throw new GuestImportError(409, 'stale_preview', 'The event changed or this preview expired. Review again before sending.');
    }
    const resolved = await resolveSelection(client, context, selection);
    const { rows, summary, importedCount } = resolved;
    if (review.audienceHash !== audienceDigest(rows) || review.rowsHash !== inputDigest(rows)) {
      throw new GuestImportError(409, 'stale_preview', 'The eligible guest list changed. Review it again before sending.');
    }
    const ready = rows.filter(row => row.status === 'ready');
    if (!ready.length) throw new GuestImportError(409, 'no_recipients', 'There are no new eligible guests to invite.');
    const budget = await budgetState(client, context, { create: true });
    if (importedCount > budget.hostRemaining || importedCount > budget.globalRemaining) {
      throw new GuestImportError(429, 'daily_limit', 'This invitation limit has been reached. Please try again tomorrow.');
    }
    const batch = (await client.query(
      `INSERT INTO previous_guest_invitation_batches
         (target_event_id,source_event_title,source_kind,status,recipient_count,import_approval_key,
          import_context_hash,import_skipped_count,import_permission_version,import_permission_at,import_contacts_count)
       VALUES ($1,'Reviewed guest selection','import','import_pending',$2,$3,$4,$5,$6,NOW(),$7) RETURNING id`,
      [id, ready.length, approvalKey, review.contextHash, summary.skipped, PERMISSION_VERSION, importedCount]
    )).rows[0];
    batchId = batch.id;
    for (const row of ready) {
      const inserted = await client.query(
        `INSERT INTO message_log
          (event_id,previous_guest_invitation_batch_id,recipient,recipient_name,message_type,channel,status,
           import_render_payload,import_delivery_state,recipient_user_id)
         VALUES ($1,$2,$3,$4,'previous_guest_invite','email','pending',$5::jsonb,'pending',$6)
         ON CONFLICT (event_id,LOWER(recipient)) WHERE message_type='previous_guest_invite' DO NOTHING RETURNING id`,
        [id, batchId, row.email, row.name || null, JSON.stringify(renderInvitation(context, row)), row.linkedUserId || null]
      );
      if (!inserted.rowCount) throw new GuestImportError(409, 'stale_preview', 'Someone on this list was just invited. Review again.');
    }
    if (importedCount) await client.query(
      `INSERT INTO guest_import_budget(approval_key,account_key,email_keys,recipient_count) VALUES ($1,$2,$3,$4)`,
      [approvalKey, budget.accountKey, budget.emailKeys, importedCount]
    );
    await client.query('COMMIT');
    queuePreviousGuestInvitationBatch(batchId);
    res.status(202).json({ ok: true, batchId: String(batchId), queued: ready.length, skipped: summary.skipped });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    handleError(error, res);
  } finally { client?.release(); }
});

router.get('/api/events/:id/guest-import/status/:batchId', async (req, res) => {
  try {
    if (!/^[1-9]\d{0,17}$/.test(req.params.batchId)) throw new GuestImportError(404, 'batch_not_found', 'Invitation batch not found.');
    res.json(await loadStatus(pool, req.params.batchId, eventId(req), req.organizer.id));
  } catch (error) { handleError(error, res); }
});

router.resetRateLimitsForTests = () => { previewLimiter.reset(); sendLimiter.reset(); };
module.exports = router;
