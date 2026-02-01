// routes/participants.js - Rota para CRUD de participantes (agora photo como TEXT base64 string)
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// GET - Lista todos os alunos (photo já é base64 string)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, name_lower, age, weight, height_cm, gender, resting_hr, email,
              use_tanaka, max_hr, historical_max_hr, device_id, device_name, photo, preferred_layout,
              created_at, updated_at
       FROM participants
       ORDER BY name ASC`
    );

    const participants = result.rows.map(row => ({
      ...row,
      photo: row.photo || null  // já é string base64 ou null
    }));

    res.json({
      success: true,
      count: participants.length,
      participants
    });
  } catch (err) {
    console.error('Erro ao listar participantes:', err);
    res.status(500).json({ error: 'Erro ao buscar alunos' });
  }
});

// GET individual
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
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
    console.error('Erro ao buscar participante:', err);
    res.status(500).json({ error: 'Erro ao buscar aluno' });
  }
});

// POST - Cadastra novo aluno (photo já vem como base64 string)
router.post('/', async (req, res) => {
  const {
    name, age, weight, height_cm, gender, resting_hr, email,
    use_tanaka = false, max_hr, historical_max_hr = 0,
    device_id, device_name, photo, preferred_layout = 'performance'
  } = req.body;

  if (!name || !max_hr) {
    return res.status(400).json({ error: 'Nome e max_hr são obrigatórios' });
  }

  try {
    const nameLower = name.trim().toLowerCase();

    // Verifica duplicata
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
        use_tanaka, max_hr, historical_max_hr, device_id, device_name, photo, preferred_layout,
        created_at, updated_at
      ) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())
      RETURNING *`,
      [
        name, nameLower, age, weight, height_cm, gender, resting_hr, email,
        use_tanaka, max_hr, historical_max_hr,
        device_id || null, device_name || null,
        photo || null, preferred_layout
      ]
    );

    const newParticipant = result.rows[0];
    newParticipant.photo = newParticipant.photo || null;

    res.status(201).json({
      success: true,
      message: 'Aluno criado',
      participant: newParticipant
    });
  } catch (err) {
    console.error('Erro ao criar participante:', err);
    res.status(500).json({ error: 'Erro ao cadastrar' });
  }
});

// PUT - Edita aluno (photo como string base64 ou null)
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const {
    name, age, weight, height_cm, gender, resting_hr, email,
    use_tanaka, max_hr, historical_max_hr, device_id, device_name, photo, preferred_layout
  } = req.body;

  try {
    const nameLower = name ? name.trim().toLowerCase() : undefined;

    let query = 'UPDATE participants SET updated_at = NOW()';
    const values = [];
    let paramIndex = 1;

    if (name !== undefined) {
      query += `, name = $${paramIndex}, name_lower = $${paramIndex + 1}`;
      values.push(name, nameLower);
      paramIndex += 2;
    }
    if (age !== undefined) {
      query += `, age = $${paramIndex}`;
      values.push(age);
      paramIndex++;
    }
    if (weight !== undefined) {
      query += `, weight = $${paramIndex}`;
      values.push(weight);
      paramIndex++;
    }
    if (height_cm !== undefined) {
      query += `, height_cm = $${paramIndex}`;
      values.push(height_cm);
      paramIndex++;
    }
    if (gender !== undefined) {
      query += `, gender = $${paramIndex}`;
      values.push(gender);
      paramIndex++;
    }
    if (resting_hr !== undefined) {
      query += `, resting_hr = $${paramIndex}`;
      values.push(resting_hr);
      paramIndex++;
    }
    if (email !== undefined) {
      query += `, email = $${paramIndex}`;
      values.push(email);
      paramIndex++;
    }
    if (use_tanaka !== undefined) {
      query += `, use_tanaka = $${paramIndex}`;
      values.push(use_tanaka);
      paramIndex++;
    }
    if (max_hr !== undefined) {
      query += `, max_hr = $${paramIndex}`;
      values.push(max_hr);
      paramIndex++;
    }
    if (historical_max_hr !== undefined) {
      query += `, historical_max_hr = $${paramIndex}`;
      values.push(historical_max_hr);
      paramIndex++;
    }
    if (device_id !== undefined) {
      query += `, device_id = $${paramIndex}`;
      values.push(device_id);
      paramIndex++;
    }
    if (device_name !== undefined) {
      query += `, device_name = $${paramIndex}`;
      values.push(device_name);
      paramIndex++;
    }
    if (photo !== undefined) {
      query += `, photo = $${paramIndex}`;
      values.push(photo); // agora salva string base64 diretamente
      paramIndex++;
    }
    if (preferred_layout !== undefined) {
      query += `, preferred_layout = $${paramIndex}`;
      values.push(preferred_layout);
      paramIndex++;
    }

    if (values.length === 0) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }

    query += ` WHERE id = $${paramIndex} RETURNING *`;
    values.push(id);

    const result = await pool.query(query, values);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Aluno não encontrado' });
    }

    const updatedParticipant = result.rows[0];
    updatedParticipant.photo = updatedParticipant.photo || null;

    res.json({
      success: true,
      message: 'Aluno atualizado',
      participant: updatedParticipant
    });
  } catch (err) {
    console.error('Erro ao editar:', err);
    res.status(500).json({ error: 'Erro ao atualizar aluno' });
  }
});

// DELETE - Exclui aluno
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('DELETE FROM participants WHERE id = $1 RETURNING id', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Aluno não encontrado' });
    }

    res.json({ success: true, message: 'Aluno excluído com sucesso' });
  } catch (err) {
    console.error('Erro ao excluir:', err);
    res.status(500).json({ error: 'Erro ao excluir aluno' });
  }
});

module.exports = router;