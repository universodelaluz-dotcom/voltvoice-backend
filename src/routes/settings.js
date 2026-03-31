import { Router } from 'express';
import pool from '../db.js';
import { verifyToken } from '../../middleware/auth.js';
import inworldTtsService from '../services/inworldTtsService.js';

const router = Router();

/**
 * Mapeo de idiomas a códigos válidos de Inworld
 */
const languageCodeMap = {
  'en': 'EN_US',
  'en-US': 'EN_US',
  'en-GB': 'EN_US',
  'es': 'ES_ES',
  'es-ES': 'ES_ES',
  'es-MX': 'ES_ES',
  'es-AR': 'ES_ES',
  'pt': 'PT_BR',
  'pt-BR': 'PT_BR',
  'pt-PT': 'PT_BR',
  'fr': 'FR_FR',
  'fr-FR': 'FR_FR',
  'de': 'DE_DE',
  'de-DE': 'DE_DE',
  'it': 'IT_IT',
  'it-IT': 'IT_IT',
  'ru': 'RU_RU',
  'ru-RU': 'RU_RU',
  'ja': 'JA_JP',
  'ja-JP': 'JA_JP',
  'ko': 'KO_KR',
  'ko-KR': 'KO_KR',
  'zh': 'ZH_CN',
  'zh-CN': 'ZH_CN',
  'ar': 'AR_SA',
  'ar-SA': 'AR_SA',
  'pl': 'PL_PL',
  'pl-PL': 'PL_PL',
  'nl': 'NL_NL',
  'nl-NL': 'NL_NL',
  'hi': 'HI_IN',
  'hi-IN': 'HI_IN',
  'he': 'HE_IL',
  'he-IL': 'HE_IL',
};

/**
 * Convertir código de idioma a formato Inworld válido
 */
const mapLanguageCodeToInworld = (languageCode) => {
  return languageCodeMap[languageCode] || 'EN_US'; // Default a EN_US si no se encuentra
};

/**
 * Traducir texto al inglés para Inworld
 * Usa google-translate-free con fallback al texto original
 */
