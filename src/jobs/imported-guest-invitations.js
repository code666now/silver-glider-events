const pool = require('../config/db');
const mailer = require('../lib/mailer');
const { withActiveHostAccount } = require('../lib/outbound-account-status');
const {
  GuestImportError, loadContext, requireEligible, contextDigest, classifyRows
} = require('../lib/guest-import');

const MAX_ATTEMPTS = 3;

async function finishBatch(batchId) {
  await pool.query(
    `UPDATE message_log SET status='failed',import_delivery_state='failed',error='delivery_unconfirmed'
     WHERE previous_guest_invitation_batch_id=$1 AND import_delivery_state='pending'
       AND attempt_count >= $2 AND last_attempt_at < NOW() - INTERVAL '2 minutes'`, [batchId, MAX_ATTEMPTS]
  );
  const counts = (await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE import_delivery_state='accepted')::int AS accepted,
            COUNT(*) FILTER (WHERE import_delivery_state='skipped')::int AS skipped,
            COUNT(*) FILTER (WHERE import_delivery_state='failed')::int AS failed,
            COUNT(*) FILTER (WHERE import_delivery_state='pending')::int AS pending
       FROM message_log WHERE previous_guest_invitation_batch_id=$1`, [batchId]
  )).rows[0];
  const complete = counts.pending === 0;
  const status = !complete ? 'import_pending' : counts.failed ? (counts.accepted ? 'partial_failed' : 'failed') : 'sent';
  await pool.query(
    `UPDATE previous_guest_invitation_batches SET status=$2,sent_count=$3,failed_count=$4,
       completed_at=CASE WHEN $5 THEN COALESCE(completed_at,NOW()) ELSE NULL END
     WHERE id=$1 AND source_kind='import'`, [batchId, status, counts.accepted, counts.failed, complete]
  );
  return { ...counts, status, complete };
}

async function suppress(db, logId, reason) {
  await db.query(
    `UPDATE message_log SET status='failed',import_delivery_state='skipped',attempt_count=$2,error=$3
      WHERE id=$1 AND import_delivery_state='pending'`, [logId, MAX_ATTEMPTS, reason]
  );
}

async function processImportedGuestInvitationBatch(batchId) {
  const batch = (await pool.query(
    `SELECT b.*,e.organizer_id FROM previous_guest_invitation_batches b
      JOIN events e ON e.id=b.target_event_id
      WHERE b.id=$1 AND b.source_kind='import' AND b.status='import_pending'`, [batchId]
  )).rows[0];
  if (!batch) return null;
  // Provider idempotency expires. Old/ambiguous requests must never be blindly
  // resent after the bounded window, even if they still look pending locally.
  await pool.query(
    `UPDATE message_log SET status='failed',import_delivery_state='failed',attempt_count=$2,
       error=CASE WHEN import_first_attempt_at IS NULL THEN 'delivery_expired' ELSE 'delivery_unconfirmed' END
     WHERE previous_guest_invitation_batch_id=$1 AND import_delivery_state='pending'
       AND created_at <= NOW() - INTERVAL '23 hours'`, [batchId, MAX_ATTEMPTS]
  );
  const deliveries = (await pool.query(
    `SELECT id,recipient,recipient_name,recipient_user_id FROM message_log
      WHERE previous_guest_invitation_batch_id=$1 AND import_delivery_state='pending' AND attempt_count<$2
        AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - INTERVAL '2 minutes')
      ORDER BY id`, [batchId, MAX_ATTEMPTS]
  )).rows;
  for (const delivery of deliveries) {
    // Commit the attempt before any network handoff. Multiple workers cannot
    // claim the same attempt, and a crash resumes the identical payload/key.
    const claim = (await pool.query(
      `UPDATE message_log SET status='pending',attempt_count=attempt_count+1,last_attempt_at=NOW(),
         import_first_attempt_at=COALESCE(import_first_attempt_at,NOW())
       WHERE id=$1 AND import_delivery_state='pending' AND attempt_count<$2
         AND created_at > NOW() - INTERVAL '23 hours'
         AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - INTERVAL '2 minutes')
       RETURNING attempt_count`, [delivery.id, MAX_ATTEMPTS]
    )).rows[0];
    if (!claim) continue;
    try {
      const result = await withActiveHostAccount(pool, batch.organizer_id, async client => {
        await client.query('BEGIN');
        try {
          let context;
          try {
            context = requireEligible(await loadContext(client, batch.target_event_id, batch.organizer_id, { lock: true }), {
              requireEmail: batch.import_contacts_count > 0
            });
          } catch (error) {
            if (!(error instanceof GuestImportError)) throw error;
            await suppress(client, delivery.id, error.code);
            await client.query('COMMIT');
            return;
          }
          if (contextDigest(context) !== batch.import_context_hash) {
            await suppress(client, delivery.id, 'event_changed');
            await client.query('COMMIT');
            return;
          }
          const [recipient] = await classifyRows(client, [{
            name: delivery.recipient_name || '', email: delivery.recipient,
            linkedUserId: delivery.recipient_user_id || null, status: 'ready'
          }], context, { excludeLogId: delivery.id });
          if (recipient.status !== 'ready') {
            await suppress(client, delivery.id, recipient.status);
            await client.query('COMMIT');
            return;
          }
          const current = (await client.query(
            `SELECT import_render_payload,import_delivery_state,attempt_count FROM message_log WHERE id=$1 FOR UPDATE`, [delivery.id]
          )).rows[0];
          if (!current || current.import_delivery_state !== 'pending' || current.attempt_count !== claim.attempt_count) {
            await client.query('ROLLBACK');
            return;
          }
          const payload = current.import_render_payload;
          if (!payload || payload.to !== delivery.recipient || !payload.html) throw new Error('Missing approved payload');
          const accepted = await mailer.sendImportedGuestInvitation({
            payload, idempotencyKey: `guest-import:${delivery.id}:v1`
          });
          if (!accepted?.id && !(accepted?.dev === true && process.env.NODE_ENV !== 'production')) {
            throw new Error('Provider acceptance not confirmed');
          }
          await client.query(
            `UPDATE message_log SET status='sent',import_delivery_state='accepted',sent_at=NOW(),provider_id=$2,error=NULL WHERE id=$1`,
            [delivery.id, accepted?.id || null]
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      });
      if (!result.allowed) await suppress(pool, delivery.id, 'host_account_inactive');
    } catch (_) {
      // Recipient addresses, provider response bodies, and raw SQL stay out of
      // logs. Provider failure may be ambiguous: retries keep the frozen key.
      console.error('[guest-import] delivery attempt not confirmed');
      await pool.query(
        `UPDATE message_log SET status=CASE WHEN attempt_count >= $2 THEN 'failed' ELSE 'pending' END,
           import_delivery_state=CASE WHEN attempt_count >= $2 THEN 'failed' ELSE 'pending' END,
           error='delivery_unconfirmed'
         WHERE id=$1 AND import_delivery_state='pending'`, [delivery.id, MAX_ATTEMPTS]
      );
    }
  }
  return finishBatch(batchId);
}

module.exports = { processImportedGuestInvitationBatch, finishBatch };
