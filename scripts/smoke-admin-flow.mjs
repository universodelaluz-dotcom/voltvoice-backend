import bcrypt from 'bcrypt';
import pool from '../src/db.js';

const API_URL = process.env.SMOKE_API_URL || 'http://127.0.0.1:5000';
const ADMIN_EMAIL = process.env.ADMIN_SMOKE_EMAIL || 'admin.smoke.local@voltvoice.test';
const ADMIN_PASSWORD = process.env.ADMIN_SMOKE_PASSWORD || 'AdminSmoke123!';

const nowSuffix = Date.now();
const TEST_USER_EMAIL = `start.smoke.${nowSuffix}@voltvoice.test`;
const TEST_USER_PASSWORD = 'StartSmoke123!';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureAdmin() {
  const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [ADMIN_EMAIL]);
  if (existing.rows.length > 0) {
    await pool.query(`UPDATE users
      SET password_hash=$1, role='admin', plan='admin', tokens=999999, email_verified=TRUE,
          is_suspended=FALSE, suspension_reason=NULL, suspended_at=NULL, suspended_until=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE email=$2`, [hash, ADMIN_EMAIL]);
  } else {
    await pool.query(`INSERT INTO users (email, password_hash, role, plan, tokens, email_verified, created_at, updated_at)
      VALUES ($1,$2,'admin','admin',999999,TRUE,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, [ADMIN_EMAIL, hash]);
  }
}

async function api(path, { method = 'GET', token = '', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function assertStep(name, condition, payload = null) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    if (payload) console.error(payload);
    throw new Error(name);
  }
  console.log(`PASS: ${name}`);
}

async function withRetry(label, fn, attempts = 4) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); } catch (err) { lastErr = err; console.log(`retry ${label} ${i}/${attempts}: ${err.message}`); await wait(i * 900); }
  }
  throw lastErr;
}

async function main() {
  await withRetry('ensureAdmin', ensureAdmin, 5);

  const loginAdmin = await api('/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  assertStep('admin login', loginAdmin.ok && loginAdmin.data?.success, loginAdmin);
  const adminToken = loginAdmin.data.token;

  const createUser = await api('/api/admin/users', {
    method: 'POST', token: adminToken,
    body: { email: TEST_USER_EMAIL, password: TEST_USER_PASSWORD, plan: 'start', tokens: 1500, role: 'user' }
  });
  assertStep('create user start', createUser.ok && createUser.data?.success, createUser);
  const userId = createUser.data.user.id;

  const suspend = await api(`/api/admin/users/${userId}/suspend`, {
    method: 'POST', token: adminToken,
    body: { reason: 'Smoke test', minutes: 10 }
  });
  assertStep('suspend user', suspend.ok && suspend.data?.success, suspend);

  const unsuspend = await api(`/api/admin/users/${userId}/unsuspend`, { method: 'POST', token: adminToken });
  assertStep('unsuspend user', unsuspend.ok && unsuspend.data?.success, unsuspend);

  const resetPass = await api(`/api/admin/users/${userId}/reset-password`, {
    method: 'POST', token: adminToken,
    body: { newPassword: 'NewStart123!' }
  });
  assertStep('reset password', resetPass.ok && resetPass.data?.success, resetPass);

  const activity = await api(`/api/admin/users/${userId}/activity?limit=20`, { token: adminToken });
  assertStep('user activity endpoint', activity.ok && activity.data?.success, activity);

  const anomalies = await api('/api/admin/anomalies', { token: adminToken });
  assertStep('anomalies endpoint', anomalies.ok && anomalies.data?.success, anomalies);

  const bc = await api('/api/admin/broadcasts', {
    method: 'POST', token: adminToken,
    body: {
      kind: 'in_app_notification',
      title: 'Smoke Notice',
      message: `Prueba automatica ${nowSuffix}`,
      audiencePlan: 'all',
      priority: 'normal',
      status: 'active'
    }
  });
  assertStep('create broadcast', bc.ok && bc.data?.success, bc);

  const loginUser = await api('/api/auth/login', {
    method: 'POST', body: { email: TEST_USER_EMAIL, password: 'NewStart123!' }
  });
  assertStep('user login after reset', loginUser.ok && loginUser.data?.success, loginUser);

  const userToken = loginUser.data.token;
  const notices = await api('/api/ops/announcements', { token: userToken });
  assertStep('announcements endpoint', notices.ok && notices.data?.success, notices);

  const hasNotice = (notices.data.announcements || []).some((n) => String(n.title || '').includes('Smoke Notice'));
  assertStep('announcement visible for user', hasNotice, notices.data.announcements || []);

  console.log('SMOKE ADMIN FLOW OK');
}

main()
  .catch((err) => {
    console.error('SMOKE ADMIN FLOW FAILED:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
