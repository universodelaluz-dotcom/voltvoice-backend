import axios from 'axios';
import db from '../db.js';
import { config } from '../config.js';
import subscriptionService from './subscriptionService.js';
import { sendPaymentReceiptEmail } from './mail.js';
import couponService from './couponService.js';

const TOKEN_PACKAGES = {
  100: { kind: 'tokens', price: 15, tokens: 100, description: 'TEST - 100 tokens' },
  150000: { kind: 'tokens', price: 4.99, tokens: 150000, description: 'MINI BOOST - 150K caracteres' },
  350000: { kind: 'tokens', price: 9.99, tokens: 350000, description: 'POWER BOOST - 350K caracteres' },
  700000: { kind: 'tokens', price: 14.99, tokens: 700000, description: 'MAX BOOST - 700K caracteres' }
};

const PLAN_PACKAGES = {
  'base_monthly': { kind: 'plan', planKey: 'base', backendPlan: 'base', price: 9.99, tokens: 20000, description: 'Plan Base Mensual' },
  'base_annual': { kind: 'plan', planKey: 'base', backendPlan: 'base', price: 99.00, tokens: 20000, description: 'Plan Base Anual' },
  'pack_lite_monthly': { kind: 'plan', planKey: 'pack_lite', backendPlan: 'pack_lite', price: 9.99, tokens: 50000, description: 'Pack Lite Mensual' },
  'pack_lite_annual': { kind: 'plan', planKey: 'pack_lite', backendPlan: 'pack_lite', price: 99.00, tokens: 50000, description: 'Pack Lite Anual' },
  'pack_pro_monthly': { kind: 'plan', planKey: 'pack_pro', backendPlan: 'pack_pro', price: 24.99, tokens: 250000, description: 'Pack Pro Mensual' },
  'pack_pro_annual': { kind: 'plan', planKey: 'pack_pro', backendPlan: 'pack_pro', price: 249.00, tokens: 250000, description: 'Pack Pro Anual' },
  'pack_max_monthly': { kind: 'plan', planKey: 'pack_max', backendPlan: 'pack_max', price: 49.99, tokens: 500000, description: 'Pack Max Mensual' },
  'pack_max_annual': { kind: 'plan', planKey: 'pack_max', backendPlan: 'pack_max', price: 499.00, tokens: 500000, description: 'Pack Max Anual' },
};

const LEGACY_PLAN_ID_ALIASES = {
  start: 'base',
  creator: 'pack_lite',
  pro: 'pack_pro',
  premium: 'pack_lite',
  elite: 'pack_max',
};
const REPEATABLE_PACK_PLANS = new Set(['pack_lite', 'pack_pro', 'pack_max']);

const roundMoney = (value) => Math.max(0, Math.round((Number(value) || 0) * 100) / 100);

const normalizeCurrency = (value) => {
  const code = String(value || '').trim().toUpperCase();
  return code === 'USD' ? 'USD' : 'MXN';
};

const convertUsdToCheckoutAmount = (amountUsd) => {
  const currency = normalizeCurrency(config.MERCADO_PAGO_CURRENCY);
  const usd = Number(amountUsd) || 0;
  if (currency === 'USD') {
    return { amount: roundMoney(usd), currency };
  }

  const rate = Number(config.MERCADO_PAGO_USD_MXN_RATE);
  const usdToMxnRate = Number.isFinite(rate) && rate > 0 ? rate : 17;
  return { amount: roundMoney(usd * usdToMxnRate), currency };
};

const buildCouponMeta = ({ couponId, originalAmount, finalAmount }) => {
  const safeCouponId = Number.isFinite(Number(couponId)) ? Number(couponId) : 0;
  const original = Number(originalAmount || 0);
  const final = Number(finalAmount || 0);
  return `cp:${safeCouponId}|od:${original.toFixed(2)}|fd:${final.toFixed(2)}`;
};

const parseCouponMeta = (raw = '') => {
  const out = { couponId: 0, originalAmount: 0, finalAmount: 0 };
  const parts = String(raw || '').split('|');
  for (const p of parts) {
    const [k, v] = String(p || '').split(':');
    if (!k) continue;
    if (k === 'cp') out.couponId = Number.parseInt(v, 10) || 0;
    if (k === 'od') out.originalAmount = Number(v) || 0;
    if (k === 'fd') out.finalAmount = Number(v) || 0;
  }
  return out;
};

