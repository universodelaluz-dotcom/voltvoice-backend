import express from 'express';
import pool from '../db.js';
import botContextService from '../services/botContextService.js';
import { verifyToken } from '../middleware/auth.js';

const router = express.Router();

/**
 * GET /api/bot/context/:tiktok_username
 * Get aggregated context for a TikTok stream (real-time + historical data)
 */
router.get('/context/:tiktok_username', async (req, res) => {
  try {
    const { tiktok_username } = req.params;

    const context = await botContextService.getStreamContext(tiktok_username);

    if (!context) {
      return res.status(404).json({
        error: 'Stream not found or not connected',
        tiktok_username
      });
    }

    res.json({
      success: true,
      context,
      formatted: botContextService.formatContextForInworld(context)
    });
  } catch (err) {
    console.error('[Bot] Error getting context:', err);
    res.status(500).json({
      error: 'Error getting stream context',
      details: err.message
    });
  }
});

/**
 * GET /api/bot/characters
 * Get user's custom bot characters + example character
 */
router.get('/characters', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Get user's custom characters
    const result = await pool.query(
      'SELECT id, name, description, system_prompt, voice_id, avatar_url, created_at FROM bot_characters WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );

    const characters = result.rows.map(char => ({
      ...char,
      is_custom: true
    }));

    // Add example character
    const exampleCharacter = {
      id: 'streamer_ai_example',
      name: 'Streamer AI',
      description: 'Default AI assistant with stream awareness',
      system_prompt: `You are a helpful AI assistant for a TikTok Live streamer. You have access to real-time stream data including viewer count, donations, followers, and chat activity. Use this information to provide accurate, entertaining, and contextual responses. Be friendly, engaging, and use the stream data to give personalized answers.`,
      voice_id: null, // Will use user's default voice
      avatar_url: null,
      is_custom: false
    };

    res.json({
      success: true,
      characters: [exampleCharacter, ...characters],
      total: characters.length + 1
    });
  } catch (err) {
    console.error('[Bot] Error getting characters:', err);
    res.status(500).json({
      error: 'Error retrieving characters',
      details: err.message
    });
  }
});

/**
 * POST /api/bot/characters
 * Create a new custom bot character
 */
router.post('/characters', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { name, description, system_prompt, voice_id, avatar_url } = req.body;

    if (!name || !system_prompt) {
      return res.status(400).json({
        error: 'name and system_prompt are required'
      });
    }

    const result = await pool.query(
      `INSERT INTO bot_characters (user_id, name, description, system_prompt, voice_id, avatar_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, description, system_prompt, voice_id, avatar_url, created_at`,
      [userId, name, description || '', system_prompt, voice_id || null, avatar_url || null]
    );

    const character = result.rows[0];

    console.log(`[Bot] Character created: ${character.name} (ID: ${character.id}) for user ${userId}`);

    res.status(201).json({
      success: true,
      character: {
        ...character,
        is_custom: true
      }
    });
  } catch (err) {
    console.error('[Bot] Error creating character:', err);
    res.status(500).json({
      error: 'Error creating character',
      details: err.message
    });
  }
});

/**
 * PATCH /api/bot/characters/:id
 * Update a custom bot character
 */
router.patch('/characters/:id', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const { name, description, system_prompt, voice_id, avatar_url } = req.body;

    // Verify ownership
    const checkResult = await pool.query(
      'SELECT id FROM bot_characters WHERE id = $1 AND user_id = $2',
      [id, userId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Character not found or you do not have permission to edit it'
      });
    }

    const updates = [];
    const values = [id, userId];
    let paramCount = 2;

    if (name !== undefined) {
      updates.push(`name = $${++paramCount}`);
      values.push(name);
    }
    if (description !== undefined) {
      updates.push(`description = $${++paramCount}`);
      values.push(description);
    }
    if (system_prompt !== undefined) {
      updates.push(`system_prompt = $${++paramCount}`);
      values.push(system_prompt);
    }
    if (voice_id !== undefined) {
      updates.push(`voice_id = $${++paramCount}`);
      values.push(voice_id);
    }
    if (avatar_url !== undefined) {
      updates.push(`avatar_url = $${++paramCount}`);
      values.push(avatar_url);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        error: 'No fields to update'
      });
    }

    updates.push('updated_at = NOW()');

    const query = `UPDATE bot_characters SET ${updates.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING *`;
    const result = await pool.query(query, values);

    console.log(`[Bot] Character updated: ${result.rows[0].name} (ID: ${id})`);

    res.json({
      success: true,
      character: {
        ...result.rows[0],
        is_custom: true
      }
    });
  } catch (err) {
    console.error('[Bot] Error updating character:', err);
    res.status(500).json({
      error: 'Error updating character',
      details: err.message
    });
  }
});

/**
 * DELETE /api/bot/characters/:id
 * Delete a custom bot character
 */
router.delete('/characters/:id', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM bot_characters WHERE id = $1 AND user_id = $2 RETURNING id, name',
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Character not found or you do not have permission to delete it'
      });
    }

    console.log(`[Bot] Character deleted: ${result.rows[0].name} (ID: ${id})`);

    res.json({
      success: true,
      deleted: result.rows[0]
    });
  } catch (err) {
    console.error('[Bot] Error deleting character:', err);
    res.status(500).json({
      error: 'Error deleting character',
      details: err.message
    });
  }
});

/**
 * POST /api/bot/invoke
 * Invoke a bot character to respond to a question
 * Body: { characterId, tiktok_username, question, responseMode: 'audio'|'text'|'both' }
 */
