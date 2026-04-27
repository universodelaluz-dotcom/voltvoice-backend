import { Router } from 'express';
import https from 'https';
import jwt from 'jsonwebtoken';
import tiktokLiveService from '../services/tiktokLiveService.js';
import inworldTtsService from '../services/inworldTtsService.js';
import { requireAdmin, verifyToken } from '../../middleware/auth.js';
import { buildGoogleTtsUrl } from '../utils/googleTtsUrl.js';
import tokenService from '../services/tokenService.js';
import audioCacheService from '../services/audioCacheService.js';
import pool from '../db.js';
import { config } from '../config.js';

const router = Router();
const INWORLD_DEFAULT_MODEL = process.env.INWORLD_MODEL || 'inworld-tts-1.5-max';
const INWORLD_TTS_TEMPERATURE = (() => {
  const configured = Number(process.env.INWORLD_TTS_TEMPERATURE);
  if (!Number.isFinite(configured) || configured <= 0) return 0.7;
  return Math.min(2, Math.max(0.7, configured));
})();

const normalizeUsername = (username = '') => String(username || '').trim().toLowerCase().replace(/^@+/, '');
const RECENT_MESSAGE_DEDUPE_MS = 3000;
const recentMessageRequests = new Map();

const toBooleanFlag = (value) => value === true || value === 'true' || value === 1 || value === '1';
const normalizeTextForDedupe = (text = '') => String(text || '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const buildMessageDedupeKey = ({ username, messageUsername, messageText, voiceId }) => {
  return [
    normalizeUsername(username),
    normalizeUsername(messageUsername || 'Usuario'),
    normalizeTextForDedupe(messageText),
    String(voiceId || 'es-ES').trim()
  ].join('|');
};

const shouldSkipRecentDuplicate = (dedupeKey) => {
  const now = Date.now();
  const lastSeen = recentMessageRequests.get(dedupeKey);
  const isDuplicate = Number.isFinite(lastSeen) && (now - lastSeen) < RECENT_MESSAGE_DEDUPE_MS;

  recentMessageRequests.set(dedupeKey, now);

  if (recentMessageRequests.size > 4000) {
    const cutoff = now - RECENT_MESSAGE_DEDUPE_MS * 3;
    for (const [key, seenAt] of recentMessageRequests) {
      if (seenAt < cutoff) recentMessageRequests.delete(key);
    }
  }

  return isDuplicate;
};

const sanitizeRuntimeDetails = (details = {}) => {
  try {
    if (!details || typeof details !== 'object') return {};
    const trimmed = {};
    Object.entries(details).slice(0, 20).forEach(([key, value]) => {
      if (value == null) {
        trimmed[key] = value;
      } else if (typeof value === 'string') {
        trimmed[key] = value.slice(0, 500);
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        trimmed[key] = value;
      } else {
        const parsed = JSON.parse(JSON.stringify(value));
        trimmed[key] = typeof parsed === 'string' ? parsed.slice(0, 500) : parsed;
      }
    });
    return trimmed;
  } catch {
    return {};
  }
};

const logStreamRuntimeEvent = async ({
  userId = null,
  streamUsername = null,
  eventType = 'runtime_event',
  eventLevel = 'info',
  message = '',
  details = null
} = {}) => {
  try {
    await pool.query(
      `INSERT INTO stream_runtime_logs (user_id, stream_username, event_type, event_level, message, details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())`,
      [
        Number.isFinite(Number(userId)) ? Number(userId) : null,
        streamUsername ? normalizeUsername(streamUsername) : null,
        String(eventType || 'runtime_event').slice(0, 80),
        String(eventLevel || 'info').slice(0, 20),
        String(message || '').slice(0, 500),
        JSON.stringify(sanitizeRuntimeDetails(details || {}))
      ]
    );
  } catch (err) {
    console.warn('[TikTok] Warning stream_runtime_logs:', err.message);
  }
};

async function resolveOptionalAuthUser(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return { userId: null, isAdmin: false };
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, config.JWT_SECRET);
    const userId = decoded?.userId;
    if (!userId) return { userId: null, isAdmin: false };

    const userRow = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
    const isAdmin = userRow.rows[0]?.role === 'admin';
    return { userId, isAdmin };
  } catch {
    return { userId: null, isAdmin: false };
  }
}

