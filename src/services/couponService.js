import pool from '../db.js';

class CouponService {

  // ===== AUTO STATUS MANAGEMENT =====

  async autoUpdateStatuses() {
    try {
      // Activate scheduled coupons
      await pool.query(`
        UPDATE coupons SET status = 'active', updated_at = NOW()
        WHERE status = 'draft' AND scheduled_activate_at IS NOT NULL AND scheduled_activate_at <= NOW()
      `);
      // Expire coupons past end_date
      await pool.query(`
        UPDATE coupons SET status = 'expired', updated_at = NOW()
        WHERE status = 'active' AND end_date IS NOT NULL AND end_date < NOW()
      `);
      // Exhaust coupons that hit max uses
      await pool.query(`
        UPDATE coupons SET status = 'exhausted', updated_at = NOW()
        WHERE status = 'active' AND max_uses_total IS NOT NULL AND uses_count >= max_uses_total
      `);
      // Scheduled deactivation
      await pool.query(`
        UPDATE coupons SET status = 'paused', updated_at = NOW()
        WHERE status = 'active' AND scheduled_deactivate_at IS NOT NULL AND scheduled_deactivate_at <= NOW()
      `);
    } catch (err) {
      console.error('[Coupon] autoUpdateStatuses error:', err.message);
    }
  }

  // ===== CRUD =====

  async create(data, adminId, ip) {
    const {
      code, internal_name, description, status = 'draft',
      discount_type, discount_value, max_discount, min_purchase = 0,
      max_uses_total, max_uses_per_user = 1,
      start_date, end_date,
      applies_to = 'all', applicable_products = [],
      eligible_user_type = 'all', eligible_user_ids = [],
      first_purchase_only = false, once_per_email = false, once_per_phone = false,
      compatible_with_others = true,
      limit_per_ip, limit_per_device, limit_per_card,
      campaign, priority = 0,
      scheduled_activate_at, scheduled_deactivate_at
    } = data;

    if (!code || !internal_name || !discount_type || discount_value == null) {
      throw new Error('Campos obligatorios: code, internal_name, discount_type, discount_value');
    }
    if (!['percentage', 'fixed'].includes(discount_type)) {
      throw new Error('discount_type debe ser "percentage" o "fixed"');
    }
    if (discount_type === 'percentage' && (discount_value < 0 || discount_value > 100)) {
      throw new Error('Porcentaje debe estar entre 0 y 100');
    }
    if (discount_type === 'percentage' && !max_discount) {
      throw new Error('max_discount es obligatorio para descuentos por porcentaje');
    }

    const existing = await pool.query('SELECT id FROM coupons WHERE UPPER(code) = UPPER($1)', [code]);
    if (existing.rows.length > 0) {
      throw new Error('Ya existe un cupón con ese código');
    }

    const result = await pool.query(`
      INSERT INTO coupons (
        code, internal_name, description, status,
        discount_type, discount_value, max_discount, min_purchase,
        max_uses_total, max_uses_per_user,
        start_date, end_date,
        applies_to, applicable_products,
        eligible_user_type, eligible_user_ids,
        first_purchase_only, once_per_email, once_per_phone,
        compatible_with_others,
        limit_per_ip, limit_per_device, limit_per_card,
        campaign, priority,
        scheduled_activate_at, scheduled_deactivate_at,
        created_by
      ) VALUES (
        UPPER($1), $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10,
        $11, $12,
        $13, $14,
        $15, $16,
        $17, $18, $19,
        $20,
        $21, $22, $23,
        $24, $25,
        $26, $27,
        $28
      ) RETURNING *
    `, [
      code, internal_name, description, status,
      discount_type, discount_value, max_discount, min_purchase,
      max_uses_total, max_uses_per_user,
      start_date || null, end_date || null,
      applies_to, applicable_products,
      eligible_user_type, eligible_user_ids,
      first_purchase_only, once_per_email, once_per_phone,
      compatible_with_others,
      limit_per_ip || null, limit_per_device || null, limit_per_card || null,
      campaign || null, priority,
      scheduled_activate_at || null, scheduled_deactivate_at || null,
      adminId
    ]);

    await this.logAudit(result.rows[0].id, 'created', adminId, null, result.rows[0], ip);
    return result.rows[0];
  }

