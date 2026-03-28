import express from 'express';
import db from '../db.js';
import { verifyToken } from '../../middleware/auth.js';

const router = express.Router();

// GET /api/stats - Obtener estadísticas del usuario
router.get('/stats', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId; // Token tiene 'userId', no 'id'

    // Obtener plan del usuario y límites de tokens
    const userRes = await db.query('SELECT plan, tokens, created_at FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
    }
    const user = userRes.rows[0];
    const accountAgeDays = Math.floor((Date.now() - new Date(user.created_at).getTime()) / (1000 * 60 * 60 * 24));

    // Contar voces clonadas
    const voicesRes = await db.query('SELECT COUNT(*) as count FROM user_voices WHERE user_id = $1', [userId]);
    const voicesClonesUsed = parseInt(voicesRes.rows[0].count);

    // Límites de voces según plan
    const planLimits = { free: 0, basic: 2, pro: 4, premium: 8 };
    const voiceCloneLimit = planLimits[user.plan] || 4;

    // Límites de tokens según plan
    const tokenLimits = { free: 100, basic: 1000, pro: 5000, premium: 10000 };
    const tokenLimit = tokenLimits[user.plan] || 1000;

    // === CURRENT MONTH STATS ===
    const currentMonthRes = await db.query(
      `SELECT
        COUNT(*) as messages_count,
        COALESCE(SUM(tokens_used), 0) as tokens_used,
        COALESCE(SUM(characters_count), 0) as characters_synthesized,
        COUNT(DISTINCT voice_name) as unique_voices
      FROM token_logs
      WHERE user_id = $1
      AND EXTRACT(YEAR FROM timestamp) = EXTRACT(YEAR FROM NOW())
      AND EXTRACT(MONTH FROM timestamp) = EXTRACT(MONTH FROM NOW())`,
      [userId]
    );
    const currentMonth = currentMonthRes.rows[0];
    const currentMonthStats = {
      messages_count: parseInt(currentMonth.messages_count) || 0,
      tokens_used: parseInt(currentMonth.tokens_used) || 0,
      characters_synthesized: parseInt(currentMonth.characters_synthesized) || 0,
      unique_voices_used: parseInt(currentMonth.unique_voices) || 0,
      live_stream_time_minutes: 0 // TODO: rastrear uptime desde TikTok
    };

    // === ALL-TIME STATS ===
    const allTimeRes = await db.query(
      `SELECT
        COUNT(*) as total_messages,
        COALESCE(SUM(tokens_used), 0) as total_tokens,
        COALESCE(SUM(characters_count), 0) as total_characters,
        MAX(voice_name) as most_used_voice
      FROM token_logs
      WHERE user_id = $1`,
      [userId]
    );
    const allTime = allTimeRes.rows[0];

    // Top voces (all-time)
    const topVoicesRes = await db.query(
      `SELECT voice_name, COUNT(*) as count, SUM(tokens_used) as tokens_used
       FROM token_logs
       WHERE user_id = $1
       GROUP BY voice_name
       ORDER BY count DESC
       LIMIT 5`,
      [userId]
    );

    // === DAILY BREAKDOWN (últimos 30 días) ===
    const dailyRes = await db.query(
      `SELECT
        DATE(timestamp) as date,
        COUNT(*) as messages,
        COALESCE(SUM(tokens_used), 0) as tokens_used
       FROM token_logs
       WHERE user_id = $1 AND timestamp > NOW() - INTERVAL '30 days'
       GROUP BY DATE(timestamp)
       ORDER BY DATE DESC`,
      [userId]
    );

    // === BENEFICIOS GANADOS ===
    // Asunciones: 0.15 min promedio por mensaje, $1 por minuto ahorrado
    const currentMonthMessages = currentMonthStats.messages_count;
    const minutesSavedCurrentMonth = currentMonthMessages * 0.15;
    const moneySavedCurrentMonth = minutesSavedCurrentMonth * 1.0; // USD por minuto
    const hoursSavedCurrentMonth = minutesSavedCurrentMonth / 60;

    // All-time
    const totalMessages = parseInt(allTime.total_messages) || 0;
    const minutesSavedAllTime = totalMessages * 0.15;
    const moneySavedAllTime = minutesSavedAllTime * 1.0;
    const hoursSavedAllTime = minutesSavedAllTime / 60;

    // Crecimiento vs mes anterior
    const lastMonthRes = await db.query(
      `SELECT COUNT(*) as count, COALESCE(SUM(tokens_used), 0) as tokens
       FROM token_logs
       WHERE user_id = $1
       AND EXTRACT(YEAR FROM timestamp) = EXTRACT(YEAR FROM NOW() - INTERVAL '1 month')
       AND EXTRACT(MONTH FROM timestamp) = EXTRACT(MONTH FROM NOW() - INTERVAL '1 month')`,
      [userId]
    );
    const lastMonthCount = parseInt(lastMonthRes.rows[0]?.count) || 0;
    const lastMonthTokens = parseInt(lastMonthRes.rows[0]?.tokens) || 0;

    const messagesGrowthPercent = lastMonthCount > 0
      ? ((currentMonthStats.messages_count - lastMonthCount) / lastMonthCount) * 100
      : 0;
    const tokensGrowthPercent = lastMonthTokens > 0
      ? ((currentMonthStats.tokens_used - lastMonthTokens) / lastMonthTokens) * 100
      : 0;

    // Alcance estimado (asumiendo 5 viewers por minuto en vivo)
    const estimatedViewersReached = currentMonthMessages * 5;

    const benefits = {
      money_saved_usd: parseFloat(moneySavedCurrentMonth.toFixed(2)),
      money_saved_calculation: `${currentMonthMessages} mensajes × 0.15 min = ${minutesSavedCurrentMonth.toFixed(2)} min ahorrados × $1/min = $${moneySavedCurrentMonth.toFixed(2)}`,
      estimated_viewers_reached: estimatedViewersReached,
      total_engagement: currentMonthStats.messages_count,
      hours_saved: parseFloat(hoursSavedCurrentMonth.toFixed(2)),
      efficiency_score: currentMonthMessages > 0 ? '95%' : '0%',
      growth_vs_last_month: {
        messages_change_percent: parseFloat(messagesGrowthPercent.toFixed(1)),
        tokens_change_percent: parseFloat(tokensGrowthPercent.toFixed(1)),
        engagement_change_percent: parseFloat(messagesGrowthPercent.toFixed(1))
      }
    };

    // Respuesta final
    res.json({
      success: true,
      current_month: currentMonthStats,
      benefits,
      all_time: {
        total_messages: parseInt(allTime.total_messages) || 0,
        total_tokens_used: parseInt(allTime.total_tokens) || 0,
        total_characters: parseInt(allTime.total_characters) || 0,
        voices_cloned: voicesClonesUsed,
        most_used_voice: allTime.most_used_voice || 'N/A',
        account_age_days: accountAgeDays,
        total_money_saved_usd: parseFloat(moneySavedAllTime.toFixed(2)),
        total_hours_saved: parseFloat(hoursSavedAllTime.toFixed(2))
      },
      daily_breakdown: dailyRes.rows.map(row => ({
        date: row.date.toISOString().split('T')[0],
        messages: parseInt(row.messages),
        tokens_used: parseInt(row.tokens_used) || 0
      })),
      top_voices: topVoicesRes.rows.map(row => ({
        voice_name: row.voice_name,
        count: parseInt(row.count),
        tokens_used: parseInt(row.tokens_used) || 0
      })),
      plan_info: {
        current_plan: user.plan,
        tokens_balance: parseInt(user.tokens),
        token_limit: tokenLimit,
        voice_clone_limit: voiceCloneLimit,
        voice_clones_used: voicesClonesUsed
      }
    });
  } catch (err) {
    console.error('[Stats] Error:', err);
    res.status(500).json({ success: false, error: 'Error cargando estadísticas' });
  }
});

export default router;
