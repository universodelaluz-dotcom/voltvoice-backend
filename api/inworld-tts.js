// Vercel serverless function for Inworld TTS
// Text-to-Speech with voice cloning support
// Pricing: $5/million chars (Mini) or $10/million (Max)

import axios from 'axios';

const INWORLD_API_KEY = process.env.INWORLD_API_KEY;
const INWORLD_BASE_URL = 'https://api.inworld.ai/tts/v1';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { text, voiceId = 'default-spanish' } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'text required' });
    }

    if (!INWORLD_API_KEY) {
      return res.status(500).json({
        error: 'Inworld API key not configured',
        code: 'INWORLD_API_KEY_MISSING'
      });
    }

    console.log(`[Inworld TTS Vercel] Text: "${text.substring(0, 50)}..." Voice: ${voiceId}`);

    // Llamar a Inworld API
    const response = await axios.post(
      `${INWORLD_BASE_URL}/synthesize`,
      {
        text: text,
        voice_id: voiceId,
        model: 'tts-1.5-max',
        audio_format: 'mp3',
        speed: 1.0,
        pitch: 1.0
      },
      {
        headers: {
          'Authorization': `Bearer ${INWORLD_API_KEY}`,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer',
        timeout: 30000
      }
    );

    // Convertir a base64
    const audioBuffer = Buffer.from(response.data);
    const base64Audio = audioBuffer.toString('base64');
    const audioDataUrl = `data:audio/mpeg;base64,${base64Audio}`;

    console.log(`[Inworld TTS Vercel] Success: ${text.length} chars → ${audioBuffer.length} bytes`);

    return res.status(200).json({
      success: true,
      audio: audioDataUrl,
      contentType: 'audio/mpeg',
      characters: text.length,
      estimatedCost: {
        mini: `$${(text.length / 1000000 * 5).toFixed(6)}`,
        max: `$${(text.length / 1000000 * 10).toFixed(6)}`
      }
    });
  } catch (error) {
    console.error('[Inworld TTS Vercel] Error:', error.message);

    // Diferenciar errores
    if (error.response?.status === 401) {
      return res.status(401).json({
        error: 'Invalid Inworld API key',
        code: 'INWORLD_AUTH_FAILED'
      });
    }

    if (error.response?.status === 429) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        code: 'INWORLD_RATE_LIMITED'
      });
    }

    return res.status(500).json({
      error: error.message || 'Error sintetizando con Inworld',
      code: 'INWORLD_SYNTHESIS_ERROR'
    });
  }
}
