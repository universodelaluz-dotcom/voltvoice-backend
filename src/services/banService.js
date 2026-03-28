import pool from '../db.js';

export class BanService {
  // Obtener todos los bans del usuario
  static async getBans(userId) {
    try {
      const result = await pool.query(
        'SELECT id, banned_username, reason, banned_at, banned_by FROM banned_users WHERE user_id = $1 ORDER BY banned_at DESC',
        [userId]
      );
      return result.rows;
    } catch (err) {
      console.error('[BanService] Error in getBans:', err.message);
      throw err;
    }
  }

  // Agregar o actualizar ban
  static async addBan(userId, bannedUsername, bannedBy, reason = null) {
    try {
      const result = await pool.query(
        `INSERT INTO banned_users (user_id, banned_username, banned_by, reason)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, banned_username)
         DO UPDATE SET banned_at = CURRENT_TIMESTAMP, reason = $4
         RETURNING *`,
        [userId, bannedUsername, bannedBy, reason]
      );
      return result.rows[0];
    } catch (err) {
      console.error('[BanService] Error in addBan:', err.message);
      throw err;
    }
  }

  // Remover ban
  static async removeBan(userId, bannedUsername) {
    try {
      const result = await pool.query(
        'DELETE FROM banned_users WHERE user_id = $1 AND banned_username = $2 RETURNING *',
        [userId, bannedUsername]
      );
      return result.rows[0];
    } catch (err) {
      console.error('[BanService] Error in removeBan:', err.message);
      throw err;
    }
  }

  // Verificar si usuario está baneado
  static async isBanned(userId, username) {
    try {
      const result = await pool.query(
        'SELECT id FROM banned_users WHERE user_id = $1 AND banned_username = $2 LIMIT 1',
        [userId, username]
      );
      return result.rows.length > 0;
    } catch (err) {
      console.error('[BanService] Error in isBanned:', err.message);
      throw err;
    }
  }
}

export default BanService;
