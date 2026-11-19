function automaticFollowerEmailEnabled() {
  return process.env.AUTO_FOLLOWER_EMAIL_ENABLED === 'true';
}

async function allowAutomaticFollowerEmailForPublication(client) {
  // A transaction-local grant prevents a rolling old worker, an admin
  // handoff, or a migration from enrolling events without the host controls.
  if (automaticFollowerEmailEnabled()) {
    await client.query("SELECT set_config('sge.auto_follower_email', 'on', true)");
  }
}

module.exports = { automaticFollowerEmailEnabled, allowAutomaticFollowerEmailForPublication };
