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

    // Call Inworld API with correct endpoint format
    const authHeader = `Basic ${Buffer.from(apiKey).toString('base64')}`;

    console.log(`[Inworld] Auth header: Basic ${apiKey.substring(0, 10)}...`);

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
        responseType: 'text', // Get as text first to parse JSON
        timeout: 30000,
        validateStatus: () => true // Don't throw on any status
      }
    );

    console.log(`[Inworld] Response status: ${response.status}`);

    if (response.status !== 200) {
      console.error(`[Inworld] API error: ${response.status}`);
      let errorMsg = 'Unknown error';
      try {
        const errorData = JSON.parse(response.data);
        errorMsg = JSON.stringify(errorData);
      } catch (e) {
        errorMsg = response.data.substring(0, 200);
      }

      return res.status(response.status || 500).json({
        error: 'Inworld API error',
        status: response.status,
        detail: errorMsg
      });
    }

    // Parse JSON response
    let jsonData;
    try {
      jsonData = JSON.parse(response.data);
    } catch (e) {
      console.error(`[Inworld] Failed to parse response as JSON:`, e.message);
      return res.status(500).json({
        error: 'Invalid response from Inworld API',
        detail: response.data.substring(0, 200)
      });
    }

    // Extract audio content from result.audioContent
    let base64Audio = null;
    if (jsonData.result && jsonData.result.audioContent) {
      base64Audio = jsonData.result.audioContent;
    } else {
      console.error(`[Inworld] No audioContent in response. Keys:`, Object.keys(jsonData));
      return res.status(500).json({
        error: 'No audioContent in Inworld response',
        detail: 'Response structure mismatch'
      });
    }

    // Decode base64 to buffer
    const audioBuffer = Buffer.from(base64Audio, 'base64');

    console.log(`[Inworld] Success: ${text.length} chars → ${audioBuffer.length} bytes`);

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

/**
 * POST /api/inworld/test - Test Inworld connection
 */
router.post('/test', async (req, res) => {
  try {
    const apiKey = process.env.INWORLD_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: 'INWORLD_API_KEY not configured',
        hasKey: false
      });
    }

    const authHeader = `Basic ${Buffer.from(apiKey).toString('base64')}`;

    console.log('[Inworld Test] Testing connection...');
    console.log('[Inworld Test] API Key length:', apiKey.length);
    console.log('[Inworld Test] Auth header preview:', authHeader.substring(0, 20) + '...');

    const response = await axios.post(
      'https://api.inworld.ai/tts/v1/voice:stream',
      {
        text: 'Test message',
        voice_id: 'default-cfjnp8x4nt-owd7yg-1xsw__garret',
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
        responseType: 'text',
        timeout: 30000,
        validateStatus: () => true
      }
    );

    console.log('[Inworld Test] Response status:', response.status);

    if (response.status === 200) {
      try {
        const jsonData = JSON.parse(response.data);
        if (jsonData.result && jsonData.result.audioContent) {
          const audioBuffer = Buffer.from(jsonData.result.audioContent, 'base64');
          return res.status(200).json({
            success: true,
            message: 'Inworld API connection successful',
            audioSize: audioBuffer.length,
            voiceId: 'default-cfjnp8x4nt-owd7yg-1xsw__garret'
          });
        }
      } catch (e) {
        console.error('[Inworld Test] Parse error:', e.message);
      }

      return res.status(500).json({
        success: false,
        error: 'Invalid response format',
        detail: response.data.substring(0, 200)
      });
    } else {
      let errorText = '';
      try {
        const errorData = JSON.parse(response.data);
        errorText = JSON.stringify(errorData);
      } catch (e) {
        errorText = response.data.substring(0, 200);
      }

      return res.status(response.status).json({
        success: false,
        error: 'Inworld API test failed',
        status: response.status,
        detail: errorText
      });
    }
  } catch (error) {
    console.error('[Inworld Test] Error:', error.message);
    return res.status(500).json({
      error: 'Test failed',
      message: error.message
    });
  }
});

export default router;
