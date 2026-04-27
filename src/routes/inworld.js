import { Router } from 'express';
import https from 'https';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import { config } from '../config.js';

// Point fluent-ffmpeg to the bundled binaries (works on any server including Render)
ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeInstaller.path);
import tokenService from '../services/tokenService.js';
import { verifyToken } from '../../middleware/auth.js';
import pool from '../db.js';
import audioCacheService from '../services/audioCacheService.js';
import inworldTtsService from '../services/inworldTtsService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STUDIO_PRO_DIR = path.join(__dirname, '../../tmp/studio-pro');
const UPLOAD_DIR = path.join(STUDIO_PRO_DIR, 'uploads');

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Multer configuration for file uploads (150MB max)
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const fileId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const ext = path.extname(file.originalname);
      cb(null, `${fileId}${ext}`);
    }
  }),
  limits: { fileSize: 150 * 1024 * 1024 }, // 150MB
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav',
      'video/mp4', 'video/x-msvideo', 'video/quicktime', 'video/x-matroska'
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Formato de archivo no soportado'));
    }
  }
});

const router = Router();

const EXTRACTOR_PRO_DAILY_LIMITS = {
  creator: 4,
  pro: 7,
  admin: 999,
};

const INWORLD_DEFAULT_MODEL = process.env.INWORLD_MODEL || 'inworld-tts-1.5-max';
const INWORLD_MIN_TEMPERATURE = 0.7;
const INWORLD_MAX_TEMPERATURE = 2.0;
const INWORLD_TTS_TEMPERATURE = (() => {
  const configured = Number(process.env.INWORLD_TTS_TEMPERATURE);
  if (!Number.isFinite(configured) || configured <= 0) return INWORLD_MIN_TEMPERATURE;
  return Math.min(INWORLD_MAX_TEMPERATURE, Math.max(INWORLD_MIN_TEMPERATURE, configured));
})();

const ensureExtractorProUsageTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS extractor_pro_usage_events (
      id BIGSERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_extractor_pro_usage_user_created
      ON extractor_pro_usage_events(user_id, created_at DESC);
  `);
};

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

function streamInworldAudio({ apiKey, text, mappedVoice, modelId, temperature = INWORLD_TTS_TEMPERATURE }) {
  const requestBody = JSON.stringify({
    text,
    voiceId: mappedVoice,
    modelId,
    temperature,
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

          console.log(`[Inworld TTS] audioContent fields found: ${allMatches.length}`);

          const audioChunks = [];
          let totalDecodedBytes = 0;
          for (let i = 0; i < allMatches.length; i++) {
            const contentMatch = allMatches[i].match(/"audioContent"\s*:\s*"([^"]*(?:\\.[^"]*)*?)"/);
            if (!contentMatch?.[1]) {
              console.log(`[Inworld TTS] Chunk ${i}: Extraction failed`);
              continue;
            }
            try {
              const decodedChunk = Buffer.from(contentMatch[1], 'base64');
              console.log(`[Inworld TTS] Chunk ${i}: ${decodedChunk.length} bytes`);
              audioChunks.push(decodedChunk);
              totalDecodedBytes += decodedChunk.length;
            } catch (decodeErr) {
              console.warn(`[Inworld TTS] Chunk ${i}: Base64 decode failed -`, decodeErr.message);
            }
          }

          const audioBuffer = Buffer.concat(audioChunks);
          console.log(`[Inworld TTS] Audio combined: ${audioBuffer.length} bytes from ${audioChunks.length} chunks`);

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
 * REQUIRES: Authentication (Bearer token)
 */
router.post('/tts', verifyToken, async (req, res) => {
  try {
    const {
      text,
      voiceId,
      temperature: requestedTemperature,
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
    const resolvedModelId = requestedModelId || modelVersion || INWORLD_DEFAULT_MODEL;
    const resolvedTemperature = INWORLD_TTS_TEMPERATURE;
    if (Number.isFinite(Number(requestedTemperature)) && Number(requestedTemperature) > resolvedTemperature) {
      console.log('[Inworld TTS] Ignoring higher requested temperature, using locked minimum:', resolvedTemperature);
    }
    console.log(
      `[Inworld TTS] Request resolved -> voice="${mappedVoice}" model="${resolvedModelId}" temp="${resolvedTemperature}"` +
      ` requestedModel="${requestedModelId || modelVersion || 'none'}" requestedTemp="${requestedTemperature ?? 'none'}"`
    );

    const userId = req.user.userId;
    const userRow = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
    const isAdmin = userRow.rows[0]?.role === 'admin';

    const cacheContext = await audioCacheService.prepareContext({
      provider: 'inworld',
      userId,
      voiceId: mappedVoice,
      text,
      modelVersion: resolvedModelId,
      params: {
        temperature: resolvedTemperature,
        speed,
        pitch,
        emotion,
        style,
        requestedVoiceId: voiceId
      }
    });

    const tokensNeeded = !isAdmin
      ? tokenService.calculateTokensCost(String(text).length)
      : 0;

    if (!isAdmin) {
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
      console.log(`[Inworld TTS] Cache HIT -> model="${resolvedModelId}" temp="${resolvedTemperature}" key="${cacheContext.cacheKey}"`);
      let remainingTokens = undefined;
      if (!isAdmin && tokensNeeded > 0) {
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
        tokensUsed: !isAdmin ? tokensNeeded : 0,
        ...(Number.isFinite(remainingTokens) ? { remainingTokens } : {}),
        cache: {
          hit: true,
          source: cacheHit.source,
          scope: cacheContext.scope,
          key: cacheContext.cacheKey,
        }
      });
    }

    const inFlight = audioCacheService.claimInFlightRender(cacheContext?.cacheKey);
    if (!inFlight.isOwner) {
      console.log(`[Inworld TTS] Waiting in-flight render for key="${cacheContext?.cacheKey || 'none'}"`);
      const waitTimeoutMs = Math.max(
        250,
        Math.min(3000, Number(cacheContext?.settings?.lookupTimeoutMs || 35) * 40)
      );
      try {
        await Promise.race([
          inFlight.wait,
          new Promise((resolve) => setTimeout(resolve, waitTimeoutMs)),
        ]);
      } catch {
        // If the owner render fails, continue and try rendering below.
      }

      const postWaitHit = await audioCacheService.lookup(cacheContext);
      if (postWaitHit.hit) {
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
        const base64Audio = postWaitHit.audioBuffer.toString('base64');
        return res.status(200).json({
          success: true,
          audio: `data:${postWaitHit.contentType};base64,${base64Audio}`,
          audioSize: postWaitHit.audioBuffer.length,
          voiceId,
          characters: String(text).length,
          tokensUsed: !isAdmin ? tokensNeeded : 0,
          ...(Number.isFinite(remainingTokens) ? { remainingTokens } : {}),
          cache: {
            hit: true,
            source: `inflight_${postWaitHit.source}`,
            scope: cacheContext.scope,
            key: cacheContext.cacheKey,
          }
        });
      }
    }

    audioCacheService.trackMetric({ rendered_requests: 1 });
    console.log(`[Inworld TTS] Cache MISS -> rendering with model="${resolvedModelId}" temp="${resolvedTemperature}"`);

    const streamArgs = { apiKey, text: String(text), mappedVoice, modelId: resolvedModelId, temperature: resolvedTemperature };
    const isAnomalousAudio = (buf) => Buffer.isBuffer(buf) && buf.length / Math.max(1, String(text).length) > 4000;

    let audioBuffer;
    const renderOwner = inFlight.isOwner ? inFlight : null;
    try {
      audioBuffer = await streamInworldAudio(streamArgs);

      if (isAnomalousAudio(audioBuffer)) {
        const ratio = Math.round(audioBuffer.length / Math.max(1, String(text).length));
        console.warn(`[Inworld TTS] Audio anormal detectado (${ratio} bytes/char, ${audioBuffer.length} bytes). Reintentando...`);
        try {
          const retryBuffer = await streamInworldAudio(streamArgs);
          const retryRatio = Math.round(retryBuffer.length / Math.max(1, String(text).length));
          console.log(`[Inworld TTS] Retry completado (${retryRatio} bytes/char, ${retryBuffer.length} bytes)`);
          audioBuffer = retryBuffer;
        } catch (retryErr) {
          console.warn(`[Inworld TTS] Retry falló (${retryErr.message}), usando audio original`);
        }
      }

      if (renderOwner) renderOwner.release();
    } catch (streamErr) {
      if (renderOwner) renderOwner.release(streamErr);
      console.error('[Inworld TTS] Request error:', streamErr.message);
      return res.status(502).json({
        success: false,
        error: 'Inworld API error',
        detail: streamErr.message
      });
    }

    const base64Audio = audioBuffer.toString('base64');
    audioCacheService.storeAfterRender(cacheContext, audioBuffer, 'audio/mpeg').catch(() => {});

    if (!isAdmin) {
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

/**
 * POST /api/inworld/extract-audio - Upload file and get duration for Extractor Pro
 * Available for CREATOR and PRO plans only
 * Returns fileId and duration (milliseconds)
 */
router.post('/extract-audio', verifyToken, upload.single('file'), async (req, res) => {
  try {
    const userId = req.user.userId;

    // Check plan
    const userResult = await pool.query('SELECT plan, role FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    const userPlan = (userResult.rows[0].plan || 'free').toLowerCase();
    const userRole = userResult.rows[0].role || 'user';
    if (!['creator', 'pro'].includes(userPlan) && userRole !== 'admin') {
      return res.status(403).json({ error: 'Extractor Pro requiere plan CREATOR o PRO' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Archivo requerido' });
    }

    const filePath = req.file.path;
    const fileId = path.basename(filePath, path.extname(filePath));

    // Get duration using ffmpeg
    let duration = 0;
    try {
      await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
          if (err) reject(err);
          else {
            duration = Math.floor((metadata.format.duration || 0) * 1000); // ms
            resolve();
          }
        });
      });
    } catch (err) {
      console.error('[Extractor Pro] ffprobe error:', err.message);
      fs.unlink(filePath, () => {});
      return res.status(400).json({ error: 'No se pudo procesar el archivo' });
    }

    // Validate duration (max 10 minutes = 600000 ms)
    if (duration > 600000) {
      fs.unlink(filePath, () => {});
      return res.status(400).json({ error: 'Archivo muy largo. Máximo 10 minutos.' });
    }

    if (duration < 5000) { // At least 5 seconds
      fs.unlink(filePath, () => {});
      return res.status(400).json({ error: 'Archivo muy corto. Mínimo 5 segundos.' });
    }

    // Create metadata file
    const metadata = {
      fileId,
      userId,
      filePath,
      duration,
      createdAt: Date.now(),
      originalName: req.file.originalname
    };

    const metadataPath = path.join(STUDIO_PRO_DIR, `${fileId}.json`);
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));

    console.log(`[Extractor Pro] Audio uploaded: fileId=${fileId} duration=${duration}ms user=${userId}`);

    return res.status(200).json({
      success: true,
      fileId,
      duration
    });
  } catch (error) {
    console.error('[Extractor Pro Extract] Error:', error.message);
    if (req.file) {
      fs.unlink(req.file.path, () => {});
    }
    return res.status(500).json({
      error: 'Error procesando archivo',
      detail: error.message
    });
  }
});

/**
 * POST /api/inworld/preview-clip - Extract audio segment and return as base64 for preview
 * Does NOT clone voice, just returns the audio clip for listening
 */
router.post('/preview-clip', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { fileId, startMs, endMs } = req.body;

    if (!fileId || startMs === undefined || endMs === undefined) {
      return res.status(400).json({ error: 'fileId, startMs, endMs requeridos' });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(fileId)) {
      return res.status(400).json({ error: 'fileId inválido' });
    }

    const clipDuration = endMs - startMs;
    if (clipDuration < 500) return res.status(400).json({ error: 'Clip muy corto' });
    if (clipDuration > 60000) return res.status(400).json({ error: 'Clip muy largo para preview' });

    const metadataPath = path.join(STUDIO_PRO_DIR, `${fileId}.json`);
    if (!fs.existsSync(metadataPath)) {
      return res.status(404).json({ error: 'Archivo no encontrado. Puede haber expirado (3 min máx).' });
    }
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    if (metadata.userId !== userId) return res.status(403).json({ error: 'Acceso denegado' });

    const inputFilePath = metadata.filePath;
    if (!fs.existsSync(inputFilePath)) {
      return res.status(404).json({ error: 'Archivo original no encontrado' });
    }

    // Extract preview clip to temp file
    const previewPath = path.join(STUDIO_PRO_DIR, `preview_${fileId}_${Date.now()}.wav`);
    try {
      await new Promise((resolve, reject) => {
        ffmpeg(inputFilePath)
          .setStartTime(startMs / 1000)
          .setDuration(clipDuration / 1000)
          .audioCodec('pcm_s16le')
          .audioFrequency(44100)
          .audioChannels(1)
          .format('wav')
          .on('error', reject)
          .on('end', resolve)
          .save(previewPath);
      });
    } catch (err) {
      return res.status(500).json({ error: 'Error extrayendo preview', detail: err.message });
    }

    let audioBuffer;
    try {
      audioBuffer = fs.readFileSync(previewPath);
    } finally {
      fs.unlink(previewPath, () => {});
    }

    const base64Audio = audioBuffer.toString('base64');
    return res.status(200).json({
      success: true,
      audio: `data:audio/wav;base64,${base64Audio}`
    });
  } catch (err) {
    console.error('[Preview Clip] Error:', err.message);
    return res.status(500).json({ error: 'Error generando preview' });
  }
});

/**
 * POST /api/inworld/extract-clip - Extract audio segment and clone voice
 * Available for CREATOR and PRO plans only
 * Body: { fileId, startMs, endMs, voiceName, langCode }
 */
router.post('/extract-clip', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { fileId, startMs, endMs, voiceName, langCode = 'ES_ES' } = req.body;
    let usageLimit = null;
    let usageBefore = 0;

    // Validate required fields
    if (!fileId || startMs === undefined || endMs === undefined || !voiceName) {
      return res.status(400).json({ error: 'fileId, startMs, endMs, voiceName son requeridos' });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(fileId)) {
      return res.status(400).json({ error: 'fileId inválido' });
    }

    // Check plan
    const userResult = await pool.query('SELECT plan, role FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    const userPlan = (userResult.rows[0].plan || 'free').toLowerCase();
    const userRole = userResult.rows[0].role || 'user';
    if (!['creator', 'pro'].includes(userPlan) && userRole !== 'admin') {
      return res.status(403).json({ error: 'Extractor Pro requiere plan CREATOR o PRO' });
    }

    // Daily usage limit (rolling 24h window): Creator 4, Pro 7
    if (userRole !== 'admin') {
      usageLimit = EXTRACTOR_PRO_DAILY_LIMITS[userPlan] ?? 0;
      if (usageLimit <= 0) {
        return res.status(403).json({ error: 'Tu plan actual no tiene acceso a Extractor Pro.' });
      }
      await ensureExtractorProUsageTable();
      const usageCountResult = await pool.query(
        `SELECT COUNT(*)::int AS total
         FROM extractor_pro_usage_events
         WHERE user_id = $1
           AND created_at >= NOW() - INTERVAL '24 hours'`,
        [userId]
      );
      usageBefore = Number(usageCountResult.rows[0]?.total || 0);
      if (usageBefore >= usageLimit) {
        return res.status(429).json({
          error: `Límite diario alcanzado en Extractor Pro (${usageLimit} usos cada 24 horas).`
        });
      }
    }

    // Load metadata
    const metadataPath = path.join(STUDIO_PRO_DIR, `${fileId}.json`);
    if (!fs.existsSync(metadataPath)) {
      return res.status(404).json({ error: 'Archivo no encontrado' });
    }

    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    if (metadata.userId !== userId) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const inputFilePath = metadata.filePath;
    if (!fs.existsSync(inputFilePath)) {
      return res.status(404).json({ error: 'Archivo subido no encontrado' });
    }

    // Validate clip duration (should be 5-15 seconds but allow any, server validates, warn on UI)
    const clipDuration = endMs - startMs;
    if (clipDuration < 1000) { // At least 1 second
      return res.status(400).json({ error: 'Duración mínima del clip: 1 segundo' });
    }
    if (clipDuration > 30000) { // Max 30 seconds for safety
      return res.status(400).json({ error: 'Duración máxima del clip: 30 segundos' });
    }

    // Extract audio segment using ffmpeg
    const outputDir = path.join(STUDIO_PRO_DIR, fileId);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputFilePath = path.join(outputDir, 'clip.wav');

    try {
      await new Promise((resolve, reject) => {
        ffmpeg(inputFilePath)
          .setStartTime(startMs / 1000)
          .setDuration(clipDuration / 1000)
          .audioCodec('pcm_s16le')
          .audioFrequency(16000)
          .audioChannels(1)
          .format('wav')
          .on('error', reject)
          .on('end', resolve)
          .save(outputFilePath);
      });
    } catch (err) {
      console.error('[Extractor Pro] ffmpeg extraction error:', err.message);
      return res.status(500).json({ error: 'Error extrayendo audio', detail: err.message });
    }

    // Read extracted audio and call cloneVoice
    let audioBuffer;
    try {
      audioBuffer = fs.readFileSync(outputFilePath);
    } catch (err) {
      console.error('[Extractor Pro] Error reading extracted clip:', err.message);
      return res.status(500).json({ error: 'Error leyendo clip extraído' });
    }

    // Call Inworld clone voice API
    let cloneResult;
    try {
      cloneResult = await inworldTtsService.cloneVoice(voiceName, audioBuffer, '', langCode);
    } catch (err) {
      console.error('[Extractor Pro] Clone voice error:', err.message);
      return res.status(502).json({ error: 'Error clonando voz', detail: err.message });
    }

    // Publish voice (same as regular clone flow) — required for TTS to work correctly
    let finalVoiceId = cloneResult.voiceId;
    try {
      const publishResult = await inworldTtsService.publishVoice(cloneResult.voiceId, voiceName);
      if (publishResult?.voiceId) {
        finalVoiceId = publishResult.voiceId;
        console.log(`[Extractor Pro] Voz publicada: ${cloneResult.voiceId} -> ${finalVoiceId}`);
      }
    } catch (publishError) {
      console.warn(`[Extractor Pro] No se pudo publicar voz ${cloneResult.voiceId}: ${publishError.message}`);
      // Continue with unpublished voiceId — TTS may still work
    }

    // Store in user_voices table
    const displayName = voiceName;

    try {
      await pool.query(
        `INSERT INTO user_voices (user_id, voice_name, voice_id, provider, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id, voice_name) DO UPDATE SET voice_id = $3`,
        [userId, displayName, finalVoiceId, 'inworld-cloned']
      );
    } catch (err) {
      console.error('[Extractor Pro] Error saving voice to DB:', err.message);
      // Continue anyway - voice is created in Inworld even if DB save fails
    }

    // Register successful processed usage (only when processing succeeded)
    let usageRemaining = null;
    if (userRole !== 'admin' && Number.isFinite(usageLimit)) {
      try {
        await ensureExtractorProUsageTable();
        await pool.query(
          'INSERT INTO extractor_pro_usage_events (user_id) VALUES ($1)',
          [userId]
        );
        usageRemaining = Math.max(0, usageLimit - (usageBefore + 1));
      } catch (usageErr) {
        console.warn('[Extractor Pro] No se pudo registrar uso:', usageErr.message);
      }
    }

    // Clean up temp files immediately on success
    try {
      fs.unlinkSync(outputFilePath);
      fs.unlinkSync(inputFilePath);
      fs.unlinkSync(metadataPath);
      fs.rmdirSync(outputDir, { force: true });
    } catch (err) {
      console.warn('[Extractor Pro] Cleanup error:', err.message);
    }

    console.log(`[Extractor Pro] Voice cloned successfully: fileId=${fileId} voiceId=${finalVoiceId} user=${userId}`);

    return res.status(200).json({
      success: true,
      voiceId: finalVoiceId,
      displayName,
      provider: 'inworld-cloned',
      extractorProUsage: userRole === 'admin' ? null : {
        limit: usageLimit,
        used: usageBefore + 1,
        remaining: usageRemaining,
        windowHours: 24,
      }
    });
  } catch (error) {
    console.error('[Extractor Pro Extract Clip] Error:', error.message);
    return res.status(500).json({
      error: 'Error procesando clip',
      detail: error.message
    });
  }
});

export default router;

