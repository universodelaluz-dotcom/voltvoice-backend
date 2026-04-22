import axios from 'axios';
import { config } from '../config.js';
import db from '../db.js';
import subscriptionService from './subscriptionService.js';
import { sendPaymentReceiptEmail } from './mail.js';
import couponService from './couponService.js';

const PAYPAL_API = config.PAYPAL_MODE === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

const TOKEN_PACKAGES = {
  150000: { kind: 'tokens', price: 4.99, tokens: 150000, description: 'MINI BOOST - 150K caracteres' },
  350000: { kind: 'tokens', price: 9.99, tokens: 350000, description: 'POWER BOOST - 350K caracteres' },
  700000: { kind: 'tokens', price: 14.99, tokens: 700000, description: 'MAX BOOST - 700K caracteres' }
};

const PLAN_PACKAGES = {
  'start_monthly': { kind: 'plan', planKey: 'start', backendPlan: 'pro', price: 6.99, tokens: 200000, description: 'Plan Base Mensual' },
  'start_annual': { kind: 'plan', planKey: 'start', backendPlan: 'pro', price: 59.00, tokens: 200000, description: 'Plan Base Anual' },
  'creator_monthly': { kind: 'plan', planKey: 'creator', backendPlan: 'premium', price: 12.99, tokens: 500000, description: 'Plan Base + Pack Lite Mensual' },
  'creator_annual': { kind: 'plan', planKey: 'creator', backendPlan: 'premium', price: 109.00, tokens: 500000, description: 'Plan Base + Pack Lite Anual' },
  'pro_monthly': { kind: 'plan', planKey: 'pro', backendPlan: 'elite', price: 17.99, tokens: 800000, description: 'Plan Base + Pack Pro Mensual' },
  'pro_annual': { kind: 'plan', planKey: 'pro', backendPlan: 'elite', price: 149.00, tokens: 800000, description: 'Plan Base + Pack Pro Anual' }
};

function getCheckoutItem(payload = {}) {
  if (payload.itemType === 'plan' || payload.planId) {
    const key = `${String(payload.planId || '').toLowerCase()}_${String(payload.billingCycle || 'monthly').toLowerCase()}`;
    return PLAN_PACKAGES[key] || null;
  }

  return TOKEN_PACKAGES[payload.tokensPackage] || null;
}

async function ensurePaidPlanForTokenPackages(userId) {
  const result = await db.query(
    "SELECT LOWER(COALESCE(plan, 'free')) AS plan FROM users WHERE id = $1 LIMIT 1",
    [Number(userId)]
  );
  const plan = String(result.rows?.[0]?.plan || 'free').toLowerCase();
  if (plan === 'free' || plan === 'on_demand') {
    const error = new Error('Los paquetes de tokens están disponibles solo para usuarios con plan de pago activo.');
    error.statusCode = 403;
    throw error;
  }
}

