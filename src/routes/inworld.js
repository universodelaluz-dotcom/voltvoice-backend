import { Router } from 'express';
import axios from 'axios';

const router = Router();

/**
 * POST /api/inworld/tts - Inworld Text-to-Speech
 * Proxy to Inworld AI API
 * $5 per million characters
 */
router.post('/tts', async (req, res) => {
  try {
    const { text, voiceId } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'text required' });
    }

    if (!voiceId) {
      return res.status(400).json({ error: 'voiceId required' });
    }

    const apiKey = process.env.INWORLD_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'INWORLD_API_KEY not configured' });
    }

    console.log(`[Inworld] Synthesizing: "${text.substring(0, 50)}..." with voice: ${voiceId}`);

    // Call Inworld API
    const authHeader = `Basic ${Buffer.from(apiKey).toString('base64')}`;

    const response = await axios.post(
      'https://api.inworld.ai/tts/v1/voice:stream',
      {
        text: text,
        voice_id: voiceId,
        model_id: 'inworld-tts-1.5-max',
        audio_config: {
          audio_encoding: 'MP3',
          speaking_rate: 1
        },
        temperature: 1
      },
      {
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer',
        timeout: 30000
      }
    );

    const audioBuffer = response.data;
    const base64 = Buffer.from(audioBuffer).toString('base64');

    return res.status(200).json({
      success: true,
      audio: `data:audio/mpeg;base64,${base64}`,
      audioSize: audioBuffer.length,
      voiceId: voiceId,
      characters: text.length,
      estimatedCost: {
        mini: `$${(text.length / 1000000 * 5).toFixed(6)}`,
        max: `$${(text.length / 1000000 * 10).toFixed(6)}`
      }
    });
  } catch (error) {
    console.error('[Inworld] Error:', error.message);

    if (error.response?.status === 401) {
      return res.status(401).json({
        error: 'Inworld authentication failed',
        detail: error.response.data
      });
    }

    return res.status(500).json({
      error: 'Error sintetizando con Inworld',
      detail: error.message
    });
  }
});

/**
 * GET /api/inworld/health - Health check
 */
router.get('/health', (req, res) => {
  const hasApiKey = !!process.env.INWORLD_API_KEY;
  return res.status(200).json({
    status: 'ok',
    service: 'Inworld TTS',
    apiKeyConfigured: hasApiKey,
    timestamp: new Date().toISOString()
  });
});

export default router;
