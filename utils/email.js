// backend/utils/email.js
const nodemailer = require('nodemailer');

function createTransporter() {
  // Configuração HostGator - porta 465 (SSL) é geralmente mais confiável que 25
  return nodemailer.createTransport({
    host: 'ns1234.hostgator.com',
    port: 465,
    secure: true,                    // true para 465 (SSL)
    auth: {
      user: process.env.EMAIL_USER || 'contato@cfv6.com.br',
      pass: process.env.EMAIL_PASS || 'Academiacross@12',
    },
    debug: process.env.NODE_ENV !== 'production',   // logs detalhados em dev
    logger: true,
  });

  // Alternativa futura (Resend / Brevo / Amazon SES) pode ser adicionada aqui
}

async function sendEmail(to, subject, html, text = null) {
  const transporter = createTransporter();

  try {
    const info = await transporter.sendMail({
      from: `"V6 WODPulse" <${process.env.EMAIL_USER || 'contato@cfv6.com.br'}>`,
      to,
      subject,
      text: text || 'Versão em texto simples não disponível',
      html,
    });

    console.log(`[EMAIL OK] Enviado para ${to} → ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[EMAIL ERRO] Falha para ${to}:`, err.message);
    if (err.response) console.error('Resposta SMTP:', err.response);
    return { success: false, error: err.message };
  }
}

module.exports = { sendEmail };