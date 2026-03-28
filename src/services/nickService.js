import pool from '../db.js';

export class NickService {
  // Obtener todos los overrides del usuario
  static async getNickOverrides(userId) {
    try {
      const result = await pool.query(
        'SELECT original_username, new_nickname FROM nick_overrides WHERE user_id = $1 ORDER BY created_at DESC',
        [userId]
      );

      // Convertir array de {original, new} a objeto {original: new}
      const nickMap = {};
      result.rows.forEach(row => {
        nickMap[row.original_username] = row.new_nickname;
      });

      return nickMap;
    } catch (err) {
      console.error('[NickService] Error in getNickOverrides:', err.message);
      throw err;
    }
  }

  // Crear o actualizar nick override
  static async setNickOverride(userId, originalUsername, newNickname) {
    try {
      if (!originalUsername || !originalUsername.trim()) {
        throw new Error('originalUsername cannot be empty');
      }
      if (!newNickname || !newNickname.trim()) {
        throw new Error('newNickname cannot be empty');
      }

      const result = await pool.query(
        `INSERT INTO nick_overrides (user_id, original_username, new_nickname)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, original_username)
         DO UPDATE SET new_nickname = $3, updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [userId, originalUsername.trim(), newNickname.trim()]
      );
      return result.rows[0];
    } catch (err) {
      console.error('[NickService] Error in setNickOverride:', err.message);
      throw err;
    }
  }

  // Remover nick override
  static async removeNickOverride(userId, originalUsername) {
    try {
      const result = await pool.query(
        'DELETE FROM nick_overrides WHERE user_id = $1 AND original_username = $2 RETURNING *',
        [userId, originalUsername]
      );
      return result.rows[0];
    } catch (err) {
      console.error('[NickService] Error in removeNickOverride:', err.message);
      throw err;
    }
  }

  // Obtener nickname para un usuario (override o original)
  static async getNickname(userId, originalUsername) {
    try {
      const result = await pool.query(
        'SELECT new_nickname FROM nick_overrides WHERE user_id = $1 AND original_username = $2 LIMIT 1',
        [userId, originalUsername]
      );

      if (result.rows.length > 0) {
        return result.rows[0].new_nickname;
      }

      return originalUsername; // Retornar original si no hay override
    } catch (err) {
      console.error('[NickService] Error in getNickname:', err.message);
      throw err;
    }
  }
}

export default NickService;