  async update(couponId, data, adminId, ip) {
    const oldResult = await pool.query('SELECT * FROM coupons WHERE id = $1', [couponId]);
    if (oldResult.rows.length === 0) throw new Error('Cupón no encontrado');
    const old = oldResult.rows[0];

    const fields = [
      'internal_name', 'description', 'status',
      'discount_type', 'discount_value', 'max_discount', 'min_purchase',
      'max_uses_total', 'max_uses_per_user',
      'start_date', 'end_date',
      'applies_to', 'applicable_products',
      'eligible_user_type', 'eligible_user_ids',
      'first_purchase_only', 'once_per_email', 'once_per_phone',
      'compatible_with_others',
      'limit_per_ip', 'limit_per_device', 'limit_per_card',
      'campaign', 'priority',
      'scheduled_activate_at', 'scheduled_deactivate_at'
    ];

    const updates = [];
    const params = [];
    let idx = 1;

    for (const field of fields) {
      if (data[field] !== undefined) {
        updates.push(`${field} = $${idx++}`);
        params.push(data[field]);
      }
    }

    if (updates.length === 0) throw new Error('Nada que actualizar');

    updates.push(`updated_at = NOW()`);
    params.push(couponId);

    const result = await pool.query(
      `UPDATE coupons SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );

    await this.logAudit(couponId, 'updated', adminId, old, result.rows[0], ip);
    return result.rows[0];
  }

  async getById(couponId) {
    const result = await pool.query('SELECT * FROM coupons WHERE id = $1', [couponId]);
    if (result.rows.length === 0) throw new Error('Cupón no encontrado');
    return result.rows[0];
  }

  async list(filters = {}) {
    await this.autoUpdateStatuses();

    const conditions = [];
    const params = [];
    let idx = 1;

    if (filters.status) {
      conditions.push(`c.status = $${idx++}`);
      params.push(filters.status);
    }
    if (filters.discount_type) {
      conditions.push(`c.discount_type = $${idx++}`);
      params.push(filters.discount_type);
    }
    if (filters.campaign) {
      conditions.push(`c.campaign ILIKE $${idx++}`);
      params.push(`%${filters.campaign}%`);
    }
    if (filters.search) {
      conditions.push(`(c.code ILIKE $${idx} OR c.internal_name ILIKE $${idx})`);
      params.push(`%${filters.search}%`);
      idx++;
    }
    if (filters.created_by) {
      conditions.push(`c.created_by = $${idx++}`);
      params.push(filters.created_by);
    }
    if (filters.active_now === 'true') {
      conditions.push(`c.status = 'active' AND (c.start_date IS NULL OR c.start_date <= NOW()) AND (c.end_date IS NULL OR c.end_date > NOW())`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const page = parseInt(filters.page) || 1;
    const limit = parseInt(filters.limit) || 25;
    const offset = (page - 1) * limit;

    const sortField = ['code', 'created_at', 'uses_count', 'end_date', 'priority'].includes(filters.sort)
      ? filters.sort : 'created_at';
    const sortDir = filters.order === 'ASC' ? 'ASC' : 'DESC';

    params.push(limit, offset);

    const [coupons, total] = await Promise.all([
      pool.query(`
        SELECT c.*, u.email as created_by_email
        FROM coupons c
        LEFT JOIN users u ON c.created_by = u.id
        ${where}
        ORDER BY c.${sortField} ${sortDir}
        LIMIT $${idx++} OFFSET $${idx++}
      `, params),
      pool.query(`SELECT COUNT(*) FROM coupons c ${where}`, params.slice(0, -2))
    ]);

    return {
      coupons: coupons.rows,
      total: parseInt(total.rows[0].count),
      page,
      pages: Math.ceil(parseInt(total.rows[0].count) / limit)
    };
  }

  // ===== VALIDATION & REDEMPTION =====

  async validate(code, userId, purchaseAmount, itemType, itemId, ip) {
    await this.autoUpdateStatuses();

    // Rate limit: max 10 attempts per IP per 10 minutes
    if (ip) {
      const recentAttempts = await pool.query(`
        SELECT COUNT(*) FROM coupon_failed_attempts
        WHERE ip_address = $1 AND attempted_at > NOW() - INTERVAL '10 minutes'
      `, [ip]);
      if (parseInt(recentAttempts.rows[0].count) >= 10) {
        return { valid: false, message: 'Demasiados intentos. Espera unos minutos.' };
      }
    }

    const couponResult = await pool.query('SELECT * FROM coupons WHERE UPPER(code) = UPPER($1)', [code]);
    if (couponResult.rows.length === 0) {
      await this.logFailedAttempt(userId, code, 'not_found', ip);
      return { valid: false, message: 'Cupón inválido' };
    }

    const coupon = couponResult.rows[0];

    // Status check
    if (coupon.status !== 'active') {
      const statusMessages = {
        draft: 'Cupón no disponible',
        paused: 'Cupón temporalmente deshabilitado',
        expired: 'Cupón expirado',
        exhausted: 'Cupón agotado',
        archived: 'Cupón inválido'
      };
      await this.logFailedAttempt(userId, code, `status_${coupon.status}`, ip);
      return { valid: false, message: statusMessages[coupon.status] || 'Cupón no disponible' };
    }

    // Date checks
    if (coupon.start_date && new Date(coupon.start_date) > new Date()) {
      await this.logFailedAttempt(userId, code, 'not_started', ip);
      return { valid: false, message: 'Cupón aún no disponible' };
    }
    if (coupon.end_date && new Date(coupon.end_date) < new Date()) {
      await this.logFailedAttempt(userId, code, 'expired', ip);
      return { valid: false, message: 'Cupón expirado' };
    }

    // Global uses
    if (coupon.max_uses_total && coupon.uses_count >= coupon.max_uses_total) {
      await this.logFailedAttempt(userId, code, 'exhausted', ip);
      return { valid: false, message: 'Cupón agotado' };
    }

    // Per-user uses
    if (coupon.max_uses_per_user) {
      const userUses = await pool.query(
        `SELECT COUNT(*) FROM coupon_redemptions WHERE coupon_id = $1 AND user_id = $2 AND status != 'reverted'`,
        [coupon.id, userId]
      );
      if (parseInt(userUses.rows[0].count) >= coupon.max_uses_per_user) {
        await this.logFailedAttempt(userId, code, 'user_limit_reached', ip);
        return { valid: false, message: 'Ya utilizaste este cupón' };
      }
    }

    // Minimum purchase
    if (coupon.min_purchase && purchaseAmount < parseFloat(coupon.min_purchase)) {
      await this.logFailedAttempt(userId, code, 'min_purchase', ip);
      return { valid: false, message: `Monto mínimo de compra: $${coupon.min_purchase} USD` };
    }

    // User eligibility
    const userResult = await pool.query(
      'SELECT id, email, plan, created_at FROM users WHERE id = $1',
      [userId]
    );
    if (userResult.rows.length === 0) {
      return { valid: false, message: 'Usuario no encontrado' };
    }
    const user = userResult.rows[0];

    // Eligible user type
    if (coupon.eligible_user_type !== 'all') {
      const eligibilityCheck = await this.checkUserEligibility(coupon, user);
      if (!eligibilityCheck.eligible) {
        await this.logFailedAttempt(userId, code, eligibilityCheck.reason, ip);
        return { valid: false, message: eligibilityCheck.message };
      }
    }

    // Selected users only
    if (coupon.applies_to === 'selected_users' && coupon.eligible_user_ids?.length > 0) {
      if (!coupon.eligible_user_ids.includes(userId)) {
        await this.logFailedAttempt(userId, code, 'not_eligible_user', ip);
        return { valid: false, message: 'Cupón no disponible para tu cuenta' };
      }
    }

    // Product/plan restriction
    if (coupon.applies_to === 'specific_product' && coupon.applicable_products?.length > 0) {
      const productKey = itemType === 'plan' ? itemId : `tokens_${itemId}`;
      if (!coupon.applicable_products.includes(productKey)) {
        await this.logFailedAttempt(userId, code, 'product_mismatch', ip);
        return { valid: false, message: 'Este cupón no aplica a este producto' };
      }
    }

    // First purchase only
    if (coupon.first_purchase_only) {
      const prevPurchases = await pool.query(
        `SELECT COUNT(*) FROM transactions WHERE user_id = $1 AND status = 'completed'`,
        [userId]
      );
      if (parseInt(prevPurchases.rows[0].count) > 0) {
        await this.logFailedAttempt(userId, code, 'not_first_purchase', ip);
        return { valid: false, message: 'Cupón solo válido para primera compra' };
      }
    }

    // Once per email
    if (coupon.once_per_email) {
      const emailUses = await pool.query(`
        SELECT COUNT(*) FROM coupon_redemptions cr
        JOIN users u ON cr.user_id = u.id
        WHERE cr.coupon_id = $1 AND u.email = $2 AND cr.status != 'reverted'
      `, [coupon.id, user.email]);
      if (parseInt(emailUses.rows[0].count) > 0) {
        await this.logFailedAttempt(userId, code, 'email_already_used', ip);
        return { valid: false, message: 'Este cupón ya fue usado con tu email' };
      }
    }

    // IP limit
    if (coupon.limit_per_ip && ip) {
      const ipUses = await pool.query(
        `SELECT COUNT(*) FROM coupon_redemptions WHERE coupon_id = $1 AND ip_address = $2 AND status != 'reverted'`,
        [coupon.id, ip]
      );
      if (parseInt(ipUses.rows[0].count) >= coupon.limit_per_ip) {
        await this.logFailedAttempt(userId, code, 'ip_limit', ip);
        return { valid: false, message: 'Límite de uso alcanzado desde tu red' };
      }
    }

    // Compatibility check
    if (!coupon.compatible_with_others) {
      const otherCoupons = await pool.query(`
        SELECT COUNT(*) FROM coupon_redemptions cr
        JOIN transactions t ON cr.transaction_id = t.id
        WHERE cr.user_id = $1 AND cr.status = 'applied'
        AND t.created_at > NOW() - INTERVAL '1 hour'
      `, [userId]);
      if (parseInt(otherCoupons.rows[0].count) > 0) {
        await this.logFailedAttempt(userId, code, 'not_compatible', ip);
        return { valid: false, message: 'No se puede combinar con otro cupón' };
      }
    }

    // Calculate discount
    let discountAmount;
    if (coupon.discount_type === 'percentage') {
      discountAmount = (purchaseAmount * parseFloat(coupon.discount_value)) / 100;
      if (coupon.max_discount) {
        discountAmount = Math.min(discountAmount, parseFloat(coupon.max_discount));
      }
    } else {
      discountAmount = Math.min(parseFloat(coupon.discount_value), purchaseAmount);
    }

    discountAmount = Math.round(discountAmount * 100) / 100;
    const finalAmount = Math.round((purchaseAmount - discountAmount) * 100) / 100;

    return {
      valid: true,
      coupon: {
        id: coupon.id,
        code: coupon.code,
        discount_type: coupon.discount_type,
        discount_value: parseFloat(coupon.discount_value),
        internal_name: coupon.internal_name
      },
      discount: discountAmount,
      originalAmount: purchaseAmount,
      finalAmount: Math.max(0, finalAmount),
      message: `Descuento de $${discountAmount.toFixed(2)} USD aplicado`
    };
  }

  async redeem(couponId, userId, transactionId, discountApplied, originalAmount, finalAmount, ip, userAgent) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Double-check coupon is still valid
      const coupon = await client.query('SELECT * FROM coupons WHERE id = $1 FOR UPDATE', [couponId]);
      if (coupon.rows.length === 0 || coupon.rows[0].status !== 'active') {
        throw new Error('Cupón ya no disponible');
      }
      if (coupon.rows[0].max_uses_total && coupon.rows[0].uses_count >= coupon.rows[0].max_uses_total) {
        throw new Error('Cupón agotado');
      }

      // Create redemption record
      const redemption = await client.query(`
        INSERT INTO coupon_redemptions (coupon_id, user_id, transaction_id, discount_applied, original_amount, final_amount, status, ip_address, user_agent)
        VALUES ($1, $2, $3, $4, $5, $6, 'applied', $7, $8)
        RETURNING *
      `, [couponId, userId, transactionId, discountApplied, originalAmount, finalAmount, ip, userAgent]);

      // Increment uses
      await client.query(
        'UPDATE coupons SET uses_count = uses_count + 1, updated_at = NOW() WHERE id = $1',
        [couponId]
      );

      // Auto-exhaust if limit reached
      await client.query(`
        UPDATE coupons SET status = 'exhausted', updated_at = NOW()
        WHERE id = $1 AND max_uses_total IS NOT NULL AND uses_count >= max_uses_total
      `, [couponId]);

      await client.query('COMMIT');
      return redemption.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async revertRedemption(redemptionId, adminId, ip) {
    const result = await pool.query(
      `UPDATE coupon_redemptions SET status = 'reverted', reverted_at = NOW() WHERE id = $1 RETURNING *`,
      [redemptionId]
    );
    if (result.rows.length === 0) throw new Error('Redención no encontrada');

    // Note: we do NOT decrement uses_count - once used, counts forever per requirements
    await this.logAudit(result.rows[0].coupon_id, 'redemption_reverted', adminId, { redemptionId }, { status: 'reverted' }, ip);
    return result.rows[0];
  }

  // ===== ELIGIBILITY HELPERS =====

  async checkUserEligibility(coupon, user) {
    switch (coupon.eligible_user_type) {
      case 'new_users': {
        const daysSinceCreation = (Date.now() - new Date(user.created_at).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceCreation > 30) {
          return { eligible: false, reason: 'not_new_user', message: 'Cupón solo válido para nuevos usuarios' };
        }
        break;
      }
      case 'existing_users': {
        const daysSinceCreation = (Date.now() - new Date(user.created_at).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceCreation <= 30) {
          return { eligible: false, reason: 'not_existing_user', message: 'Cupón solo válido para usuarios existentes' };
        }
        break;
      }
      case 'active_membership': {
        if (user.plan === 'free') {
          return { eligible: false, reason: 'no_membership', message: 'Cupón solo para usuarios con membresía activa' };
        }
        break;
      }
      case 'no_previous_purchases': {
        const purchases = await pool.query(
          `SELECT COUNT(*) FROM transactions WHERE user_id = $1 AND status = 'completed'`,
          [user.id]
        );
        if (parseInt(purchases.rows[0].count) > 0) {
          return { eligible: false, reason: 'has_purchases', message: 'Cupón solo para usuarios sin compras previas' };
        }
        break;
      }
      case 'no_previous_coupons': {
        const couponsUsed = await pool.query(
          `SELECT COUNT(*) FROM coupon_redemptions WHERE user_id = $1 AND status = 'applied'`,
          [user.id]
        );
        if (parseInt(couponsUsed.rows[0].count) > 0) {
          return { eligible: false, reason: 'used_coupon_before', message: 'Cupón solo para usuarios que no hayan usado otro cupón' };
        }
        break;
      }
    }
    return { eligible: true };
  }

  // ===== REPORTING & METRICS =====

  async getRedemptions(couponId, filters = {}) {
    const conditions = ['cr.coupon_id = $1'];
    const params = [couponId];
    let idx = 2;

    if (filters.status) {
      conditions.push(`cr.status = $${idx++}`);
      params.push(filters.status);
    }
    if (filters.user_search) {
      conditions.push(`u.email ILIKE $${idx++}`);
      params.push(`%${filters.user_search}%`);
    }

    const page = parseInt(filters.page) || 1;
    const limit = parseInt(filters.limit) || 25;
    const offset = (page - 1) * limit;
    params.push(limit, offset);

    const result = await pool.query(`
      SELECT cr.*, u.email as user_email, u.plan as user_plan
      FROM coupon_redemptions cr
      JOIN users u ON cr.user_id = u.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY cr.redeemed_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, params);

    const total = await pool.query(
      `SELECT COUNT(*) FROM coupon_redemptions cr JOIN users u ON cr.user_id = u.id WHERE ${conditions.join(' AND ')}`,
      params.slice(0, -2)
    );

    return {
      redemptions: result.rows,
      total: parseInt(total.rows[0].count),
      page,
      pages: Math.ceil(parseInt(total.rows[0].count) / limit)
    };
  }

