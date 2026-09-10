const crypto = require('crypto');

const SMS_CREDIT_PACKS = Object.freeze({
  starter: Object.freeze({ key: 'starter', credits: 300, amountCents: 2000, currency: 'USD' }),
  standard: Object.freeze({ key: 'standard', credits: 1000, amountCents: 5000, currency: 'USD' }),
  pro: Object.freeze({ key: 'pro', credits: 5000, amountCents: 20000, currency: 'USD' })
});

class SmsCreditError extends Error {
  constructor(message, { code = 'sms_credit_error', status = 400 } = {}) {
    super(message);
    this.name = 'SmsCreditError';
    this.code = code;
    this.status = status;
  }
}

function packForKey(value) {
  const key = String(value || '').trim().toLowerCase();
  const pack = SMS_CREDIT_PACKS[key];
  if (!pack) {
    throw new SmsCreditError('Choose a valid SMS credit pack', {
      code: 'invalid_sms_credit_pack', status: 400
    });
  }
  return pack;
}

function publicPacks() {
  return Object.values(SMS_CREDIT_PACKS).map(pack => ({ ...pack }));
}

function featureMode(env = process.env) {
  const mode = String(env.SMS_CREDITS_ENABLED || '').trim().toLowerCase();
  return mode === 'true' || mode === 'admin' ? mode : 'false';
}

function canAccessSmsCredits(organizer, env = process.env) {
  const mode = featureMode(env);
  if (mode === 'false') return false;
  if (mode === 'admin') return Boolean(organizer?.is_admin);
  // Sandbox money must never be presented to ordinary production hosts.
  if (String(env.PAYPAL_ENV || '').trim().toLowerCase() !== 'live') {
    return Boolean(organizer?.is_admin);
  }
  return true;
}

function centsFromPayPal(value) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(value || ''))) {
    throw new SmsCreditError('PayPal returned an invalid payment amount', {
      code: 'invalid_paypal_amount', status: 502
    });
  }
  return Math.round(Number(value) * 100);
}

function completedCapture(order) {
  const units = Array.isArray(order?.purchase_units) ? order.purchase_units : [];
  for (const unit of units) {
    const captures = Array.isArray(unit?.payments?.captures) ? unit.payments.captures : [];
    const capture = captures.find(item => String(item?.status || '').toUpperCase() === 'COMPLETED');
    if (!capture) continue;
    return {
      captureId: String(capture.id || ''),
      orderId: String(order.id || capture?.supplementary_data?.related_ids?.order_id || ''),
      reference: String(unit.custom_id || unit.reference_id || ''),
      amountCents: centsFromPayPal(capture?.amount?.value),
      currency: String(capture?.amount?.currency_code || '').toUpperCase()
    };
  }
  throw new SmsCreditError('PayPal has not completed this payment', {
    code: 'paypal_payment_not_completed', status: 409
  });
}

