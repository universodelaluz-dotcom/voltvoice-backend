import express from 'express';
import { verifyToken } from '../middleware/auth.js';
import * as ttsService from '../services/tts.service.js';

const router = express.Router();

// TODO: Conectar a DB para guardar streams por usuario

/**
 * GET /api/streams - Lista streams del usuario
 */
router.get('/', verifyToken, async (req, res) => {
  try {
    // TODO: Obtener de DB según req.user.userId
    res.json({
      streams: [
        {
          id: 'demo-1',
          platform: 'tiktok',
          channel: '@demo_user',
          status: 'stopped',
          createdAt: new Date(),
        }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/streams - Crear nuevo stream
 */
router.post('/', verifyToken, async (req, res) => {
  try {
    const { platform, channel } = req.body;

    if (!platform || !channel) {
      return res.status(400).json({ error: 'Platform and channel required' });
    }

    // TODO: Validar que user no exceeda límite según su plan
    // TODO: Guardar en DB

    const streamId = Math.random().toString(36).substr(2, 9);

    res.json({
      success: true,
      stream: {
        id: streamId,
        platform,
        channel,
        status: 'idle',
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/tts/synthesize - Sintetizar texto a audio
 * Frontend envía texto, backend retorna URL descargable
 */
router.post('/tts/synthesize', verifyToken, async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'Text required' });
    }

    // Censurar
    const cleanText = ttsService.censorBadWords(text);

    // Obtener audio URL desde Google TTS
    const audioUrl = await ttsService.synthesizeText(cleanText);

    res.json({
      success: true,
      text: cleanText,
      audioUrl, // Frontend descarga desde aquí
    });
  } catch (err) {
    console.error('[TTS Error]', err);
    res.status(500).json({ error: 'TTS synthesis failed' });
  }
});

/**
 * GET /api/tts/preview - Escuchar preview de voz
 */
router.get('/tts/preview', verifyToken, async (req, res) => {
  try {
    const text = req.query.text || 'Hola, soy VoltVoice';

    const { buffer } = await ttsService.synthesizeAndDownload(text);

    res.set('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: 'Preview failed' });
  }
});

export default router;
