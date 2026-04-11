import { Router } from 'express';
import { verifyToken, requireAdmin } from '../../middleware/auth.js';
import couponService from '../services/couponService.js';

const router = Router();

// ===== ADMIN ENDPOINTS =====

/**
 * GET /api/coupons/admin/list - List all coupons with filters
 */
router.get('/admin/list', requireAdmin, async (req, res) => {
  try {
    const result = await couponService.list(req.query);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Coupons] List error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/coupons/admin/metrics - Global coupon metrics
 */
router.get('/admin/metrics', requireAdmin, async (req, res) => {
  try {
    const metrics = await couponService.getGlobalMetrics();
    return res.json({ success: true, metrics });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/coupons/admin/create - Create a new coupon
 */
router.post('/admin/create', requireAdmin, async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress;
    const coupon = await couponService.create(req.body, req.user.userId, ip);
    return res.json({ success: true, coupon });
  } catch (err) {
    console.error('[Coupons] Create error:', err.message);
    return res.status(400).json({ error: err.message });
  }
});

/**
 * PUT /api/coupons/admin/:id - Update a coupon
 */
router.put('/admin/:id', requireAdmin, async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress;
    const coupon = await couponService.update(parseInt(req.params.id), req.body, req.user.userId, ip);
    return res.json({ success: true, coupon });
  } catch (err) {
    console.error('[Coupons] Update error:', err.message);
    return res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/coupons/admin/:id - Get coupon details
 */
router.get('/admin/:id', requireAdmin, async (req, res) => {
  try {
    const coupon = await couponService.getById(parseInt(req.params.id));
    return res.json({ success: true, coupon });
  } catch (err) {
    return res.status(404).json({ error: err.message });
  }
});

/**
 * GET /api/coupons/admin/:id/metrics - Get metrics for a specific coupon
 */
router.get('/admin/:id/metrics', requireAdmin, async (req, res) => {
  try {
    const metrics = await couponService.getMetrics(parseInt(req.params.id));
    return res.json({ success: true, metrics });
  } catch (err) {
    return res.status(404).json({ error: err.message });
  }
});

/**
 * GET /api/coupons/admin/:id/redemptions - Get redemptions for a coupon
 */
router.get('/admin/:id/redemptions', requireAdmin, async (req, res) => {
  try {
    const result = await couponService.getRedemptions(parseInt(req.params.id), req.query);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/coupons/admin/:id/audit - Get audit log for a coupon
 */
router.get('/admin/:id/audit', requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const log = await couponService.getAuditLog(parseInt(req.params.id), page);
    return res.json({ success: true, log });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/coupons/admin/:id/export - Export coupon data
 */
router.get('/admin/:id/export', requireAdmin, async (req, res) => {
  try {
    const data = await couponService.exportData(parseInt(req.params.id));
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/coupons/admin/:id/revert/:redemptionId - Revert a redemption
 */
router.post('/admin/:id/revert/:redemptionId', requireAdmin, async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress;
    const result = await couponService.revertRedemption(
      parseInt(req.params.redemptionId),
      req.user.userId,
      ip
    );
    return res.json({ success: true, redemption: result });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// ===== USER-FACING ENDPOINTS =====

/**
 * POST /api/coupons/validate - Validate a coupon code at checkout
 */
router.post('/validate', verifyToken, async (req, res) => {
  try {
    const { code, amount, itemType, itemId } = req.body;

    if (!code || !amount) {
      return res.status(400).json({ valid: false, message: 'Código y monto son requeridos' });
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress;
    const result = await couponService.validate(
      code.trim(),
      req.user.userId,
      parseFloat(amount),
      itemType,
      itemId,
      ip
    );

    return res.json(result);
  } catch (err) {
    console.error('[Coupons] Validate error:', err.message);
    return res.status(500).json({ valid: false, message: 'Error validando cupón' });
  }
});

export default router;