async function createPendingPurchase(db, organizerId, pack) {
  const reference = `sgsms_${crypto.randomUUID()}`;
  const { rows } = await db.query(
    `INSERT INTO sms_credit_purchases
       (reference,organizer_id,pack_key,credits,amount_cents,currency)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [reference, organizerId, pack.key, pack.credits, pack.amountCents, pack.currency]
  );
  return rows[0];
}

async function attachProviderOrder(db, purchaseId, organizerId, orderId) {
  const { rows } = await db.query(
    `UPDATE sms_credit_purchases
        SET provider_order_id=$3,updated_at=NOW(),failure_code=NULL
      WHERE id=$1 AND organizer_id=$2 AND status='pending'
      RETURNING *`,
    [purchaseId, organizerId, orderId]
  );
  if (!rows.length) {
    throw new SmsCreditError('This SMS credit purchase is no longer available', {
      code: 'sms_credit_purchase_unavailable', status: 409
    });
  }
  return rows[0];
}

async function markPurchaseFailed(db, purchaseId, code) {
  await db.query(
    `UPDATE sms_credit_purchases
        SET status='failed',failure_code=$2,updated_at=NOW()
      WHERE id=$1 AND status='pending'`,
    [purchaseId, String(code || 'paypal_error').slice(0, 100)]
  );
}

async function purchaseForOrganizerOrder(db, organizerId, orderId) {
  const { rows } = await db.query(
    `SELECT * FROM sms_credit_purchases
      WHERE organizer_id=$1 AND provider='paypal' AND provider_order_id=$2`,
    [organizerId, orderId]
  );
  if (!rows.length) {
    throw new SmsCreditError('PayPal order does not belong to this host', {
      code: 'sms_credit_purchase_not_found', status: 404
    });
  }
  return rows[0];
}

async function completePurchase(db, capture) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM sms_credit_purchases
        WHERE provider='paypal' AND provider_order_id=$1 FOR UPDATE`,
      [capture.orderId]
    );
    const purchase = rows[0];
    if (!purchase) {
      throw new SmsCreditError('SMS credit purchase was not found', {
        code: 'sms_credit_purchase_not_found', status: 404
      });
    }
    if (purchase.status === 'completed' || purchase.status === 'partially_refunded' || purchase.status === 'refunded' || purchase.status === 'reversed') {
      if (purchase.provider_capture_id !== capture.captureId) {
        throw new SmsCreditError('PayPal capture does not match this purchase', {
          code: 'sms_credit_capture_conflict', status: 409
        });
      }
      const balance = Number((await client.query(
        'SELECT sms_credits FROM organizers WHERE id=$1', [purchase.organizer_id]
      )).rows[0]?.sms_credits || 0);
      await client.query('COMMIT');
      return { purchase, balance, duplicate: true };
    }
    if (purchase.reference !== capture.reference ||
        Number(purchase.amount_cents) !== Number(capture.amountCents) ||
        purchase.currency !== capture.currency) {
      throw new SmsCreditError('PayPal payment does not match the selected credit pack', {
        code: 'sms_credit_payment_mismatch', status: 409
      });
    }

    const balance = Number((await client.query(
      `UPDATE organizers SET sms_credits=COALESCE(sms_credits,0)+$2,updated_at=NOW()
        WHERE id=$1 RETURNING sms_credits`,
      [purchase.organizer_id, purchase.credits]
    )).rows[0].sms_credits);
    await client.query(
      `INSERT INTO sms_credit_transactions
         (organizer_id,purchase_id,kind,credits_delta,balance_after,amount_cents_delta,
          currency,provider,provider_transaction_id,external_key,metadata)
       VALUES ($1,$2,'purchase',$3,$4,$5,$6,'paypal',$7,$8,$9::jsonb)`,
      [
        purchase.organizer_id, purchase.id, purchase.credits, balance,
        purchase.amount_cents, purchase.currency, capture.captureId,
        `paypal:capture:${capture.captureId}`,
        JSON.stringify({ packKey: purchase.pack_key, orderId: capture.orderId })
      ]
    );
    const updated = (await client.query(
      `UPDATE sms_credit_purchases
          SET provider_capture_id=$2,status='completed',completed_at=COALESCE(completed_at,NOW()),
              updated_at=NOW(),failure_code=NULL
        WHERE id=$1 RETURNING *`,
      [purchase.id, capture.captureId]
    )).rows[0];
    await client.query('COMMIT');
    return { purchase: updated, balance, duplicate: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function applyPurchaseAdjustment(db, {
  captureId, providerTransactionId, amountCents, reversed = false
}) {
  const externalKey = `paypal:${reversed ? 'reversal' : 'refund'}:${providerTransactionId}`;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT id FROM sms_credit_transactions WHERE external_key=$1', [externalKey]
    );
    if (existing.rows.length) {
      await client.query('COMMIT');
      return { duplicate: true };
    }
    const { rows } = await client.query(
      `SELECT * FROM sms_credit_purchases
        WHERE provider='paypal' AND provider_capture_id=$1 FOR UPDATE`,
      [captureId]
    );
    const purchase = rows[0];
    if (!purchase) {
      throw new SmsCreditError('Original SMS credit purchase was not found', {
        code: 'sms_credit_purchase_not_found', status: 404
      });
    }
    const requestedAdjustmentCents = reversed
      ? Math.max(0, Number(purchase.amount_cents) - Number(purchase.refunded_cents))
      : Math.max(0, Number(amountCents) || 0);
    const totalRefundedCents = Math.min(
      Number(purchase.amount_cents),
      Number(purchase.refunded_cents) + requestedAdjustmentCents
    );
    const adjustmentCents = totalRefundedCents - Number(purchase.refunded_cents);
    const targetRefundedCredits = reversed
      ? Number(purchase.credits)
      : Math.floor(Number(purchase.credits) * totalRefundedCents / Number(purchase.amount_cents));
    const creditsToRemove = Math.max(0, targetRefundedCredits - Number(purchase.refunded_credits));
    let balance = Number((await client.query(
      'SELECT sms_credits FROM organizers WHERE id=$1 FOR UPDATE', [purchase.organizer_id]
    )).rows[0]?.sms_credits || 0);
    if (creditsToRemove > 0) {
      balance = Number((await client.query(
        `UPDATE organizers SET sms_credits=COALESCE(sms_credits,0)-$2,updated_at=NOW()
          WHERE id=$1 RETURNING sms_credits`,
        [purchase.organizer_id, creditsToRemove]
      )).rows[0].sms_credits);
    }
    if (creditsToRemove > 0 || adjustmentCents > 0) {
      await client.query(
        `INSERT INTO sms_credit_transactions
           (organizer_id,purchase_id,kind,credits_delta,balance_after,amount_cents_delta,
            currency,provider,provider_transaction_id,external_key,metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'paypal',$8,$9,$10::jsonb)`,
        [
          purchase.organizer_id, purchase.id, reversed ? 'reversal' : 'refund',
          -creditsToRemove, balance, -adjustmentCents, purchase.currency,
          providerTransactionId, externalKey,
          JSON.stringify({ captureId, totalRefundedCents })
        ]
      );
    }
    const status = reversed
      ? 'reversed'
      : (totalRefundedCents >= Number(purchase.amount_cents) ? 'refunded' : 'partially_refunded');
    await client.query(
      `UPDATE sms_credit_purchases
          SET status=$2,refunded_cents=$3,refunded_credits=$4,updated_at=NOW()
        WHERE id=$1`,
      [purchase.id, status, totalRefundedCents, targetRefundedCredits]
    );
    await client.query('COMMIT');
    return { duplicate: false, balance, creditsRemoved: creditsToRemove, status };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function creditSummary(db, organizerId, { limit = 20 } = {}) {
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 20));
  const [account, transactions] = await Promise.all([
    db.query('SELECT sms_credits FROM organizers WHERE id=$1', [organizerId]),
    db.query(
      `SELECT id,kind,credits_delta,balance_after,amount_cents_delta,currency,created_at,
              metadata->>'packKey' AS pack_key
         FROM sms_credit_transactions
        WHERE organizer_id=$1
        ORDER BY created_at DESC,id DESC LIMIT $2`,
      [organizerId, safeLimit]
    )
  ]);
  return {
    balance: Number(account.rows[0]?.sms_credits || 0),
    transactions: transactions.rows.map(row => ({
      id: String(row.id),
      kind: row.kind,
      creditsDelta: Number(row.credits_delta),
      balanceAfter: Number(row.balance_after),
      amountCentsDelta: row.amount_cents_delta == null ? null : Number(row.amount_cents_delta),
      currency: row.currency || null,
      packKey: row.pack_key || null,
      createdAt: row.created_at
    }))
  };
}

