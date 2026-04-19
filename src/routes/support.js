import { Router } from 'express'
import pool from '../db.js'
import { verifyToken } from '../../middleware/auth.js'
import { sendSupportEmail, sendSupportReceiptEmail } from '../services/mail.js'

const router = Router()

const isValidEmail = (value = '') =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim())

const normalizeMessage = (value = '') => String(value || '').trim()

// POST /api/support/public - formulario publico desde portada
router.post('/public', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase()
    const message = normalizeMessage(req.body?.message)

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Ingresa un correo valido.' })
    }
    if (message.length < 5) {
      return res.status(400).json({ error: 'El mensaje es muy corto.' })
    }
    if (message.length > 500) {
      return res.status(400).json({ error: 'El mensaje excede 500 caracteres.' })
    }

    const sent = await sendSupportEmail(email, 'publico', message)
    if (!sent) return res.status(500).json({ error: 'No se pudo enviar el mensaje. Intenta de nuevo.' })

    sendSupportReceiptEmail(email).catch(() => {})
    res.json({ success: true })
  } catch (err) {
    console.error('[Support Public] Error:', err.message)
    res.status(500).json({ error: 'Error interno del servidor.' })
  }
})

// POST /api/support/message - solo usuarios con plan activo (no free)
router.post('/message', verifyToken, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id
    if (!userId) return res.status(401).json({ error: 'No autenticado' })

    // Obtener plan y email del usuario
    const { rows } = await pool.query(
      'SELECT email, plan FROM users WHERE id = $1',
      [userId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' })

    const { email, plan } = rows[0]
    const normalizedPlan = String(plan || 'free').toLowerCase()

    if (normalizedPlan === 'free') {
      return res.status(403).json({ error: 'El soporte directo esta disponible solo para planes de pago.' })
    }

    const message = normalizeMessage(req.body?.message)
    if (!message || typeof message !== 'string' || message.length < 5) {
      return res.status(400).json({ error: 'El mensaje es muy corto.' })
    }
    if (message.length > 500) {
      return res.status(400).json({ error: 'El mensaje excede 500 caracteres.' })
    }

    const sent = await sendSupportEmail(email, normalizedPlan, message)
    if (!sent) return res.status(500).json({ error: 'No se pudo enviar el mensaje. Intenta de nuevo.' })

    // Acuse al usuario (no bloquea el flujo si falla)
    sendSupportReceiptEmail(email).catch(() => {})

    res.json({ success: true })
  } catch (err) {
    console.error('[Support] Error:', err.message)
    res.status(500).json({ error: 'Error interno del servidor.' })
  }
})

export default router
