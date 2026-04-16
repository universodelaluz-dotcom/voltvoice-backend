import express from 'express';
import pool from '../db.js';
import { verifyToken } from '../../middleware/auth.js';

const router = express.Router();

/**
 * Middleware para verificar si el usuario tiene plan PROFESSIONAL o superior
 */
const checkCommentatorAccess = async (req, res, next) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'No autenticado',
        required_plan: 'PROFESSIONAL'
      });
    }

    // Obtener plan del usuario
    const userResult = await pool.query(
      `SELECT subscription_plan FROM users WHERE id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Usuario no encontrado'
      });
    }

    const userPlan = userResult.rows[0].subscription_plan || 'STARTER';

    // Mapeo de niveles de plan
    const planLevels = {
      STARTER: 1,
      PROFESSIONAL: 2,
      PREMIUM: 3,
      FREE: 0
    };

    const userLevel = planLevels[userPlan] || 0;
    const requiredLevel = planLevels['PROFESSIONAL'];

    // Verificar si el usuario tiene acceso
    if (userLevel < requiredLevel) {
      return res.status(403).json({
        success: false,
        error: 'This feature is not available in your plan',
        required_plan: 'PROFESSIONAL',
        current_plan: userPlan,
        message: 'No disponible en tu plan'
      });
    }

    // Usuario tiene acceso, continuar
    next();
  } catch (error) {
    console.error('[Commentator] Error checking access:', error);
    res.status(500).json({
      success: false,
      error: 'Error verificando acceso',
      details: error.message
    });
  }
};

/**
 * POST /api/commentator/toggle
 * Toggle comentarista - solo PROFESSIONAL+
 */
router.post('/toggle', verifyToken, checkCommentatorAccess, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Aquí puedes agregar lógica para activar/desactivar comentarista
    // Por ahora, solo responder que fue exitoso

    res.json({
      success: true,
      message: 'Commentator toggled successfully',
      feature: 'commentator_mode'
    });
  } catch (error) {
    console.error('[Commentator] Error toggling commentator:', error);
    res.status(500).json({
      success: false,
      error: 'Error toggling commentator',
      details: error.message
    });
  }
});

/**
 * GET /api/commentator/status
 * Get commentator status
 */
router.get('/status', verifyToken, checkCommentatorAccess, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Obtener estado del comentarista (si lo hubiera en BD)
    res.json({
      success: true,
      enabled: false, // Default, personalizar según necesidad
      userId: userId
    });
  } catch (error) {
    console.error('[Commentator] Error getting status:', error);
    res.status(500).json({
      success: false,
      error: 'Error getting commentator status',
      details: error.message
    });
  }
});

export default router;
