import { Router } from 'express';
import pool from '../db.js';
import { verifyToken } from '../../middleware/auth.js';
import inworldTtsService from '../services/inworldTtsService.js';
import { translate } from 'google-translate-free';

const router = Router();

/**
 * Traducir texto al inglés para Inworld
 */
const translateToEnglish = async (text, language = 'es') => {
  if (!text || text.trim().length === 0) return text;

  try {
    // Si ya está en inglés, retornar tal cual
    if (language === 'en' || language === 'en-US' || language === 'en-GB') {
      return text;
    }

    console.log(`[Translate] Traduciendo de ${language} a inglés: "${text.substring(0, 50)}..."`);
    const result = await translate({
      text: text,
      source: language.split('-')[0], // es, pt, fr, etc
      target: 'en'
    });

    console.log(`[Translate] ✓ Traducido: "${result}"`);
    return result;
  } catch (error) {
    console.error('[Translate] Error:', error.message);
    // Si falla la traducción, retornar el texto original
    return text;
  }
};

/**
 * Mapeo de tipos de voz a inglés
 */
const voiceTypeTranslations = {
  'Narrador': 'Narrator',
  'Agente de Soporte': 'Support Agent',
  'Compañero': 'Companion',
  'Instructor de Meditación': 'Meditation Instructor',
  // Ya en inglés
  'Narrator': 'Narrator',
  'Support Agent': 'Support Agent',
  'Companion': 'Companion',
  'Meditation Instructor': 'Meditation Instructor'
};

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
 * Body: { voiceName, base64Audio, transcription?, language?, langCode? }
 */
router.post('/voices/clone', verifyToken, async (req, res) => {
  const { voiceName, base64Audio, transcription, language, langCode } = req.body;

  if (!voiceName || !base64Audio) {
    return res.status(400).json({ error: 'voiceName y base64Audio son requeridos' });
  }

  // Convertir código de idioma de es-ES a ES_ES (formato Inworld)
  let finalLangCode = 'ES_ES'; // default
  if (language) {
    // Frontend envía es-ES, convertir a ES_ES
    finalLangCode = language.toUpperCase().replace('-', '_');
  } else if (langCode) {
    // Backwards compatibility
    finalLangCode = langCode;
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
    console.log(`[Clone] Usuario ${req.user.userId} clonando voz: "${voiceName}" - Idioma: ${finalLangCode}`);

    // Convertir base64 a Buffer
    const audioBuffer = Buffer.from(base64Audio, 'base64');

    // Llamar a Inworld para clonar
    const result = await inworldTtsService.cloneVoice(
      voiceName,
      audioBuffer,
      transcription || '',
      finalLangCode
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

/**
 * POST /api/voices/generate - Generar voz personalizada con descripción
 * Body: { description, voiceType, language, scriptMode, script? }
 */
router.post('/voices/generate', verifyToken, async (req, res) => {
  const { description, voiceType, language, scriptMode, script } = req.body;

  if (!description || !voiceType || !language) {
    return res.status(400).json({ error: 'description, voiceType y language son requeridos' });
  }

  // Límite de voces generadas según plan del usuario
  const voiceLimits = { free: 0, basic: 1, professional: 3, premium: 5 };
  try {
    const userResult = await pool.query('SELECT plan FROM users WHERE id = $1', [req.user.userId]);
    const userPlan = userResult.rows[0]?.plan || 'free';
    const maxVoices = voiceLimits[userPlan] || 0;

    if (maxVoices === 0) {
      return res.status(403).json({ error: 'Tu plan Free no incluye generación de voces. Mejora tu plan para desbloquear esta función.' });
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM user_voices WHERE user_id = $1 AND provider = 'inworld-generated'`,
      [req.user.userId]
    );
    if (parseInt(countResult.rows[0].total) >= maxVoices) {
      return res.status(400).json({ error: `Tu plan ${userPlan} permite máximo ${maxVoices} voces generadas. Elimina una o mejora tu plan.` });
    }
  } catch (err) {
    console.error('[Generate] Error verificando límite:', err);
  }

  try {
    console.log(`[Generate] Usuario ${req.user.userId} generando voz: "${description.substring(0, 50)}..."`);

    // Traducir descripción al inglés (Inworld requiere inglés)
    const languageCode = language.split('-')[0]; // es, pt, en, etc
    const descriptionEnglish = await translateToEnglish(description, languageCode);
    const voiceTypeEnglish = voiceTypeTranslations[voiceType] || voiceType;
    const scriptEnglish = scriptMode === 'custom' && script ? await translateToEnglish(script, languageCode) : undefined;

    // Construir el prompt para Inworld (EN INGLÉS)
    const voicePrompt = `${descriptionEnglish}\n\nVoice Type: ${voiceTypeEnglish}\nLanguage: ${language}`;

    console.log(`[Generate] Prompt para Inworld (en inglés): "${voicePrompt.substring(0, 100)}..."`);

    // Llamar a Inworld para generar
    const result = await inworldTtsService.cloneVoice(
      `Generated_${Date.now()}`,  // Nombre único temporal
      Buffer.from(voicePrompt),   // "audio" es en realidad el prompt
      scriptEnglish || ''
    );

    // Generar un nombre amigable para la voz
    const voiceFriendlyName = `Voz ${voiceType} - ${new Date().toLocaleDateString()}`;

    // Guardar en la base de datos del usuario
    const dbResult = await pool.query(
      `INSERT INTO user_voices (user_id, voice_name, voice_id, provider, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id, voice_name, voice_id, provider, created_at`,
      [req.user.userId, voiceFriendlyName, result, 'inworld-generated']
    );

    console.log(`[Generate] ✓ Voz generada y guardada para usuario ${req.user.userId}`);

    return res.status(201).json({
      success: true,
      voice: dbResult.rows[0],
      message: `Voz personalizada generada exitosamente: ${voiceFriendlyName}`
    });
  } catch (error) {
    console.error('[Generate] Error generando voz:', error.message);
    return res.status(500).json({
      error: 'Error generando la voz personalizada',
      details: error.message
    });
  }
});

/**
 * POST /api/settings/voices/migrate - Migrar voces existentes de Inworld a la DB del usuario
 * Solo funciona una vez por voz (ON CONFLICT ignora duplicados)
 */
router.post('/voices/migrate', verifyToken, async (req, res) => {
  try {
    const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.userId]);
    const email = userResult.rows[0]?.email;

    // Voces pre-existentes por email
    const preExistingVoices = {
      'alainsh@gmail.com': [
        { voice_name: 'Garret', voice_id: 'default-cfjnp8x4nt-owd7yg-1xsw__garret', provider: 'inworld' },
        { voice_name: 'Connor', voice_id: 'default-cfjnp8x4nt-owd7yg-1xsw__connor', provider: 'inworld' },
      ]
    };

    const voices = preExistingVoices[email];
    if (!voices || voices.length === 0) {
      return res.json({ success: true, message: 'No hay voces para migrar', migrated: 0 });
    }

    let migrated = 0;
    for (const v of voices) {
      await pool.query(
        `INSERT INTO user_voices (user_id, voice_name, voice_id, provider)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, voice_name) DO NOTHING`,
        [req.user.userId, v.voice_name, v.voice_id, v.provider]
      );
      migrated++;
    }

    return res.json({ success: true, migrated });
  } catch (error) {
    console.error('[Migrate] Error:', error.message);
    return res.status(500).json({ error: 'Error migrando voces' });
  }
});

export default router;
