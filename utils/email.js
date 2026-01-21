const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT),
  secure: process.env.EMAIL_SECURE === 'true', // true para 465
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  // tls: { rejectUnauthorized: false } // só se der erro de certificado auto-assinado
});

async function sendEmail(to, subject, html) {
  try {
    const info = await transporter.sendMail({
      from: `"V6 WODPulse" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html,
    });
    console.log(`Email enviado: ${info.messageId} para ${to}`);
    return true;
  } catch (err) {
    console.error('Erro ao enviar email:', err.message);
    return false;
  }
}

module.exports = { sendEmail };