  async getMetrics(couponId) {
    const [coupon, totalRedemptions, revenueStats, userStats] = await Promise.all([
      pool.query('SELECT * FROM coupons WHERE id = $1', [couponId]),
      pool.query(`
        SELECT
          COUNT(*) as total,
          COUNT(CASE WHEN status = 'applied' THEN 1 END) as applied,
          COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled,
          COUNT(CASE WHEN status = 'refunded' THEN 1 END) as refunded,
          COUNT(CASE WHEN status = 'reverted' THEN 1 END) as reverted
        FROM coupon_redemptions WHERE coupon_id = $1
      `, [couponId]),
      pool.query(`
        SELECT
          COALESCE(SUM(discount_applied), 0) as total_discount,
          COALESCE(SUM(final_amount), 0) as total_revenue,
          COALESCE(AVG(final_amount), 0) as avg_ticket,
          COUNT(DISTINCT user_id) as unique_users
        FROM coupon_redemptions
        WHERE coupon_id = $1 AND status = 'applied'
      `, [couponId]),
      pool.query(`
        SELECT COUNT(*) as new_users FROM coupon_redemptions cr
        JOIN users u ON cr.user_id = u.id
        WHERE cr.coupon_id = $1 AND cr.status = 'applied'
        AND u.created_at > NOW() - INTERVAL '30 days'
      `, [couponId])
    ]);

    if (coupon.rows.length === 0) throw new Error('Cupón no encontrado');
    const c = coupon.rows[0];

    return {
      coupon: c,
      uses_remaining: c.max_uses_total ? c.max_uses_total - c.uses_count : null,
      redemptions: totalRedemptions.rows[0],
      revenue: {
        total_discount: parseFloat(revenueStats.rows[0].total_discount),
        total_revenue: parseFloat(revenueStats.rows[0].total_revenue),
        avg_ticket: parseFloat(revenueStats.rows[0].avg_ticket),
        unique_users: parseInt(revenueStats.rows[0].unique_users)
      },
      new_users_captured: parseInt(userStats.rows[0].new_users)
    };
  }

