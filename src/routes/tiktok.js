import { Router } from 'express';
import https from 'https';
import gTTS from 'google-tts-api';
import tiktokLiveService from '../services/tiktokLiveService.js';
import inworldTtsService from '../services/inworldTtsService.js';

const router = Router();

const normalizeUsername = (username = '') => String(username || '').trim().replace(/^@+/, '');

const isNotLiveError = (message = '') => {
  const normalized = String(message || '').toLowerCase();
  return normalized.includes('offline')
    || normalized.includes('not found')
    || normalized.includes('user_not_found')
    || normalized.includes('live has ended')
    || normalized.includes('live ended')
    || normalized.includes('room is not open')
    || normalized.includes('is not live')
    || normalized.includes('not currently live');
};

/**
 * Normalizar Unicode para evitar homóglifos y caracteres de evasión
 * Detecta intentos de evasión usando caracteres especiales (griegos, cirílicos, CJK, etc.)
 */
const normalizeUnicode = (text) => {
  // Contar caracteres sospechosos antes de normalizar
  // Griegos, Cirílicos, Hiragana, Katakana, Kanji
  const suspiciousChars = text.match(/[\u0370-\u03FF\u0400-\u04FF\u3040-\u309F\u4E00-\u9FFF\u2000-\u206F\u2070-\u209F]/g) || []
  const suspiciousRatio = suspiciousChars.length / text.length

  // Si más del 30% son caracteres no-latinos sospechosos, marcar como riesgoso
  if (suspiciousRatio > 0.3) {
    return { text, suspicious: true, reason: 'Muchos caracteres especiales detectados', ratio: suspiciousRatio }
  }

  // Normalizar Unicode NFKD (descomponer caracteres)
  const normalized = text.normalize('NFKD')
    // Remover diacríticos
    .replace(/[\u0300-\u036f]/g, '')
    // Reemplazar caracteres cirilicos/griegos/CJK comunes
    .replace(/[а-яЁё]/g, 'a')   // Cirílico
    .replace(/[α-ω]/g, 'a')     // Griego
    .replace(/[ぁ-ん]/g, 'a')    // Hiragana
    .replace(/[ァ-ン]/g, 'a')    // Katakana
    .replace(/[一-龯]/g, 'a')    // Kanji

  const changed = normalized.toLowerCase() !== text.toLowerCase()

  return { text: normalized, suspicious: changed && suspiciousRatio > 0, reason: changed ? 'Caracteres Unicode normalizados' : null, ratio: suspiciousRatio }
}

// Add CORS headers for all TikTok routes
router.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

/**
 * GET /api/tiktok/status/:username - Verificar estado de conexión
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

router.get('/debug/:username', (req, res) => {
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

  if (!username) {
    return res.status(400).json({ error: 'username required' });
  }

  try {
    // Verificar si ya está conectado
    const existing = tiktokLiveService.getStreamStatus(username);
    if (existing) {
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
      // El WebSocket transmitirá automáticamente via registerClientCallback
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
router.post('/message', async (req, res) => {
  const { username, messageUsername, messageText, voiceId } = req.body;

  if (!username || !messageText) {
    return res.status(400).json({ error: 'username and messageText required' });
  }

  try {
    // Normalizar Unicode y detectar intentos de evasión
    let processedText = messageText;
    const unicodeCheck = normalizeUnicode(messageText);

    if (unicodeCheck.suspicious) {
      console.warn(`[TikTok] ⚠️ ALERTA: Mensaje sospechoso detectado`);
      console.warn(`[TikTok] Usuario: ${messageUsername}, Ratio: ${(unicodeCheck.ratio * 100).toFixed(1)}%`);
      console.warn(`[TikTok] Original: "${messageText.substring(0, 100)}..."`);
      console.warn(`[TikTok] Razón: ${unicodeCheck.reason}`);
      // Usar el texto normalizado
      processedText = unicodeCheck.text;
    } else if (unicodeCheck.text !== messageText) {
      // Si hay normalización pero no es sospechoso, usar el texto normalizado
      processedText = unicodeCheck.text;
    }

    // Agregar mensaje a la cola (no bloquear si no hay stream)
    tiktokLiveService.addMessage(username, {
      username: messageUsername || 'Usuario',
      text: processedText
    });

    // Voces gratuitas usan Google TTS, el resto usa Inworld premium
    const freeVoices = { 'es-ES': 'es-MX', 'en-US': 'en-US' };
    const selectedVoiceId = voiceId || 'es-ES';
    const isGoogleVoice = freeVoices.hasOwnProperty(selectedVoiceId);

    let synthesisResult;

    if (isGoogleVoice) {
      // Google TTS gratuito
      const lang = freeVoices[selectedVoiceId];
      console.log(`[TikTok] Sintetizando con Google TTS - lang: ${lang}`);
      const url = gTTS.getAudioUrl(processedText, { lang, slow: false });
      const audioBuffer = await new Promise((resolve, reject) => {
        https.get(url, (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
      });
      synthesisResult = { audio: audioBuffer, contentType: 'audio/mpeg' };
    } else {
      // Inworld premium TTS
      console.log(`[TikTok] Sintetizando con Inworld TTS - voiceId: ${selectedVoiceId}`);
      synthesisResult = await inworldTtsService.synthesize(processedText, selectedVoiceId);
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

    return res.status(200).json({
      success: true,
      audio: audioDataUrl,
      contentType: synthesisResult.contentType,
      text: processedText,
      user: messageUsername || 'Usuario'
    });
  } catch (error) {
    console.error('[TikTok] Error procesando mensaje:', error);
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

  if (!username) {
    return res.status(400).json({ error: 'username required' });
  }

  try {
    await tiktokLiveService.disconnectStream(username);

    return res.status(200).json({
      success: true,
      message: `Desconectado de @${username}`
    });
  } catch (error) {
    console.error('[TikTok] Error desconectando:', error.message);
    return res.status(400).json({
      error: error.message || 'Error desconectando'
    });
  }
});

/**
 * GET /api/tiktok/stats - Estadísticas del servidor
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