async function getUserEmail(userId) {
  try {
    const result = await db.query(
      "SELECT email FROM users WHERE id = $1 LIMIT 1",
      [Number(userId)]
    );
    return String(result.rows?.[0]?.email || '').trim().toLowerCase();
  } catch {
    return '';
  }
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

const buildCouponMeta = ({ couponId, originalAmount, finalAmount }) => {
  const safeCouponId = Number.isFinite(Number(couponId)) ? Number(couponId) : 0;
  const original = Number(originalAmount || 0);
  const final = Number(finalAmount || 0);
  return `cp:${safeCouponId}|od:${original.toFixed(2)}|fd:${final.toFixed(2)}`;
};

const parseCouponMeta = (customId = '') => {
  const out = { couponId: 0, originalAmount: 0, finalAmount: 0 };
  const parts = String(customId || '').split('|');
  for (const p of parts) {
    const [k, v] = String(p || '').split(':');
    if (!k) continue;
    if (k === 'cp') out.couponId = Number.parseInt(v, 10) || 0;
    if (k === 'od') out.originalAmount = Number(v) || 0;
    if (k === 'fd') out.finalAmount = Number(v) || 0;
  }
  return out;
};

export async function createPaypalOrder(userId, payload, options = {}) {
  const item = getCheckoutItem(payload);
  if (!item) throw new Error('Invalid checkout item');
  if (item.kind === 'tokens') {
    await ensurePaidPlanForTokenPackages(userId);
  }

  try {
    const accessToken = await getAccessToken();
    const billingCycle = String(payload.billingCycle || 'monthly').toLowerCase();
    let quote = null;
    let chargedPrice = item.price;
    const originalPrice = Number(item.price || 0);
    let couponMeta = null;

    if (item.kind === 'plan') {
      quote = await subscriptionService.quotePlanChange(Number(userId), item.planKey, billingCycle);
      const shouldChargeNowForScheduledChange =
        ['downgrade_next_cycle', 'billing_cycle_next_cycle'].includes(quote.action);
      if (quote.action === 'already_scheduled') {
        return {
          action: quote.action,
          requiresPayment: false,
          message: 'Este cambio ya está programado para el siguiente ciclo.',
          quote
        };
      }
      if (quote.action === 'pending_change_exists') {
        return {
          action: quote.action,
          requiresPayment: false,
          message: 'Ya tienes un cambio de plan programado. Espera al próximo ciclo o cancela el cambio pendiente.',
          quote
        };
      }
      if (quote.action === 'already_on_plan') {
        return {
          action: quote.action,
          requiresPayment: false,
          message: 'Ya tienes este plan activo para el ciclo actual.',
          quote
        };
      }
      chargedPrice = quote.payableAmountUsd;
      if (shouldChargeNowForScheduledChange && chargedPrice <= 0) {
        chargedPrice = item.price;
      }
    }

    const referenceId = item.kind === 'plan'
      ? `user_${userId}_plan_${item.planKey}_${billingCycle}`
      : `user_${userId}_tokens_${payload.tokensPackage}`;

    const couponCode = String(payload.couponCode || '').trim();
    const couponId = Number.parseInt(payload.couponId, 10);
    if (couponCode && chargedPrice > 0) {
      const couponValidation = await couponService.validate(
        couponCode,
        Number(userId),
        Number(chargedPrice),
        item.kind === 'plan' ? 'plan' : 'tokens',
        item.kind === 'plan' ? item.planKey : item.tokens,
        options.clientIp || null
      );

      if (!couponValidation?.valid) {
        const err = new Error(couponValidation?.message || 'Cupón inválido para esta compra');
        err.statusCode = 400;
        throw err;
      }

      const validatedCouponId = Number(couponValidation?.coupon?.id || 0);
      if (Number.isFinite(couponId) && couponId > 0 && validatedCouponId > 0 && couponId !== validatedCouponId) {
        const err = new Error('El cupón cambió, vuelve a validarlo e intenta de nuevo.');
        err.statusCode = 400;
        throw err;
      }

      chargedPrice = Number(couponValidation.finalAmount || chargedPrice);
      couponMeta = {
        couponId: validatedCouponId,
        originalAmount: Number(couponValidation.originalAmount || originalPrice),
        finalAmount: Number(couponValidation.finalAmount || chargedPrice),
        discount: Number(couponValidation.discount || 0),
      };
    }

    const backendBaseUrl = String(options.backendBaseUrl || config.BACKEND_URL || '').trim().replace(/\/+$/, '');
    if (!backendBaseUrl) {
      throw new Error('BACKEND_URL not configured for PayPal return URL');
    }

    const res = await axios.post(
      `${PAYPAL_API}/v2/checkout/orders`,
      {
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: referenceId,
          custom_id: couponMeta ? buildCouponMeta(couponMeta) : undefined,
          description: `Streamvoicer - ${item.description}`,
          amount: {
            currency_code: 'USD',
            value: chargedPrice.toFixed(2)
          }
        }],
        application_context: {
          brand_name: 'Streamvoicer',
          return_url: `${backendBaseUrl}/api/paypal/return`,
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
      action: quote?.action || 'purchase',
      requiresPayment: true,
      quote
    };
  } catch (error) {
    console.error('[PAYPAL] Error creating order:', error.response?.data || error.message);
    throw error;
  }
}

export async function capturePaypalOrder(orderId, options = {}) {
  try {
    const accessToken = await getAccessToken();
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
    const capture = res.data;
    const purchaseUnit = capture?.purchase_units?.[0];
    const referenceId = String(purchaseUnit?.reference_id || '');
    const parts = referenceId.split('_');
    const userId = Number(parts[1]);
    const kind = parts[2];

    if (!userId || !kind) {
      throw new Error('Invalid PayPal reference_id');
    }

    const captureId = purchaseUnit?.payments?.captures?.[0]?.id || orderId;
    const amountPaid = Number(purchaseUnit?.payments?.captures?.[0]?.amount?.value || purchaseUnit?.amount?.value || 0);
    const couponMeta = parseCouponMeta(purchaseUnit?.custom_id || '');

    if (kind === 'plan') {
      const item = getCheckoutItem({
        itemType: 'plan',
        planId: parts[3],
        billingCycle: parts[4]
      });
      if (!item) throw new Error('Invalid plan reference');

      const applied = await subscriptionService.applyPaidPlanChange({
        userId,
        planKey: item.planKey,
        billingCycle: parts[4]
      });

      await db.query(
        `INSERT INTO transactions (user_id, tokens_purchased, amount_usd, stripe_payment_id, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, item.tokens, amountPaid, captureId, 'completed']
      );

      if (couponMeta.couponId > 0 && couponMeta.originalAmount > couponMeta.finalAmount) {
        await couponService.redeem(
          couponMeta.couponId,
          userId,
          String(captureId),
          Math.max(0, Number(couponMeta.originalAmount - couponMeta.finalAmount)),
          Number(couponMeta.originalAmount),
          Number(couponMeta.finalAmount),
          options.clientIp || null,
          options.userAgent || null
        );
      }

      const planBuyerEmail = await getUserEmail(userId);
      if (planBuyerEmail) {
        sendPaymentReceiptEmail({
          toEmail: planBuyerEmail,
          provider: 'paypal',
          paymentId: String(captureId),
          itemDescription: item.description,
          amount: amountPaid,
          currency: purchaseUnit?.payments?.captures?.[0]?.amount?.currency_code || 'USD',
          purchasedAt: capture?.update_time || capture?.create_time || new Date().toISOString()
        }).catch(() => {});
      }

      return {
        ...capture,
        planApplied: applied.subscription,
        quote: applied.quote
      };
    }

    const tokens = parseInt(parts[3], 10);
    const balance = await db.query(
      `UPDATE users
       SET tokens = tokens + $1
       WHERE id = $2
       RETURNING tokens`,
      [tokens, userId]
    );

    await db.query(
      `INSERT INTO transactions (user_id, tokens_purchased, amount_usd, stripe_payment_id, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, tokens, amountPaid, captureId, 'completed']
    );

    if (couponMeta.couponId > 0 && couponMeta.originalAmount > couponMeta.finalAmount) {
      await couponService.redeem(
        couponMeta.couponId,
        userId,
        String(captureId),
        Math.max(0, Number(couponMeta.originalAmount - couponMeta.finalAmount)),
        Number(couponMeta.originalAmount),
        Number(couponMeta.finalAmount),
        options.clientIp || null,
        options.userAgent || null
      );
    }

    const tokensBuyerEmail = await getUserEmail(userId);
    if (tokensBuyerEmail) {
      sendPaymentReceiptEmail({
        toEmail: tokensBuyerEmail,
        provider: 'paypal',
        paymentId: String(captureId),
        itemDescription: `${tokens} tokens`,
        amount: amountPaid,
        currency: purchaseUnit?.payments?.captures?.[0]?.amount?.currency_code || 'USD',
        purchasedAt: capture?.update_time || capture?.create_time || new Date().toISOString()
      }).catch(() => {});
    }

    return {
      ...capture,
      tokensAdded: tokens,
      newBalance: balance.rows[0]?.tokens || 0
    };
  } catch (error) {
    console.error('[PAYPAL] Error capturing order:', error.response?.data || error.message);
    throw error;
  }
}

export default { createPaypalOrder, capturePaypalOrder };

