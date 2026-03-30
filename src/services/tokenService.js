// Token Service - Gestiona tokens y créditos de usuarios

import db from '../db.js'; // conexión a PostgreSQL

class TokenService {
  // Obtener tokens de un usuario
  async getUserTokens(userId) {
    const query = 'SELECT tokens FROM users WHERE id = $1';
    const result = await db.query(query, [userId]);
    return result.rows[0]?.tokens || 0;
  }

  // Calcular tokens necesarios basado en caracteres
  calculateTokensCost(characterCount) {
    // 1 token = 100 caracteres (ajustable)
    return Math.ceil(characterCount / 100);
  }

  // Verificar si usuario tiene suficientes tokens
  async hasEnoughTokens(userId, tokensNeeded) {
    const currentTokens = await this.getUserTokens(userId);
    return currentTokens >= tokensNeeded;
  }

  // Restar tokens después de usar síntesis de voz
  async deductTokens(userId, tokensToDeduct, characterCount, voiceName, action = 'synthesis') {
    try {
      // Actualizar tokens en usuario
      const updateQuery = 'UPDATE users SET tokens = tokens - $1 WHERE id = $2 RETURNING tokens';
      const result = await db.query(updateQuery, [tokensToDeduct, userId]);

      // Registrar en log
      const logQuery = `
        INSERT INTO token_logs (user_id, action, tokens_used, characters_count, voice_name)
        VALUES ($1, $2, $3, $4, $5)
      `;
      await db.query(logQuery, [userId, action, tokensToDeduct, characterCount, voiceName]);

      return {
        success: true,
        remainingTokens: result.rows[0]?.tokens || 0,
        tokensUsed: tokensToDeduct
      };
    } catch (error) {
      console.error('Error deducting tokens:', error);
      throw error;
    }
  }

  // Agregar tokens (compra o bonus)
  async addTokens(userId, tokensToAdd, reason = 'purchase') {
    try {
      const updateQuery = 'UPDATE users SET tokens = tokens + $1 WHERE id = $2 RETURNING tokens';
      const result = await db.query(updateQuery, [tokensToAdd, userId]);

      // Registrar en log
      const logQuery = `
        INSERT INTO token_logs (user_id, action, tokens_used)
        VALUES ($1, $2, $3)
      `;
      await db.query(logQuery, [userId, `added_${reason}`, -tokensToAdd]); // negativo = suma

      return {
        success: true,
        newTokens: result.rows[0]?.tokens || 0,
        tokensAdded: tokensToAdd
      };
    } catch (error) {
      console.error('Error adding tokens:', error);
      throw error;
    }
  }

  // Obtener historial de uso de tokens
  async getTokenHistory(userId, limit = 50) {
    const query = `
      SELECT * FROM token_logs
      WHERE user_id = $1
      ORDER BY timestamp DESC
      LIMIT $2
    `;
    const result = await db.query(query, [userId, limit]);
    return result.rows;
  }

  // Obtener estadísticas de tokens
  async getTokenStats(userId) {
    const query = `
      SELECT
        u.tokens as current_tokens,
        u.plan,
        COUNT(tl.id) as total_syntheses,
        SUM(CASE WHEN tl.action = 'synthesis' THEN tl.tokens_used ELSE 0 END) as total_used,
        SUM(CASE WHEN tl.action LIKE 'added_%' THEN ABS(tl.tokens_used) ELSE 0 END) as total_purchased
      FROM users u
      LEFT JOIN token_logs tl ON u.id = tl.user_id
      WHERE u.id = $1
      GROUP BY u.id, u.tokens, u.plan
    `;
    const result = await db.query(query, [userId]);
    return result.rows[0] || {};
  }

  // Actualizar plan del usuario
  async updateUserPlan(userId, newPlan) {
    const planTokens = {
      'free': 100,
      'pro': 1000,
      'premium': 5000
    };

    const tokensToAdd = planTokens[newPlan] || 0;
    const query = 'UPDATE users SET plan = $1, tokens = $2 WHERE id = $3 RETURNING *';
    const result = await db.query(query, [newPlan, tokensToAdd, userId]);
    return result.rows[0];
  }
}

export default new TokenService();
