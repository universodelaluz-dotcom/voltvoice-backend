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

export async function sendVerificationEmail(email, code) {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Verifica tu email - Stream Voicer',
      html: `
        <h2>¡Bienvenido a Stream Voicer!</h2>
        <p>Para completar tu registro, usa el siguiente código de verificación:</p>
        <h1 style="color: #06b6d4; font-size: 32px; letter-spacing: 2px;">${code}</h1>
        <p>Este código expira en 15 minutos.</p>
        <p><small>Si no solicitaste este código, ignora este email.</small></p>
      `
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
      html: `
        <h2>¡Cuenta activada!</h2>
        <p>Tu cuenta en Stream Voicer ha sido creada exitosamente.</p>
        <p>Puedes iniciar sesión ahora y comenzar a usar la plataforma.</p>
        <p>¡Que disfrutes!</p>
      `
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
      html: `
        <h2>Recuperación de contraseña</h2>
        <p>Recibimos una solicitud para restablecer tu contraseña.</p>
        <p>Usa este código para continuar:</p>
        <h1 style="color: #06b6d4; font-size: 32px; letter-spacing: 2px;">${code}</h1>
        <p>Este código expira en 15 minutos.</p>
        <p><small>Si no solicitaste esto, ignora este correo.</small></p>
      `
    });
    console.log(`[Mail] Email de recuperación enviado a: ${email}`);
    return true;
  } catch (error) {
    console.error(`[Mail] Error enviando recuperación a ${email}:`, error.message);
    return false;
  }
}
