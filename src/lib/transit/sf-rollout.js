'use strict';

const pool = require('../../config/db');

function sfRolloutBlockReason(env = process.env) {
  if (env.TRANSIT_GETTING_HOME_ENABLED !== 'true') return 'Getting Home is disabled for this service.';
  if (env.TRANSIT_SF_GETTING_HOME_ENABLED !== 'true') return 'The Railway safety gate is off. Complete the feed and walking checks before enabling it.';
  if (!(env.TRANSIT_511_API_KEY || env['511_API_TOKEN'])?.trim()) return 'The 511 schedule feed is not configured.';
  if (!env.GEOAPIFY_API_KEY?.trim()) return 'The walking provider is not configured.';
  return null;
}

function rolloutState(row, env) {
  const reason = sfRolloutBlockReason(env) || (!row ? 'The Transportation settings are not ready.' : null);
  const requested = row?.enabled === true;
  return { enabled: requested && !reason, allowed: !reason, reason, requested, updatedAt: row?.updated_at || null };
}

async function readSfRollout({ db = pool, env = process.env } = {}) {
  const { rows } = await db.query('SELECT enabled, updated_at FROM transit_sf_rollout WHERE singleton');
  return rolloutState(rows[0], env);
}

// Public planner and worker fail shut on a settings read failure. Never let
// an analytics/admin database problem expose a citywide plan or stop RSVP.
async function isSfRolloutEnabled({ db = pool, env = process.env } = {}) {
  if (sfRolloutBlockReason(env)) return false;
  try { return (await readSfRollout({ db, env })).enabled; }
  catch { return false; }
}

const denied = statusCode => Object.assign(new Error('Transportation setting not changed'), { statusCode });

async function writeSfRollout({ db = pool, env = process.env, enabled, operatorId } = {}) {
  if (!Number.isSafeInteger(operatorId) || operatorId <= 0 || typeof enabled !== 'boolean') throw denied(403);
  if (enabled && sfRolloutBlockReason(env)) throw denied(409);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [operator] } = await client.query(`SELECT id FROM admin_operators
      WHERE id=$1 AND role='super_admin' AND status='active' FOR SHARE`, [operatorId]);
    if (!operator) throw denied(403);
    const { rows: [before] } = await client.query('SELECT enabled, updated_at FROM transit_sf_rollout WHERE singleton FOR UPDATE');
    if (!before) throw denied(409);
    let current = before;
    if (before.enabled !== enabled) {
      const { rows } = await client.query(`UPDATE transit_sf_rollout
        SET enabled=$1, updated_at=NOW(), updated_by_admin_operator_id=$2 WHERE singleton
        RETURNING enabled, updated_at`, [enabled, operator.id]);
      current = rows[0];
      await client.query(`INSERT INTO admin_account_audit_log
        (actor_admin_operator_id,action_type,reason,before_state,after_state)
        VALUES ($1,'transportation_sf_rollout_changed','Updated the public San Francisco Getting Home rollout',$2::jsonb,$3::jsonb)`,
      [operator.id, JSON.stringify({ enabled: before.enabled }), JSON.stringify({ enabled })]);
    }
    await client.query('COMMIT');
    return rolloutState(current, env);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

module.exports = { readSfRollout, isSfRolloutEnabled, sfRolloutBlockReason, writeSfRollout };
