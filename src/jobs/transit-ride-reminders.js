'use strict';

const cron = require('node-cron');
const pool = require('../config/db');
const { create511ScheduleSource } = require('../lib/transit/gtfs-feed');
const { createMakeOutRoomTransit, selectPilotStopTimes } = require('../lib/transit');
const { createGettingHome, gettingHomeEnabled } = require('../lib/transit/getting-home');
const { createRideReminders } = require('../lib/transit/ride-reminders');

// Sending never relies on the UI's half-day cache. A new current snapshot is
// required every five minutes when reminders are due (shared within a pass).
const workerHome = createGettingHome({ transit: createMakeOutRoomTransit({
  source: create511ScheduleSource({ selectStopTime: selectPilotStopTimes, ttlMs: 5 * 60_000 })
}) });
const rideReminders = createRideReminders({ pool, getDeparture: workerHome.getDeparture });

function startTransitRideReminderCron() {
  if (!gettingHomeEnabled() || process.env.TRANSIT_RIDE_REMINDERS_ENABLED !== 'true') return null;
  return cron.schedule('* * * * *', async () => {
    try { await rideReminders.processDue(); }
    catch { console.error('[transit-reminders] failed to process due reminders'); }
  }, { noOverlap: true });
}

module.exports = { startTransitRideReminderCron, rideReminders };
