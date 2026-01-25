const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// GET - Lista alunos do box (versão original, sem zonas - elas ficam em session_participants)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, name_lower, age, weight, height_cm, gender, resting_hr, email,
              use_tanaka, max_hr, historical_max_hr, device_id, device_name,
              created_at, updated_at
       FROM participants
       ORDER BY name ASC`
    );

    res.json({
      success: true,
      count: result.rows.length,
      participants: result.rows
    });
  } catch (err) {
    console.error('Erro ao listar participantes:', err.stack || err.message);
    res.status(500).json({ 
      error: 'Erro ao buscar alunos',
      details: err.message 
    });
  }
});

// POST - Cadastra novo aluno
router.post('/', async (req, res) => {
  const {
    name, age, weight, height_cm, gender, resting_hr, email,
    use_tanaka = false, max_hr, historical_max_hr = 0,
    device_id, device_name
  } = req.body;

  if (!name || !max_hr) {
    return res.status(400).json({ error: 'Nome e max_hr são obrigatórios' });
  }

  try {
    const nameLower = name.trim().toLowerCase();

    const existing = await pool.query(
      'SELECT id FROM participants WHERE name_lower = $1',
      [nameLower]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Já existe aluno com esse nome' });
    }

    const result = await pool.query(
      `INSERT INTO participants (
        box_id, name, name_lower, age, weight, height_cm, gender, resting_hr, email,
        use_tanaka, max_hr, historical_max_hr, device_id, device_name,
        created_at, updated_at
      ) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())
      RETURNING id, name, created_at`,
      [
        name, nameLower, age, weight, height_cm, gender, resting_hr, email,
        use_tanaka, max_hr, historical_max_hr, device_id || null, device_name || null
      ]
    );

    res.status(201).json({
      success: true,
      message: 'Aluno criado',
      participant: result.rows[0]
    });
  } catch (err) {
    console.error('Erro ao criar participante:', err.stack || err.message);
    res.status(500).json({ error: 'Erro ao cadastrar', details: err.message });
  }
});

// PUT - Edita aluno
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const {
    name, age, weight, height_cm, gender, resting_hr, email,
    use_tanaka, max_hr, historical_max_hr, device_id, device_name
  } = req.body;

  try {
    const nameLower = name ? name.trim().toLowerCase() : undefined;

    const result = await pool.query(
      `UPDATE participants SET
        name = COALESCE($1, name),
        name_lower = COALESCE($2, name_lower),
        age = COALESCE($3, age),
        weight = COALESCE($4, weight),
        height_cm = COALESCE($5, height_cm),
        gender = COALESCE($6, gender),
        resting_hr = COALESCE($7, resting_hr),
        email = COALESCE($8, email),
        use_tanaka = COALESCE($9, use_tanaka),
        max_hr = COALESCE($10, max_hr),
        historical_max_hr = COALESCE($11, historical_max_hr),
        device_id = COALESCE($12, device_id),
        device_name = COALESCE($13, device_name),
        updated_at = NOW()
      WHERE id = $14
      RETURNING id, name, email, device_id, device_name`,
      [
        name || null, nameLower || null, age, weight, height_cm, gender, resting_hr, email, use_tanaka, max_hr, historical_max_hr,
        device_id, device_name, id
      ]
    );

    if (result.rowCount === 0) return res.status(404).json({ error: 'Aluno não encontrado' });

    res.json({
      success: true,
      message: 'Aluno atualizado',
      participant: result.rows[0]
    });
  } catch (err) {
    console.error('Erro ao editar:', err.stack || err.message);
    res.status(500).json({ error: 'Erro ao atualizar aluno', details: err.message });
  }
});

// DELETE - Exclui aluno
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query('DELETE FROM participants WHERE id = $1', [id]);

    res.json({ success: true, message: 'Aluno excluído com sucesso' });
  } catch (err) {
    console.error('Erro ao excluir:', err.stack || err.message);
    res.status(500).json({ error: 'Erro ao excluir aluno' });
  }
});

module.exports = router;