const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const validateDBSession = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });
  try {
    const result = await pool.query(`
      SELECT s.*, p.id as participant_id, p.name, p.box_id 
      FROM social_sessions s
      JOIN participants p ON s.participant_id = p.id
      WHERE s.session_token = $1 AND s.expires_at > NOW()
      LIMIT 1
    `, [token]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Sessão inválida' });
    req.user = result.rows[0];
    next();
  } catch (err) {
    res.status(500).json({ error: 'Erro de auth' });
  }
};

router.post('/login', async (req, res) => {
  const { email } = req.body;
  try {
    const userRes = await pool.query('SELECT id FROM participants WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'Não encontrado' });
    const participantId = userRes.rows[0].id;
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    await pool.query('INSERT INTO social_sessions (participant_id, session_token, expires_at) VALUES ($1, $2, $3)', [participantId, sessionToken, expiresAt]);
    res.json({ success: true, token: sessionToken, studentId: participantId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/profile', validateDBSession, async (req, res) => {
  try {
    // Busca foto separadamente se necessário para evitar payloads gigantes
    const userRes = await pool.query('SELECT id, name, photo, box_id FROM participants WHERE id = $1', [req.user.participant_id]);
    const user = userRes.rows[0];
    
    const statsRes = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM social_challenges WHERE creator_id = $1 OR opponent_id = $1) as challenges,
        (SELECT COUNT(*) FROM social_matches WHERE user_id_1 = $1 AND status = 'matched') as likes,
        (SELECT COUNT(*) FROM social_matches WHERE (user_id_1 = $1 OR user_id_2 = $1) AND status = 'matched') as matches
    `, [req.user.participant_id]);

    res.json({ ...user, stats: statsRes.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/candidates', validateDBSession, async (req, res) => {
  try {
    // Limitamos a 5 candidatos e otimizamos a query para evitar URI_TOO_LONG
    const result = await pool.query(`
      SELECT id, name, photo, age, box_id 
      FROM participants 
      WHERE id != $1 
      AND photo IS NOT NULL
      ORDER BY RANDOM() LIMIT 5
    `, [req.user.participant_id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/match', validateDBSession, async (req, res) => {
  const { targetId, action } = req.body;
  try {
    await pool.query(`
      INSERT INTO social_matches (user_id_1, user_id_2, status) 
      VALUES ($1, $2, $3) 
      ON CONFLICT (user_id_1, user_id_2) DO UPDATE SET status = $3
    `, [req.user.participant_id, targetId, action === 'like' ? 'matched' : 'rejected']);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/challenge/create', validateDBSession, async (req, res) => {
  const { opponentIds, type, duration } = req.body;
  try {
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + parseInt(duration));
    for (const oppId of opponentIds) {
      await pool.query('INSERT INTO social_challenges (creator_id, opponent_id, challenge_type, end_date) VALUES ($1, $2, $3, $4)', [req.user.participant_id, oppId, type, endDate]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
