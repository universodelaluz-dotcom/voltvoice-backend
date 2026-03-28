import express from 'express';
import { verifyToken } from '../../middleware/auth.js';
import NickService from '../services/nickService.js';

const router = express.Router();

// GET /api/nicks - Obtener todos los nick overrides del usuario
router.get('/nicks', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const nickMap = await NickService.getNickOverrides(userId);
    res.json(nickMap);
  } catch (err) {
    console.error('[NicksRoute] GET /nicks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/nicks - Crear o actualizar nick override
router.post('/nicks', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { username, newNickname } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!username || !username.trim()) {
      return res.status(400).json({ error: 'Username is required' });
    }

    if (!newNickname || !newNickname.trim()) {
      return res.status(400).json({ error: 'New nickname is required' });
    }

    const override = await NickService.setNickOverride(userId, username.trim(), newNickname.trim());
    res.json(override);
  } catch (err) {
    console.error('[NicksRoute] POST /nicks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/nicks/:username - Remover nick override
router.delete('/nicks/:username', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { username } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!username || !username.trim()) {
      return res.status(400).json({ error: 'Username is required' });
    }

    const result = await NickService.removeNickOverride(userId, username.trim());

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
