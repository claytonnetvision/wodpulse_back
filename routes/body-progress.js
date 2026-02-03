// routes/body-progress.js
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// GET - Lista histórico de progresso do aluno (ordenado por data DESC)
router.get('/', async (req, res) => {
  const { alunoId } = req.query; // frontend envia ?alunoId=

  if (!alunoId) {
    return res.status(400).json({ error: 'alunoId obrigatório' });
  }

  try {
    const result = await pool.query(
      `SELECT id, date, measures, photos, analysis, created_at
       FROM body_progress
       WHERE participant_id = $1
       ORDER BY date DESC`,
      [alunoId]
    );

    // Formata para frontend: photos já são array de base64 strings
    const progress = result.rows.map(row => ({
      id: row.id,
      date: row.date.toISOString().split('T')[0], // YYYY-MM-DD
      measures: row.measures || {},
      photos: row.photos || [],
      analysis: row.analysis || null
    }));

    res.json(progress);
  } catch (err) {
    console.error('Erro ao buscar body_progress:', err.stack);
    res.status(500).json({ error: 'Erro ao buscar progresso corporal' });
  }
});

// POST - Salva nova entrada de progresso
router.post('/', async (req, res) => {
  const { alunoId, date, measures = {}, photos = [] } = req.body;

  if (!alunoId || !date || photos.length === 0) {
    return res.status(400).json({ error: 'alunoId, date e pelo menos uma foto são obrigatórios' });
  }

  // Valida se aluno existe
  try {
    const participantCheck = await pool.query(
      'SELECT id FROM participants WHERE id = $1',
      [alunoId]
    );
    if (participantCheck.rowCount === 0) {
      return res.status(404).json({ error: 'Aluno não encontrado' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao validar aluno' });
  }

  // Limita a 3 fotos (como no frontend)
  const limitedPhotos = photos.slice(0, 3);

  try {
    const result = await pool.query(
      `INSERT INTO body_progress (
        participant_id, date, measures, photos
      ) VALUES ($1, $2, $3, $4)
      RETURNING id, date`,
      [alunoId, date, measures, limitedPhotos]
    );

    res.status(201).json({
      success: true,
      entry: {
        id: result.rows[0].id,
        date: result.rows[0].date.toISOString().split('T')[0]
      }
    });
  } catch (err) {
    console.error('Erro ao salvar body_progress:', err.stack);
    res.status(500).json({ error: 'Erro ao salvar progresso' });
  }
});

module.exports = router;