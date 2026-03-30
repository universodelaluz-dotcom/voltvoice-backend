import { Router } from 'express';
import https from 'https';
import jwt from 'jsonwebtoken';

const router = Router();

/**
 * POST /api/inworld/tts - Inworld Text-to-Speech
 * $5 per million characters
 * CRITICAL: Inworld retorna STREAMING JSON con múltiples audioContent chunks
 */
router.post('/tts', (req, res) => {
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

    // Mapear voiceIds del frontend a nombres reales de Inworld
    const voiceMap = {
      'default-spanish': 'Diego',
      'default-english': 'Garret',
      'es-ES': 'Diego',
      'es-MX': 'Diego',
      'default': 'Diego'
    };
    const mappedVoice = voiceMap[voiceId] || voiceId || 'Diego';

    console.log(`[Inworld TTS] Sintetizando: "${text.substring(0, 50)}..." (voz: ${voiceId} → ${mappedVoice})`);

    const requestBody = JSON.stringify({
      text: text,
      voiceId: mappedVoice,
      modelId: 'inworld-tts-1.5-max'
    });

    // API key from portal is already base64-encoded, use with Bearer token
    const options = {
      hostname: 'api.inworld.ai',
      port: 443,
      path: '/tts/v1/voice:stream',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
      },
    };

    const httpsReq = https.request(options, (response) => {
      const chunks = [];

      console.log(`[Inworld TTS] Response status: ${response.statusCode}`);

      response.on('data', (chunk) => {
        chunks.push(chunk);
      });

      response.on('end', () => {
        try {
          if (response.statusCode !== 200) {
            const dataBuffer = Buffer.concat(chunks);
            const errorText = dataBuffer.toString('utf-8');
            console.error(`[Inworld TTS] Error ${response.statusCode}: ${errorText.substring(0, 300)}`);
            return res.status(response.statusCode).json({
              error: `Inworld API error: ${response.statusCode}`,
              detail: errorText.substring(0, 200)
            });
          }

          const dataBuffer = Buffer.concat(chunks);
          const dataStr = dataBuffer.toString('utf-8');

          console.log(`[Inworld TTS] Respuesta recibida (${dataBuffer.length} bytes)`);

          // CRITICAL FIX: La respuesta es STREAMING JSON con MÚLTIPLES audioContent fields
          // Extraer TODOS y decodificar cada uno, luego concatenar los buffers binarios
          const allMatches = dataStr.match(/"audioContent"\s*:\s*"([^"]*(?:\\.[^"]*)*?)"/g) || [];
          console.log(`[Inworld TTS] Total audioContent fields: ${allMatches.length}`);

          if (allMatches.length === 0) {
            console.error(`[Inworld TTS] No audioContent encontrado en respuesta`);
            return res.status(500).json({
              error: 'No audioContent in response',
              detail: dataStr.substring(0, 300)
            });
          }

          // Decodificar CADA chunk y concatenar como binario
          const audioChunks = [];
          for (let i = 0; i < allMatches.length; i++) {
            const match = allMatches[i];
            const contentMatch = match.match(/"audioContent"\s*:\s*"([^"]*(?:\\.[^"]*)*?)"/);
            if (contentMatch && contentMatch[1]) {
              const base64Content = contentMatch[1];
              try {
                const chunk = Buffer.from(base64Content, 'base64');
                audioChunks.push(chunk);
                console.log(`[Inworld TTS] Chunk ${i + 1}: ${base64Content.length} chars → ${chunk.length} bytes`);
              } catch (e) {
                console.error(`[Inworld TTS] Error decodificando chunk ${i + 1}: ${e.message}`);
              }
            }
          }

          if (audioChunks.length === 0) {
            return res.status(500).json({
              error: 'Failed to decode audio chunks',
              detail: 'No valid base64 found'
            });
          }

          // Concatenar todos los chunks
          const audioBuffer = Buffer.concat(audioChunks);
          const base64Audio = audioBuffer.toString('base64');

          console.log(`[Inworld TTS] ✅ Audio completo: ${audioChunks.length} chunks → ${audioBuffer.length} bytes`);

          return res.status(200).json({
            success: true,
            audio: `data:audio/mpeg;base64,${base64Audio}`,
            audioSize: audioBuffer.length,
            voiceId: voiceId,
            characters: text.length,
            estimatedCost: {
              mini: `$${(text.length / 1000000 * 5).toFixed(6)}`,
              max: `$${(text.length / 1000000 * 10).toFixed(6)}`
            }
          });
        } catch (err) {
          console.error('[Inworld TTS] Error procesando respuesta:', err.message);
          return res.status(500).json({
            error: 'Error procesando respuesta',
            detail: err.message
          });
        }
      });
    });

    httpsReq.on('error', (err) => {
      console.error('[Inworld TTS] Request error:', err.message);
      return res.status(500).json({
        error: 'Request error',
        detail: err.message
      });
    });

    console.log(`[Inworld TTS] Enviando solicitud con voiceId: ${voiceId}`);
    httpsReq.write(requestBody);
    httpsReq.end();
  } catch (error) {
    console.error('[Inworld TTS] Error:', error.message);
    return res.status(500).json({
      error: 'Error en TTS',
      detail: error.message
    });
  }
});

/**
 * GET /api/inworld/config - Get WebRTC config (JWT token + ICE servers)
 * SECURE: JWT token generated on backend, API credentials never exposed to client
 */
router.get('/config', async (req, res) => {
  try {
    const jwtKey = process.env.INWORLD_JWT_KEY;
    const jwtSecret = process.env.INWORLD_JWT_SECRET;

    if (!jwtKey || !jwtSecret) {
      return res.status(500).json({
        error: 'INWORLD_JWT_KEY or INWORLD_JWT_SECRET not configured on server'
      });
    }

    // Use Basic Auth with JWT_KEY:JWT_SECRET
    const basicAuth = `Basic ${Buffer.from(`${jwtKey}:${jwtSecret}`).toString('base64')}`;

    console.log('[Inworld Config] Using Basic Auth for Inworld API');

    // Fetch ICE servers from Inworld
    let iceServers = [];
    try {
      const iceResponse = await fetch('https://api.inworld.ai/v1/realtime/ice-servers', {
        method: 'GET',
        headers: {
          'Authorization': basicAuth
        }
      });

      if (iceResponse.ok) {
        const iceData = await iceResponse.json();
        iceServers = iceData.ice_servers || [];
        console.log('[Inworld Config] Fetched ICE servers:', iceServers.length);
      } else {
        console.warn('[Inworld Config] Failed to fetch ICE servers:', iceResponse.status);
      }
    } catch (err) {
      console.warn('[Inworld Config] Error fetching ICE servers:', err.message);
      // Continue anyway - client can work without TURN servers
    }

    // Return config to client
    return res.status(200).json({
      api_key: basicAuth,  // Basic Auth token
      ice_servers: iceServers,
      url: 'https://api.inworld.ai/v1/realtime/calls',
      workspace_id: process.env.INWORLD_WORKSPACE_ID || 'default-cfjnp8x4nt-owd7yg-1xsw',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Inworld Config] Error:', error.message);
    return res.status(500).json({
      error: 'Failed to get config',
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
