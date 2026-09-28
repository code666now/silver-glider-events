const HOST_ACCOUNT_INACTIVE = 'host_account_inactive';
const HOST_ACCOUNT_DELETED = 'host_account_deleted';
const HOST_ACCOUNT_SUSPENDED = 'host_account_suspended';

function outboundDeliveryLockKey(userId) {
  return `account-outbound-delivery:${userId}`;
}

async function withActiveHostAccount(pool, organizerId, send) {
  if (!Number.isInteger(Number(organizerId)) || Number(organizerId) <= 0) {
    return { accountStatus: null, allowed: false, result: null, userId: null };
  }
  const client = await pool.connect();
  let lockKey = null;
  let locked = false;
  try {
    const canonicalHost = (await client.query(
      `SELECT user_id FROM organizers WHERE id=$1`,
      [organizerId]
    )).rows[0];
    const userId = Number(canonicalHost?.user_id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return { accountStatus: null, allowed: false, result: null, userId: null };
    }

    lockKey = outboundDeliveryLockKey(userId);
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    locked = true;

    const accountStatus = (await client.query(
      `SELECT canonical_host.account_status
         FROM organizers host
         JOIN users canonical_host ON canonical_host.id=host.user_id
        WHERE host.id=$1 AND host.user_id=$2
        LIMIT 1`,
      [organizerId, userId]
    )).rows[0]?.account_status || null;
    if (accountStatus !== 'active') {
      return { accountStatus, allowed: false, result: null, userId };
    }

    return { accountStatus, allowed: true, result: await send(), userId };
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
      } catch (error) {
        client.release(error);
        throw error;
      }
    }
    client.release();
  }
}

module.exports = {
  HOST_ACCOUNT_DELETED,
  HOST_ACCOUNT_INACTIVE,
  HOST_ACCOUNT_SUSPENDED,
  outboundDeliveryLockKey,
  withActiveHostAccount
};
