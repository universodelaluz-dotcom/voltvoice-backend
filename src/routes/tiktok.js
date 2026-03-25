import { Router } from 'express';
import tiktokLiveService from '../services/tiktokLiveService.js';
import simpleTtsService from '../services/espeak-tts-service.js';
import elevenLabsService from '../services/elevenLabsService.js';

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
    // Agregar mensaje a la cola
    const message = tiktokLiveService.addMessage(username, {
      username: messageUsername || 'Usuario',
      text: messageText
    });

    if (!message) {
      return res.status(404).json({ error: 'Stream no encontrado' });
    }

    // Determinar qué servicio usar
    const selectedVoiceId = voiceId || 'es-ES';
    const isElevenLabs = selectedVoiceId.length > 5; // IDs de ElevenLabs son más largos

    console.log(`[TikTok] Sintetizando con voiceId: ${selectedVoiceId}, isElevenLabs: ${isElevenLabs}`);

    let synthesisResult;
    try {
      if (isElevenLabs) {
        console.log('[TikTok] Usando ElevenLabs service');
        synthesisResult = await elevenLabsService.synthesize(messageText, selectedVoiceId);
      } else {
        console.log('[TikTok] Usando Simple TTS service (Google Translate)');
        synthesisResult = await simpleTtsService.synthesize(messageText, selectedVoiceId);
      }
    } catch (synthError) {
      console.error('[TikTok] Synthesis error:', synthError);
      // Fallback a Simple TTS
      console.log('[TikTok] Fallback a Simple TTS');
      synthesisResult = await simpleTtsService.synthesize(messageText, 'es-ES');
    }

    if (!synthesisResult || !synthesisResult.success) {
      console.error('[TikTok] Synthesis result invalid:', synthesisResult);
      return res.status(500).json({
        error: 'Error sintetizando mensaje',
        details: synthesisResult
      });
    }

    return res.status(200).json({
      success: true,
      messageId: message.id,
      audio: synthesisResult.audio,
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

export default router;
