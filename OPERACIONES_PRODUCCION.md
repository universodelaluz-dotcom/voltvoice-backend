# Operaciones de Produccion (Hardening + Runbook)

## Seguridad activa en backend
- Cookie HttpOnly de sesion JWT habilitada (`AUTH_COOKIE_NAME`).
- reCAPTCHA obligatorio en produccion (`RECAPTCHA_REQUIRED_IN_PROD=true`).
- Rate limiting global con `express-rate-limit`.
- Headers de seguridad con `helmet`.
- Bloqueado el fallback `x-user-id` en rutas de pago cuando `NODE_ENV=production`.

## Variables recomendadas
- `NODE_ENV=production`
- `TRUST_PROXY=true`
- `GLOBAL_RATE_LIMIT_WINDOW_MS=900000`
- `GLOBAL_RATE_LIMIT_MAX_REQUESTS=300`
- `RECAPTCHA_REQUIRED_IN_PROD=true`
- `RECAPTCHA_SECRET=<tu secreto>`
- `ALERT_WEBHOOK_URL=<webhook de Slack/Discord/etc>`
- `AUTH_COOKIE_NAME=vv_auth`
- `AUTH_COOKIE_SAMESITE=None`
- `AUTH_COOKIE_SECURE=true`
- `AUTH_COOKIE_DOMAIN=` (opcional)

## Monitoreo y alertas
- Salud general: `GET /api/health`
- Metricas internas (admin): `GET /api/ops/metrics`
- Alertas webhook:
  - errores 5xx
  - rate limit excesivo
  - fallos de pago (PayPal / Mercado Pago)

## Backups y recuperacion de BD
- Crear respaldo:
  - `npm run backup:db`
- Restaurar respaldo:
  - `npm run restore:db -- ./backups/backup-YYYY-MM-DDTHH-mm-ss-sql.gz`

Notas:
- Requiere `pg_dump` y `psql` instalados en el entorno.
- Rotacion automatica de backups por `DB_BACKUP_RETENTION_DAYS` (por defecto 7 dias).
- Recomendado ejecutar `backup:db` con cron externo cada 6 o 12 horas.