const isNotLiveError = (message = '') => {
  const raw = String(message || '').trim();
  const normalized = raw.toLowerCase();
  return normalized.includes('offline')
    || normalized.includes('not found')
    || normalized.includes('user_not_found')
    || normalized.includes('live has ended')
    || normalized.includes('live ended')
    || normalized.includes("isn't online")
    || normalized.includes('isnt online')
    || normalized.includes('not online')
    || normalized.includes('room is not open')
    || normalized.includes('is not live')
    || normalized.includes('not currently live')
    || /^no se pudo conectar a @[^:]+:\s*$/i.test(raw);
};

/**
 * Normalizar Unicode para evitar homÃ³glifos y caracteres de evasiÃ³n
 * Detecta intentos de evasiÃ³n usando caracteres especiales (griegos, cirÃ­licos, CJK, etc.)
 */
const normalizeUnicode = (text) => {
  // Contar caracteres sospechosos antes de normalizar
  // Griegos, CirÃ­licos, Hiragana, Katakana, Kanji
  const suspiciousChars = text.match(/[\u0370-\u03FF\u0400-\u04FF\u3040-\u309F\u4E00-\u9FFF\u2000-\u206F\u2070-\u209F]/g) || []
  const suspiciousRatio = suspiciousChars.length / text.length

  // Si mÃ¡s del 30% son caracteres no-latinos sospechosos, marcar como riesgoso
  if (suspiciousRatio > 0.3) {
    return { text, suspicious: true, reason: 'Muchos caracteres especiales detectados', ratio: suspiciousRatio }
  }

  // Normalizar Unicode NFKD (descomponer caracteres)
  const normalized = text.normalize('NFKD')
    // Remover diacrÃ­ticos
    .replace(/[\u0300-\u036f]/g, '')
    // Reemplazar caracteres cirílicos/griegos/CJK comunes
    .replace(/[\u0400-\u04FF]/g, 'a')   // Cirílico
    .replace(/[\u0370-\u03FF]/g, 'a')   // Griego
    .replace(/[\u3040-\u309F]/g, 'a')   // Hiragana
    .replace(/[\u30A0-\u30FF]/g, 'a')   // Katakana
    .replace(/[\u4E00-\u9FFF]/g, 'a')   // Kanji

  const changed = normalized.toLowerCase() !== text.toLowerCase()

  return { text: normalized, suspicious: changed && suspiciousRatio > 0, reason: changed ? 'Caracteres Unicode normalizados' : null, ratio: suspiciousRatio }
}

// Add CORS headers for all TikTok routes
router.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

/**
 * GET /api/tiktok/status/:username - Verificar estado de conexiÃ³n
 */
