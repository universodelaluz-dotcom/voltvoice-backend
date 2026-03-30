// Routes para manejo de tokens

import express from 'express';
import * as tokenService from '../services/tokenService.js';
import { verifyToken } from '../../middleware/auth.js';

const router = express.Router();

// GET - Obtener tokens actuales del usuario
router.get('/balance', verifyToken, async (req, res) => {
  try {
    const tokens = await tokenService.getUserTokens(req.user.userId);
    const stats = await tokenService.getTokenStats(req.user.userId);

    res.json({
      currentTokens: tokens,
      stats: stats
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST - Sintetizar voz (gasta tokens)
router.post('/synthesize', verifyToken, async (req, res) => {
  try {
    const { text, voiceName } = req.body;

    if (!text || !voiceName) {
      return res.status(400).json({ error: 'Missing text or voiceName' });
    }

    // Calcular tokens necesarios
    const tokensNeeded = tokenService.calculateTokensCost(text.length);

    // Verificar si tiene suficientes tokens
    const hasEnough = await tokenService.hasEnoughTokens(req.user.userId, tokensNeeded);
    if (!hasEnough) {
      return res.status(402).json({
        error: 'Insufficient tokens',
        tokensNeeded: tokensNeeded,
        tokensAvailable: await tokenService.getUserTokens(req.user.userId)
      });
    }

    // Aquí iría la llamada a ElevenLabs para sintetizar
    // Por ahora, solo descontamos tokens
    const result = await tokenService.deductTokens(req.user.userId, tokensNeeded, text.length, voiceName);

    res.json({
      success: true,
      message: `Síntesis completada. ${result.tokensUsed} tokens usados.`,
      remainingTokens: result.remainingTokens,
      // audioUrl: "https://..." (cuando implementemos ElevenLabs)
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST - Comprar tokens (integrado con Stripe después)
router.post('/purchase', verifyToken, async (req, res) => {
  try {
    const { tokensPurchase, stripePaymentId } = req.body;

    if (!tokensPurchase) {
      return res.status(400).json({ error: 'Missing tokensPurchase' });
    }

    // Aquí iría validación de Stripe
    // Por ahora, agregamos tokens directo
    const result = await tokenService.addTokens(req.user.userId, tokensPurchase, 'purchase');

    res.json({
      success: true,
      message: `${tokensPurchase} tokens comprados`,
      newBalance: result.newTokens
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET - Ver historial de uso
router.get('/history', verifyToken, async (req, res) => {
  try {
    const history = await tokenService.getTokenHistory(req.user.userId);
    res.json({ history });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST - Upgrade de plan
router.post('/upgrade-plan', verifyToken, async (req, res) => {
  try {
    const { newPlan } = req.body;

    if (!['free', 'pro', 'premium'].includes(newPlan)) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const updatedUser = await tokenService.updateUserPlan(req.user.userId, newPlan);

    res.json({
      success: true,
      message: `Plan actualizado a ${newPlan}`,
      newTokens: updatedUser.tokens,
      plan: updatedUser.plan
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
