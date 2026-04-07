import axios from 'axios';
import { config } from '../config.js';

const PAYPAL_API = config.PAYPAL_MODE === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

const TOKEN_PACKAGES = {
  150000: { kind: 'tokens', price: 4.99, tokens: 150000, description: 'MINI BOOST - 150K caracteres' },
  350000: { kind: 'tokens', price: 9.99, tokens: 350000, description: 'POWER BOOST - 350K caracteres' },
  700000: { kind: 'tokens', price: 14.99, tokens: 700000, description: 'MAX BOOST - 700K caracteres' }
};

const PLAN_PACKAGES = {
  'start_monthly': { kind: 'plan', planKey: 'start', backendPlan: 'pro', price: 6.99, tokens: 200000, description: 'Plan START Mensual' },
  'start_annual': { kind: 'plan', planKey: 'start', backendPlan: 'pro', price: 59.00, tokens: 200000, description: 'Plan START Anual' },
  'creator_monthly': { kind: 'plan', planKey: 'creator', backendPlan: 'premium', price: 12.99, tokens: 500000, description: 'Plan CREATOR Mensual' },
  'creator_annual': { kind: 'plan', planKey: 'creator', backendPlan: 'premium', price: 109.00, tokens: 500000, description: 'Plan CREATOR Anual' },
  'pro_monthly': { kind: 'plan', planKey: 'pro', backendPlan: 'elite', price: 17.99, tokens: 800000, description: 'Plan PRO Mensual' },
  'pro_annual': { kind: 'plan', planKey: 'pro', backendPlan: 'elite', price: 149.00, tokens: 800000, description: 'Plan PRO Anual' }
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
