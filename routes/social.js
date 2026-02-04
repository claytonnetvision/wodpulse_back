const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

// Usamos as variáveis de ambiente que o Render já possui
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'wodpulse_social_secret_key_2024';

// Middleware de Autenticação
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// Rota de Login
router.post('/login', async (req, res) => {
  const { email } = req.body;
  try {
    const result = await pool.query(
      'SELECT id, name, email, box_id, photo FROM participants WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [email]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'E-mail não encontrado' });
    const student = result.rows[0];
    const token = jwt.sign({ id: student.id, email: student.email, box_id: student.box_id }, JWT_SECRET);
    res.json({ success: true, token, student });
  } catch (err) { 
    console.error('Erro no login social:', err);
    res.status(500).json({ error: 'Erro interno no servidor' }); 
  }
});

// Perfil
router.get('/profile', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name, email, photo, box_id FROM participants WHERE id = $1', [req.user.id]);
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Candidatos para Match
router.get('/candidates', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.name, p.photo, p.age 
      FROM participants p
      WHERE p.id != $1 
      LIMIT 10
    `, [req.user.id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// EXPORTAÇÃO CORRETA PARA EXPRESS
module.exports = router;
