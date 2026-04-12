import pool from '../db.js';
import { config } from '../../config.js';

const toPositiveInt = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
};

const FREE_CACHE_INACTIVE_PURGE_DAYS = toPositiveInt(config.FREE_CACHE_INACTIVE_PURGE_DAYS, 15);
const FREE_ACCOUNT_DELETE_INACTIVE_DAYS = toPositiveInt(config.FREE_ACCOUNT_DELETE_INACTIVE_DAYS, 30);
const LAPSED_PAID_CACHE_PURGE_DAYS = toPositiveInt(config.LAPSED_PAID_CACHE_PURGE_DAYS, 30);
const LAPSED_PAID_ACCOUNT_DELETE_DAYS = toPositiveInt(config.LAPSED_PAID_ACCOUNT_DELETE_DAYS, 45);
const INACTIVE_CLEANUP_INTERVAL_MINUTES = toPositiveInt(config.INACTIVE_CLEANUP_INTERVAL_MINUTES, 60);
const INACTIVE_CLEANUP_BATCH_SIZE = toPositiveInt(config.INACTIVE_CLEANUP_BATCH_SIZE, 200);

let cleanupIntervalRef = null;
let isRunning = false;

export async function runInactiveUserCleanupOnce() {
  if (isRunning) return;
  isRunning = true;

  try {
    const purgeFreeCacheResult = await pool.query(
      `DELETE FROM audio_cache_entries e
       USING users u
       WHERE e.scope = 'personal'
         AND e.user_id = u.id
         AND LOWER(COALESCE(u.plan, 'free')) = 'free'
         AND NOT EXISTS (
           SELECT 1 FROM transactions t
           WHERE t.user_id = u.id
             AND LOWER(COALESCE(t.status, '')) = 'completed'
         )
         AND NOT EXISTS (
           SELECT 1 FROM audio_cache_user_state s
           WHERE s.user_id = u.id
             AND s.last_paid_at IS NOT NULL
         )
         AND COALESCE(u.last_seen, u.created_at) < NOW() - ($1::int * INTERVAL '1 day')`,
      [FREE_CACHE_INACTIVE_PURGE_DAYS]
    );

    const purgeLapsedPaidCacheResult = await pool.query(
      `DELETE FROM audio_cache_entries e
       USING users u
       WHERE e.scope = 'personal'
         AND e.user_id = u.id
         AND LOWER(COALESCE(u.plan, 'free')) = 'free'
         AND (
           EXISTS (
             SELECT 1 FROM transactions t
             WHERE t.user_id = u.id
               AND LOWER(COALESCE(t.status, '')) = 'completed'
           )
           OR EXISTS (
             SELECT 1 FROM audio_cache_user_state s
             WHERE s.user_id = u.id
               AND s.last_paid_at IS NOT NULL
           )
         )
         AND COALESCE(u.last_seen, u.created_at) < NOW() - ($1::int * INTERVAL '1 day')`,
      [LAPSED_PAID_CACHE_PURGE_DAYS]
    );

    const freeInactiveUsersResult = await pool.query(
      `SELECT id, email
       FROM users
       WHERE LOWER(COALESCE(plan, 'free')) = 'free'
         AND COALESCE(role, 'user') = 'user'
         AND NOT EXISTS (
           SELECT 1 FROM transactions t
           WHERE t.user_id = users.id
             AND LOWER(COALESCE(t.status, '')) = 'completed'
         )
         AND NOT EXISTS (
           SELECT 1 FROM audio_cache_user_state s
           WHERE s.user_id = users.id
             AND s.last_paid_at IS NOT NULL
         )
       AND COALESCE(last_seen, created_at) < NOW() - ($1::int * INTERVAL '1 day')
       ORDER BY COALESCE(last_seen, created_at) ASC
       LIMIT $2`,
      [FREE_ACCOUNT_DELETE_INACTIVE_DAYS, INACTIVE_CLEANUP_BATCH_SIZE]
    );

    const lapsedPaidInactiveUsersResult = await pool.query(
      `SELECT id, email
       FROM users
       WHERE LOWER(COALESCE(plan, 'free')) = 'free'
         AND COALESCE(role, 'user') = 'user'
         AND (
           EXISTS (
             SELECT 1 FROM transactions t
             WHERE t.user_id = users.id
               AND LOWER(COALESCE(t.status, '')) = 'completed'
           )
           OR EXISTS (
             SELECT 1 FROM audio_cache_user_state s
             WHERE s.user_id = users.id
               AND s.last_paid_at IS NOT NULL
           )
         )
         AND COALESCE(last_seen, created_at) < NOW() - ($1::int * INTERVAL '1 day')
       ORDER BY COALESCE(last_seen, created_at) ASC
       LIMIT $2`,
      [LAPSED_PAID_ACCOUNT_DELETE_DAYS, INACTIVE_CLEANUP_BATCH_SIZE]
    );

    const userIdsToDelete = [
      ...freeInactiveUsersResult.rows.map((row) => Number(row.id)),
      ...lapsedPaidInactiveUsersResult.rows.map((row) => Number(row.id)),
    ].filter((id) => Number.isFinite(id));
    const uniqueUserIdsToDelete = [...new Set(userIdsToDelete)];

    let deletedFreeUsers = 0;
    let deletedLapsedPaidUsers = 0;

    if (uniqueUserIdsToDelete.length > 0) {
      await pool.query('BEGIN');
      try {
        await pool.query('DELETE FROM token_logs WHERE user_id = ANY($1::int[])', [uniqueUserIdsToDelete]);
        await pool.query('DELETE FROM audio_cache_entries WHERE scope = $1 AND user_id = ANY($2::int[])', ['personal', uniqueUserIdsToDelete]);
        await pool.query('DELETE FROM user_voices WHERE user_id = ANY($1::int[])', [uniqueUserIdsToDelete]);
        await pool.query('DELETE FROM user_settings WHERE user_id = ANY($1::int[])', [uniqueUserIdsToDelete]);
        await pool.query('UPDATE coupons SET created_by = NULL WHERE created_by = ANY($1::int[])', [uniqueUserIdsToDelete]);
        await pool.query('UPDATE coupon_audit_log SET changed_by = NULL WHERE changed_by = ANY($1::int[])', [uniqueUserIdsToDelete]);

        const deleted = await pool.query(
          'DELETE FROM users WHERE id = ANY($1::int[])',
          [uniqueUserIdsToDelete]
        );
        const deletedSet = new Set(uniqueUserIdsToDelete);
        deletedFreeUsers = freeInactiveUsersResult.rows
          .map((row) => Number(row.id))
          .filter((id) => deletedSet.has(id))
          .length;
        deletedLapsedPaidUsers = lapsedPaidInactiveUsersResult.rows
          .map((row) => Number(row.id))
          .filter((id) => deletedSet.has(id))
          .length;
        const totalDeleted = Number(deleted.rowCount || 0);
        if (totalDeleted !== deletedSet.size) {
          console.warn(`[InactiveCleanup] requested_delete=${deletedSet.size} actual_deleted=${totalDeleted}`);
        }

        await pool.query('COMMIT');
      } catch (err) {
        await pool.query('ROLLBACK');
        throw err;
      }
    }

    const purgedFree = Number(purgeFreeCacheResult.rowCount || 0);
    const purgedLapsedPaid = Number(purgeLapsedPaidCacheResult.rowCount || 0);

    if (purgedFree > 0 || purgedLapsedPaid > 0 || deletedFreeUsers > 0 || deletedLapsedPaidUsers > 0) {
      console.log(
        `[InactiveCleanup] free_cache_purged=${purgedFree} lapsed_paid_cache_purged=${purgedLapsedPaid} deleted_free_users=${deletedFreeUsers} deleted_lapsed_paid_users=${deletedLapsedPaidUsers}`
      );
    }
  } catch (err) {
    console.error('[InactiveCleanup] Error:', err.message);
  } finally {
    isRunning = false;
  }
}

export function startInactiveUserCleanupJob() {
  if (cleanupIntervalRef) return;

  const intervalMs = Math.max(5, INACTIVE_CLEANUP_INTERVAL_MINUTES) * 60 * 1000;
  cleanupIntervalRef = setInterval(() => {
    runInactiveUserCleanupOnce().catch(() => {});
  }, intervalMs);

  runInactiveUserCleanupOnce().catch(() => {});
  console.log(
    `[InactiveCleanup] started interval=${Math.round(intervalMs / 60000)}min free_cache_purge_days=${FREE_CACHE_INACTIVE_PURGE_DAYS} free_delete_days=${FREE_ACCOUNT_DELETE_INACTIVE_DAYS} lapsed_paid_cache_purge_days=${LAPSED_PAID_CACHE_PURGE_DAYS} lapsed_paid_delete_days=${LAPSED_PAID_ACCOUNT_DELETE_DAYS}`
  );
}

export default {
  startInactiveUserCleanupJob,
  runInactiveUserCleanupOnce,
};