router.get('/status/:username', (req, res) => {
  const username = normalizeUsername(req.params.username);

  try {
    const status = tiktokLiveService.getStreamStatus(username);

    return res.status(200).json({
      success: true,
      username,
      isConnected: !!status,
      status: status ? 'connected' : 'disconnected'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

router.get('/debug/:username', requireAdmin, (req, res) => {
  const username = normalizeUsername(req.params.username);

  if (!username) {
    return res.status(400).json({ error: 'username required' });
  }

  try {
    const limit = Number(req.query.limit || 25);
    const events = tiktokLiveService.getDebugEvents(username, limit);

    return res.status(200).json({
      success: true,
      username,
      count: events.length,
      events
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/tiktok/connect - Conectar a stream de TikTok LIVE
 */
router.post('/connect', async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  let runtimeUserId = null;

  if (!username) {
    return res.status(400).json({ error: 'username required' });
  }

  try {
    const { userId } = await resolveOptionalAuthUser(req);
    runtimeUserId = userId;
    await logStreamRuntimeEvent({
      userId: runtimeUserId,
      streamUsername: username,
      eventType: 'connect_request',
      eventLevel: 'info',
      message: 'Manual connect requested via API',
      details: { ip: req.ip || null }
    });

    // Verificar si ya estÃ¡ conectado
    const existing = tiktokLiveService.getStreamStatus(username);
    if (existing) {
      await logStreamRuntimeEvent({
        userId: runtimeUserId,
        streamUsername: username,
        eventType: 'connect_already_connected',
        eventLevel: 'info',
        message: 'Connect requested while stream already connected'
      });
      return res.status(200).json({
        success: true,
        username,
        message: 'Ya conectado a este stream',
        alreadyConnected: true
      });
    }

    // Conectar a TikTok LIVE
    const stream = await tiktokLiveService.connectToStream(username, (message) => {
      console.log(`[TikTok] Mensaje recibido: @${message.username}: ${message.text}`);
      // El WebSocket transmitirÃ¡ automÃ¡ticamente via registerClientCallback
    }, {
      onEvent: (event) => {
        logStreamRuntimeEvent({
          userId: runtimeUserId,
          streamUsername: username,
          eventType: event?.eventType || 'runtime_event',
          eventLevel: event?.eventLevel || 'info',
          message: event?.message || '',
          details: event?.details || null
        });
      }
    });

    return res.status(200).json({
      success: true,
      username,
      isConnected: stream.isConnected,
      messageCount: stream.messageCount,
      message: `Conectado al stream en vivo de @${username}`
    });
  } catch (error) {
    console.error('[TikTok] Error conectando:', error.message);
    const notLive = isNotLiveError(error.message);
    await logStreamRuntimeEvent({
      userId: runtimeUserId,
      streamUsername: username,
      eventType: 'connect_failed_api',
      eventLevel: notLive ? 'warn' : 'error',
      message: String(error.message || 'connect_failed').slice(0, 500),
      details: { notLive }
    });
    return res.status(notLive ? 409 : 400).json({
      error: error.message || 'Error conectando a TikTok LIVE',
      notLive,
      username
    });
  }
});

/**
 * POST /api/tiktok/message - Procesar y sintetizar mensaje manualmente
 */
router.post('/message', verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const userRow = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
  const isAdmin = userRow.rows[0]?.role === 'admin';
  const runtimeUserId = userId;

  const { username, messageUsername, messageText, voiceId } = req.body;

  // Log authentication status at start
  const isGoogleVoice = voiceId && (voiceId === 'es-ES' || voiceId === 'en-US');
  if (!isGoogleVoice && userId) {
    console.log(`[TikTok] AUTH OK - userId: ${userId}, voiceId: ${voiceId}, isAdmin: ${isAdmin}`);
  }
  const isPreGenerate = toBooleanFlag(req.body?.preGenerate);
  let inFlightRender = null;

  if (!username || !messageText) {
    return res.status(400).json({ error: 'username and messageText required' });
  }

  try {
    // Normalizar Unicode y detectar intentos de evasiÃ³n
    let processedText = messageText;
    const unicodeCheck = normalizeUnicode(messageText);

    if (unicodeCheck.suspicious) {
      console.warn(`[TikTok] âš ï¸ ALERTA: Mensaje sospechoso detectado`);
      console.warn(`[TikTok] Usuario: ${messageUsername}, Ratio: ${(unicodeCheck.ratio * 100).toFixed(1)}%`);
      console.warn(`[TikTok] Original: "${messageText.substring(0, 100)}..."`);
      console.warn(`[TikTok] RazÃ³n: ${unicodeCheck.reason}`);
      // Usar el texto normalizado
      processedText = unicodeCheck.text;
    } else if (unicodeCheck.text !== messageText) {
      // Si hay normalizaciÃ³n pero no es sospechoso, usar el texto normalizado
      processedText = unicodeCheck.text;
    }

    // Solo encolar en requests "reales"; pre-generación y duplicados recientes no deben duplicar lectura.
    if (!isPreGenerate) {
      const dedupeKey = buildMessageDedupeKey({
        username,
        messageUsername: messageUsername || 'Usuario',
        messageText: processedText,
        voiceId
      });

      if (shouldSkipRecentDuplicate(dedupeKey)) {
        console.log(`[TikTok] Duplicado reciente omitido en cola: @${messageUsername || 'Usuario'}`);
      } else {
        tiktokLiveService.addMessage(username, {
          username: messageUsername || 'Usuario',
          text: processedText
        });
      }
    }

    // Voces gratuitas usan Google TTS, el resto usa Inworld premium
    const freeVoices = { 'es-ES': 'es-MX', 'en-US': 'en-US' };
    const selectedVoiceId = voiceId || 'es-ES';
    const isGoogleVoice = freeVoices.hasOwnProperty(selectedVoiceId);

    let fallbackToLocal = false;
    let fallbackReason = null;
    let tokensNeeded = 0;
    let cacheContext = null;

    if (!isGoogleVoice) {
      if (!isAdmin) {
        tokensNeeded = tokenService.calculateTokensCost(String(processedText).length);
        const hasEnough = await tokenService.hasEnoughTokens(userId, tokensNeeded);
        if (!hasEnough) {
          fallbackToLocal = true;
          fallbackReason = 'token_insufficient';
        }
      }
    }

    if (!fallbackToLocal) {
      cacheContext = await audioCacheService.prepareContext({
        provider: isGoogleVoice ? 'local' : 'inworld',
        userId,
        voiceId: selectedVoiceId,
        text: processedText,
        modelVersion: isGoogleVoice
          ? 'google-translate-tts-v1'
          : INWORLD_DEFAULT_MODEL,
        params: {
          source: 'tiktok_live',
          requestedVoiceId: selectedVoiceId,
          temperature: INWORLD_TTS_TEMPERATURE
        }
      });

      const cacheHit = await audioCacheService.lookup(cacheContext);
      if (cacheHit.hit) {
        if (!isGoogleVoice && tokensNeeded > 0) {
          if (userId && !isAdmin) {
            console.log(`[TikTok] CACHE HIT - DEDUCIENDO TOKENS - userId: ${userId}, tokens: ${tokensNeeded}`);
            await tokenService.deductTokens(
              userId,
              tokensNeeded,
              String(processedText).length,
              selectedVoiceId,
              'tiktok_live_cache'
            );
            console.log(`[TikTok] CACHE HIT - TOKENS DEDUCIDOS EXITOSAMENTE`);
          } else if (!userId) {
            console.warn(`[TikTok] ⚠️ CACHE HIT - NO USERID PARA DEDUCIR TOKENS (voiceId: ${selectedVoiceId}, tokensNeeded: ${tokensNeeded})`);
          }
        }

        const base64Audio = cacheHit.audioBuffer.toString('base64');
        return res.status(200).json({
          success: true,
          audio: `data:${cacheHit.contentType || 'audio/mpeg'};base64,${base64Audio}`,
          contentType: cacheHit.contentType || 'audio/mpeg',
          text: processedText,
          user: messageUsername || 'Usuario',
          fallback: false,
          fallbackReason: null,
          useLocalVoice: false,
          fallbackVoiceId: null,
          tokensUsed: (!isGoogleVoice && userId && !isAdmin) ? tokensNeeded : 0,
          cache: {
            hit: true,
            source: cacheHit.source,
            scope: cacheContext.scope,
            key: cacheContext.cacheKey
          }
        });
      }

      const inFlight = audioCacheService.claimInFlightRender(cacheContext?.cacheKey);
      inFlightRender = inFlight.isOwner ? inFlight : null;
      if (!inFlight.isOwner) {
        const waitTimeoutMs = Math.max(
          250,
          Math.min(2500, Number(cacheContext?.settings?.lookupTimeoutMs || 35) * 35)
        );
        try {
          await Promise.race([
            inFlight.wait,
            new Promise((resolve) => setTimeout(resolve, waitTimeoutMs)),
          ]);
        } catch {
          // If owner render fails, continue normal flow.
        }

        const postWaitHit = await audioCacheService.lookup(cacheContext);
        if (postWaitHit.hit) {
          if (!isGoogleVoice && tokensNeeded > 0) {
            if (userId && !isAdmin) {
              console.log(`[TikTok] POST-WAIT CACHE HIT - DEDUCIENDO TOKENS - userId: ${userId}, tokens: ${tokensNeeded}`);
              await tokenService.deductTokens(
                userId,
                tokensNeeded,
                String(processedText).length,
                selectedVoiceId,
                'tiktok_live_cache'
              );
              console.log(`[TikTok] POST-WAIT CACHE HIT - TOKENS DEDUCIDOS EXITOSAMENTE`);
            } else if (!userId) {
              console.warn(`[TikTok] ⚠️ POST-WAIT CACHE HIT - NO USERID PARA DEDUCIR TOKENS (voiceId: ${selectedVoiceId}, tokensNeeded: ${tokensNeeded})`);
            }
          }

          const base64Audio = postWaitHit.audioBuffer.toString('base64');
          return res.status(200).json({
            success: true,
            audio: `data:${postWaitHit.contentType || 'audio/mpeg'};base64,${base64Audio}`,
            contentType: postWaitHit.contentType || 'audio/mpeg',
            text: processedText,
            user: messageUsername || 'Usuario',
            fallback: false,
            fallbackReason: null,
            useLocalVoice: false,
            fallbackVoiceId: null,
            tokensUsed: (!isGoogleVoice && userId && !isAdmin) ? tokensNeeded : 0,
            cache: {
              hit: true,
              source: `inflight_${postWaitHit.source}`,
              scope: cacheContext.scope,
              key: cacheContext.cacheKey
            }
          });
        }
      }
    }

    let synthesisResult;

    if (isGoogleVoice) {
      audioCacheService.trackMetric({ rendered_requests: 1 });
      // Google TTS gratuito
      const lang = freeVoices[selectedVoiceId];
      console.log(`[TikTok] Sintetizando con Google TTS - lang: ${lang}`);
      const url = buildGoogleTtsUrl(processedText, lang);
      const audioBuffer = await new Promise((resolve, reject) => {
        https.get(url, (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
      });
      synthesisResult = { audio: audioBuffer, contentType: 'audio/mpeg' };
    } else if (fallbackToLocal) {
      // Cuando faltan tokens o auth para premium/clonada, el fallback debe ser voz local real del navegador.
      // No renderizamos Google TTS para evitar confusión de voz y mantener coherencia con "voz local".
      synthesisResult = { audio: null, contentType: null, useLocalVoice: true, fallbackVoiceId: 'es-ES' };
    } else {
      audioCacheService.trackMetric({ rendered_requests: 1 });
      // Inworld premium TTS
      console.log(`[TikTok] Sintetizando con Inworld TTS - voiceId: ${selectedVoiceId}, userId: ${userId}, isAdmin: ${isAdmin}, tokensNeeded: ${tokensNeeded}`);
      synthesisResult = await inworldTtsService.synthesize(processedText, selectedVoiceId);

      if (userId && !isAdmin && tokensNeeded > 0) {
        console.log(`[TikTok] DEDUCIENDO TOKENS - userId: ${userId}, tokens: ${tokensNeeded}, texto length: ${String(processedText).length}`);
        await tokenService.deductTokens(
          userId,
          tokensNeeded,
          String(processedText).length,
          selectedVoiceId,
          'tiktok_live'
        );
        console.log(`[TikTok] TOKENS DEDUCIDOS EXITOSAMENTE`);
      } else {
        const reason = !userId ? 'NO_USERID' : isAdmin ? 'IS_ADMIN' : 'NO_TOKENS_NEEDED';
        console.warn(`[TikTok] ⚠️ NO SE DEDUJERON TOKENS - userId: ${userId}, isAdmin: ${isAdmin}, tokensNeeded: ${tokensNeeded}, reason: ${reason}`);
      }
    }

    if (!fallbackToLocal && cacheContext && Buffer.isBuffer(synthesisResult?.audio)) {
      audioCacheService.storeAfterRender(cacheContext, synthesisResult.audio, synthesisResult.contentType || 'audio/mpeg').catch(() => {});
    }

    // Convertir Buffer a base64 data URL para el frontend
    let audioDataUrl;
    if (Buffer.isBuffer(synthesisResult.audio)) {
      const base64 = synthesisResult.audio.toString('base64');
      audioDataUrl = `data:${synthesisResult.contentType || 'audio/mpeg'};base64,${base64}`;
    } else if (typeof synthesisResult.audio === 'string') {
      audioDataUrl = synthesisResult.audio;
    } else {
      audioDataUrl = null;
    }

    // Registrar uso de lectura de chat incluso cuando no consume tokens
    // (voces locales directas o fallback por falta de tokens).
    if (userId && (isGoogleVoice || fallbackToLocal)) {
      await pool.query(
        `INSERT INTO token_logs (user_id, action, tokens_used, characters_count, voice_name)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          userId,
          fallbackToLocal ? 'tiktok_local_fallback' : 'tiktok_local',
          0,
          String(processedText).length,
          isGoogleVoice ? selectedVoiceId : 'es-ES'
        ]
      ).catch((logErr) => {
        console.warn('[TikTok] Warning logging local usage:', logErr.message);
      });
    }

    try { inFlightRender?.release(); } catch {}
    return res.status(200).json({
      success: true,
      audio: audioDataUrl,
      contentType: synthesisResult.contentType,
      text: processedText,
      user: messageUsername || 'Usuario',
      fallback: fallbackToLocal,
      fallbackReason,
      useLocalVoice: fallbackToLocal,
      fallbackVoiceId: fallbackToLocal ? 'es-ES' : null,
      tokensUsed: (!fallbackToLocal && !isGoogleVoice) ? tokensNeeded : 0,
      cache: {
        hit: false,
        scope: cacheContext?.scope || null,
        key: cacheContext?.cacheKey || null,
        cacheable: cacheContext?.enabled || false
      }
    });
  } catch (error) {
    try { inFlightRender?.release(error); } catch {}
    console.error('[TikTok] Error procesando mensaje:', error);
    await logStreamRuntimeEvent({
      userId: runtimeUserId,
      streamUsername: username,
      eventType: 'message_processing_error',
      eventLevel: 'error',
      message: String(error?.message || 'message_processing_error').slice(0, 500),
      details: {
        messageUsername: messageUsername || null,
        voiceId: voiceId || null
      }
    });
    return res.status(500).json({
      error: error.message || 'Error procesando mensaje',
      details: error.toString()
    });
  }
});

/**
 * GET /api/tiktok/status/:username - Obtener estado del stream
 */
router.get('/status/:username', (req, res) => {
  const username = normalizeUsername(req.params.username);

  const status = tiktokLiveService.getStreamStatus(username);

  if (!status) {
    return res.status(404).json({ error: 'Stream no encontrado' });
  }

  return res.status(200).json({
    success: true,
    username: status.username,
    isConnected: status.isConnected,
    messageCount: status.messageCount,
    uptime: Math.floor((status.uptime || 0) / 1000) // En segundos
  });
});

/**
 * POST /api/tiktok/disconnect - Desconectar del stream
 */
router.post('/disconnect', async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  let runtimeUserId = null;

  if (!username) {
    return res.status(400).json({ error: 'username required' });
  }

  try {
    const { userId } = await resolveOptionalAuthUser(req);
    runtimeUserId = userId;
    await logStreamRuntimeEvent({
      userId: runtimeUserId,
      streamUsername: username,
      eventType: 'disconnect_request',
      eventLevel: 'info',
      message: 'Manual disconnect requested via API'
    });
    await tiktokLiveService.disconnectStream(username);
    await logStreamRuntimeEvent({
      userId: runtimeUserId,
      streamUsername: username,
      eventType: 'disconnect_success',
      eventLevel: 'info',
      message: 'Stream disconnected manually'
    });

    return res.status(200).json({
      success: true,
      message: `Desconectado de @${username}`
    });
  } catch (error) {
    console.error('[TikTok] Error desconectando:', error.message);
    await logStreamRuntimeEvent({
      userId: runtimeUserId,
      streamUsername: username,
      eventType: 'disconnect_failed',
      eventLevel: 'error',
      message: String(error.message || 'disconnect_failed').slice(0, 500)
    });
    return res.status(400).json({
      error: error.message || 'Error desconectando'
    });
  }
});

/**
 * GET /api/tiktok/stats - EstadÃ­sticas del servidor
 */
router.get('/stats', (req, res) => {
  const streams = tiktokLiveService.getActiveStreams();

  return res.status(200).json({
    success: true,
    activeStreams: streams.length,
    streams: streams.map(s => ({
      username: s.username,
      isConnected: s.isConnected,
      messageCount: s.messageCount,
      uptime: Math.floor((s.startTime ? Date.now() - s.startTime : 0) / 1000)
    }))
  });
});

/**
 * GET /api/tiktok/test-inworld - Probar si Inworld funciona
 */
router.get('/test-inworld', async (req, res) => {
  try {
    const keyPreview = process.env.INWORLD_API_KEY
      ? process.env.INWORLD_API_KEY.substring(0, 10) + '...'
      : 'NOT SET';

    console.log(`[Test] INWORLD_API_KEY starts with: ${keyPreview}`);

    const result = await inworldTtsService.synthesize('prueba de voz', 'Diego');

    return res.status(200).json({
      success: true,
      keyPreview,
      audioSize: result.audio ? result.audio.length : 0,
      message: 'Inworld TTS funciona correctamente'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      keyPreview: process.env.INWORLD_API_KEY
        ? process.env.INWORLD_API_KEY.substring(0, 10) + '...'
        : 'NOT SET',
      error: error.message
    });
  }
});

export default router;

