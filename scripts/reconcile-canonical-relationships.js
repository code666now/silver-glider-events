require('dotenv').config();
const pool = require('../src/config/db');
const {
  canonicalRelationshipReport,
  relationshipReportHasDrift
} = require('../src/lib/canonical-relationships');

async function main() {
  const report = await canonicalRelationshipReport(pool);
  console.log(JSON.stringify({
    ok: !relationshipReportHasDrift(report),
    report
  }, null, 2));
  if (relationshipReportHasDrift(report)) process.exitCode = 1;
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
