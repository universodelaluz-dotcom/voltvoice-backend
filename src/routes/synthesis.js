// Routes para síntesis de voz con ElevenLabs

import express from 'express';
import espeakTtsService from '../services/espeak-tts-service.js';
import elevenLabsService from '../services/elevenLabsService.js';
import googleTtsService from '../services/googleTtsService.js';
import tokenService from '../services/tokenService.js';
import db from '../db.js';
import FormData from 'form-data';
import { Writer } from 'wav';
import { Readable } from 'stream';
import { verifyToken, requireAdmin } from '../../middleware/auth.js';

const router = express.Router();

// Función para generar audio WAV fallback de 2 segundos
function generateFallbackAudioBuffer() {
  const sampleRate = 44100;
  const duration = 2; // 2 segundos
  const frequency = 440; // La (A4)
  const samples = sampleRate * duration;

  // Crear buffer para 16-bit audio
  const buffer = Buffer.alloc(samples * 2);

  // Generar tono simple
  for (let i = 0; i < samples; i++) {
    const value = Math.sin(2 * Math.PI * frequency * i / sampleRate) * 0.3 * 32767;
    buffer.writeInt16LE(Math.round(value), i * 2);
  }

  // Crear WAV con header
  const wav = Buffer.alloc(44 + buffer.length);

  // RIFF header
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + buffer.length, 4);
  wav.write('WAVE', 8);

  // fmt subchunk
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); // Subchunk1Size
  wav.writeUInt16LE(1, 20);  // AudioFormat (PCM)
  wav.writeUInt16LE(1, 22);  // NumChannels (mono)
  wav.writeUInt32LE(sampleRate, 24); // SampleRate
  wav.writeUInt32LE(sampleRate * 2, 28); // ByteRate
  wav.writeUInt16LE(2, 32);  // BlockAlign
  wav.writeUInt16LE(16, 34); // BitsPerSample

  // data subchunk
  wav.write('data', 36);
  wav.writeUInt32LE(buffer.length, 40);
  buffer.copy(wav, 44);

  return wav;
}

