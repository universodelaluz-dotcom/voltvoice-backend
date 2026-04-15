import { Router } from 'express'
import pool from '../db.js'
import { verifyToken } from '../../middleware/auth.js'
import { sendSupportEmail, sendSupportReceiptEmail } from '../services/mail.js'

const router = Router()

// POST /api/support/message  — solo usuarios con plan activo (no free)
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
      return res.status(403).json({ error: 'El soporte directo está disponible solo para planes de pago.' })
    }

    const { message } = req.body
    if (!message || typeof message !== 'string' || message.trim().length < 5) {
      return res.status(400).json({ error: 'El mensaje es muy corto.' })
    }
    if (message.length > 500) {
      return res.status(400).json({ error: 'El mensaje excede 500 caracteres.' })
    }

    const sent = await sendSupportEmail(email, normalizedPlan, message.trim())
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