  async getGlobalMetrics() {
    const [totalCoupons, activeCount, totalRedemptions, topCoupons, recentRedemptions] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM coupons'),
      pool.query(`SELECT COUNT(*) FROM coupons WHERE status = 'active'`),
      pool.query(`
        SELECT
          COUNT(*) as total,
          COALESCE(SUM(discount_applied), 0) as total_discount,
          COALESCE(SUM(final_amount), 0) as total_revenue
        FROM coupon_redemptions WHERE status = 'applied'
      `),
      pool.query(`
        SELECT c.id, c.code, c.internal_name, c.uses_count, c.status,
          COALESCE(SUM(cr.discount_applied), 0) as total_discount,
          COALESCE(SUM(cr.final_amount), 0) as total_revenue
        FROM coupons c
        LEFT JOIN coupon_redemptions cr ON cr.coupon_id = c.id AND cr.status = 'applied'
        GROUP BY c.id, c.code, c.internal_name, c.uses_count, c.status
        ORDER BY c.uses_count DESC LIMIT 5
      `),
      pool.query(`
        SELECT cr.*, c.code, u.email
        FROM coupon_redemptions cr
        JOIN coupons c ON cr.coupon_id = c.id
        JOIN users u ON cr.user_id = u.id
        ORDER BY cr.redeemed_at DESC LIMIT 10
      `)
    ]);

    return {
      total_coupons: parseInt(totalCoupons.rows[0].count),
      active_coupons: parseInt(activeCount.rows[0].count),
      total_redemptions: parseInt(totalRedemptions.rows[0].total),
      total_discount_given: parseFloat(totalRedemptions.rows[0].total_discount),
      total_revenue_with_coupons: parseFloat(totalRedemptions.rows[0].total_revenue),
      top_coupons: topCoupons.rows,
      recent_redemptions: recentRedemptions.rows
    };
  }

  // ===== AUDIT =====

  async getAuditLog(couponId, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const result = await pool.query(`
      SELECT cal.*, u.email as changed_by_email
      FROM coupon_audit_log cal
      LEFT JOIN users u ON cal.changed_by = u.id
      WHERE cal.coupon_id = $1
      ORDER BY cal.created_at DESC
      LIMIT $2 OFFSET $3
    `, [couponId, limit, offset]);
    return result.rows;
  }

  async logAudit(couponId, action, changedBy, oldValues, newValues, ip) {
    try {
      await pool.query(`
        INSERT INTO coupon_audit_log (coupon_id, action, changed_by, old_values, new_values, ip_address)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [couponId, action, changedBy, oldValues ? JSON.stringify(oldValues) : null, newValues ? JSON.stringify(newValues) : null, ip]);
    } catch (err) {
      console.error('[Coupon] Audit log error:', err.message);
    }
  }

  async logFailedAttempt(userId, code, reason, ip) {
    try {
      await pool.query(`
        INSERT INTO coupon_failed_attempts (user_id, code_attempted, reason, ip_address)
        VALUES ($1, $2, $3, $4)
      `, [userId || null, code, reason, ip || null]);
    } catch (err) {
      console.error('[Coupon] Failed attempt log error:', err.message);
    }
  }

  // ===== EXPORT =====

  async exportData(couponId) {
    const [coupon, redemptions] = await Promise.all([
      pool.query('SELECT * FROM coupons WHERE id = $1', [couponId]),
      pool.query(`
        SELECT cr.*, u.email, u.plan
        FROM coupon_redemptions cr
        JOIN users u ON cr.user_id = u.id
        WHERE cr.coupon_id = $1
        ORDER BY cr.redeemed_at DESC
      `, [couponId])
    ]);

    return {
      coupon: coupon.rows[0],
      redemptions: redemptions.rows
    };
  }
}

export default new CouponService();
