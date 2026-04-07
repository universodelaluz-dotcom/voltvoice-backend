import axios from 'axios';
import { config } from '../config.js';
import couponService from './couponService.js';
import db from '../db.js';

const PAYPAL_API = config.PAYPAL_MODE === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

const TOKEN_PACKAGES = {
  100000: { kind: 'tokens', price: 3.00, tokens: 100000, description: '100K Tokens - Pequeno' },
  250000: { kind: 'tokens', price: 7.00, tokens: 250000, description: '250K Tokens - Mediano' },
  500000: { kind: 'tokens', price: 12.00, tokens: 500000, description: '500K Tokens - Grande' },
  1000000: { kind: 'tokens', price: 20.00, tokens: 1000000, description: '1M Tokens - Maximo' }
};

const PLAN_PACKAGES = {
  'creator_monthly': { kind: 'plan', planKey: 'creator', backendPlan: 'pro', price: 7.99, tokens: 120000, description: 'Plan Creator Mensual' },
  'creator_annual': { kind: 'plan', planKey: 'creator', backendPlan: 'pro', price: 79.00, tokens: 120000, description: 'Plan Creator Anual' },
  'pro_monthly': { kind: 'plan', planKey: 'pro', backendPlan: 'premium', price: 19.99, tokens: 500000, description: 'Plan Pro Mensual' },
  'pro_annual': { kind: 'plan', planKey: 'pro', backendPlan: 'premium', price: 199.00, tokens: 500000, description: 'Plan Pro Anual' },
  'elite_monthly': { kind: 'plan', planKey: 'elite', backendPlan: 'elite', price: 39.99, tokens: 1500000, description: 'Plan Elite Mensual' },
  'elite_annual': { kind: 'plan', planKey: 'elite', backendPlan: 'elite', price: 399.00, tokens: 1500000, description: 'Plan Elite Anual' }
};

function getCheckoutItem(payload = {}) {
  if (payload.itemType === 'plan' || payload.planId) {
    const key = `${String(payload.planId || '').toLowerCase()}_${String(payload.billingCycle || 'monthly').toLowerCase()}`;
    return PLAN_PACKAGES[key] || null;
  }

  return TOKEN_PACKAGES[payload.tokensPackage] || null;
}

function parseReferenceId(referenceId) {
  const parts = String(referenceId || '').split('_');
  if (parts.length < 4 || parts[0] !== 'user') return null;

  const userId = parseInt(parts[1], 10);
  const kind = parts[2];
  const couponIndex = parts.indexOf('cpn');
  const couponId = couponIndex !== -1 ? parseInt(parts[couponIndex + 1], 10) : null;

  if (!Number.isInteger(userId) || userId <= 0) return null;

  if (kind === 'plan') {
    return {
      userId,
      kind,
      planId: parts[3],
      billingCycle: parts[4] || 'monthly',
      couponId: Number.isInteger(couponId) ? couponId : null,
    };
  }

  if (kind === 'tokens') {
    const tokensPackage = parseInt(parts[3], 10);
    if (!Number.isInteger(tokensPackage) || tokensPackage <= 0) return null;
    return {
      userId,
      kind,
      tokensPackage,
      couponId: Number.isInteger(couponId) ? couponId : null,
    };
  }

  return null;
}

async function getAccessToken() {
  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = config;
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error('PayPal credentials not configured');
  }

  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await axios.post(
    `${PAYPAL_API}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  );

  return res.data.access_token;
}

async function getPaypalOrder(orderId, accessToken) {
  const res = await axios.get(`${PAYPAL_API}/v2/checkout/orders/${orderId}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });

  return res.data;
}

