const { providerBillingFields } = require('./sms');
const { accountWelcomeSmsAccepted } = require('./sms-credit-ledger');

const COST_SCOPE = 'Twilio outbound message charges for welcome-funded texts only; excludes Verify, incoming texts, phone rental, taxes and other account fees.';
let reconciling = false;

async function prepareWelcomeSmsCost(db, { recipientId, welcomeClaimId, welcomeCredits }) {
  if (!(Number(welcomeCredits) > 0)) return;
  const inserted = await db.query(
    `INSERT INTO sms_provider_cost_facts
       (source_recipient_id,notification_recipient_id,welcome_claim_id,welcome_credits,acceptance_state,accepted_at)
     VALUES ($1,(SELECT id FROM sms_notification_recipients WHERE id=$1),
             (SELECT id FROM sms_welcome_claims WHERE id=$2),$3,'pending',NULL)
     ON CONFLICT (source_recipient_id) DO NOTHING RETURNING id`,
    [recipientId,welcomeClaimId,Number(welcomeCredits)]
  );
  if (inserted.rows.length) return;
  // Only a definitive not-sent attempt is safe to reuse. A prior pending or
  // unknown POST might already have been accepted even if the process crashed.
  const retry = await db.query(
    `UPDATE sms_provider_cost_facts SET acceptance_state='pending'
      WHERE source_recipient_id=$1 AND provider_message_sid IS NULL AND acceptance_state='not_sent'
      RETURNING id`, [recipientId]
  );
  if (!retry.rows.length) throw Object.assign(new Error('A previous SMS attempt is awaiting confirmation'), {
    code: 'sms_acceptance_unknown', acceptance: 'unknown'
  });
}

async function markWelcomeSmsCostOutcome(db, recipientId, state) {
  if (!['unknown','not_sent'].includes(state)) throw new Error('Invalid SMS acceptance outcome');
  await db.query(
    `UPDATE sms_provider_cost_facts SET acceptance_state=$2
      WHERE source_recipient_id=$1 AND provider_message_sid IS NULL`, [recipientId,state]
  );
}

async function recordWelcomeSmsCost(db, { recipientId, welcomeClaimId, welcomeCredits, result }) {
  if (!(Number(welcomeCredits) > 0)) return false;
  if (!/^(SM|MM)[0-9a-f]{32}$/i.test(String(result?.sid || ''))) throw new Error('Invalid provider cost reference');
  const billing = providerBillingFields(result);
  const updated = await db.query(
    `UPDATE sms_provider_cost_facts SET provider_message_sid=$2,acceptance_state='accepted',accepted_at=COALESCE(accepted_at,NOW()),
       provider_price=COALESCE($3,provider_price),price_unit=COALESCE($4,price_unit),
       provider_segments=COALESCE($5,provider_segments),
       price_checked_at=CASE WHEN $3::numeric IS NOT NULL THEN NOW() ELSE price_checked_at END
     WHERE source_recipient_id=$1 AND (provider_message_sid IS NULL OR provider_message_sid=$2)
     RETURNING id`, [recipientId,result.sid,billing.price,billing.priceUnit,billing.numSegments]
  );
  if (updated.rows.length) return true;
  await db.query(
    `INSERT INTO sms_provider_cost_facts
       (provider_message_sid,source_recipient_id,notification_recipient_id,welcome_claim_id,welcome_credits,
        provider_price,price_unit,provider_segments,price_checked_at)
     VALUES ($1,$2,(SELECT id FROM sms_notification_recipients WHERE id=$2),
             (SELECT id FROM sms_welcome_claims WHERE id=$3),$4,$5,$6,$7,
             CASE WHEN $5::numeric IS NOT NULL THEN NOW() ELSE NULL END)
     ON CONFLICT (provider_message_sid) DO UPDATE
       SET acceptance_state='accepted',source_recipient_id=COALESCE(sms_provider_cost_facts.source_recipient_id,EXCLUDED.source_recipient_id),
           provider_price=COALESCE(EXCLUDED.provider_price,sms_provider_cost_facts.provider_price),
           price_unit=COALESCE(EXCLUDED.price_unit,sms_provider_cost_facts.price_unit),
           provider_segments=COALESCE(EXCLUDED.provider_segments,sms_provider_cost_facts.provider_segments),
           price_checked_at=COALESCE(EXCLUDED.price_checked_at,sms_provider_cost_facts.price_checked_at)`,
    [result.sid,recipientId,welcomeClaimId,Number(welcomeCredits),billing.price,billing.priceUnit,billing.numSegments]
  );
  return true;
}

