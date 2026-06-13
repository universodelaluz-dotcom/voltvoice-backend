import express from 'express';
import { verifyToken } from '../../middleware/auth.js';
import NickService from '../services/nickService.js';

const router = express.Router();
const resolveRequestUserId = (req) => req?.user?.userId ?? req?.user?.id ?? null;
const normalizeUsername = (username = '') => String(username || '').trim().replace(/^@+/, '').toLowerCase();

// GET /api/nicks?platform=tiktok - Obtener todos los nick overrides del usuario para una plataforma
router.get('/nicks', verifyToken, async (req, res) => {
  try {
    const userId = resolveRequestUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const platform = req.query.platform || 'tiktok';
    const nickMap = await NickService.getNickOverrides(userId, platform);
    res.json(nickMap);
  } catch (err) {
    console.error('[NicksRoute] GET /nicks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/nicks - Crear o actualizar nick override
router.post('/nicks', verifyToken, async (req, res) => {
  try {
    const userId = resolveRequestUserId(req);
    const { username, newNickname, platform } = req.body;
    const normalizedUsername = normalizeUsername(username);

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!normalizedUsername) {
      return res.status(400).json({ error: 'Username is required' });
    }

    if (!newNickname || !newNickname.trim()) {
      return res.status(400).json({ error: 'New nickname is required' });
    }

    const override = await NickService.setNickOverride(userId, normalizedUsername, newNickname.trim(), platform || 'tiktok');
    res.json(override);
  } catch (err) {
    console.error('[NicksRoute] POST /nicks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/nicks/:username?platform=tiktok - Remover nick override
router.delete('/nicks/:username', verifyToken, async (req, res) => {
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

    const platform = req.query.platform || 'tiktok';
    const result = await NickService.removeNickOverride(userId, normalizedUsername, platform);

    if (!result) {
      return res.status(404).json({ error: 'Nick override not found' });
    }

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[NicksRoute] DELETE /nicks/:username error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
