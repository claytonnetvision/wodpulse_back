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
 * LOGIN
 */
router.post('/login', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'E-mail obrigatório' });

  try {
    const userRes = await pool.query('SELECT id FROM participants WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'E-mail não encontrado' });

    const participantId = userRes.rows[0].id;
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    await pool.query(`
      INSERT INTO social_sessions (participant_id, session_token, expires_at)
      VALUES ($1, $2, $3)
    `, [participantId, sessionToken, expiresAt]);

    res.json({ success: true, token: sessionToken, studentId: participantId });
  } catch (err) {
    console.error('[LOGIN ERROR]', err);
    res.status(500).json({ error: 'Erro ao criar sessão' });
  }
});

/**
 * PERFIL: Retorna dados completos incluindo a foto original
 */
router.get('/profile', validateDBSession, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, photo, box_id, age FROM participants WHERE id = $1', [req.user.participant_id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * CANDIDATOS: Busca alunos do mesmo box (ou geral) para interagir
 */
router.get('/candidates', validateDBSession, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.name, p.photo, p.age, p.box_id 
      FROM participants p
      WHERE p.id != $1 
      AND p.id NOT IN (
        SELECT user_id_2 FROM social_matches WHERE user_id_1 = $1
      )
      ORDER BY RANDOM()
      LIMIT 15
    `, [req.user.participant_id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * MATCH: Salva curtida ou descurtida
 */
router.post('/match', validateDBSession, async (req, res) => {
  const { targetId, action } = req.body;
  try {
    await pool.query(`
      INSERT INTO social_matches (user_id_1, user_id_2, status)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id_1, user_id_2) DO UPDATE SET status = $3
    `, [req.user.participant_id, targetId, action === 'like' ? 'matched' : 'rejected']);
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DESAFIO: Criar desafio para múltiplos oponentes
 */
router.post('/challenge/create', validateDBSession, async (req, res) => {
  const { opponentIds, type, duration } = req.body;
  try {
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + parseInt(duration));

    for (const oppId of opponentIds) {
      await pool.query(`
        INSERT INTO social_challenges (creator_id, opponent_id, challenge_type, end_date, status)
        VALUES ($1, $2, $3, $4, 'pending')
      `, [req.user.participant_id, oppId, type, endDate]);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
