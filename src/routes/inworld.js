import { Router } from 'express';
import https from 'https';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import tokenService from '../services/tokenService.js';
import { verifyToken } from '../../middleware/auth.js';
import pool from '../db.js';
import audioCacheService from '../services/audioCacheService.js';

const router = Router();

function getRealtimeApiKey() {
  const apiKey = process.env.INWORLD_API_KEY;
  if (apiKey) {
    return apiKey;
  }

  const jwtKey = process.env.INWORLD_JWT_KEY;
  const jwtSecret = process.env.INWORLD_JWT_SECRET;

  if (jwtKey && jwtSecret) {
    return Buffer.from(`${jwtKey}:${jwtSecret}`).toString('base64');
  }

  return null;
}

function streamInworldAudio({ apiKey, text, mappedVoice, modelId }) {
  const requestBody = JSON.stringify({
    text,
    voiceId: mappedVoice,
    modelId,
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.inworld.ai',
      port: 443,
      path: '/tts/v1/voice:stream',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
      },
    };

    const httpsReq = https.request(options, (response) => {
      const chunks = [];

      response.on('data', (chunk) => {
        chunks.push(chunk);
      });

      response.on('end', () => {
        if (response.statusCode !== 200) {
          const errorText = Buffer.concat(chunks).toString('utf-8');
          return reject(new Error(`Status ${response.statusCode}: ${errorText.substring(0, 300)}`));
        }

        try {
          const dataStr = Buffer.concat(chunks).toString('utf-8');
          const allMatches = dataStr.match(/"audioContent"\s*:\s*"([^"]*(?:\\.[^"]*)*?)"/g) || [];

          if (allMatches.length === 0) {
            return reject(new Error('No audioContent in Inworld response'));
          }

          const audioChunks = [];
          for (const match of allMatches) {
            const contentMatch = match.match(/"audioContent"\s*:\s*"([^"]*(?:\\.[^"]*)*?)"/);
            if (!contentMatch?.[1]) continue;
            audioChunks.push(Buffer.from(contentMatch[1], 'base64'));
          }

          const audioBuffer = Buffer.concat(audioChunks);
          if (!audioBuffer.length) {
            return reject(new Error('Decoded audio buffer is empty'));
          }

          return resolve(audioBuffer);
        } catch (err) {
          return reject(err);
        }
      });
    });

    httpsReq.on('error', (err) => reject(err));
    httpsReq.write(requestBody);
    httpsReq.end();
  });
}

/**
 * POST /api/inworld/tts - Inworld Text-to-Speech
 * Hybrid cache strategy:
 * 1) hot memory cache
 * 2) persistent cache with timeout guard
 * 3) render immediately on miss/slow lookup
 */
router.post('/tts', async (req, res) => {
  try {
    const {
      text,
      voiceId,
      speed,
      pitch,
      emotion,
      style,
      modelVersion,
      modelId: requestedModelId
    } = req.body;

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

    const voiceMap = {
      'default-spanish': 'Diego',
      'default-english': 'Garret',
      'es-ES': 'Diego',
      'es-MX': 'Diego',
      'default': 'Diego'
    };
    const mappedVoice = voiceMap[voiceId] || voiceId || 'Diego';
    const resolvedModelId = requestedModelId || modelVersion || 'inworld-tts-1.5-max';

    let userId = null;
    let isAdmin = false;
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      try {
        const decoded = jwt.verify(token, config.JWT_SECRET);
        userId = decoded.userId;
        const userRow = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
        isAdmin = userRow.rows[0]?.role === 'admin';
      } catch (err) {
        console.warn('[Inworld TTS] Invalid token provided, continuing as guest.');
      }
    }

    const cacheContext = await audioCacheService.prepareContext({
      provider: 'inworld',
      userId,
      voiceId: mappedVoice,
      text,
      modelVersion: resolvedModelId,
      params: {
        speed,
        pitch,
        emotion,
        style,
        requestedVoiceId: voiceId
      }
    });

    const tokensNeeded = userId && !isAdmin
      ? tokenService.calculateTokensCost(String(text).length)
      : 0;

    if (userId && !isAdmin) {
      const hasEnough = await tokenService.hasEnoughTokens(userId, tokensNeeded);
      if (!hasEnough) {
        return res.status(402).json({
          error: 'token_insufficient',
          detail: 'No tienes suficientes tokens para sintetizar este mensaje. Puedes recargar desde el panel.'
        });
      }
    }

    const cacheHit = await audioCacheService.lookup(cacheContext);
    if (cacheHit.hit) {
      let remainingTokens = undefined;
      if (userId && !isAdmin && tokensNeeded > 0) {
        const deduction = await tokenService.deductTokens(
          userId,
          tokensNeeded,
          String(text).length,
          mappedVoice,
          'ptt_speech_cache'
        );
        remainingTokens = deduction.remainingTokens;
      }
      const base64Audio = cacheHit.audioBuffer.toString('base64');
      return res.status(200).json({
        success: true,
        audio: `data:${cacheHit.contentType};base64,${base64Audio}`,
        audioSize: cacheHit.audioBuffer.length,
        voiceId,
        characters: String(text).length,
        tokensUsed: userId && !isAdmin ? tokensNeeded : 0,
        ...(Number.isFinite(remainingTokens) ? { remainingTokens } : {}),
        cache: {
          hit: true,
          source: cacheHit.source,
          scope: cacheContext.scope,
          key: cacheContext.cacheKey,
        }
      });
    }

    audioCacheService.trackMetric({ rendered_requests: 1 });

    let audioBuffer;
    try {
      audioBuffer = await streamInworldAudio({
        apiKey,
        text: String(text),
        mappedVoice,
        modelId: resolvedModelId,
      });
    } catch (streamErr) {
      console.error('[Inworld TTS] Request error:', streamErr.message);
      return res.status(502).json({
        success: false,
        error: 'Inworld API error',
        detail: streamErr.message
      });
    }

    const base64Audio = audioBuffer.toString('base64');
    audioCacheService.storeAfterRender(cacheContext, audioBuffer, 'audio/mpeg').catch(() => {});

    if (userId && !isAdmin) {
      const deduction = await tokenService.deductTokens(
        userId,
        tokensNeeded,
        String(text).length,
        mappedVoice,
        'ptt_speech'
      );

      return res.status(200).json({
        success: true,
        audio: `data:audio/mpeg;base64,${base64Audio}`,
        audioSize: audioBuffer.length,
        voiceId,
        characters: String(text).length,
        tokensUsed: tokensNeeded,
        remainingTokens: deduction.remainingTokens,
        cache: {
          hit: false,
          scope: cacheContext.scope,
          key: cacheContext.cacheKey,
          cacheable: cacheContext.enabled,
        },
        estimatedCost: {
          mini: `$${(String(text).length / 1000000 * 5).toFixed(6)}`,
          max: `$${(String(text).length / 1000000 * 10).toFixed(6)}`
        }
      });
    }

    return res.status(200).json({
      success: true,
      audio: `data:audio/mpeg;base64,${base64Audio}`,
      audioSize: audioBuffer.length,
      voiceId,
      characters: String(text).length,
      tokensUsed: 0,
      cache: {
        hit: false,
        scope: cacheContext.scope,
        key: cacheContext.cacheKey,
        cacheable: cacheContext.enabled,
      },
      estimatedCost: {
        mini: `$${(String(text).length / 1000000 * 5).toFixed(6)}`,
        max: `$${(String(text).length / 1000000 * 10).toFixed(6)}`
      }
    });
  } catch (error) {
    console.error('[Inworld TTS] Error:', error.message);
    return res.status(500).json({
      error: 'Error en TTS',
      detail: error.message
    });
  }
});

