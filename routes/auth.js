const express = require('express');
const router = express.Router();

const validUsers = { // ← temporário — depois virá do banco
  'v6':        { password: 'abc123v6', boxName: 'V6 CrossFit' },
  'uranium':   { password: 'uranium2025', boxName: 'CrossFit Uranium' },
  'apolo':     { password: 'apolo2025', boxName: 'CrossFit Apolo' }
};

router.post('/login', (req, res) => {
  const { slug, password } = req.body;

  if (!slug || !password) {
    return res.status(400).json({ error: 'slug e password são obrigatórios' });
  }

  const user = validUsers[slug.toLowerCase()];
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }

  // Sucesso (futuramente devolveria JWT)
  res.json({
    success: true,
    box: {
      slug,
      name: user.boxName
    },
    message: 'Login realizado com sucesso'
  });
});

module.exports = router;