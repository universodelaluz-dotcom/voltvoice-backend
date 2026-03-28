import express from 'express';
import { verifyToken } from '../middleware/auth.js';
import BanService from '../services/banService.js';

const router = express.Router();

// GET /api/bans - Obtener todos los bans del usuario
router.get('/bans', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const bans = await BanService.getBans(userId);
    res.json(bans);
  } catch (err) {
    console.error('[BansRoute] GET /bans error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bans - Crear o actualizar ban
router.post('/bans', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { username, reason } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!username || !username.trim()) {
      return res.status(400).json({ error: 'Username is required' });
    }

    const ban = await BanService.addBan(userId, username.trim(), 'user', reason || 'Banned from chat');
    res.json(ban);
  } catch (err) {
    console.error('[BansRoute] POST /bans error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/bans/:username - Remover ban
router.delete('/bans/:username', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { username } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!username || !username.trim()) {
      return res.status(400).json({ error: 'Username is required' });
    }

    const result = await BanService.removeBan(userId, username.trim());

    if (!result) {
      return res.status(404).json({ error: 'Ban not found' });
    }

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[BansRoute] DELETE /bans/:username error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
