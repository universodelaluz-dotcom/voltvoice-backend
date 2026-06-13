import pool from '../db.js';

const VALID_PLATFORMS = new Set(['tiktok', 'youtube']);
const normalizePlatform = (p) => VALID_PLATFORMS.has(String(p || '').toLowerCase()) ? String(p).toLowerCase() : 'tiktok';

export class NickService {
  // Obtener todos los overrides del usuario para una plataforma
  static async getNickOverrides(userId, platform = 'tiktok') {
    const p = normalizePlatform(platform);
    try {
      const result = await pool.query(
        'SELECT original_username, new_nickname FROM nick_overrides WHERE user_id = $1 AND platform = $2 ORDER BY created_at DESC',
        [userId, p]
      );
      const nickMap = {};
      result.rows.forEach(row => { nickMap[row.original_username] = row.new_nickname; });
      return nickMap;
    } catch (err) {
      // Si la columna platform todavía no existe (migración en curso), fallback a query sin plataforma
      if (String(err.message || '').includes('platform')) {
        console.warn('[NickService] platform column missing, falling back to unfiltered query');
        try {
          const result = await pool.query(
            'SELECT original_username, new_nickname FROM nick_overrides WHERE user_id = $1 ORDER BY created_at DESC',
            [userId]
          );
          const nickMap = {};
          result.rows.forEach(row => { nickMap[row.original_username] = row.new_nickname; });
          return nickMap;
        } catch (fallbackErr) {
          console.error('[NickService] Fallback query also failed:', fallbackErr.message);
          return {};
        }
      }
      console.error('[NickService] Error in getNickOverrides:', err.message);
      return {};
    }
  }

  // Crear o actualizar nick override
  static async setNickOverride(userId, originalUsername, newNickname, platform = 'tiktok') {
    try {
      if (!originalUsername || !originalUsername.trim()) {
        throw new Error('originalUsername cannot be empty');
      }
      if (!newNickname || !newNickname.trim()) {
        throw new Error('newNickname cannot be empty');
      }

      const p = normalizePlatform(platform);
      const result = await pool.query(
        `INSERT INTO nick_overrides (user_id, original_username, new_nickname, platform)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, platform, original_username)
         DO UPDATE SET new_nickname = $3, updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [userId, originalUsername.trim(), newNickname.trim(), p]
      );
      return result.rows[0];
    } catch (err) {
      console.error('[NickService] Error in setNickOverride:', err.message);
      throw err;
    }
  }

  // Remover nick override
  static async removeNickOverride(userId, originalUsername, platform = 'tiktok') {
    try {
      const p = normalizePlatform(platform);
      const result = await pool.query(
        'DELETE FROM nick_overrides WHERE user_id = $1 AND original_username = $2 AND platform = $3 RETURNING *',
        [userId, originalUsername, p]
      );
      return result.rows[0];
    } catch (err) {
      console.error('[NickService] Error in removeNickOverride:', err.message);
      throw err;
    }
  }

  // Obtener nickname para un usuario (override o original)
  static async getNickname(userId, originalUsername, platform = 'tiktok') {
    try {
      const p = normalizePlatform(platform);
      const result = await pool.query(
        'SELECT new_nickname FROM nick_overrides WHERE user_id = $1 AND original_username = $2 AND platform = $3 LIMIT 1',
        [userId, originalUsername, p]
      );

      if (result.rows.length > 0) {
        return result.rows[0].new_nickname;
      }

      return originalUsername;
    } catch (err) {
      console.error('[NickService] Error in getNickname:', err.message);
      throw err;
    }
  }
}

export default NickService;
