import { Router } from 'express';
import https from 'https';
import jwt from 'jsonwebtoken';
import { buildGoogleTtsUrl } from '../utils/googleTtsUrl.js';
import { config } from '../config.js';
import audioCacheService from '../services/audioCacheService.js';

const router = Router();

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
      const base64Audio = cacheHit.audioBuffer.toString('base64');
      const wordCount = Math.max(1, String(text).length / 5);
      const duration = Math.round((wordCount / 150) * 60000 + 300);
      return res.status(200).json({
        success: true,
        audio: `data:${cacheHit.contentType};base64,${base64Audio}`,
        audioSize: cacheHit.audioBuffer.length,
        duration,
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

    const wordCount = Math.max(1, String(text).length / 5);
    const duration = Math.round((wordCount / 150) * 60000 + 300);

    return res.status(200).json({
      success: true,
      audio: `data:audio/mpeg;base64,${base64Audio}`,
      audioSize: audioBuffer.length,
      duration,
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