const translateToEnglish = async (text, language = 'es') => {
  if (!text || text.trim().length === 0) return text;

  try {
    // Si ya está en inglés, retornar tal cual
    if (language === 'en' || language === 'en-US' || language === 'en-GB') {
      return text;
    }

    console.log(`[Translate] Intentando traducir de ${language} a inglés: "${text.substring(0, 50)}..."`);

    // Intenta importar dinámicamente
    const { translate } = await import('google-translate-free');
    const result = await translate({
      text: text,
      source: language.split('-')[0], // es, pt, fr, etc
      target: 'en'
    });

    console.log(`[Translate] ✓ Traducido: "${result}"`);
    return result;
  } catch (error) {
    console.warn(`[Translate] No se pudo traducir, usando texto original: ${error.message}`);
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
    const voiceLimits = { free: 0, pro: 2, premium: 4, elite: 8, on_demand: 999 };
    const userResult = await pool.query('SELECT plan FROM users WHERE id = $1', [req.user.userId]);
    const userPlan = userResult.rows[0]?.plan || 'free';
    const maxVoices = voiceLimits[userPlan] || 0;

    const result = await pool.query(
      'SELECT id, voice_name, voice_id, provider, created_at FROM user_voices WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.userId]
    );

    // Filtrar voces con IDs problemáticos (ej: Arno)
    const validVoices = result.rows.filter(v => {
      // Rechazar TODAS las voces llamadas 'Arno' (incompletas/problemáticas)
      if (v.voice_name.toLowerCase() === 'arno') {
        console.warn(`[Settings] Eliminando voz problemática: ${v.voice_name} (${v.voice_id})`);
        return false;
      }
      return true;
    });

    return res.json({ success: true, voices: validVoices, plan: userPlan, maxVoices, used: validVoices.length });
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
 * PATCH /api/settings/voices/:id - Actualizar nombre de voz
 */
router.patch('/voices/:id', verifyToken, async (req, res) => {
  const { voiceName } = req.body;

  if (!voiceName) {
    return res.status(400).json({ error: 'voiceName requerido' });
  }

  try {
    const result = await pool.query(
      'UPDATE user_voices SET voice_name = $1 WHERE id = $2 AND user_id = $3 RETURNING id, voice_name, voice_id, provider, created_at',
      [voiceName, req.params.id, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Voz no encontrada' });
    }

    console.log(`[Settings] Voz ${req.params.id} renombrada a: ${voiceName}`);

    return res.json({ success: true, voice: result.rows[0] });
  } catch (error) {
    console.error('[Settings] Error actualizando voz:', error.message);
    return res.status(500).json({ error: 'Error actualizando voz' });
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

  // Convertir código de idioma a formato Inworld válido
  let finalLangCode = 'ES_ES'; // default
  if (language) {
    finalLangCode = mapLanguageCodeToInworld(language);
  } else if (langCode) {
    finalLangCode = mapLanguageCodeToInworld(langCode);
  }

  // Límite de voces clonadas según plan del usuario
  const voiceLimits = { free: 0, pro: 2, premium: 4, elite: 8, on_demand: 999 };
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

    let finalVoiceId = result.voiceId;
    try {
      const publishResult = await inworldTtsService.publishVoice(result.voiceId, voiceName);
      if (publishResult?.voiceId) {
        finalVoiceId = publishResult.voiceId;
        console.log(`[Clone] Voz publicada: ${result.voiceId} -> ${finalVoiceId}`);
      }
    } catch (publishError) {
      console.warn(`[Clone] No se pudo publicar inmediatamente la voz ${result.voiceId}: ${publishError.message}`);
    }

    // Guardar en la base de datos del usuario
    const dbResult = await pool.query(
      `INSERT INTO user_voices (user_id, voice_name, voice_id, provider)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, voice_name) DO UPDATE SET voice_id = $3
       RETURNING id, voice_name, voice_id, provider, created_at`,
      [req.user.userId, voiceName, finalVoiceId, 'inworld-cloned']
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
 * POST /api/settings/voices/generate - Generar voz personalizada con descripción
 * Body: { description, voiceType, language, scriptMode, script? }
 */
router.post('/voices/generate', verifyToken, async (req, res) => {
  const { description, voiceType, language, scriptMode, script } = req.body;

  if (!description || !voiceType || !language) {
    return res.status(400).json({ error: 'description, voiceType y language son requeridos' });
  }

  // Límite de voces generadas según plan del usuario
  const voiceLimits = { free: 0, pro: 2, premium: 4, elite: 8, on_demand: 999 };
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

    // Mapear el código de idioma a uno válido de Inworld
    const langCode = mapLanguageCodeToInworld(language);
    console.log(`[Generate] Language mapping: ${language} → ${langCode}`);

    // Traducir descripción al inglés (Inworld lo requiere)
    const languageCode = language.split('-')[0]; // es, pt, en, etc
    const descriptionEnglish = await translateToEnglish(description, languageCode);
    const voiceTypeEnglish = voiceTypeTranslations[voiceType] || voiceType;

    // Construir el prompt para Inworld (en inglés)
    const designPrompt = `${descriptionEnglish}. Voice type: ${voiceTypeEnglish}`;
    const previewText = script && scriptMode === 'custom'
      ? await translateToEnglish(script, languageCode)
      : descriptionEnglish; // Usar la descripción como preview para que sea más representativo

    console.log(`[Generate] Design prompt: "${designPrompt.substring(0, 80)}..."`);

    // Llamar a Inworld para diseñar la voz
    const result = await inworldTtsService.designVoice(
      designPrompt,
      langCode,
      previewText
    );

    console.log(`[Generate] Voz diseñada: ${result.voiceId}, publicando...`);

    // Generar un nombre amigable para la voz (puede ser editado por el usuario)
    const defaultVoiceName = `Voz ${voiceType} - ${new Date().toLocaleDateString()}`;

    // Publicar la voz (convertir de DRAFT a ACTIVE)
    let publishedVoiceId = result.voiceId;
    try {
      const publishResult = await inworldTtsService.publishVoice(result.voiceId, defaultVoiceName);
      publishedVoiceId = publishResult.voiceId;
      console.log(`[Generate] ✓ Voz publicada exitosamente: ${publishedVoiceId}`);
    } catch (publishErr) {
      console.warn(`[Generate] Advertencia al publicar voz: ${publishErr.message}`);
      // Continuar de todas formas - la voz ya está generada
    }

    // Guardar en la base de datos del usuario (usar voiceId publicado)
    const dbResult = await pool.query(
      `INSERT INTO user_voices (user_id, voice_name, voice_id, provider, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id, voice_name, voice_id, provider, created_at`,
      [req.user.userId, defaultVoiceName, publishedVoiceId, 'inworld-generated']
    );

    console.log(`[Generate] ✓ Voz generada y guardada para usuario ${req.user.userId}`);

    // Convertir preview audio a data URL si existe
    let previewAudioUrl = null;
    if (result.previewAudio) {
      const base64Audio = Buffer.isBuffer(result.previewAudio)
        ? result.previewAudio.toString('base64')
        : result.previewAudio;
      previewAudioUrl = `data:audio/mpeg;base64,${base64Audio}`;
    }

    return res.status(201).json({
      success: true,
      voice: {
        ...dbResult.rows[0],
        defaultName: defaultVoiceName,  // Nombre sugerido
        previewAudio: previewAudioUrl,   // Audio para reproducir
        voiceId: publishedVoiceId        // ID de Inworld publicado
      },
      message: `Voz personalizada generada exitosamente`
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

    // Limpiar voces problemáticas primero
    await pool.query(
      `DELETE FROM user_voices WHERE user_id = $1 AND LOWER(voice_name) = 'arno'`,
      [req.user.userId]
    );

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

/**
 * GET /api/settings/plan - Ver plan actual del usuario
 */
router.get('/plan', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, plan, tokens FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const user = result.rows[0];
    return res.json({
      success: true,
      userId: user.id,
      email: user.email,
      currentPlan: user.plan || 'free',
      tokens: user.tokens
    });
  } catch (error) {
    console.error('[Plan] Error:', error.message);
    return res.status(500).json({ error: 'Error obteniendo plan' });
  }
});

/**
 * POST /api/settings/plan - Actualizar plan del usuario (DEBUG)
 */
router.post('/plan', verifyToken, async (req, res) => {
  const { newPlan } = req.body;

  if (!['free', 'pro', 'premium', 'elite', 'on_demand'].includes(newPlan)) {
    return res.status(400).json({ error: 'Plan inválido. Use: free, pro, premium, elite, on_demand' });
  }

  try {
    const result = await pool.query(
      'UPDATE users SET plan = $1 WHERE id = $2 RETURNING id, plan, tokens',
      [newPlan, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    console.log(`[Plan] Usuario ${req.user.userId} plan actualizado a ${newPlan}`);

    return res.json({
      success: true,
      message: `Plan actualizado a ${newPlan}`,
      plan: result.rows[0].plan,
      tokens: result.rows[0].tokens
    });
  } catch (error) {
    console.error('[Plan] Error actualizando:', error.message);
    return res.status(500).json({ error: 'Error actualizando plan' });
  }
});

/**
 * GET /api/settings/voices/:id/play - Sintetizar audio de prueba con una voz
 */
router.get('/voices/:id/play', verifyToken, async (req, res) => {
  try {
    const voiceResult = await pool.query(
      'SELECT voice_id FROM user_voices WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    );

    if (voiceResult.rows.length === 0) {
      return res.status(404).json({ error: 'Voz no encontrada' });
    }

    const voiceId = voiceResult.rows[0].voice_id;
    const testText = 'HOLA';

    console.log(`[Voice Play] Sintetizando audio con voz ${voiceId}`);

    // Sintetizar audio con Inworld
    const result = await inworldTtsService.synthesize(testText, voiceId);

    // Devolver audio como bytes
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(result);

  } catch (error) {
    console.error('[Voice Play] Error sintetizando:', error.message);
    return res.status(500).json({ error: 'Error sintetizando audio' });
  }
});

/**
 * POST /api/settings/plan/update-by-email - Actualizar plan por email (DEBUG - sin auth)
 */
router.post('/plan/update-by-email', async (req, res) => {
  const { email, newPlan } = req.body;

  if (!email || !newPlan) {
    return res.status(400).json({ error: 'email y newPlan requeridos' });
  }

  if (!['free', 'pro', 'premium', 'elite', 'on_demand'].includes(newPlan)) {
    return res.status(400).json({ error: 'Plan inválido. Use: free, pro, premium, elite, on_demand' });
  }

  try {
    const result = await pool.query(
      'UPDATE users SET plan = $1 WHERE email = $2 RETURNING id, email, plan, tokens',
      [newPlan, email]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    console.log(`[Plan DEBUG] Usuario ${email} plan actualizado a ${newPlan}`);

    return res.json({
      success: true,
      message: `Plan de ${email} actualizado a ${newPlan}`,
      user: result.rows[0]
    });
  } catch (error) {
    console.error('[Plan DEBUG] Error actualizando:', error.message);
    return res.status(500).json({ error: 'Error actualizando plan' });
  }
});

export default router;
