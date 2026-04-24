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
  'base_monthly': { kind: 'plan', planKey: 'base', backendPlan: 'base', price: 9.99, tokens: 20000, description: 'Plan Base Mensual' },
  'base_annual': { kind: 'plan', planKey: 'base', backendPlan: 'base', price: 99.90, tokens: 20000, description: 'Plan Base Anual (2 meses gratis)' },
  'pack_lite_monthly': { kind: 'plan', planKey: 'pack_lite', backendPlan: 'pack_lite', price: 9.99, tokens: 50000, description: 'Pack Lite Mensual' },
  'pack_lite_combo_monthly': { kind: 'plan', planKey: 'pack_lite', backendPlan: 'pack_lite', price: 19.98, tokens: 70000, description: 'Plan Base + Lite Mensual (1 transacción)', monthlyBundleBasePack: true },
  'pack_lite_annual': { kind: 'plan', planKey: 'pack_lite', backendPlan: 'pack_lite', price: 199.80, tokens: 70000, description: 'Plan Anual Base + Lite (2 meses gratis)' },
  'pack_pro_monthly': { kind: 'plan', planKey: 'pack_pro', backendPlan: 'pack_pro', price: 24.99, tokens: 250000, description: 'Pack Pro Mensual' },
  'pack_pro_combo_monthly': { kind: 'plan', planKey: 'pack_pro', backendPlan: 'pack_pro', price: 34.98, tokens: 270000, description: 'Plan Base + Pro Mensual (1 transacción)', monthlyBundleBasePack: true },
  'pack_pro_annual': { kind: 'plan', planKey: 'pack_pro', backendPlan: 'pack_pro', price: 349.80, tokens: 270000, description: 'Plan Anual Base + Pro (2 meses gratis)' },
  'pack_max_monthly': { kind: 'plan', planKey: 'pack_max', backendPlan: 'pack_max', price: 49.99, tokens: 500000, description: 'Pack Max Mensual' },
  'pack_max_combo_monthly': { kind: 'plan', planKey: 'pack_max', backendPlan: 'pack_max', price: 59.98, tokens: 520000, description: 'Plan Base + Max Mensual (1 transacción)', monthlyBundleBasePack: true },
  'pack_max_annual': { kind: 'plan', planKey: 'pack_max', backendPlan: 'pack_max', price: 599.80, tokens: 520000, description: 'Plan Anual Base + Max (2 meses gratis)' },
};

const LEGACY_PLAN_ID_ALIASES = {
  start: 'base',
  creator: 'pack_lite',
  pro: 'pack_pro',
  premium: 'pack_lite',
  elite: 'pack_max',
};
const REPEATABLE_PACK_PLANS = new Set(['pack_lite', 'pack_pro', 'pack_max']);

