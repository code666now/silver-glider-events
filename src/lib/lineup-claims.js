const { createSignInChallenge } = require('./sign-in-challenges');
const { sendLineupClaim } = require('./mailer');
const { cleanArtistEmail } = require('./event-editor');

const SLOTS = [1, 2, 3];
const suffix = slot => (slot === 1 ? '' : `_${slot}`);
const artistNameFor = (event, slot) => String(event?.[`event_vibe_label${suffix(slot)}`] || '').trim();
const requestedEmailFor = (body, slot) => cleanArtistEmail(body?.[`event_vibe_email${suffix(slot)}`]);

// Keeps event_artist_claims in step with the Event Vibe slots on one event, and
// reports which artists should be emailed an invitation to claim their slot.
// Claimed slots are never re-emailed or re-pointed by an edit; a slot whose
// artist name is removed loses its claim row entirely.
async function syncLineupClaims(client, { event, body }) {
  if (!event?.id) return [];
  const { rows: existing } = await client.query(
    'SELECT id, slot, artist_name, email, status FROM event_artist_claims WHERE event_id=$1',
    [event.id]
  );
  const bySlot = new Map(existing.map(row => [Number(row.slot), row]));
  const invites = [];

  for (const slot of SLOTS) {
    const name = artistNameFor(event, slot);
    const current = bySlot.get(slot);

    if (!name) {
      if (current) await client.query('DELETE FROM event_artist_claims WHERE id=$1', [current.id]);
      continue;
    }

    // Only a body that actually carries the field can change the email, so a
    // partial save (say, a date change) never clears an invitation.
    const carriesEmail = body && Object.prototype.hasOwnProperty.call(body, `event_vibe_email${suffix(slot)}`);
    const email = carriesEmail ? requestedEmailFor(body, slot) : current?.email || null;

    if (current?.status === 'claimed') {
      if (current.artist_name !== name) {
        await client.query(
          'UPDATE event_artist_claims SET artist_name=$2, updated_at=NOW() WHERE id=$1',
          [current.id, name]
        );
      }
      continue;
    }

    if (!email) {
      if (current && carriesEmail) await client.query('DELETE FROM event_artist_claims WHERE id=$1', [current.id]);
      continue;
    }

    if (current && current.email === email) {
      if (current.artist_name !== name) {
        await client.query(
          'UPDATE event_artist_claims SET artist_name=$2, updated_at=NOW() WHERE id=$1',
          [current.id, name]
        );
      }
      continue;
    }

    // A new address (or a first one) starts a fresh invitation for that slot.
    const { rows } = current
      ? await client.query(
        `UPDATE event_artist_claims
            SET artist_name=$2, email=$3, status='invited', organizer_id=NULL,
                invited_at=NOW(), claimed_at=NULL, declined_at=NULL, updated_at=NOW()
          WHERE id=$1 RETURNING id`,
        [current.id, name, email]
      )
      : await client.query(
        `INSERT INTO event_artist_claims (event_id, slot, artist_name, email)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [event.id, slot, name, email]
      );
    invites.push({ claimId: rows[0].id, email, artistName: name });
  }

  return invites;
}

// Sent after the event's transaction commits: one email per artist per slot,
// only to an address the host typed. The link signs the artist in and lands on
// the claim screen for that slot.
async function deliverLineupClaimInvites(db, { event, hostLabel, invites }) {
  for (const invite of invites) {
    try {
      const challenge = await createSignInChallenge(db, {
        email: invite.email,
        intent: 'sign_in',
        returnPath: `/lineup/${invite.claimId}`,
        withCode: false,
        ttlMinutes: 60 * 24 * 14
      });
      const link = `${String(process.env.APP_URL || '').replace(/\/$/, '')}/auth/verify?token=${challenge.token}`;
      await sendLineupClaim({
        to: invite.email,
        event,
        artistName: invite.artistName,
        hostLabel: hostLabel || 'A host',
        link
      });
    } catch (error) {
      console.error('[lineup] claim invite failed', { claimId: invite.claimId, error: error.message });
    }
  }
}

// Slots the public page must hide: the artist said "not me".
async function declinedLineupSlots(db, eventId) {
  const { rows } = await db.query(
    `SELECT slot FROM event_artist_claims WHERE event_id=$1 AND status='declined'`,
    [eventId]
  );
  return new Set(rows.map(row => Number(row.slot)));
}

module.exports = { SLOTS, syncLineupClaims, deliverLineupClaimInvites, declinedLineupSlots, artistNameFor };
