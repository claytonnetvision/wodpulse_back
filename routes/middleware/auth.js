const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    console.log('[AUTH MIDDLEWARE] Nenhum header Authorization recebido');
    return res.status(401).json({ error: 'Token não fornecido' });
  }

  const parts = authHeader.split(' ');

  if (parts.length !== 2 || !/^Bearer$/i.test(parts[0])) {
    console.log('[AUTH MIDDLEWARE] Header mal formatado:', authHeader);
    return res.status(401).json({ error: 'Token mal formatado' });
  }

  const token = parts[1];

  // CHAVE FIXA PARA TESTE - deve ser EXATAMENTE a mesma do login
  const SECRET_KEY = 'CHAVE-FIXA-ROBSON-2026-TESTE-ABC123XYZ789';

  try {
    const decoded = jwt.verify(token, SECRET_KEY);

    console.log('[AUTH MIDDLEWARE] Token válido! Payload decodificado:', decoded);
    console.log('[AUTH MIDDLEWARE] Token recebido (início):', token.substring(0, 50) + '...');

    req.user = decoded;
    next();
  } catch (err) {
    console.error('[AUTH MIDDLEWARE] Erro ao validar token:', err.message);
    console.error('[AUTH MIDDLEWARE] Token recebido (início):', token.substring(0, 50) + '...');
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
};