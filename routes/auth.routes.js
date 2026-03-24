import express from 'express';
import { generateToken } from '../middleware/auth.js';

const router = express.Router();

/**
 * TEMPORAL: Mock auth para demo
 * En prod, conectar a DB real
 */

// POST /auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, username } = req.body;

    if (!email || !password || !username) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    // TODO: Hash password con bcrypt
    // TODO: Guardar en DB PostgreSQL

    const userId = Math.random().toString(36).substr(2, 9); // Mock ID
    const token = generateToken(userId);

    res.json({
      success: true,
      token,
      user: { userId, email, username },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    // TODO: Verificar contra DB
    // TODO: Comparar password con bcrypt

    const userId = 'demo-user';
    const token = generateToken(userId);

    res.json({
      success: true,
      token,
      user: { userId, email, plan: 'free' },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/logout
router.post('/logout', (req, res) => {
  // JWT no tiene estado en servidor, pero client debe borrar token
  res.json({ success: true, message: 'Logged out' });
});

export default router;