async function reserveSendCredits(client, { organizerId, batchId, credits, metadata = {} }) {
  const amount = Number(credits);
  if (!Number.isInteger(amount) || amount < 1) {
    throw new SmsCreditError('SMS credit cost is invalid', { code: 'invalid_sms_credit_cost', status: 400 });
  }
  const { rows } = await client.query(
    `UPDATE organizers
        SET sms_credits=sms_credits-$2,updated_at=NOW()
      WHERE id=$1 AND sms_credits >= $2
      RETURNING sms_credits`,
    [organizerId, amount]
  );
  if (!rows.length) {
    throw new SmsCreditError('Buy more SMS credits before sending this text', {
      code: 'insufficient_sms_credits', status: 402
    });
  }
  const balance = Number(rows[0].sms_credits);
  await client.query(
    `INSERT INTO sms_credit_transactions
       (organizer_id,kind,credits_delta,balance_after,external_key,metadata)
     VALUES ($1,'send',$2,$3,$4,$5::jsonb)`,
    [organizerId, -amount, balance, `sms:batch:${batchId}:send`, JSON.stringify(metadata)]
  );
  return balance;
}

async function refundSendCredits(client, { organizerId, batchId, credits, metadata = {} }) {
  const amount = Number(credits);
  if (!Number.isInteger(amount) || amount < 1) return null;
  const externalKey = `sms:batch:${batchId}:refund`;
  const existing = await client.query(
    'SELECT balance_after FROM sms_credit_transactions WHERE external_key=$1', [externalKey]
  );
  if (existing.rows.length) return Number(existing.rows[0].balance_after);
  const balance = Number((await client.query(
    `UPDATE organizers SET sms_credits=sms_credits+$2,updated_at=NOW()
      WHERE id=$1 RETURNING sms_credits`,
    [organizerId, amount]
  )).rows[0].sms_credits);
  await client.query(
    `INSERT INTO sms_credit_transactions
       (organizer_id,kind,credits_delta,balance_after,external_key,metadata)
     VALUES ($1,'adjustment',$2,$3,$4,$5::jsonb)`,
    [organizerId, amount, balance, externalKey, JSON.stringify(metadata)]
  );
  return balance;
}

module.exports = {
  SMS_CREDIT_PACKS,
  SmsCreditError,
  applyPurchaseAdjustment,
  attachProviderOrder,
  canAccessSmsCredits,
  centsFromPayPal,
  completedCapture,
  completePurchase,
  createPendingPurchase,
  creditSummary,
  featureMode,
  markPurchaseFailed,
  packForKey,
  publicPacks,
  purchaseForOrganizerOrder,
  reserveSendCredits,
  refundSendCredits
};
