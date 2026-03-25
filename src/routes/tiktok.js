import { Router } from 'express';
import tiktokLiveService from '../services/tiktokLiveService.js';
import googleTtsService from '../services/googleTtsService.js';

const router = Router();

/**
 * POST /api/tiktok/connect - Conectar a stream de TikTok
 */
router.post('/connect', async (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: 'username required' });
  }

  try {
    const stream = await tiktokLiveService.connectToStream(username, async (message) => {
      // Callback cuando llega un mensaje
      console.log(`[TikTok] Nuevo mensaje: ${message.username}: ${message.text}`);
    });

    return res.status(200).json({
      success: true,
      username,
      roomId: stream.roomId,
      message: 'Conectado al stream de TikTok'
    });
  } catch (error) {
    console.error('[TikTok] Error:', error.message);
    return res.status(400).json({
      error: error.message || 'Error conectando a TikTok'
    });
  }
});

/**
 * POST /api/tiktok/message - Agregar mensaje a procesar
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

    // Sintetizar el mensaje con ElevenLabs
    const synthesisResult = await googleTtsService.synthesize(
      messageText,
      voiceId || 'es-ES'
    );

    if (!synthesisResult.success) {
      return res.status(500).json({
        error: 'Error sintetizando mensaje'
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
    console.error('[TikTok] Error:', error.message);
    return res.status(500).json({
      error: error.message || 'Error procesando mensaje'
    });
  }
});

/**
 * GET /api/tiktok/status/:username - Estado del stream
 */
router.get('/status/:username', (req, res) => {
  const { username } = req.params;

  const status = tiktokLiveService.getStreamStatus(username);

  if (!status) {
    return res.status(404).json({ error: 'Stream no encontrado' });
  }

  return res.status(200).json({
    success: true,
    username,
    isConnected: status.isConnected,
    messageCount: status.messageCount,
    uptime: Date.now() - status.startTime
  });
});

/**
 * POST /api/tiktok/disconnect - Desconectar de stream
 */
router.post('/disconnect', (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: 'username required' });
  }

  tiktokLiveService.disconnectStream(username);

  return res.status(200).json({
    success: true,
    message: `Desconectado de @${username}`
  });
});

export default router;
