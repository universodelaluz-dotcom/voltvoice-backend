import { Router } from 'express';
import https from 'https';
import gTTS from 'google-tts-api';
import tiktokLiveService from '../services/tiktokLiveService.js';
import inworldTtsService from '../services/inworldTtsService.js';

const router = Router();

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
  const { username } = req.params;

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

/**
 * POST /api/tiktok/connect - Conectar a stream de TikTok LIVE
 */
router.post('/connect', async (req, res) => {
  const { username } = req.body;

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
    return res.status(400).json({
      error: error.message || 'Error conectando a TikTok LIVE'
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
    // Agregar mensaje a la cola (no bloquear si no hay stream)
    tiktokLiveService.addMessage(username, {
      username: messageUsername || 'Usuario',
      text: messageText
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
      const url = gTTS.getAudioUrl(messageText, { lang, slow: false });
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
      synthesisResult = await inworldTtsService.synthesize(messageText, selectedVoiceId);
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
      text: messageText,
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
  const { username } = req.params;

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
  const { username } = req.body;

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
