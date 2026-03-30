// Servicio de PayPal para pagos
import axios from 'axios';
import { config } from '../config.js';

const PAYPAL_API = config.PAYPAL_MODE === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

const packages = {
  100000:  { price: 3.00,  tokens: 100000,  description: '100K Tokens - Pequeño' },
  250000:  { price: 7.00,  tokens: 250000,  description: '250K Tokens - Mediano' },
  500000:  { price: 12.00, tokens: 500000,  description: '500K Tokens - Grande'  },
  1000000: { price: 20.00, tokens: 1000000, description: '1M Tokens - Máximo'    }
};

async function getAccessToken() {
  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = config;
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error('PayPal credentials not configured');
  }

  try {
    console.log('[PAYPAL] Getting access token...');
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

    console.log('[PAYPAL] ✓ Access token obtained');
    return res.data.access_token;
  } catch (error) {
    console.error('[PAYPAL] ✗ Error getting access token:', error.response?.data || error.message);
    throw error;
  }
}

export async function createPaypalOrder(userId, tokensPackage) {
  const pkg = packages[tokensPackage];
  if (!pkg) throw new Error('Invalid token package');

  try {
    const accessToken = await getAccessToken();

    const res = await axios.post(
      `${PAYPAL_API}/v2/checkout/orders`,
      {
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: `user_${userId}_tokens_${tokensPackage}`,
          description: `VoltVoice - ${pkg.description}`,
          amount: {
            currency_code: 'USD',
            value: pkg.price.toFixed(2)
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

    console.log('[PAYPAL] ✓ Order created:', res.data.id);
    const approvalLink = res.data.links.find(l => l.rel === 'approve');
    return {
      orderId: res.data.id,
      approvalUrl: approvalLink.href
    };
  } catch (error) {
    console.error('[PAYPAL] ✗ Error creating order:', error.response?.data || error.message);
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
    console.log('[PAYPAL] ✓ Order captured:', orderId);
    return res.data;
  } catch (error) {
    console.error('[PAYPAL] ✗ Error capturing order:', error.response?.data || error.message);
    throw error;
  }
}

export default { createPaypalOrder, capturePaypalOrder, packages };
