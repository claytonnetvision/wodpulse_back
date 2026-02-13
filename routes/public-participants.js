// routes/public-participants.js
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// GET individual - ROTA PÚBLICA PARA ALUNOS
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // Esta query não filtra por box_id de propósito, para que o link do e-mail funcione
    const result = await pool.query(
      `SELECT id, name, name_lower, age, weight, height_cm, gender, resting_hr, email,
              use_tanaka, max_hr, historical_max_hr, device_id, device_name, photo, preferred_layout,
              created_at, updated_at
       FROM participants WHERE id = $1`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Aluno não encontrado' });
    }

    const participant = result.rows[0];
    participant.photo = participant.photo || null;

    res.json({
      success: true,
      participant
    });
  } catch (err) {
    console.error('Erro ao buscar participante (público):', err);
    res.status(500).json({ error: 'Erro ao buscar aluno' });
  }
});

module.exports = router;