const isPublicHttpsUrl = (urlValue) => {
  try {
    const parsed = new URL(String(urlValue || ''));
    const host = String(parsed.hostname || '').toLowerCase();
    const isLocalHost = host === 'localhost' || host === '127.0.0.1';
    return parsed.protocol === 'https:' && !isLocalHost;
  } catch {
    return false;
  }
};

const resolveReturnBaseUrl = (candidateUrl) => {
  const fallback = String(config.FRONTEND_URL || '').trim();
  try {
    const parsed = new URL(String(candidateUrl || '').trim());
    const host = String(parsed.hostname || '').toLowerCase();
    const isLocalHost = host === 'localhost' || host === '127.0.0.1';
    const isHttps = parsed.protocol === 'https:';
    const isLocalHttp = isLocalHost && parsed.protocol === 'http:';
    if (isHttps || isLocalHttp) return `${parsed.protocol}//${parsed.host}`;
  } catch {}
  return fallback;
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

class MercadoPagoService {
  constructor() {
    this.apiUrl = 'https://api.mercadopago.com/checkout/preferences';
    this.token = config.MERCADO_PAGO_ACCESS_TOKEN;
    this.preferenceCache = new Map();

    if (!this.token) {
      console.warn('[MERCADO_PAGO] Access token not configured. Payments will not work.');
    } else {
      console.log('[MERCADO_PAGO] Service initialized');
    }
  }

  getCheckoutItem(payload = {}) {
    if (payload.itemType === 'plan' || payload.planId) {
      const rawPlanId = String(payload.planId || '').toLowerCase();
      const normalizedPlanId = LEGACY_PLAN_ID_ALIASES[rawPlanId] || rawPlanId;
      const key = `${normalizedPlanId}_${String(payload.billingCycle || 'monthly').toLowerCase()}`;
      return PLAN_PACKAGES[key] || null;
    }

    return TOKEN_PACKAGES[payload.tokensPackage] || null;
  }

  async getTestResetCutoff(userId) {
    try {
      await db.query(`
        CREATE TABLE IF NOT EXISTS test_lab_user_resets (
          user_id INT PRIMARY KEY,
          reset_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      const result = await db.query(
        'SELECT reset_at FROM test_lab_user_resets WHERE user_id = $1 LIMIT 1',
        [Number(userId)]
      );
      const value = result.rows?.[0]?.reset_at;
      return value ? new Date(value) : null;
    } catch (error) {
      console.warn('[MERCADO_PAGO] Could not read test reset cutoff:', error.message);
      return null;
    }
  }

  async getPayerData(userId) {
    if (!userId) return {};
    try {
      const result = await db.query(
        'SELECT email FROM users WHERE id = $1 LIMIT 1',
        [userId]
      );
      const email = String(result.rows?.[0]?.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) return {};
      return { email };
    } catch (error) {
      console.warn('[MERCADO_PAGO] Could not load payer data:', error.message);
      return {};
    }
  }

  async getUserEmail(userId) {
    try {
      const result = await db.query('SELECT email FROM users WHERE id = $1 LIMIT 1', [Number(userId)]);
      return String(result.rows?.[0]?.email || '').trim().toLowerCase();
    } catch {
      return '';
    }
  }

  async ensurePaidPlanForTokenPackages(userId) {
    const result = await db.query(
      'SELECT LOWER(COALESCE(plan, \'free\')) AS plan FROM users WHERE id = $1 LIMIT 1',
      [Number(userId)]
    );
    const plan = String(result.rows?.[0]?.plan || 'free').toLowerCase();
    if (plan === 'free' || plan === 'on_demand') {
      const error = new Error('Los paquetes de tokens están disponibles solo para usuarios con plan de pago activo.');
      error.statusCode = 403;
      throw error;
    }
  }

  async createPaymentPreference(userId, payload) {
    try {
      if (!this.token) {
        throw new Error('MERCADO_PAGO_ACCESS_TOKEN is not configured');
      }

      const item = this.getCheckoutItem(payload);
      if (!item) {
        throw new Error('Invalid checkout item');
      }
      if (item.kind === 'tokens') {
        await this.ensurePaidPlanForTokenPackages(userId);
      }

      const billingCycle = String(payload.billingCycle || 'monthly').toLowerCase();
      let quotedPlan = null;
      let chargedPrice = item.price;
      const originalPrice = Number(item.price || 0);
      let couponMeta = null;

      if (item.kind === 'plan') {
        quotedPlan = await subscriptionService.quotePlanChange(Number(userId), item.planKey, billingCycle);
        const isRepeatablePackPurchase = REPEATABLE_PACK_PLANS.has(String(item.planKey || '').toLowerCase());

        const shouldChargeNowForScheduledChange =
          // Para evitar bloqueos antes de checkout: cambios programables cobran primero.
          ['downgrade_next_cycle', 'billing_cycle_next_cycle'].includes(quotedPlan.action);

        if (quotedPlan.action === 'already_scheduled' && !isRepeatablePackPurchase) {
          return {
            success: true,
            action: quotedPlan.action,
            requiresPayment: false,
            message: 'Este cambio ya está programado para el siguiente ciclo.',
            quote: quotedPlan
          };
        }

        if (quotedPlan.action === 'pending_change_exists' && !isRepeatablePackPurchase) {
          return {
            success: true,
            action: quotedPlan.action,
            requiresPayment: false,
            message: 'Ya tienes un cambio de plan programado. Espera al próximo ciclo o cancela el cambio pendiente.',
            quote: quotedPlan
          };
        }

        if (quotedPlan.action === 'already_on_plan' && !isRepeatablePackPurchase) {
          return {
            success: true,
            action: quotedPlan.action,
            requiresPayment: false,
            message: 'Ya tienes este plan activo para el ciclo actual.',
            quote: quotedPlan
          };
        }

        if (isRepeatablePackPurchase && ['already_scheduled', 'pending_change_exists', 'already_on_plan'].includes(quotedPlan.action)) {
          quotedPlan = {
            ...quotedPlan,
            action: 'pack_repurchase',
            payableAmountUsd: Number(item.price || 0),
            prorationCreditUsd: 0
          };
        }

        chargedPrice = quotedPlan.payableAmountUsd;
        if (shouldChargeNowForScheduledChange && chargedPrice <= 0) {
          chargedPrice = item.price;
        }
      }

      const couponCode = String(payload.couponCode || '').trim();
      const couponId = Number.parseInt(payload.couponId, 10);
      if (couponCode && chargedPrice > 0) {
        const couponValidation = await couponService.validate(
          couponCode,
          Number(userId),
          Number(chargedPrice),
          item.kind === 'plan' ? 'plan' : 'tokens',
          item.kind === 'plan' ? item.planKey : item.tokens,
          null
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

      const baseExternalReference = item.kind === 'plan'
        ? `user_${userId}_plan_${item.planKey}_${billingCycle}`
        : `user_${userId}_tokens_${payload.tokensPackage}_${Date.now()}`;
      const externalReference = couponMeta
        ? `${baseExternalReference}|${buildCouponMeta(couponMeta)}`
        : baseExternalReference;
      const cacheKey = item.kind === 'plan'
        ? baseExternalReference
        : `user_${userId}_tokens_${payload.tokensPackage}`;
      const now = Date.now();
      const cached = this.preferenceCache.get(cacheKey);
      if (item.kind === 'plan' && cached && cached.expiresAt > now) {
        return {
          success: true,
          action: quotedPlan?.action || 'purchase',
          requiresPayment: true,
          quote: quotedPlan,
          preferenceId: cached.preferenceId,
          initPoint: cached.initPoint,
          sandboxInitPoint: cached.sandboxInitPoint,
          cached: true
        };
      }
      const checkoutAmount = convertUsdToCheckoutAmount(chargedPrice);
      console.log(
        `[MERCADO_PAGO] Preference amount -> usd_base=${roundMoney(chargedPrice)} ${checkoutAmount.currency}_sent=${checkoutAmount.amount}`
      );

      const tokenLooksTest = String(this.token || '').startsWith('TEST-');
      const payer = tokenLooksTest ? {} : await this.getPayerData(userId);

      const returnBaseUrl = resolveReturnBaseUrl(payload?.returnUrlBase || payload?.requestOrigin);
      const successUrl = `${returnBaseUrl}?payment=success&provider=mercadopago`;
      const failureUrl = `${returnBaseUrl}?payment=failed&provider=mercadopago`;
      const pendingUrl = `${returnBaseUrl}?payment=pending&provider=mercadopago`;

      const preferenceData = {
        items: [
          {
            id: item.kind === 'plan'
              ? `plan_${item.planKey}_${billingCycle}`
              : `tokens_${payload.tokensPackage}`,
            title: `Streamvoicer - ${item.description}`,
            description: item.kind === 'plan'
              ? `Compra del ${item.description}`
              : `Compra ${payload.tokensPackage} tokens para sintetizar voces`,
            quantity: 1,
            unit_price: checkoutAmount.amount,
            currency_id: checkoutAmount.currency
          }
        ],
        payer,
        back_urls: {
          success: successUrl,
          failure: failureUrl,
          pending: pendingUrl
        },
        notification_url: `${config.BACKEND_URL}/api/mercadopago/webhook`,
        external_reference: externalReference,
        currency_id: checkoutAmount.currency
      };

      const frontendUrlLower = String(returnBaseUrl || '').toLowerCase();
      const isValidUrl = frontendUrlLower.startsWith('http');
      const isProduction = !frontendUrlLower.includes('localhost') && !frontendUrlLower.includes('127.0.0.1');
      const shouldTryAutoReturn = isValidUrl && (isProduction || config.isDevelopment);
      if (shouldTryAutoReturn) {
        preferenceData.auto_return = 'approved';
      }

      // En entorno de pruebas/local, forzar flujo con tarjeta para reducir
      // errores de procesamiento en medios alternativos.
      const forceCardFlow =
        tokenLooksTest ||
        (config.isDevelopment && item.kind === 'tokens');
      if (forceCardFlow) {
        preferenceData.payment_methods = {
          excluded_payment_types: [
            { id: 'ticket' },
            { id: 'atm' },
            { id: 'bank_transfer' }
          ],
          installments: 1,
          default_installments: 1
        };
      }


      const requestHeaders = {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      };

      let response;
      try {
        response = await axios.post(this.apiUrl, preferenceData, { headers: requestHeaders });
      } catch (initialError) {
        const status = Number(initialError?.response?.status || 0);
        const apiCause = String(initialError?.response?.data?.cause?.[0]?.code || '').toLowerCase();
        const apiMessage = String(initialError?.response?.data?.message || '').toLowerCase();
        const shouldRetryWithoutAutoReturn =
          status === 400 &&
          preferenceData?.auto_return === 'approved' &&
          (
            apiCause.includes('invalid_back_urls') ||
            apiMessage.includes('back_url') ||
            apiMessage.includes('back_urls') ||
            apiMessage.includes('auto_return')
          );

        const shouldRetryWithoutPayer = (status === 401 || status === 403);

        if (!shouldRetryWithoutAutoReturn && !shouldRetryWithoutPayer) throw initialError;

        if (shouldRetryWithoutAutoReturn) {
          console.warn('[MERCADO_PAGO] Retry create preference without auto_return due to invalid back_urls/auto_return');
          delete preferenceData.auto_return;
        }
        if (shouldRetryWithoutPayer) {
          console.warn('[MERCADO_PAGO] Retry create preference without payer due to auth policy');
          delete preferenceData.payer;
        }
        response = await axios.post(this.apiUrl, preferenceData, { headers: requestHeaders });
      }

      const responsePayload = {
        success: true,
        action: quotedPlan?.action || 'purchase',
        requiresPayment: true,
        quote: quotedPlan,
        preferenceId: response.data.id,
        // Usar init_point como URL principal incluso con credenciales TEST.
        // sandbox_init_point puede causar bucles de redirect/challenge en algunos flujos.
        initPoint: response.data.init_point || response.data.sandbox_init_point,
        sandboxInitPoint: response.data.sandbox_init_point
      };
      if (item.kind === 'plan') {
        this.preferenceCache.set(cacheKey, {
          preferenceId: responsePayload.preferenceId,
          initPoint: responsePayload.initPoint,
          sandboxInitPoint: responsePayload.sandboxInitPoint,
          expiresAt: Date.now() + 60 * 1000
        });
      }
      return responsePayload;
    } catch (error) {
      const details = error?.response?.data || error.message;
      console.error('[MERCADO_PAGO] Error creating payment preference:', details);
      const normalizedMessage =
        error?.response?.data?.message ||
        error?.response?.data?.cause?.[0]?.description ||
        error?.message ||
        'Error creating payment preference';
      throw new Error(normalizedMessage);
    }
  }

  async handlePaymentNotification(paymentData) {
    let paymentId = '';
    let lockAcquired = false;
    try {
      paymentId = String(paymentData?.data?.id || '').trim();
      if (!paymentId) {
        throw new Error('Invalid payment id');
      }

      await db.query(`
        CREATE TABLE IF NOT EXISTS payment_processing_locks (
          provider VARCHAR(40) NOT NULL,
          payment_id VARCHAR(120) NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          PRIMARY KEY (provider, payment_id)
        )
      `);

      const lockResult = await db.query(
        `INSERT INTO payment_processing_locks (provider, payment_id, created_at)
         VALUES ('mercadopago', $1, NOW())
         ON CONFLICT (provider, payment_id) DO NOTHING
         RETURNING payment_id`,
        [paymentId]
      );
      lockAcquired = lockResult.rows.length > 0;
      if (!lockAcquired) {
        console.log(`[MERCADO_PAGO] Pago ${paymentId} ya está en proceso o procesado, ignorando.`);
        return { success: true, status: 'already_processed' };
      }

      // Idempotencia: no procesar el mismo pago dos veces
      const existing = await db.query(
        'SELECT id FROM transactions WHERE stripe_payment_id = $1',
        [paymentId]
      );
      if (existing.rows.length > 0) {
        console.log(`[MERCADO_PAGO] Pago ${paymentId} ya fue procesado, ignorando.`);
        return { success: true, status: 'already_processed' };
      }

      const response = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: {
          'Authorization': `Bearer ${this.token}`
        }
      });

      const payment = response.data;
      console.log(
        `[MERCADO_PAGO] Payment notification -> id=${payment.id} status=${payment.status} amount=${payment.transaction_amount} currency=${payment.currency_id}`
      );
      if (payment.status !== 'approved') {
        return { success: false, status: payment.status };
      }

      const [baseReference, couponRawMeta = ''] = String(payment.external_reference || '').split('|', 2);
      const parsedReference = parseCheckoutReference(baseReference);
      const userId = parsedReference?.userId;
      const kind = parsedReference?.kind;
      const couponMeta = parseCouponMeta(couponRawMeta);

      if (!userId || !kind) {
        throw new Error('Invalid external reference');
      }

      const resetCutoff = await this.getTestResetCutoff(userId);
      const paymentCreatedAt = payment?.date_created ? new Date(payment.date_created) : null;
      if (
        resetCutoff &&
        paymentCreatedAt &&
        Number.isFinite(paymentCreatedAt.getTime()) &&
        paymentCreatedAt.getTime() <= resetCutoff.getTime()
      ) {
        console.log(
          `[MERCADO_PAGO] Ignorando pago ${payment.id} por reset de test user (${resetCutoff.toISOString()}).`
        );
        return { success: true, status: 'ignored_before_test_reset' };
      }

      if (kind === 'plan') {
        const item = this.getCheckoutItem({
          itemType: 'plan',
          planId: parsedReference.planId,
          billingCycle: parsedReference.billingCycle
        });

        if (!item) {
          throw new Error('Invalid plan reference');
        }

        const applied = await subscriptionService.applyPaidPlanChange({
          userId: Number(userId),
          planKey: item.planKey,
          billingCycle: parsedReference.billingCycle
        });

        const scheduledChange = ['downgrade_next_cycle', 'billing_cycle_next_cycle'].includes(applied.quote?.action);
        const tokensPurchased = scheduledChange ? 0 : item.tokens;

        await db.query(
          `INSERT INTO transactions (user_id, tokens_purchased, amount_usd, stripe_payment_id, status)
           VALUES ($1, $2, $3, $4, $5)`,
          [userId, tokensPurchased, payment.transaction_amount, paymentId, 'completed']
        );

        if (couponMeta.couponId > 0 && couponMeta.originalAmount > couponMeta.finalAmount) {
          await couponService.redeem(
            couponMeta.couponId,
            Number(userId),
            String(paymentId),
            Math.max(0, Number(couponMeta.originalAmount - couponMeta.finalAmount)),
            Number(couponMeta.originalAmount),
            Number(couponMeta.finalAmount),
            null,
            null
          );
        }

        const planBuyerEmail = await this.getUserEmail(userId);
        if (planBuyerEmail) {
          sendPaymentReceiptEmail({
            toEmail: planBuyerEmail,
            provider: 'mercadopago',
            paymentId: String(paymentId),
            itemDescription: item.description,
            amount: payment.transaction_amount,
            currency: payment.currency_id || config.MERCADO_PAGO_CURRENCY || 'MXN',
            purchasedAt: payment.date_approved || payment.date_created || new Date().toISOString()
          }).catch(() => {});
        }

        return {
          success: true,
          userId,
          plan: applied.subscription.backendPlan,
          newBalance: applied.subscription.tokens,
          tokensAdded: tokensPurchased,
          scheduled: scheduledChange,
          quote: applied.quote
        };
      }

      const tokens = Number(parsedReference.tokensPackage || 0);
      const result = await db.query(
        `UPDATE users
         SET tokens = tokens + $1
         WHERE id = $2
         RETURNING tokens`,
        [tokens, userId]
      );

      await db.query(
        `INSERT INTO transactions (user_id, tokens_purchased, amount_usd, stripe_payment_id, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, tokens, payment.transaction_amount, paymentId, 'completed']
      );

      if (couponMeta.couponId > 0 && couponMeta.originalAmount > couponMeta.finalAmount) {
        await couponService.redeem(
          couponMeta.couponId,
          Number(userId),
          String(paymentId),
          Math.max(0, Number(couponMeta.originalAmount - couponMeta.finalAmount)),
          Number(couponMeta.originalAmount),
          Number(couponMeta.finalAmount),
          null,
          null
        );
      }

      const tokensBuyerEmail = await this.getUserEmail(userId);
      if (tokensBuyerEmail) {
        sendPaymentReceiptEmail({
          toEmail: tokensBuyerEmail,
          provider: 'mercadopago',
          paymentId: String(paymentId),
          itemDescription: `${tokens} tokens`,
          amount: payment.transaction_amount,
          currency: payment.currency_id || config.MERCADO_PAGO_CURRENCY || 'MXN',
          purchasedAt: payment.date_approved || payment.date_created || new Date().toISOString()
        }).catch(() => {});
      }

      return {
        success: true,
        userId,
        tokensAdded: tokens,
        newBalance: result.rows[0].tokens
      };
    } catch (error) {
      if (lockAcquired && paymentId) {
        try {
          await db.query(
            `DELETE FROM payment_processing_locks
             WHERE provider = 'mercadopago' AND payment_id = $1`,
            [paymentId]
          );
        } catch (_) {}
      }
      console.error('[MERCADO_PAGO] Error processing payment:', error.response?.data || error.message);
      throw error;
    }
  }

  async getUserTransactions(userId) {
    const query = `
      SELECT * FROM transactions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 20
    `;
    const result = await db.query(query, [userId]);
    return result.rows;
  }

  async reconcileUserPayments(userId) {
    if (!this.token) {
      throw new Error('MERCADO_PAGO_ACCESS_TOKEN is not configured');
    }

    const numericUserId = Number(userId);
    if (!Number.isFinite(numericUserId) || numericUserId <= 0) {
      throw new Error('Invalid user id');
    }

    const candidateRefs = [];
    for (const key of Object.keys(PLAN_PACKAGES)) {
      const item = PLAN_PACKAGES[key];
      const cycle = key.endsWith('_annual') ? 'annual' : 'monthly';
      candidateRefs.push(`user_${numericUserId}_plan_${item.planKey}_${cycle}`);
    }
    for (const tokenAmount of Object.keys(TOKEN_PACKAGES)) {
      candidateRefs.push(`user_${numericUserId}_tokens_${tokenAmount}`);
    }

    let reconciled = 0;
    let alreadyProcessed = 0;
    let ignoredBeforeReset = 0;
    const scanned = [];

    for (const externalReference of candidateRefs) {
      try {
        const response = await axios.get('https://api.mercadopago.com/v1/payments/search', {
          headers: {
            'Authorization': `Bearer ${this.token}`
          },
          params: {
            external_reference: externalReference,
            sort: 'date_created',
            criteria: 'desc',
            limit: 5
          }
        });

        const results = Array.isArray(response?.data?.results) ? response.data.results : [];
        for (const payment of results) {
          if (String(payment?.status || '').toLowerCase() !== 'approved') continue;
          const paymentId = String(payment?.id || '').trim();
          if (!paymentId) continue;

          try {
            const processed = await this.handlePaymentNotification({ data: { id: paymentId } });
            if (processed?.status === 'already_processed') {
              alreadyProcessed += 1;
            } else if (processed?.status === 'ignored_before_test_reset') {
              ignoredBeforeReset += 1;
            } else {
              reconciled += 1;
            }
          } catch (error) {
            const msg = String(error?.message || '').toLowerCase();
            if (msg.includes('already')) {
              alreadyProcessed += 1;
            } else {
              console.warn(`[MERCADO_PAGO] reconcile skipped payment ${paymentId}: ${error.message}`);
            }
          }
        }
        scanned.push({ externalReference, found: results.length });
      } catch (error) {
        console.warn(
          `[MERCADO_PAGO] reconcile search failed for ref ${externalReference}:`,
          error?.response?.data?.message || error.message
        );
      }
    }

    return { success: true, userId: numericUserId, reconciled, alreadyProcessed, ignoredBeforeReset, scanned };
  }
}

export default new MercadoPagoService();
