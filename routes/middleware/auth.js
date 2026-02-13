// Arquivo: middleware.js (o seu arquivo, com o nome que ele já tem)
// CONTEÚDO ATUALIZADO

const jwt = require('jsonwebtoken');

// A mesma chave secreta que você usa no auth.js para criar o token
const SECRET_KEY = 'CHAVE-FIXA-ROBSON-2026-TESTE-ABC123XYZ789';

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

  try {
    // 1. Verificamos e decodificamos o token
    const payload = jwt.verify(token, SECRET_KEY);

    console.log('[AUTH MIDDLEWARE] Token válido! Payload decodificado:', payload);

    // 2. Verificamos se a informação ESSENCIAL (boxId) está no token
    if (!payload.boxId) {
        console.error('[AUTH MIDDLEWARE] Token válido, mas sem boxId no payload.');
        return res.status(403).json({ error: 'Token incompleto, boxId ausente.' });
    }

    // 3. Anexamos as informações diretamente na requisição (req)
    //    Isso deixa o uso nas rotas mais claro (req.boxId em vez de req.user.boxId)
    req.boxId = payload.boxId;
    req.userId = payload.userId;
    req.userRole = payload.role; // Opcional, mas útil para o futuro

    console.log(`[AUTH MIDDLEWARE] Acesso liberado para Box ID: ${req.boxId}, Usuário ID: ${req.userId}`);
    
    // 4. Tudo certo, pode prosseguir para a rota final!
    next();

  } catch (err) {
    console.error('[AUTH MIDDLEWARE] Erro ao validar token:', err.message);
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
};
