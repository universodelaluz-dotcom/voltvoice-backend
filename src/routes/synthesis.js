// Routes para síntesis de voz con ElevenLabs

import express from 'express';
import * as elevenLabsService from '../services/elevenLabsService.js';
import * as tokenService from '../services/tokenService.js';
import FormData from 'form-data';

const router = express.Router();

// Middleware para verificar autenticación
const authMiddleware = (req, res, next) => {
  const userId = req.headers['x-user-id'];
  if (!userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  req.userId = userId;
  next();
};

// GET - Obtener voces disponibles
router.get('/voices', authMiddleware, async (req, res) => {
  try {
    const voices = await elevenLabsService.getAvailableVoices();

    // Retornar solo información básica (nombre, id, descripción)
    const simplifiedVoices = voices.map(v => ({
      id: v.voice_id,
      name: v.name,
      preview_url: v.preview_url,
      category: v.category
    }));

    res.json({
      success: true,
      voices: simplifiedVoices
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST - Sintetizar voz (gasta tokens)
router.post('/synthesize', authMiddleware, async (req, res) => {
  try {
    const { text, voiceId } = req.body;

    if (!text || !voiceId) {
      return res.status(400).json({ error: 'Missing text or voiceId' });
    }

    // Calcular tokens necesarios (1 token = 100 caracteres)
    const tokensNeeded = tokenService.calculateTokensCost(text.length);

    // Verificar si usuario tiene suficientes tokens
    const hasEnough = await tokenService.hasEnoughTokens(req.userId, tokensNeeded);
    if (!hasEnough) {
      return res.status(402).json({
        error: 'Insufficient tokens',
        tokensNeeded: tokensNeeded,
        tokensAvailable: await tokenService.getUserTokens(req.userId)
      });
    }

    // Sintetizar voz
    const audioResult = await elevenLabsService.synthesizeAndSave(text, voiceId, req.userId);

    // Deducir tokens
    const tokenResult = await tokenService.deductTokens(
      req.userId,
      tokensNeeded,
      text.length,
      voiceId
    );

    res.json({
      success: true,
      message: 'Síntesis completada',
      audio: audioResult.audioUrl,
      tokensUsed: tokenResult.tokensUsed,
      remainingTokens: tokenResult.remainingTokens
    });

  } catch (error) {
    console.error('Synthesis error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST - Clonar voz (requiere archivo de audio)
router.post('/clone-voice', authMiddleware, async (req, res) => {
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

    // Llamar a ElevenLabs
    const clonedVoice = await elevenLabsService.cloneVoice(voiceName, audioBuffer);

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
router.get('/user-voices', authMiddleware, async (req, res) => {
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
router.get('/usage', authMiddleware, async (req, res) => {
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
router.delete('/voice/:voiceId', authMiddleware, async (req, res) => {
  try {
    const { voiceId } = req.params;
    const result = await elevenLabsService.deleteVoice(voiceId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
