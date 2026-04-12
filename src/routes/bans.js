import express from 'express';
import { verifyToken } from '../../middleware/auth.js';
import BanService from '../services/banService.js';

const router = express.Router();
const resolveRequestUserId = (req) => req?.user?.userId ?? req?.user?.id ?? null;
const normalizeUsername = (username = '') => String(username || '').trim().replace(/^@+/, '').toLowerCase();

// GET /api/bans - Obtener todos los bans del usuario
router.get('/bans', verifyToken, async (req, res) => {
  try {
    const userId = resolveRequestUserId(req);

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
    const userId = resolveRequestUserId(req);
    const { username, reason } = req.body;
    const normalizedUsername = normalizeUsername(username);

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!normalizedUsername) {
      return res.status(400).json({ error: 'Username is required' });
    }

    const ban = await BanService.addBan(userId, normalizedUsername, 'user', reason || 'Banned from chat');
    res.json(ban);
  } catch (err) {
    console.error('[BansRoute] POST /bans error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/bans/:username - Remover ban
router.delete('/bans/:username', verifyToken, async (req, res) => {
  try {
    const userId = resolveRequestUserId(req);
    const { username } = req.params;
    const normalizedUsername = normalizeUsername(username);

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!normalizedUsername) {
      return res.status(400).json({ error: 'Username is required' });
    }

    const result = await BanService.removeBan(userId, normalizedUsername);

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
