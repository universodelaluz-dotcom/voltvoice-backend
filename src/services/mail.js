import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: 'mail.privateemail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  }
});

const LOGO_URL = 'https://raw.githubusercontent.com/universodelaluz-dotcom/voltvoice-frontend/refs/heads/main/public/images/logo-main.png';

const emailWrapper = (content) => `
  <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#0f0f23;border-radius:16px;overflow:hidden;">
    <div style="background:#0f0f23;padding:32px 40px 16px;text-align:center;border-bottom:1px solid rgba(255,255,255,0.08);">
      <img src="${LOGO_URL}" alt="Stream Voicer" style="height:40px;object-fit:contain;" />
    </div>
    <div style="padding:32px 40px;color:#e2e8f0;">
      ${content}
    </div>
    <div style="padding:16px 40px 24px;text-align:center;border-top:1px solid rgba(255,255,255,0.08);">
      <p style="color:#4b5563;font-size:12px;margin:0;">© 2026 Stream Voicer · <a href="mailto:soporte@streamvoicer.com" style="color:#06b6d4;text-decoration:none;">soporte@streamvoicer.com</a></p>
    </div>
  </div>
`;

export async function sendVerificationEmail(email, code) {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Verifica tu email - Stream Voicer',
      html: emailWrapper(`
        <h2 style="color:#fff;margin-top:0;">¡Bienvenido a Stream Voicer!</h2>
        <p>Para completar tu registro usa este código de verificación:</p>
        <div style="text-align:center;margin:24px 0;">
          <span style="display:inline-block;background:#1e1e3a;border:1px solid rgba(6,182,212,0.4);border-radius:12px;padding:16px 32px;font-size:36px;font-weight:900;letter-spacing:8px;color:#06b6d4;">${code}</span>
        </div>
        <p style="color:#9ca3af;font-size:14px;">Expira en 15 minutos. Si no solicitaste esto, ignora este correo.</p>
      `)
    });
    console.log(`[Mail] Email de verificación enviado a: ${email}`);
    return true;
  } catch (error) {
    console.error(`[Mail] Error enviando email a ${email}:`, error.message);
    return false;
  }
}

export async function sendWelcomeEmail(email) {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: '¡Cuenta creada exitosamente - Stream Voicer',
      html: emailWrapper(`
        <h2 style="color:#fff;margin-top:0;">¡Cuenta activada! 🎉</h2>
        <p>Tu cuenta en Stream Voicer ha sido creada exitosamente.</p>
        <p>Ya puedes iniciar sesión y comenzar a usar la plataforma.</p>
        <p style="color:#9ca3af;font-size:14px;">¡Que disfrutes!</p>
      `)
    });
    return true;
  } catch (error) {
    console.error(`[Mail] Error enviando welcome email a ${email}:`, error.message);
    return false;
  }
}

export async function sendPasswordResetEmail(email, code) {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Recuperar contraseña - Stream Voicer',
      html: emailWrapper(`
        <h2 style="color:#fff;margin-top:0;">Recuperación de contraseña</h2>
        <p>Recibimos una solicitud para restablecer tu contraseña. Usa este código:</p>
        <div style="text-align:center;margin:24px 0;">
          <span style="display:inline-block;background:#1e1e3a;border:1px solid rgba(6,182,212,0.4);border-radius:12px;padding:16px 32px;font-size:36px;font-weight:900;letter-spacing:8px;color:#06b6d4;">${code}</span>
        </div>
        <p style="color:#9ca3af;font-size:14px;">Expira en 15 minutos. Si no solicitaste esto, ignora este correo.</p>
      `)
    });
    console.log(`[Mail] Email de recuperación enviado a: ${email}`);
    return true;
  } catch (error) {
    console.error(`[Mail] Error enviando recuperación a ${email}:`, error.message);
    return false;
  }
}
