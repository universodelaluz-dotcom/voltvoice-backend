import { Router } from 'express';
import https from 'https';
import jwt from 'jsonwebtoken';
import { buildGoogleTtsUrl } from '../utils/googleTtsUrl.js';
import { config } from '../config.js';
import audioCacheService from '../services/audioCacheService.js';
import db from '../db.js';

const router = Router();
const FREE_LOCAL_VOICE_DAILY_LIMIT_MS = Math.max(
  60_000,
  Number(process.env.FREE_LOCAL_VOICE_DAILY_LIMIT_MS || 2 * 60 * 60 * 1000)
);

function estimateDurationMs(text = '') {
  const wordCount = Math.max(1, String(text).length / 5);
  return Math.round((wordCount / 150) * 60000 + 300);
}

function resolveOptionalUserId(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, config.JWT_SECRET);
    return decoded?.userId || null;
  } catch {
    return null;
  }
}

async function enforceFreeLocalVoiceLimit(userId, durationMs, voiceId = 'es-MX', textLength = 0) {
  if (!userId) {
    return { allowed: true };
  }

  const userQuery = await db.query(
    'SELECT plan, role FROM users WHERE id = $1 LIMIT 1',
    [userId]
  );
  const user = userQuery.rows[0];
  const plan = String(user?.plan || 'free').toLowerCase();
  const role = String(user?.role || 'user').toLowerCase();

  if (!user || role === 'admin' || plan !== 'free') {
    return { allowed: true };
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [9137, Number(userId) || 0]);

    const usage = await client.query(
      `SELECT
         COALESCE(SUM(duration_ms), 0)::bigint AS used_ms,
         MIN(created_at) AS oldest_at
       FROM local_tts_usage_events
       WHERE user_id = $1
         AND created_at >= (NOW() - INTERVAL '24 hours')`,
      [userId]
    );

    const usedMs = Number(usage.rows[0]?.used_ms || 0);
    const oldestAt = usage.rows[0]?.oldest_at ? new Date(usage.rows[0].oldest_at) : null;
    const projected = usedMs + durationMs;

    if (projected > FREE_LOCAL_VOICE_DAILY_LIMIT_MS) {
      await client.query('ROLLBACK');

      let resetInSeconds = 24 * 60 * 60;
      if (oldestAt && !Number.isNaN(oldestAt.getTime())) {
        const msSinceOldest = Date.now() - oldestAt.getTime();
        resetInSeconds = Math.max(1, Math.ceil((24 * 60 * 60 * 1000 - msSinceOldest) / 1000));
      }

      return {
        allowed: false,
        usedMs,
        remainingMs: Math.max(0, FREE_LOCAL_VOICE_DAILY_LIMIT_MS - usedMs),
        resetInSeconds
      };
    }

    await client.query(
      `INSERT INTO local_tts_usage_events (user_id, duration_ms, voice_id, text_chars, source)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, durationMs, String(voiceId || 'es-MX'), Math.max(0, Number(textLength) || 0), 'api_tts_say']
    );

    await client.query('COMMIT');
    return {
      allowed: true,
      usedMs: projected,
      remainingMs: Math.max(0, FREE_LOCAL_VOICE_DAILY_LIMIT_MS - projected),
      resetInSeconds: 24 * 60 * 60
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

/**
 * POST /api/tts/say - Google TTS
 */
router.post('/say', async (req, res) => {
  try {
    const {
      text,
      rate = 160,
      voice,
      speed,
      pitch,
      emotion,
      modelVersion
    } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'text required' });
    }

    const resolvedVoice = voice || 'es-MX';
    const userId = resolveOptionalUserId(req);
    const estimatedDurationMs = estimateDurationMs(text);
    const localLimitResult = await enforceFreeLocalVoiceLimit(
      userId,
      estimatedDurationMs,
      resolvedVoice,
      String(text).length
    );

    if (!localLimitResult.allowed) {
      return res.status(429).json({
        error: 'Limite diario alcanzado para voces locales en plan FREE',
        code: 'FREE_LOCAL_VOICE_DAILY_LIMIT_REACHED',
        details: {
          maxDailyMs: FREE_LOCAL_VOICE_DAILY_LIMIT_MS,
          usedMs: localLimitResult.usedMs,
          remainingMs: localLimitResult.remainingMs,
          resetInSeconds: localLimitResult.resetInSeconds
        }
      });
    }

    const cacheContext = await audioCacheService.prepareContext({
      provider: 'local',
      userId,
      voiceId: resolvedVoice,
      text,
      modelVersion: modelVersion || 'google-translate-tts-v1',
      params: { rate, speed, pitch, emotion }
    });

    const cacheHit = await audioCacheService.lookup(cacheContext);
    if (cacheHit.hit) {
      if (userId) {
        db.query(
          `INSERT INTO token_logs (user_id, action, tokens_used, characters_count, voice_name)
           VALUES ($1, $2, 0, $3, $4)`,
          [userId, 'tts_local_cache', String(text).length, resolvedVoice]
        ).catch(() => {});
      }
      const base64Audio = cacheHit.audioBuffer.toString('base64');
      return res.status(200).json({
        success: true,
        audio: `data:${cacheHit.contentType};base64,${base64Audio}`,
        audioSize: cacheHit.audioBuffer.length,
        duration: estimatedDurationMs,
        text,
        rate,
        tokensUsed: 0,
        cache: {
          hit: true,
          source: cacheHit.source,
          scope: cacheContext.scope,
          key: cacheContext.cacheKey
        }
      });
    }

    audioCacheService.trackMetric({ rendered_requests: 1 });

    console.log(`[TTS] Google TTS: "${String(text).substring(0, 50)}..." (voice: ${resolvedVoice})`);

    const voiceToLangMap = {
      'en-US': 'en',
      'es-ES': 'es',
      'es-MX': 'es-MX',
      'en-GB': 'en',
      'fr-FR': 'fr',
      'de-DE': 'de',
      'it-IT': 'it',
      'pt-BR': 'pt-br',
    };

    const langCode = voiceToLangMap[resolvedVoice] || 'es-MX';
    const url = buildGoogleTtsUrl(text, langCode);

    const audioBuffer = await downloadAudio(url);
    const base64Audio = audioBuffer.toString('base64');
    audioCacheService.storeAfterRender(cacheContext, audioBuffer, 'audio/mpeg').catch(() => {});

    // Registrar en token_logs para que aparezca en estadísticas
    if (userId) {
      db.query(
        `INSERT INTO token_logs (user_id, action, tokens_used, characters_count, voice_name)
         VALUES ($1, $2, 0, $3, $4)`,
        [userId, 'tts_local', String(text).length, resolvedVoice]
      ).catch(() => {});
    }

    return res.status(200).json({
      success: true,
      audio: `data:audio/mpeg;base64,${base64Audio}`,
      audioSize: audioBuffer.length,
      duration: estimatedDurationMs,
      text,
      rate,
      tokensUsed: 0,
      cache: {
        hit: false,
        scope: cacheContext.scope,
        key: cacheContext.cacheKey,
        cacheable: cacheContext.enabled
      }
    });

  } catch (error) {
    console.error('[TTS] Error:', error.message);
    return res.status(500).json({
      error: 'TTS Error',
      detail: error.message
    });
  }
});

function downloadAudio(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      const chunks = [];

      response.on('data', (chunk) => {
        chunks.push(chunk);
      });

      response.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

export default router;
