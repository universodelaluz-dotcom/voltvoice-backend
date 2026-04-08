import { Router } from 'express';
import https from 'https';
import { buildGoogleTtsUrl } from '../utils/googleTtsUrl.js';

const router = Router();

/**
 * POST /api/tts/say - Google TTS
 * Usa URL directa de Google Translate TTS
 */
router.post('/say', async (req, res) => {
  try {
    const { text, rate = 160, voice } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'text required' });
    }

    console.log(`[TTS] Google TTS: "${text.substring(0, 50)}..." (voice: ${voice || 'es-MX'})`);

    // Mapear voiceId a código de idioma de Google
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

    const langCode = voiceToLangMap[voice] || 'es-MX'; // default a español

    // Obtener URL de Google TTS con el idioma correcto
    const url = buildGoogleTtsUrl(text, langCode);

    // Descargar audio
    const audioBuffer = await downloadAudio(url);
    const base64Audio = audioBuffer.toString('base64');

    // Estimar duración
    const wordCount = Math.max(1, text.length / 5);
    const duration = Math.round((wordCount / 150) * 60000 + 300);

    console.log(`[TTS] ✅ Audio: ${audioBuffer.length} bytes, duración: ${duration}ms`);

    return res.status(200).json({
      success: true,
      audio: `data:audio/mpeg;base64,${base64Audio}`,
      audioSize: audioBuffer.length,
      duration: duration,
      text: text,
      rate: rate
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
