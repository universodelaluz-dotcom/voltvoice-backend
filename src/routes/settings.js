import { Router } from 'express';
import pool from '../db.js';
import { verifyToken, requireAdmin } from '../../middleware/auth.js';
import inworldTtsService from '../services/inworldTtsService.js';
import subscriptionService from '../services/subscriptionService.js';

const router = Router();

const resolveRequestUserId = (req) => req?.user?.userId ?? req?.user?.id ?? null;
const normalizePlan = (value = 'free') => String(value || 'free').trim().toLowerCase();

// "premium" y "elite" se mantienen como aliases internos de facturacion
const CLONED_VOICE_LIMITS = {
  free: 0,
  start: 1,
  pro: 5,
  creator: 2,
  premium: 2,
  elite: 5,
  on_demand: 999,
  admin: 999
};

const normalizeStoredConfig = (rawConfig) => {
  if (!rawConfig) return {};
  if (typeof rawConfig === 'string') {
    try {
      const parsed = JSON.parse(rawConfig);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return (typeof rawConfig === 'object' && !Array.isArray(rawConfig)) ? rawConfig : {};
};

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
 * En producción devolvemos el texto original para evitar dependencia insegura.
 */
const translateToEnglish = async (text, language = 'es') => {
  if (!text || text.trim().length === 0) return text;

  try {
    // Si ya está en inglés, retornar tal cual
    if (language === 'en' || language === 'en-US' || language === 'en-GB') {
      return text;
    }

    console.log(`[Translate] Traducción externa deshabilitada, usando texto original para idioma: ${language}`);
    return text;
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

const DAILY_VOICE_DELETE_LIMITS = {
  start: 3,
  creator: 6,
  pro: 6,
  premium: 6,
  elite: 6,
  on_demand: 6,
  admin: 999,
};

const ensureVoiceDeleteEventsTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS voice_delete_events (
      id BIGSERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      voice_name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_voice_delete_events_user_created
      ON voice_delete_events(user_id, created_at DESC);
  `);
};

/**
 * GET /api/settings - Cargar config del usuario
 */
router.get('/', verifyToken, async (req, res) => {
  try {
    const userId = resolveRequestUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Usuario no autenticado' });
    }

    const result = await pool.query(
      'SELECT config FROM user_settings WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.json({ success: true, config: {} });
    }

    return res.json({ success: true, config: normalizeStoredConfig(result.rows[0].config) });
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
  const userId = resolveRequestUserId(req);

  if (!userId) {
    return res.status(401).json({ error: 'Usuario no autenticado' });
  }

  let parsedConfig = config;
  if (typeof parsedConfig === 'string') {
    try {
      parsedConfig = JSON.parse(parsedConfig);
    } catch {
      parsedConfig = null;
    }
  }

  if (!parsedConfig || typeof parsedConfig !== 'object' || Array.isArray(parsedConfig)) {
    return res.status(400).json({ error: 'Config inválido' });
  }

  try {
    await pool.query(
      `INSERT INTO user_settings (user_id, config, updated_at)
       VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) DO UPDATE SET config = $2::jsonb, updated_at = CURRENT_TIMESTAMP`,
      [userId, JSON.stringify(parsedConfig)]
    );

    return res.json({ success: true, config: parsedConfig });
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
    const userResult = await pool.query('SELECT plan FROM users WHERE id = $1', [req.user.userId]);
    const userPlan = normalizePlan(userResult.rows[0]?.plan || 'free');
    const maxVoices = CLONED_VOICE_LIMITS[userPlan] ?? 0;

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
 * DELETE /api/settings/voices/:id - Eliminar voz clonada (también de Inworld)
 */
router.delete('/voices/:id', verifyToken, async (req, res) => {
  try {
    // Primero obtener la voz para conseguir el voiceId de Inworld
    const voiceResult = await pool.query(
      'SELECT voice_id, voice_name, provider FROM user_voices WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    );

    if (voiceResult.rows.length === 0) {
      return res.status(404).json({ error: 'Voz no encontrada' });
    }

    const { voice_id, voice_name, provider } = voiceResult.rows[0];
    const isCountedVoiceType = ['inworld-cloned', 'inworld-generated', 'inworld'].includes(String(provider || '').toLowerCase());

    // Límite diario de eliminaciones por plan
    const userPlanResult = await pool.query('SELECT plan, role FROM users WHERE id = $1', [req.user.userId]);
    const userPlan = String(userPlanResult.rows[0]?.plan || 'free').toLowerCase();
    const userRole = userPlanResult.rows[0]?.role || 'user';
    if (isCountedVoiceType && userRole !== 'admin') {
      await ensureVoiceDeleteEventsTable();
      const dailyLimit = DAILY_VOICE_DELETE_LIMITS[userPlan] ?? 0;
      if (dailyLimit <= 0) {
        return res.status(403).json({ error: 'Tu plan actual no permite eliminar voces hoy.' });
      }
      const deleteCountResult = await pool.query(
        `SELECT COUNT(*)::int AS total
         FROM voice_delete_events
         WHERE user_id = $1
           AND created_at >= date_trunc('day', NOW())`,
        [req.user.userId]
      );
      const usedToday = Number(deleteCountResult.rows[0]?.total || 0);
      if (usedToday >= dailyLimit) {
        return res.status(429).json({
          error: `Límite diario de eliminaciones alcanzado para plan ${userPlan}: ${dailyLimit} por día.`
        });
      }
    }

    // Si es una voz clonada, eliminarla también de Inworld
    if (provider === 'inworld-cloned' || provider === 'inworld-generated') {
      try {
        await inworldTtsService.deleteVoice(voice_id);
        console.log(`[Delete] ✓ Voz "${voice_name}" (${voice_id}) eliminada de Inworld`);
      } catch (inworldError) {
        console.warn(`[Delete] Advertencia eliminando de Inworld: ${inworldError.message}`);
        // No rechazamos la solicitud si Inworld falla, pero lo registramos
      }
    }

    // Eliminar de la base de datos local
    const deleteResult = await pool.query(
      'DELETE FROM user_voices WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.userId]
    );

    if (isCountedVoiceType && userRole !== 'admin') {
      try {
        await ensureVoiceDeleteEventsTable();
        await pool.query(
          'INSERT INTO voice_delete_events (user_id, voice_name) VALUES ($1, $2)',
          [req.user.userId, voice_name]
        );
      } catch (eventErr) {
        console.warn('[Delete] No se pudo registrar evento de eliminación:', eventErr.message);
      }
    }

    console.log(`[Delete] ✓ Voz "${voice_name}" eliminada de la base de datos`);

    return res.json({ success: true, message: `Voz "${voice_name}" eliminada exitosamente` });
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
  // Clonar es GRATIS — solo se limita cuántas puede tener activas a la vez (puede eliminar y re-clonar libremente)
  const PLAN_NAMES = { free: 'Free', start: 'Start', creator: 'Creator', premium: 'Creator', pro: 'Pro', elite: 'Pro', admin: 'Admin' };
  try {
    const userResult = await pool.query('SELECT plan, role FROM users WHERE id = $1', [req.user.userId]);
    const userPlan = normalizePlan(userResult.rows[0]?.plan || 'free');
    const userRole = userResult.rows[0]?.role || 'user';

    if (userRole !== 'admin') {
      const maxVoices = CLONED_VOICE_LIMITS[userPlan] ?? 0;
      const planLabel = PLAN_NAMES[userPlan] || userPlan;

      // Contar solo voces clonadas activas
      const countResult = await pool.query(
        `SELECT COUNT(*) as total
         FROM user_voices
         WHERE user_id = $1
           AND LOWER(COALESCE(provider, '')) IN ('inworld', 'inworld-cloned', 'inworld-generated')`,
        [req.user.userId]
      );
      if (parseInt(countResult.rows[0].total) >= maxVoices) {
        return res.status(400).json({
          error: `Tu plan ${planLabel} permite máximo ${maxVoices} ${maxVoices === 1 ? 'voz clonada' : 'voces clonadas'} activas. Elimina una para crear otra.`
        });
      }
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
    const subscription = await subscriptionService.getSubscription(req.user.userId);
    return res.json({
      success: true,
      userId: user.id,
      email: user.email,
      currentPlan: user.plan || 'free',
      tokens: user.tokens,
      subscription
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
 * GET /api/settings/subscription - Estado de suscripción del usuario
 */
router.get('/subscription', verifyToken, async (req, res) => {
  try {
    const subscription = await subscriptionService.getSubscription(req.user.userId);
    return res.json({ success: true, subscription });
  } catch (error) {
    console.error('[Subscription] Error leyendo estado:', error.message);
    return res.status(500).json({ error: 'Error obteniendo suscripción' });
  }
});

/**
 * POST /api/settings/subscription/cancel - Cancelar al final del periodo
 */
router.post('/subscription/cancel', verifyToken, async (req, res) => {
  try {
    const subscription = await subscriptionService.cancelAtPeriodEnd(req.user.userId);
    return res.json({
      success: true,
      message: 'Cancelación programada. El acceso se mantiene hasta el final del periodo actual.',
      subscription
    });
  } catch (error) {
    console.error('[Subscription] Error cancelando:', error.message);
    return res.status(500).json({ error: 'No se pudo cancelar la suscripción' });
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
 * POST /api/settings/plan/update-by-email - Actualizar plan por email (solo admin)
 */
router.post('/plan/update-by-email', requireAdmin, async (req, res) => {
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

/**
 * PRIVADO: POST /api/settings/voices/add-to-user - Agregar voz a usuario específico
 * Solo funciona con API key privada, no se expone en frontend
 * Body: { email, voiceName, voiceId }
 */
router.post('/voices/add-to-user', async (req, res) => {
  const { email, voiceName, voiceId } = req.body;
  const adminKey = req.headers['x-admin-key'];

  // Verificar API key privada
  if (adminKey !== process.env.ADMIN_API_KEY) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  if (!email || !voiceName || !voiceId) {
    return res.status(400).json({ error: 'email, voiceName y voiceId requeridos' });
  }

  try {
    // Buscar usuario por email
    const userResult = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: `Usuario ${email} no encontrado` });
    }

    const userId = userResult.rows[0].id;

    // Agregar voz
    const result = await pool.query(
      `INSERT INTO user_voices (user_id, voice_name, voice_id, provider)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, voice_name) DO UPDATE SET voice_id = $3, provider = $4
       RETURNING id, voice_name, voice_id, provider, created_at`,
      [userId, voiceName, voiceId, 'inworld']
    );

    console.log(`[Admin] ✓ Voz "${voiceName}" agregada a ${email} (${userId})`);

    return res.status(201).json({
      success: true,
      voice: result.rows[0],
      message: `Voz "${voiceName}" agregada a ${email}`
    });
  } catch (error) {
    console.error('[Admin] Error agregando voz:', error.message);
    return res.status(500).json({ error: 'Error agregando voz' });
  }
});

export default router;
