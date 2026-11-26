'use strict';

const cron = require('node-cron');
const pool = require('../config/db');
const { createRideMetrics } = require('../lib/transit/ride-metrics');

function startTransitRideMetricsCron() {
  const metrics = createRideMetrics({ db: pool });
  // Privacy expiry is independent of whether either reminder worker runs.
  return cron.schedule('17 * * * *', () => metrics.prune(), { noOverlap: true });
}

module.exports = { startTransitRideMetricsCron };
