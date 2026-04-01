import axios from 'axios';
import { config } from '../config.js';

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

export async function createPaypalOrder(userId, payload) {
  const item = getCheckoutItem(payload);
  if (!item) throw new Error('Invalid checkout item');

  try {
    const accessToken = await getAccessToken();
    const billingCycle = String(payload.billingCycle || 'monthly').toLowerCase();
    const referenceId = item.kind === 'plan'
      ? `user_${userId}_plan_${item.planKey}_${billingCycle}`
      : `user_${userId}_tokens_${payload.tokensPackage}`;

    const res = await axios.post(
      `${PAYPAL_API}/v2/checkout/orders`,
      {
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: referenceId,
          description: `VoltVoice - ${item.description}`,
          amount: {
            currency_code: 'USD',
            value: item.price.toFixed(2)
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
      approvalUrl: approvalLink?.href || null
    };
  } catch (error) {
    console.error('[PAYPAL] Error creating order:', error.response?.data || error.message);
    throw error;
  }
}

export async function capturePaypalOrder(orderId) {
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
    return res.data;
  } catch (error) {
    console.error('[PAYPAL] Error capturing order:', error.response?.data || error.message);
    throw error;
  }
}

export default { createPaypalOrder, capturePaypalOrder };