// Also handles a signed status callback winning the race with sendSms(), or a
// transient cost-write failure after provider acceptance. Read-only provider
// reconciliation never retries delivery and never fetches recipients or bodies.
async function backfillWelcomeSmsCosts(db) {
  const { rows } = await db.query(
    `SELECT r.id,r.provider_message_sid,r.welcome_credits,b.welcome_claim_id,
            r.provider_price,r.provider_price_unit,r.provider_num_segments
       FROM sms_notification_recipients r JOIN sms_notification_batches b ON b.id=r.batch_id
      WHERE r.welcome_credits>0 AND r.provider_message_sid IS NOT NULL
        AND (r.welcome_accounted_at IS NULL OR NOT EXISTS (
          SELECT 1 FROM sms_provider_cost_facts f WHERE f.provider_message_sid=r.provider_message_sid))
      ORDER BY r.id LIMIT 100`
  );
  for (const row of rows) {
    // Accounting must be atomic: the recipient marker and durable claim count
    // either both commit or both roll back. Pool callers use a separate client.
    const client = typeof db.connect === 'function' ? await db.connect() : db;
    try {
      await client.query('BEGIN');
      await recordWelcomeSmsCost(client, {
        recipientId: row.id, welcomeClaimId: row.welcome_claim_id,
        welcomeCredits: row.welcome_credits, result: {
          sid: row.provider_message_sid,price: row.provider_price,
          priceUnit: row.provider_price_unit,numSegments: row.provider_num_segments
        }
      });
      await accountWelcomeSmsAccepted(client, row.id);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { if (client !== db) client.release(); }
  }
  return rows.length;
}

async function reconcileWelcomeSmsCosts({ db, fetchBilling, limit = 25 } = {}) {
  if (reconciling) return { checked: 0 };
  const queryable = db || require('../config/db');
  const fetch = fetchBilling || require('./sms').fetchMessageBilling;
  reconciling = true;
  try {
    await backfillWelcomeSmsCosts(queryable);
    const boundedLimit = Math.min(25, Math.max(1, Math.floor(Number(limit) || 25)));
    const { rows } = await queryable.query(
      `SELECT id,provider_message_sid FROM sms_provider_cost_facts
        WHERE provider_message_sid IS NOT NULL
          AND (provider_price IS NULL OR price_unit IS NULL OR provider_segments IS NULL)
          AND (price_checked_at IS NULL OR price_checked_at < NOW()-INTERVAL '10 minutes')
        ORDER BY price_checked_at NULLS FIRST,id LIMIT $1`, [boundedLimit]
    );
    for (const row of rows) {
      // Claim this lookup across workers/restarts before making the API call.
      const claimed = await queryable.query(
        `UPDATE sms_provider_cost_facts SET price_checked_at=NOW()
          WHERE id=$1 AND (price_checked_at IS NULL OR price_checked_at < NOW()-INTERVAL '10 minutes')
          RETURNING id`, [row.id]
      );
      if (!claimed.rows.length) continue;
      try {
        const result = await fetch(row.provider_message_sid);
        const billing = providerBillingFields(result);
        await queryable.query(
          `UPDATE sms_provider_cost_facts SET provider_price=COALESCE($2,provider_price),
             price_unit=COALESCE($3,price_unit),provider_segments=COALESCE($4,provider_segments),
             price_error_code=NULL WHERE id=$1`,
          [row.id,billing.price,billing.priceUnit,billing.numSegments]
        );
        await queryable.query(
          `UPDATE sms_notification_recipients SET provider_price=COALESCE($2,provider_price),
             provider_price_unit=COALESCE($3,provider_price_unit),provider_num_segments=COALESCE($4,provider_num_segments),
             provider_price_checked_at=NOW() WHERE provider_message_sid=$1`,
          [row.provider_message_sid,billing.price,billing.priceUnit,billing.numSegments]
        );
      } catch (error) {
        const safeCode = /^[a-z_]{1,60}$/.test(String(error.code || '')) ? error.code : 'provider_cost_unavailable';
        await queryable.query('UPDATE sms_provider_cost_facts SET price_error_code=$2 WHERE id=$1', [row.id,safeCode]);
      }
    }
    return { checked: rows.length };
  } finally { reconciling = false; }
}

async function getWelcomeSmsCostSummary(db) {
  const row = (await db.query(
    `SELECT COUNT(*) FILTER (WHERE provider_message_sid IS NOT NULL)::int AS accepted_texts,
            COALESCE(SUM(welcome_credits) FILTER (WHERE provider_message_sid IS NOT NULL),0)::int AS welcome_credits_used,
            COUNT(*) FILTER (WHERE provider_price IS NOT NULL AND price_unit='USD')::int AS recorded_texts,
            COUNT(*) FILTER (WHERE provider_message_sid IS NOT NULL AND (provider_price IS NULL OR price_unit IS NULL))::int AS pending_texts,
            COUNT(*) FILTER (WHERE provider_message_sid IS NULL AND acceptance_state IN ('pending','unknown'))::int AS unknown_acceptance_texts,
            COUNT(*) FILTER (WHERE provider_price IS NOT NULL AND price_unit<>'USD')::int AS non_usd_texts,
            SUM(ABS(provider_price)) FILTER (WHERE price_unit='USD') AS recorded_usd_cost,
            SUM(provider_segments) AS provider_segments,MAX(price_checked_at) AS last_checked_at,
            CURRENT_TIMESTAMP AS as_of
       FROM sms_provider_cost_facts`
  )).rows[0] || {};
  return {
    acceptedTexts: Number(row.accepted_texts || 0),
    welcomeCreditsUsed: Number(row.welcome_credits_used || 0),
    recordedTexts: Number(row.recorded_texts || 0),
    pendingTexts: Number(row.pending_texts || 0),
    unknownAcceptanceTexts: Number(row.unknown_acceptance_texts || 0),
    nonUsdTexts: Number(row.non_usd_texts || 0),
    recordedUsdCost: row.recorded_usd_cost == null ? null : Number(row.recorded_usd_cost),
    providerSegments: row.provider_segments == null ? null : Number(row.provider_segments),
    lastCheckedAt: row.last_checked_at || null,
    asOf: row.as_of || null,
    scope: COST_SCOPE
  };
}

module.exports = {
  COST_SCOPE, backfillWelcomeSmsCosts, getWelcomeSmsCostSummary, markWelcomeSmsCostOutcome,
  prepareWelcomeSmsCost, recordWelcomeSmsCost, reconcileWelcomeSmsCosts
};
