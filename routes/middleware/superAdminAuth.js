// Arquivo: backend/routes/middleware/superAdminAuth.js

const jwt = require('jsonwebtoken');
const SECRET_KEY = 'CHAVE-FIXA-ROBSON-2026-TESTE-ABC123XYZ789';

const authenticateSuperAdmin = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token == null) return res.sendStatus(401);

  jwt.verify(token, SECRET_KEY, (err, payload) => {
    if (err) return res.sendStatus(403);

    // A VERIFICAÇÃO CRUCIAL: O usuário tem a permissão 'superadmin'?
    if (payload.role !== 'superadmin') {
      console.warn(`[SUPER ADMIN] Tentativa de acesso negada para usuário com role: ${payload.role}`);
      return res.status(403).json({ error: 'Acesso negado. Permissões insuficientes.' });
    }

    // Anexa as informações para uso, se necessário
    req.boxId = payload.boxId;
    req.userId = payload.userId;
    req.userRole = payload.role;

    console.log(`[SUPER ADMIN] Acesso liberado para ${payload.username} (Role: ${payload.role})`);
    next();
  });
};

module.exports = { authenticateSuperAdmin };
