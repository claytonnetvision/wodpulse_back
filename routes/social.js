const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/**
 * Middleware: Valida Sessão via Banco de Dados
 */
const validateDBSession = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Token não fornecido' });

  try {
    const result = await pool.query(`
      SELECT s.*, p.name, p.email, p.box_id 
      FROM social_sessions s
      JOIN participants p ON s.participant_id = p.id
      WHERE s.session_token = $1 AND s.expires_at > NOW()
      LIMIT 1
    `, [token]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Sessão inválida ou expirada' });
    }

    await pool.query('UPDATE social_sessions SET last_activity = NOW() WHERE id = $1', [result.rows[0].id]);

    req.user = result.rows[0];
    next();
  } catch (err) {
    console.error('[SOCIAL AUTH ERROR]', err);
    res.status(500).json({ error: 'Erro ao validar sessão' });
  }
};

/**
 * LOGIN: Cria sessão no Banco de Dados
 */
router.post('/login', async (req, res) => {
  const { email } = req.body;
  console.log('[SOCIAL LOGIN] Tentativa para:', email);

  if (!email) return res.status(400).json({ error: 'E-mail obrigatório' });

  try {
    const userRes = await pool.query('SELECT id FROM participants WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
    
    if (userRes.rows.length === 0) {
      console.warn('[SOCIAL LOGIN] E-mail não encontrado:', email);
      return res.status(404).json({ error: 'E-mail não encontrado' });
    }

    const participantId = userRes.rows[0].id;
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    console.log('[SOCIAL LOGIN] Criando sessão para ID:', participantId);

    try {
      await pool.query(`
        INSERT INTO social_sessions (participant_id, session_token, expires_at)
        VALUES ($1, $2, $3)
      `, [participantId, sessionToken, expiresAt]);
      
      console.log('[SOCIAL LOGIN] Sessão criada com sucesso');
      res.json({ success: true, token: sessionToken, studentId: participantId });
    } catch (dbErr) {
      console.error('[SOCIAL LOGIN DB ERROR] Erro ao inserir na tabela social_sessions:', dbErr.message);
      console.error('[SOCIAL LOGIN DB DETAIL]', dbErr.detail);
      res.status(500).json({ error: 'Erro no banco de dados ao criar sessão', details: dbErr.message });
    }

  } catch (err) {
    console.error('[SOCIAL LOGIN GENERAL ERROR]', err);
    res.status(500).json({ error: 'Erro interno no servidor' });
  }
});

router.get('/profile', validateDBSession, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM participants WHERE id = $1', [req.user.participant_id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/candidates', validateDBSession, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.name, p.photo, p.age 
      FROM participants p
      WHERE p.id != $1 
      AND p.id NOT IN (
        SELECT user_id_2 FROM social_matches WHERE user_id_1 = $1
      )
      LIMIT 10
    `, [req.user.participant_id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