export async function createPaypalOrder(userId, payload, ip) {
  const item = getCheckoutItem(payload);
  if (!item) throw new Error('Invalid checkout item');

  let finalPrice = item.price;
  let couponData = null;

  // Validate and apply coupon if provided
  if (payload.couponCode && payload.couponId) {
    const billingCycle = String(payload.billingCycle || 'monthly').toLowerCase();
    const itemId = item.kind === 'plan' ? `${item.planKey}_${billingCycle}` : payload.tokensPackage;
    const validation = await couponService.validate(
      payload.couponCode, userId, item.price, item.kind, itemId, ip
    );
    if (validation.valid) {
      finalPrice = validation.finalAmount;
      couponData = {
        couponId: validation.coupon.id,
        discount: validation.discount,
        originalAmount: item.price,
        finalAmount: validation.finalAmount
      };
    }
  }

  try {
    const accessToken = await getAccessToken();
    const billingCycle = String(payload.billingCycle || 'monthly').toLowerCase();
    const couponSuffix = couponData ? `_cpn_${couponData.couponId}` : '';
    const referenceId = item.kind === 'plan'
      ? `user_${userId}_plan_${item.planKey}_${billingCycle}${couponSuffix}`
      : `user_${userId}_tokens_${payload.tokensPackage}${couponSuffix}`;

    const res = await axios.post(
      `${PAYPAL_API}/v2/checkout/orders`,
      {
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: referenceId,
          description: `VoltVoice - ${item.description}${couponData ? ' (cupón aplicado)' : ''}`,
          amount: {
            currency_code: 'USD',
            value: finalPrice.toFixed(2)
          }
        }],
        application_context: {
          brand_name: 'VoltVoice',
          return_url: `${config.FRONTEND_URL}?payment=success&provider=paypal`,
          cancel_url: `${config.FRONTEND_URL}?payment=cancelled`,
          user_action: 'PAY_NOW'
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const approvalLink = res.data.links.find((link) => link.rel === 'approve');
    return {
      orderId: res.data.id,
      approvalUrl: approvalLink?.href || null,
      couponApplied: couponData
    };
  } catch (error) {
    console.error('[PAYPAL] Error creating order:', error.response?.data || error.message);
    throw error;
  }
}

export async function capturePaypalOrder(orderId, expectedUserId = null) {
  let client;
  let order;
  try {
    const accessToken = await getAccessToken();
    try {
      const res = await axios.post(
        `${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`,
        {},
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      order = res.data;
    } catch (captureError) {
      const issue = captureError?.response?.data?.details?.[0]?.issue;
      const isAlreadyCaptured = issue === 'ORDER_ALREADY_CAPTURED';

      if (!isAlreadyCaptured) {
        throw captureError;
      }

      order = await getPaypalOrder(orderId, accessToken);
    }

    const purchaseUnit = order?.purchase_units?.[0];
    const capture = purchaseUnit?.payments?.captures?.[0];
    const captureStatus = String(capture?.status || '').toUpperCase();
    const referenceId = purchaseUnit?.reference_id;
    const parsedRef = parseReferenceId(referenceId);

    if (!parsedRef) {
      throw new Error('Invalid or missing PayPal reference_id');
    }

    if (expectedUserId && Number(expectedUserId) !== parsedRef.userId) {
      throw new Error('Order does not belong to authenticated user');
    }

    if (captureStatus && captureStatus !== 'COMPLETED') {
      return {
        success: false,
        status: captureStatus,
        orderId: order?.id,
      };
    }

    const paymentAmount = Number(
      capture?.amount?.value ??
      purchaseUnit?.amount?.value ??
      0
    );

    const idempotencyKey = capture?.id
      ? `paypal_capture_${capture.id}`
      : `paypal_order_${order?.id}`;

    client = await db.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [idempotencyKey]);

    const existingTx = await client.query(
      `SELECT id, user_id, tokens_purchased, amount_usd, status
       FROM transactions
       WHERE stripe_payment_id = $1
       LIMIT 1`,
      [idempotencyKey]
    );

    if (existingTx.rows.length > 0) {
      await client.query('COMMIT');
      return {
        success: true,
        alreadyProcessed: true,
        transactionId: existingTx.rows[0].id,
        userId: existingTx.rows[0].user_id,
        tokensAdded: existingTx.rows[0].tokens_purchased,
        amountUsd: Number(existingTx.rows[0].amount_usd || 0),
        orderId: order?.id,
      };
    }

    let updateResult;
    let tokensAdded = 0;
    let planApplied = null;
    let originalAmount = paymentAmount;

    if (parsedRef.kind === 'plan') {
      const planKey = `${String(parsedRef.planId || '').toLowerCase()}_${String(parsedRef.billingCycle || 'monthly').toLowerCase()}`;
      const item = PLAN_PACKAGES[planKey];
      if (!item) {
        throw new Error('Invalid plan reference on PayPal order');
      }

      tokensAdded = item.tokens;
      planApplied = item.backendPlan;
      originalAmount = item.price;

      updateResult = await client.query(
        `UPDATE users
         SET plan = $1, tokens = GREATEST(tokens, $2), updated_at = CURRENT_TIMESTAMP
         WHERE id = $3
         RETURNING id, plan, tokens`,
        [item.backendPlan, item.tokens, parsedRef.userId]
      );
    } else {
      const item = TOKEN_PACKAGES[parsedRef.tokensPackage];
      if (!item) {
        throw new Error('Invalid tokens package reference on PayPal order');
      }

      tokensAdded = item.tokens;
      originalAmount = item.price;

      updateResult = await client.query(
        `UPDATE users
         SET tokens = tokens + $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2
         RETURNING id, plan, tokens`,
        [item.tokens, parsedRef.userId]
      );
    }

    if (!updateResult || updateResult.rows.length === 0) {
      throw new Error('User not found while applying PayPal payment');
    }

    const txResult = await client.query(
      `INSERT INTO transactions (user_id, tokens_purchased, amount_usd, stripe_payment_id, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [parsedRef.userId, tokensAdded, paymentAmount, idempotencyKey, 'completed']
    );

    if (parsedRef.couponId) {
      try {
        const discount = Math.max(0, originalAmount - paymentAmount);
        await couponService.redeem(
          parsedRef.couponId,
          parsedRef.userId,
          txResult.rows[0].id,
          discount,
          originalAmount,
          paymentAmount,
          null,
          null
        );
      } catch (couponError) {
        console.error('[PAYPAL] Coupon redemption error:', couponError.message);
      }
    }

    await client.query('COMMIT');

    return {
      success: true,
      alreadyProcessed: false,
      transactionId: txResult.rows[0].id,
      userId: parsedRef.userId,
      tokensAdded,
      plan: planApplied,
      newBalance: updateResult.rows[0].tokens,
      amountUsd: paymentAmount,
      orderId: order?.id,
      captureId: capture?.id || null,
    };
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
    }
    console.error('[PAYPAL] Error capturing order:', error.response?.data || error.message);
    throw error;
  } finally {
    if (client) {
      client.release();
    }
  }
}

export default { createPaypalOrder, capturePaypalOrder };