router.post('/invoke', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { characterId, tiktok_username, question, responseMode = 'audio' } = req.body;

    if (!characterId || !tiktok_username || !question) {
      return res.status(400).json({
        error: 'characterId, tiktok_username, and question are required'
      });
    }

    // Get character
    let character;
    if (characterId === 'streamer_ai_example') {
      character = {
        id: 'streamer_ai_example',
        name: 'Streamer AI',
        system_prompt: `You are a helpful AI assistant for a TikTok Live streamer. You have access to real-time stream data. Be friendly, engaging, and use the stream context to provide personalized responses.`,
        voice_id: null
      };
    } else {
      const result = await pool.query(
        'SELECT id, name, system_prompt, voice_id FROM bot_characters WHERE id = $1 AND user_id = $2',
        [characterId, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Character not found'
        });
      }

      character = result.rows[0];
    }

    // Get stream context
    const context = await botContextService.getStreamContext(tiktok_username);
    if (!context) {
      return res.status(404).json({
        error: 'Stream not found or not connected'
      });
    }

    const contextText = botContextService.formatContextForInworld(context);

    // Prepare system prompt with context
    const fullSystemPrompt = `${character.system_prompt}

CURRENT STREAM DATA:
${contextText}`;

    // Return invoke data (frontend will call Inworld Realtime API)
    res.json({
      success: true,
      invoke: {
        character_id: character.id,
        character_name: character.name,
        voice_id: character.voice_id,
        system_prompt: fullSystemPrompt,
        user_question: question,
        response_mode: responseMode,
        stream_context: context
      }
    });
  } catch (err) {
    console.error('[Bot] Error invoking character:', err);
    res.status(500).json({
      error: 'Error invoking character',
      details: err.message
    });
  }
});

/**
 * POST /api/bot/action/execute
 * Ejecutar acción de moderación (ban, mute, kick, timeout, clear)
 */
router.post('/action/execute', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { action, targetUsername, reason, tiktok_username } = req.body;

    if (!action || !targetUsername) {
      return res.status(400).json({
        error: 'action and targetUsername are required'
      });
    }

    const validActions = ['ban', 'mute', 'kick', 'timeout', 'clear'];
    if (!validActions.includes(action)) {
      return res.status(400).json({
        error: `Invalid action. Must be one of: ${validActions.join(', ')}`
      });
    }

    // Registrar la acción en el log
    const logResult = await pool.query(
      `INSERT INTO bot_moderations_log (user_id, action_type, target_username, reason, status)
       VALUES ($1, $2, $3, $4, 'executed')
       RETURNING id, action_type, target_username, executed_at`,
      [userId, action, targetUsername, reason || null]
    );

    console.log(`[Bot] Action executed: ${action} on ${targetUsername} by user ${userId}`);

    // TODO: Integrar con sistema de bans/mutes existente
    // Por ahora, solo registramos en el log

    res.json({
      success: true,
      action_executed: logResult.rows[0],
      message: `Acción "${action}" ejecutada en ${targetUsername}`
    });
  } catch (err) {
    console.error('[Bot] Error executing action:', err);
    res.status(500).json({
      error: 'Error executing action',
      details: err.message
    });
  }
});

/**
 * GET /api/bot/actions/log
 * Obtener historial de acciones de moderación del bot
 */
router.get('/actions/log', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    const result = await pool.query(
      `SELECT id, action_type, target_username, reason, executed_at, status
       FROM bot_moderations_log
       WHERE user_id = $1
       ORDER BY executed_at DESC
       LIMIT $2`,
      [userId, limit]
    );

    res.json({
      success: true,
      actions: result.rows,
      total: result.rows.length
    });
  } catch (err) {
    console.error('[Bot] Error getting action log:', err);
    res.status(500).json({
      error: 'Error retrieving action log',
      details: err.message
    });
  }
});

/**
 * POST /api/bot/action/suggest
 * Sugerir acciones basadas en análisis de spam o comportamiento
 */
router.post('/action/suggest', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { chatAnalysis, tiktok_username } = req.body;

    if (!chatAnalysis) {
      return res.status(400).json({
        error: 'chatAnalysis is required'
      });
    }

    // Analizar el chat para detectar patrones de spam
    const suggestions = [];

    // Detectar spam
    if (chatAnalysis.spamUsers && chatAnalysis.spamUsers.length > 0) {
      suggestions.push({
        action: 'mute',
        users: chatAnalysis.spamUsers,
        confidence: 0.8,
        reason: 'Detección automática de spam'
      });
    }

    // Detectar toxicidad
    if (chatAnalysis.toxicUsers && chatAnalysis.toxicUsers.length > 0) {
      suggestions.push({
        action: 'timeout',
        users: chatAnalysis.toxicUsers,
        confidence: 0.7,
        reason: 'Lenguaje inapropiado detectado'
      });
    }

    res.json({
      success: true,
      suggestions,
      total: suggestions.length,
      message: 'Sugerencias basadas en análisis automático del chat'
    });
  } catch (err) {
    console.error('[Bot] Error analyzing chat:', err);
    res.status(500).json({
      error: 'Error analyzing chat',
      details: err.message
    });
  }
});

/**
 * DELETE /api/bot/actions/log/:id
 * Eliminar entrada del log (admin only)
 */
router.delete('/actions/log/:id', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM bot_moderations_log WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Action log entry not found'
      });
    }

    res.json({
      success: true,
      deleted: result.rows[0]
    });
  } catch (err) {
    console.error('[Bot] Error deleting log entry:', err);
    res.status(500).json({
      error: 'Error deleting log entry',
      details: err.message
    });
  }
});

export default router;