function getCheckoutItem(payload = {}) {
  if (payload.itemType === 'plan' || payload.planId) {
    const rawPlanId = String(payload.planId || '').toLowerCase();
    const normalizedPlanId = LEGACY_PLAN_ID_ALIASES[rawPlanId] || rawPlanId;
    const key = `${normalizedPlanId}_${String(payload.billingCycle || 'monthly').toLowerCase()}`;
    const item = PLAN_PACKAGES[key];
    return item ? { ...item, checkoutPlanId: normalizedPlanId } : null;
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

const parseCheckoutReference = (rawReference = '') => {
  const parts = String(rawReference || '').split('_');
  if (parts.length < 4 || parts[0] !== 'user') return null;

  const userId = Number(parts[1]);
  const kind = String(parts[2] || '').toLowerCase();
  if (!Number.isFinite(userId) || userId <= 0 || !kind) return null;

  if (kind === 'plan') {
    if (parts.length < 5) return null;
    const cycleRaw = String(parts[parts.length - 1] || '').toLowerCase();
    const billingCycle = cycleRaw === 'annual' ? 'annual' : 'monthly';
    const planId = String(parts.slice(3, parts.length - 1).join('_') || '').toLowerCase();
    if (!planId) return null;
    return { userId, kind, planId, billingCycle };
  }

  if (kind === 'tokens') {
    const tokensPackage = Number.parseInt(parts[3], 10);
    if (!Number.isFinite(tokensPackage) || tokensPackage <= 0) return null;
    return { userId, kind, tokensPackage };
  }

  return null;
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
      quote = await subscriptionService.quotePlanChange(Number(userId), item.planKey, billingCycle, {
        allowPackFromFreeMonthly: Boolean(item.monthlyBundleBasePack),
      });
      const isRepeatablePackPurchase = REPEATABLE_PACK_PLANS.has(String(item.planKey || '').toLowerCase());
      if (quote.action === 'invalid') {
        const err = new Error(
          quote.reason === 'pack_requires_active_base_monthly'
            ? 'Para comprar un pack mensual primero debes activar el Plan Base.'
            : quote.reason === 'monthly_pack_not_allowed_on_annual_subscription'
              ? 'Con una suscripción anual activa no puedes comprar packs mensuales. Elige la versión anual del pack.'
            : 'No se pudo procesar el plan solicitado.'
        );
        err.statusCode = 400;
        throw err;
      }
      const shouldChargeNowForScheduledChange =
        ['downgrade_next_cycle', 'billing_cycle_next_cycle'].includes(quote.action);
      if (quote.action === 'already_scheduled' && !isRepeatablePackPurchase) {
        return {
          action: quote.action,
          requiresPayment: false,
          message: 'Este cambio ya está programado para el siguiente ciclo.',
          quote
        };
      }
      if (quote.action === 'pending_change_exists' && !isRepeatablePackPurchase) {
        return {
          action: quote.action,
          requiresPayment: false,
          message: 'Ya tienes un cambio de plan programado. Espera al próximo ciclo o cancela el cambio pendiente.',
          quote
        };
      }
      if (quote.action === 'already_on_plan' && !isRepeatablePackPurchase) {
        return {
          action: quote.action,
          requiresPayment: false,
          message: 'Ya tienes este plan activo para el ciclo actual.',
          quote
        };
      }
      if (isRepeatablePackPurchase && ['already_scheduled', 'pending_change_exists', 'already_on_plan'].includes(quote.action)) {
        quote = {
          ...quote,
          action: 'pack_repurchase',
          payableAmountUsd: Number(item.price || 0),
          prorationCreditUsd: 0
        };
      }

      chargedPrice = quote.payableAmountUsd;
      // En combos mensuales Base + Pack, el cobro debe usar el precio combo
      // definido para checkout, no el precio individual del pack.
      if (item.monthlyBundleBasePack) {
        chargedPrice = Number(item.price || 0);
      }
      if (shouldChargeNowForScheduledChange && chargedPrice <= 0) {
        chargedPrice = item.price;
      }
    }

    const referenceId = item.kind === 'plan'
      ? `user_${userId}_plan_${item.checkoutPlanId || item.planKey}_${billingCycle}`
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
    const frontendBaseUrl = String(options.frontendOrigin || config.FRONTEND_URL || '').trim().replace(/\/+$/, '');
    if (!backendBaseUrl) {
      throw new Error('BACKEND_URL not configured for PayPal return URL');
    }
    if (!frontendBaseUrl) {
      throw new Error('FRONTEND_URL not configured for PayPal cancel URL');
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
          return_url: `${backendBaseUrl}/api/paypal/return?front_origin=${encodeURIComponent(frontendBaseUrl)}`,
          cancel_url: `${frontendBaseUrl}?payment=cancelled&provider=paypal`,
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
    const parsedReference = parseCheckoutReference(referenceId);
    const userId = Number(parsedReference?.userId || 0);
    const kind = parsedReference?.kind;

    if (!userId || !kind) {
      throw new Error('Invalid PayPal reference_id');
    }

    const captureId = purchaseUnit?.payments?.captures?.[0]?.id || orderId;
    const amountPaid = Number(purchaseUnit?.payments?.captures?.[0]?.amount?.value || purchaseUnit?.amount?.value || 0);
    const couponMeta = parseCouponMeta(purchaseUnit?.custom_id || '');

    if (kind === 'plan') {
      const item = getCheckoutItem({
        itemType: 'plan',
        planId: parsedReference.planId,
        billingCycle: parsedReference.billingCycle
      });
      if (!item) throw new Error('Invalid plan reference');

      const applied = await subscriptionService.applyPaidPlanChange({
        userId,
        planKey: item.planKey,
        billingCycle: parsedReference.billingCycle,
        monthlyBundleBasePack: Boolean(item.monthlyBundleBasePack),
      });
      const scheduledChange = ['downgrade_next_cycle', 'billing_cycle_next_cycle'].includes(applied.quote?.action);
      const tokensPurchased = scheduledChange ? 0 : item.tokens;

      await db.query(
        `INSERT INTO transactions (user_id, tokens_purchased, amount_usd, stripe_payment_id, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, tokensPurchased, amountPaid, captureId, 'completed']
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
          purchasedAt: capture?.update_time || capture?.create_time || new Date().toISOString(),
          tokensReceived: tokensPurchased
        }).catch(() => {});
      }

      return {
        ...capture,
        planApplied: applied.subscription,
        quote: applied.quote
      };
    }

    const tokens = Number(parsedReference.tokensPackage || 0);
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
        purchasedAt: capture?.update_time || capture?.create_time || new Date().toISOString(),
        tokensReceived: tokens
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

