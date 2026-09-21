const cron = require('node-cron');
const pool = require('../config/db');
const { configured, deleteManagedPublicId, managedPublicIdFromUrl } = require('../lib/cloudinary');

let running = false;
const backgroundWork = new Set();

async function publicIdStillReferenced(publicId) {
  const photoReference = await pool.query(
    'SELECT 1 FROM event_photos WHERE cloudinary_id=$1 LIMIT 1',
    [publicId]
  );
  if (photoReference.rows.length) return true;
  const [organizerMedia, eventMedia] = await Promise.all([
    pool.query(
      `SELECT avatar_url,logo_url,header_image_url
         FROM organizers
        WHERE avatar_url IS NOT NULL OR logo_url IS NOT NULL OR header_image_url IS NOT NULL`
    ),
    pool.query(
      `SELECT cover_image_url,flyer_image_url,event_vibe_image_url,
              event_vibe_image_url_2,event_vibe_image_url_3
         FROM events
        WHERE cover_image_url IS NOT NULL OR flyer_image_url IS NOT NULL
           OR event_vibe_image_url IS NOT NULL OR event_vibe_image_url_2 IS NOT NULL
           OR event_vibe_image_url_3 IS NOT NULL`
    )
  ]);
  const urls = [
    ...organizerMedia.rows.flatMap(row => [row.avatar_url, row.logo_url, row.header_image_url]),
    ...eventMedia.rows.flatMap(row => [
      row.cover_image_url,
      row.flyer_image_url,
      row.event_vibe_image_url,
      row.event_vibe_image_url_2,
      row.event_vibe_image_url_3
    ])
  ];
  return urls.some(url => managedPublicIdFromUrl(url) === publicId);
}

async function processManagedMediaDeletionJob(jobId) {
  if (!configured) throw new Error('Managed media deletion is not configured');
  const { rows } = await pool.query(
    `UPDATE managed_media_deletion_jobs
        SET status='processing',attempt_count=attempt_count+1,
            last_attempt_at=NOW(),updated_at=NOW(),last_error=NULL
      WHERE id=$1
        AND status IN ('pending','processing')
        AND next_attempt_at<=NOW()
        AND (status='pending' OR last_attempt_at<NOW() - INTERVAL '5 minutes')
      RETURNING id,public_id,attempt_count`,
    [jobId]
  );
  const job = rows[0];
  if (!job) return null;
  try {
    if (await publicIdStillReferenced(job.public_id)) {
      await pool.query(
        `UPDATE managed_media_deletion_jobs
            SET status='completed',completed_at=NOW(),updated_at=NOW(),
                last_error='Skipped because the managed asset is still referenced'
          WHERE id=$1 AND status='processing' AND attempt_count=$2`,
        [job.id, job.attempt_count]
      );
      return { id: Number(job.id), status: 'completed', skipped: true };
    }
    const deleted = await deleteManagedPublicId(job.public_id);
    if (!deleted) throw new Error('Managed media public ID is not eligible for deletion');
    await pool.query(
      `UPDATE managed_media_deletion_jobs
          SET status='completed',completed_at=NOW(),updated_at=NOW(),last_error=NULL
        WHERE id=$1 AND status='processing' AND attempt_count=$2`,
      [job.id, job.attempt_count]
    );
    return { id: Number(job.id), status: 'completed' };
  } catch (error) {
    await pool.query(
      `UPDATE managed_media_deletion_jobs
          SET status='pending',next_attempt_at=NOW() + INTERVAL '10 minutes',
              updated_at=NOW(),last_error=$2
        WHERE id=$1 AND status='processing' AND attempt_count=$3`,
      [job.id, String(error.message || 'Managed media deletion failed').slice(0, 500), job.attempt_count]
    );
    throw error;
  }
}

function queueManagedMediaDeletionJobs(jobIds) {
  if (!configured) return;
  for (const jobId of [...new Set((jobIds || []).map(Number).filter(Number.isInteger))]) {
    const work = new Promise(resolve => setImmediate(resolve))
      .then(() => processManagedMediaDeletionJob(jobId))
      .catch(error => {
        console.error(`[managed-media-deletions] job ${jobId} failed:`, error.message);
      });
    backgroundWork.add(work);
    work.finally(() => backgroundWork.delete(work));
  }
}

async function settleManagedMediaDeletionWork() {
  while (backgroundWork.size) await Promise.allSettled([...backgroundWork]);
}

async function runManagedMediaDeletionPass() {
  if (running || !configured) return;
  running = true;
  try {
    const { rows } = await pool.query(
      `SELECT id
         FROM managed_media_deletion_jobs
        WHERE status IN ('pending','processing')
          AND next_attempt_at<=NOW()
          AND (status='pending' OR last_attempt_at<NOW() - INTERVAL '5 minutes')
        ORDER BY id
        LIMIT 25`
    );
    for (const row of rows) await processManagedMediaDeletionJob(row.id);
  } catch (error) {
    console.error('[managed-media-deletions] retry pass failed:', error.message);
  } finally {
    running = false;
  }
}

function startManagedMediaDeletionCron() {
  cron.schedule('* * * * *', () => runManagedMediaDeletionPass());
  const initial = setTimeout(() => runManagedMediaDeletionPass(), 1800);
  initial.unref?.();
  console.log('[managed-media-deletions] minute retry cron scheduled');
}

module.exports = {
  publicIdStillReferenced,
  processManagedMediaDeletionJob,
  queueManagedMediaDeletionJobs,
  runManagedMediaDeletionPass,
  settleManagedMediaDeletionWork,
  startManagedMediaDeletionCron
};