function getElevenLabsApiKey() {
  return (process.env.ELEVENLABS_API_KEY || '').trim().replace(/^['"]|['"]$/g, '');
}

// verifyToken usa verifyToken JWT (Bearer token)
// req.user.userId queda disponible tras pasar el middleware

// DEBUG - Test espeak-ng installation
router.get('/debug/espeak', requireAdmin, async (req, res) => {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execPromise = promisify(exec);

    try {
      const { stdout } = await execPromise('which espeak-ng');
      res.json({
        installed: true,
        path: stdout.trim(),
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.json({
        installed: false,
        error: 'espeak-ng not found in PATH',
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DEBUG - Test gTTS
router.get('/debug/gtts-test', requireAdmin, async (req, res) => {
  try {
    const testText = 'Hello world, this is a test';
    const result = await espeakTtsService.synthesize(testText, '21m00Tcm4TlvDq8ikWAM');

    res.json({
      working: true,
      audioSize: result.audio.length,
      contentType: result.contentType,
      message: 'gTTS is working - audio generated successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.json({
      working: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// DEBUG - Test ElevenLabs connection
router.get('/debug/elevenlabs', requireAdmin, (req, res) => {
  try {
    const apiKey = getElevenLabsApiKey();
    const baseUrl = 'https://api.elevenlabs.io/v1';

    res.json({
      apiKeyConfigured: !!apiKey,
      apiKeyLength: apiKey ? apiKey.length : 0,
      apiKeyPreview: apiKey ? `${apiKey.substring(0, 10)}...${apiKey.substring(apiKey.length - 10)}` : 'NOT SET',
      baseUrl: baseUrl,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DEBUG - Test ElevenLabs with Fetch instead of Axios
router.get('/debug/elevenlabs-fetch', requireAdmin, async (req, res) => {
  try {
    const apiKey = getElevenLabsApiKey();

    const response = await fetch('https://api.elevenlabs.io/v1/voices', {
      method: 'GET',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();

    res.json({
      status: response.status,
      statusText: response.statusText,
      data: response.ok ? { voiceCount: data.voices?.length || 0 } : data
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DEBUG - Test Flash/Turbo TTS directly
router.get('/debug/flash-turbo', requireAdmin, async (req, res) => {
  try {
    const apiKey = getElevenLabsApiKey();

    if (!apiKey) {
      return res.status(400).json({
        error: 'ELEVENLABS_API_KEY not set',
        allEnvVars: Object.keys(process.env).filter(k => k.includes('ELEVEN') || k.includes('API'))
      });
    }

    const voiceId = '21m00Tcm4TlvDq8ikWAM'; // Rachel voice
    const testText = 'Hola mundo, esto es una prueba de Flash Turbo';

    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: testText,
        model_id: 'eleven_flash_v2_5',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      })
    });

    console.log('[DEBUG] Response status:', response.status);
    console.log('[DEBUG] Response headers:', Object.fromEntries(response.headers));

    const contentType = response.headers.get('content-type');

    if (contentType && contentType.includes('audio')) {
      // Audio success
      const audioBuffer = await response.arrayBuffer();
      res.json({
        success: true,
        status: response.status,
        audioSize: audioBuffer.byteLength,
        contentType: contentType,
        message: 'Flash/Turbo TTS working!',
        timestamp: new Date().toISOString()
      });
    } else {
      // Error response
      const text = await response.text();
      res.json({
        success: false,
        status: response.status,
        statusText: response.statusText,
        contentType: contentType,
        response: text,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    res.json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ADMIN - Add tokens to user (for testing)
router.post('/admin/add-tokens', requireAdmin, async (req, res) => {
  try {
    const { userId, tokens } = req.body;

    if (!userId || !tokens) {
      return res.status(400).json({ error: 'userId and tokens required' });
    }

    // Primero, intenta actualizar
    let result = await db.query(
      'UPDATE users SET tokens = tokens + $1 WHERE id = $2 RETURNING id, tokens',
      [tokens, userId]
    );

    // Si no existe, crea el usuario
    if (result.rows.length === 0) {
      result = await db.query(
        'INSERT INTO users (id, email, tokens, plan) VALUES ($1, $2, $3, $4) RETURNING id, tokens',
        [userId, `user${userId}@voltvoice.test`, tokens, 'free']
      );
    }

    res.json({
      success: true,
      userId: result.rows[0].id,
      newTokens: result.rows[0].tokens
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET - Obtener voces disponibles
router.get('/voices', verifyToken, async (req, res) => {
  try {
    let voices;
    let provider = 'elevenlabs';

    try {
      voices = await elevenLabsService.getAvailableVoices();
    } catch (serviceError) {
      console.warn('[SYNTHESIS] ElevenLabs voices failed, using fallback:', serviceError.message);
      voices = await espeakTtsService.getAvailableVoices();
      provider = 'fallback';
    }

    // Retornar solo información básica (nombre, id, descripción)
    const simplifiedVoices = voices.map(v => ({
      id: v.voice_id || v.id,
      name: v.name,
      preview_url: v.preview_url,
      category: v.category
    }));

    res.json({
      success: true,
      voices: simplifiedVoices,
      provider
    });
  } catch (error) {
    console.error('[SYNTHESIS ERROR]', {
      message: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      headers: error.response?.headers
    });

    // FALLBACK: Retornar voces por defecto si ElevenLabs falla
    const defaultVoices = [
      { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella - Warm & Engaging', category: 'premade' },
      { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel - Warm & Expressive', category: 'premade' },
      { id: 'AZnzlk1uvptSRtMUZeKw', name: 'Domi - Bold & Confident', category: 'premade' },
      { id: 'EL1QtFI7ePme4xLqrPzT', name: 'Elli - Calm & Serene', category: 'premade' },
      { id: 'MF3mGyEYCl7XYWbV7PLe', name: 'Gigi - Upbeat & Energetic', category: 'premade' },
      { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Harry - Deep & Authoritative', category: 'premade' }
    ];

    res.json({
      success: true,
      voices: defaultVoices,
      note: 'Using fallback voices due to API connectivity issue',
      provider: 'default-fallback'
    });
  }
});

// POST - Sintetizar voz (gasta tokens)
router.post('/synthesize', verifyToken, async (req, res) => {
  try {
    const { text, voiceId } = req.body;

    if (!text || !voiceId) {
      return res.status(400).json({ error: 'Missing text or voiceId' });
    }

    // Calcular tokens necesarios (1 token = 1 caracter)
    const tokensNeeded = tokenService.calculateTokensCost(text.length);

    // Verificar si usuario tiene suficientes tokens
    const hasEnough = await tokenService.hasEnoughTokens(req.user.userId, tokensNeeded);
    if (!hasEnough) {
      return res.status(402).json({
        error: 'Insufficient tokens',
        tokensNeeded: tokensNeeded,
        tokensAvailable: await tokenService.getUserTokens(req.user.userId)
      });
    }

    // Sintetizar voz
    let audioResult;
    let usedFallback = false;
    let provider = 'elevenlabs';

    // Detectar si es una voz básica (Google TTS)
    const basicVoices = ['en-US', 'es-ES'];
    const isBasicVoice = basicVoices.includes(voiceId);

    try {
      if (isBasicVoice) {
        // Usar Google TTS para voces básicas
        console.log(`[SYNTHESIS] Using Google TTS for basic voice: ${voiceId}`);
        audioResult = await googleTtsService.synthesizeAndSave(text, voiceId, req.user.userId);
        provider = 'google-tts';
      } else {
        // Usar ElevenLabs para voces premium/clonadas
        audioResult = await elevenLabsService.synthesizeAndSave(text, voiceId, req.user.userId);
      }
    } catch (ttsError) {
      console.warn(`[SYNTHESIS] Primary provider (${provider}) failed, trying fallback:`, ttsError.message);

      try {
        audioResult = await espeakTtsService.synthesizeAndSave(text, voiceId, req.user.userId);
        usedFallback = true;
        provider = 'fallback';
      } catch (fallbackError) {
        console.warn('[SYNTHESIS] Fallback provider failed, using generated tone:', fallbackError.message);
        const audioBuffer = generateFallbackAudioBuffer();
        const fallbackBase64 = audioBuffer.toString('base64');
        audioResult = {
          success: true,
          audioUrl: `data:audio/wav;base64,${fallbackBase64}`
        };
        usedFallback = true;
        provider = 'generated-tone';
      }
    }

    // Deducir tokens
    const tokenResult = await tokenService.deductTokens(
      req.user.userId,
      tokensNeeded,
      text.length,
      voiceId
    );

    res.json({
      success: true,
      message: usedFallback ? 'Síntesis completada (fallback audio)' : 'Síntesis completada',
      audio: audioResult.audioUrl,
      tokensUsed: tokenResult.tokensUsed,
      remainingTokens: tokenResult.remainingTokens,
      fallback: usedFallback,
      provider
    });

  } catch (error) {
    console.error('[SYNTHESIS ERROR]', {
      message: error.message,
      stack: error.stack,
      userId: req.user.userId,
      text: req.body?.text ? req.body.text.substring(0, 50) : 'N/A'
    });
    res.status(500).json({ error: error.message, details: error.stack });
  }
});

// POST - Clonar voz (requiere archivo de audio)
router.post('/clone-voice', verifyToken, async (req, res) => {
  try {
    const { voiceName, audioBase64 } = req.body;

    if (!voiceName || !audioBase64) {
      return res.status(400).json({ error: 'Missing voiceName or audioBase64' });
    }

    // Convertir base64 a buffer
    const audioBuffer = Buffer.from(audioBase64, 'base64');

    // Crear FormData para ElevenLabs
    const formData = new FormData();
    formData.append('name', voiceName);
    formData.append('files', audioBuffer, 'voice_sample.wav');

    // Llamar a servicio TTS
    const clonedVoice = await espeakTtsService.cloneVoice(voiceName, audioBuffer);

    res.json({
      success: true,
      message: 'Voz clonada exitosamente',
      voiceId: clonedVoice.voice_id,
      voiceName: clonedVoice.name
    });

  } catch (error) {
    console.error('Clone voice error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET - Obtener voces del usuario
router.get('/user-voices', verifyToken, async (req, res) => {
  try {
    const voices = await elevenLabsService.getUserVoices();
    res.json({
      success: true,
      voices: voices
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET - Obtener uso de API
router.get('/usage', verifyToken, async (req, res) => {
  try {
    const usage = await elevenLabsService.getUsage();
    res.json({
      success: true,
      usage: usage
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE - Eliminar voz clonada
router.delete('/voice/:voiceId', verifyToken, async (req, res) => {
  try {
    const { voiceId } = req.params;
    const result = await elevenLabsService.deleteVoice(voiceId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
