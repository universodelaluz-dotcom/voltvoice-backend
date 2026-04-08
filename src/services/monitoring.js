import { config } from '../../config.js';

const MAX_EVENTS = 100;
const LATENCY_WINDOW = 500;
const ALERT_THROTTLE_MS = 60 * 1000;

const state = {
  requestsTotal: 0,
  errors5xx: 0,
  rateLimited: 0,
  paymentFailures: 0,
  latencies: [],
  recentErrors: [],
  recentPayments: [],
  alertThrottleByKey: new Map(),
};

const nowIso = () => new Date().toISOString();

const pushBounded = (arr, value, limit = MAX_EVENTS) => {
  arr.unshift(value);
  if (arr.length > limit) arr.length = limit;
};

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
};

const shouldSendAlert = (key) => {
  const now = Date.now();
  const lastSent = state.alertThrottleByKey.get(key) || 0;
  if (now - lastSent < ALERT_THROTTLE_MS) return false;
  state.alertThrottleByKey.set(key, now);
  return true;
};

const sendAlert = async (key, title, payload) => {
  if (!config.ALERT_WEBHOOK_URL) return;
  if (!shouldSendAlert(key)) return;

  try {
    await fetch(config.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: title,
        timestamp: nowIso(),
        payload,
      }),
    });
  } catch (error) {
    console.error('[Monitoring] No se pudo enviar alerta:', error.message);
  }
};

export const recordRequest = ({ method, path, statusCode, durationMs }) => {
  state.requestsTotal += 1;
  state.latencies.push(durationMs);
  if (state.latencies.length > LATENCY_WINDOW) {
    state.latencies.shift();
  }

  if (statusCode >= 500) {
    state.errors5xx += 1;
    const item = { at: nowIso(), method, path, statusCode, durationMs };
    pushBounded(state.recentErrors, item);
    sendAlert('http_5xx', 'http_5xx', item);
  }
};

export const recordRateLimit = ({ path, ip }) => {
  state.rateLimited += 1;
  sendAlert('rate_limit', 'rate_limit', { at: nowIso(), path, ip });
};

export const recordPaymentFailure = ({ provider, action, errorMessage, userId }) => {
  state.paymentFailures += 1;
  const item = {
    at: nowIso(),
    provider,
    action,
    errorMessage: String(errorMessage || 'unknown'),
    userId: userId || null,
  };
  pushBounded(state.recentPayments, item);
  sendAlert(`payment_${provider}`, 'payment_failure', item);
};

export const getSnapshot = () => {
  const avgLatency = state.latencies.length
    ? state.latencies.reduce((sum, val) => sum + val, 0) / state.latencies.length
    : 0;

  return {
    requestsTotal: state.requestsTotal,
    errors5xx: state.errors5xx,
    rateLimited: state.rateLimited,
    paymentFailures: state.paymentFailures,
    avgLatencyMs: Number(avgLatency.toFixed(2)),
    p95LatencyMs: Number(percentile(state.latencies, 95).toFixed(2)),
    recentErrors: state.recentErrors.slice(0, 20),
    recentPayments: state.recentPayments.slice(0, 20),
  };
};

export default {
  recordRequest,
  recordRateLimit,
  recordPaymentFailure,
  getSnapshot,
};
