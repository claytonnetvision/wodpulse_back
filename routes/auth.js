const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Rota de login
router.post('/login', async (req, res) => {
  const { username, password, slug } = req.body;

  console.log('[LOGIN] Requisição recebida:', { username, slug, password: password ? '***' : 'vazio' });

  if (!username || !password || !slug) {
    console.log('[LOGIN] Campos obrigatórios faltando');
    return res.status(400).json({ error: 'username, password e slug são obrigatórios' });
  }

  try {
    // Busca o box pelo slug
    const boxResult = await pool.query(
      'SELECT id, name FROM boxes WHERE slug = $1 AND active = true',
      [slug.toLowerCase()]
    );

    if (boxResult.rows.length === 0) {
      console.log('[LOGIN] Box não encontrado ou inativo:', slug);
      return res.status(401).json({ error: 'Box não encontrado ou inativo' });
    }

    const box = boxResult.rows[0];
    console.log('[LOGIN] Box encontrado:', box.id, box.name);

    // Busca o usuário desse box
    const userResult = await pool.query(
      'SELECT id, username, password_hash, role, box_id FROM users WHERE username = $1 AND box_id = $2',
      [username, box.id]
    );

    if (userResult.rows.length === 0) {
      console.log('[LOGIN] Usuário não encontrado:', username);
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    const user = userResult.rows[0];
    console.log('[LOGIN] Usuário encontrado:', user.id, user.username);

    // Verifica senha
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      console.log('[LOGIN] Senha incorreta para usuário:', username);
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    console.log('[LOGIN] Senha verificada com sucesso');

    // Payload do token
    const payload = {
      userId: user.id,
      username: user.username,
      role: user.role,
      boxId: user.box_id,
      boxSlug: slug,
      boxName: box.name,
      iat: Math.floor(Date.now() / 1000)
    };

    // CHAVE FIXA PARA TESTE - deve ser exatamente a mesma do middleware
    const SECRET_KEY = 'CHAVE-FIXA-ROBSON-2026-TESTE-ABC123XYZ789';

    const token = jwt.sign(payload, SECRET_KEY, { expiresIn: '7d' });

    console.log('[LOGIN] Token gerado com sucesso');
    console.log('[LOGIN] Payload enviado:', payload);
    console.log('[LOGIN] Token (início):', token.substring(0, 50) + '...');

    // Atualiza último login
    await pool.query(
      'UPDATE users SET last_login = NOW() WHERE id = $1',
      [user.id]
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        box: {
          id: box.id,
          slug,
          name: box.name
        }
      }
    });
  } catch (err) {
    console.error('[LOGIN] Erro no login:', err.message, err.stack);
    res.status(500).json({ error: 'Erro interno no servidor' });
  }
});

module.exports = router;