/**
 * POST /api/inworld/realtime-usage - Charge tokens for push-to-talk realtime answers
 */
router.post('/realtime-usage', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const text = String(req.body?.text || '').trim();
    const voiceId = String(req.body?.voiceId || 'Clive').trim();

    if (!text) {
      return res.status(400).json({ error: 'text required' });
    }

    const userRow = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
    const isAdmin = userRow.rows[0]?.role === 'admin';

    const tokensNeeded = tokenService.calculateTokensCost(text.length);

    if (!isAdmin) {
      const hasEnough = await tokenService.hasEnoughTokens(userId, tokensNeeded);
      if (!hasEnough) {
        return res.status(402).json({
          error: 'token_insufficient',
          detail: 'No tienes suficientes tokens para respuesta realtime del asistente.'
        });
      }
    }

    const deduction = isAdmin
      ? { remainingTokens: 999999999 }
      : await tokenService.deductTokens(
          userId,
          tokensNeeded,
          text.length,
          voiceId || 'Clive',
          'ptt_realtime'
        );

    return res.status(200).json({
      success: true,
      tokensUsed: tokensNeeded,
      remainingTokens: deduction.remainingTokens
    });
  } catch (error) {
    console.error('[Inworld Realtime Usage] Error:', error.message);
    return res.status(500).json({
      error: 'Failed to record realtime usage',
      detail: error.message
    });
  }
});

/**
 * GET /api/inworld/config - Get WebRTC config (API key + ICE servers)
 */
router.get('/config', async (req, res) => {
  try {
    const realtimeApiKey = getRealtimeApiKey();

    if (!realtimeApiKey) {
      return res.status(500).json({
        error: 'INWORLD_API_KEY or INWORLD_JWT_KEY/INWORLD_JWT_SECRET not configured on server'
      });
    }

    let iceServers = [];
    try {
      const iceResponse = await fetch('https://api.inworld.ai/v1/realtime/ice-servers', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${realtimeApiKey}`
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
    }

    return res.status(200).json({
      api_key: realtimeApiKey,
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
    const apiKey = getRealtimeApiKey();

    if (!apiKey) {
      return res.status(500).json({
        error: 'INWORLD_API_KEY or INWORLD_JWT_KEY/INWORLD_JWT_SECRET not configured',
        hasKey: false
      });
    }

    const authHeader = `Bearer ${apiKey}`;

    console.log('[Inworld Test] Testing connection...');
    console.log('[Inworld Test] API Key length:', apiKey.length);
    console.log('[Inworld Test] Auth header preview:', authHeader.substring(0, 20) + '...');

    const response = await fetch('https://api.inworld.ai/v1/realtime/ice-servers', {
      method: 'GET',
      headers: {
        Authorization: authHeader
      }
    });

    console.log('[Inworld Test] Response status:', response.status);

    if (response.ok) {
      const data = await response.json();
      return res.status(200).json({
        success: true,
        message: 'Inworld Realtime API connection successful',
        iceServers: data.ice_servers?.length || 0
      });
    }

    const errorText = await response.text();
    try {
      const errorData = JSON.parse(errorText);
      return res.status(response.status).json({
        success: false,
        error: 'Inworld API test failed',
        status: response.status,
        detail: errorData
      });
    } catch (e) {
      return res.status(response.status).json({
        success: false,
        error: 'Inworld API test failed',
        status: response.status,
        detail: errorText.substring(0, 200)
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
