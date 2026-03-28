import { Router } from 'express';
import pool from '../db.js';
import { verifyToken } from '../../middleware/auth.js';
import inworldTtsService from '../services/inworldTtsService.js';

const router = Router();

/**
 * GET /api/settings - Cargar config del usuario
 */
router.get('/', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT config FROM user_settings WHERE user_id = $1',
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.json({ success: true, config: {} });
    }

    return res.json({ success: true, config: result.rows[0].config });
  } catch (error) {
    console.error('[Settings] Error cargando:', error.message);
    return res.status(500).json({ error: 'Error cargando configuración' });
  }
});

/**
 * POST /api/settings - Guardar config del usuario
 */
router.post('/', verifyToken, async (req, res) => {
  const { config } = req.body;

  if (!config || typeof config !== 'object') {
    return res.status(400).json({ error: 'Config inválido' });
  }

  try {
    await pool.query(
      `INSERT INTO user_settings (user_id, config, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) DO UPDATE SET config = $2, updated_at = CURRENT_TIMESTAMP`,
      [req.user.userId, JSON.stringify(config)]
    );

    return res.json({ success: true });
  } catch (error) {
    console.error('[Settings] Error guardando:', error.message);
    return res.status(500).json({ error: 'Error guardando configuración' });
  }
});

/**
 * GET /api/settings/voices - Listar voces clonadas del usuario
 */
router.get('/voices', verifyToken, async (req, res) => {
  try {
    const voiceLimits = { free: 0, basic: 2, professional: 4, premium: 8 };
    const userResult = await pool.query('SELECT plan FROM users WHERE id = $1', [req.user.userId]);
    const userPlan = userResult.rows[0]?.plan || 'free';
    const maxVoices = voiceLimits[userPlan] || 0;

    const result = await pool.query(
      'SELECT id, voice_name, voice_id, provider, created_at FROM user_voices WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.userId]
    );

    return res.json({ success: true, voices: result.rows, plan: userPlan, maxVoices, used: result.rows.length });
  } catch (error) {
    console.error('[Settings] Error listando voces:', error.message);
    return res.status(500).json({ error: 'Error listando voces' });
  }
});

/**
 * POST /api/settings/voices - Guardar voz clonada del usuario
 */
router.post('/voices', verifyToken, async (req, res) => {
  const { voiceName, voiceId, provider } = req.body;

  if (!voiceName || !voiceId) {
    return res.status(400).json({ error: 'voiceName y voiceId requeridos' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO user_voices (user_id, voice_name, voice_id, provider)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, voice_name) DO UPDATE SET voice_id = $3, provider = $4
       RETURNING id, voice_name, voice_id, provider, created_at`,
      [req.user.userId, voiceName, voiceId, provider || 'inworld']
    );

    return res.status(201).json({ success: true, voice: result.rows[0] });
  } catch (error) {
    console.error('[Settings] Error guardando voz:', error.message);
    return res.status(500).json({ error: 'Error guardando voz' });
  }
});

/**
 * DELETE /api/settings/voices/:id - Eliminar voz clonada
 */
router.delete('/voices/:id', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM user_voices WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Voz no encontrada' });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('[Settings] Error eliminando voz:', error.message);
    return res.status(500).json({ error: 'Error eliminando voz' });
  }
});

/**
 * POST /api/settings/voices/clone - Clonar voz con Inworld AI
 * Body: { voiceName, base64Audio, transcription?, langCode? }
 */
router.post('/voices/clone', verifyToken, async (req, res) => {
  const { voiceName, base64Audio, transcription, langCode } = req.body;

  if (!voiceName || !base64Audio) {
    return res.status(400).json({ error: 'voiceName y base64Audio son requeridos' });
  }

  // Límite de voces clonadas según plan del usuario
  const voiceLimits = { free: 0, basic: 2, professional: 4, premium: 8 };
  try {
    const userResult = await pool.query('SELECT plan FROM users WHERE id = $1', [req.user.userId]);
    const userPlan = userResult.rows[0]?.plan || 'free';
    const maxVoices = voiceLimits[userPlan] || 0;

    if (maxVoices === 0) {
      return res.status(403).json({ error: 'Tu plan Free no incluye clonación de voces. Mejora tu plan para desbloquear esta función.' });
    }

    const countResult = await pool.query(
      'SELECT COUNT(*) as total FROM user_voices WHERE user_id = $1',
      [req.user.userId]
    );
    if (parseInt(countResult.rows[0].total) >= maxVoices) {
      return res.status(400).json({ error: `Tu plan ${userPlan} permite máximo ${maxVoices} voces clonadas. Elimina una o mejora tu plan.` });
    }
  } catch (err) {
    console.error('[Clone] Error verificando límite:', err);
  }

  try {
    console.log(`[Clone] Usuario ${req.user.userId} clonando voz: "${voiceName}"`);

    // Convertir base64 a Buffer
    const audioBuffer = Buffer.from(base64Audio, 'base64');

    // Llamar a Inworld para clonar
    const result = await inworldTtsService.cloneVoice(
      voiceName,
      audioBuffer,
      transcription || '',
      langCode || 'ES_ES'
    );

    // Guardar en la base de datos del usuario
    const dbResult = await pool.query(
      `INSERT INTO user_voices (user_id, voice_name, voice_id, provider)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, voice_name) DO UPDATE SET voice_id = $3
       RETURNING id, voice_name, voice_id, provider, created_at`,
      [req.user.userId, voiceName, result.voiceId, 'inworld']
    );

    console.log(`[Clone] ✓ Voz "${voiceName}" clonada y guardada para usuario ${req.user.userId}`);

    return res.status(201).json({
      success: true,
      voice: dbResult.rows[0],
      message: `Voz "${voiceName}" clonada exitosamente`
    });
  } catch (error) {
    console.error('[Clone] Error clonando voz:', error.message);
    return res.status(500).json({
      error: 'Error clonando la voz',
      details: error.message
    });
  }
});

export default router;
