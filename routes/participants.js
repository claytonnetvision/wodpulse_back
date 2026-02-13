// routes/participants.js - Rota para CRUD de participantes (photo como TEXT base64 string)
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// GET - Lista todos os alunos
router.get('/', async (req, res) => {
  // ALTERAÇÃO: Pegamos o boxId que o middleware injetou na requisição.
  const boxId = req.boxId;

  try {
    // ALTERAÇÃO: Adicionamos o filtro "WHERE box_id = $1" na query.
    const result = await pool.query(
      `SELECT id, name, name_lower, age, weight, height_cm, gender, resting_hr, email,
              use_tanaka, max_hr, historical_max_hr, device_id, device_name, photo, preferred_layout,
              created_at, updated_at
       FROM participants
       WHERE box_id = $1
       ORDER BY name ASC`,
      [boxId] // ALTERAÇÃO: Passamos o boxId como parâmetro para a query.
    );

    const participants = result.rows.map(row => ({
      ...row,
      photo: row.photo || null
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
  // ALTERAÇÃO: Pegamos o boxId que o middleware injetou na requisição.
  const boxId = req.boxId;

  try {
    // ALTERAÇÃO: Adicionamos "AND box_id = $2" para garantir que o usuário só possa ver alunos do seu próprio box.
    const result = await pool.query(
      `SELECT id, name, name_lower, age, weight, height_cm, gender, resting_hr, email,
              use_tanaka, max_hr, historical_max_hr, device_id, device_name, photo, preferred_layout,
              created_at, updated_at
       FROM participants WHERE id = $1 AND box_id = $2`,
      [id, boxId] // ALTERAÇÃO: Passamos o id do aluno e o id do box.
    );

    if (result.rowCount === 0) {
      // A mensagem de erro é genérica por segurança.
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

// POST - Cadastra novo aluno
router.post('/', async (req, res) => {
  const {
    name, age, weight, height_cm, gender, resting_hr, email,
    use_tanaka = false, max_hr, historical_max_hr = 0,
    device_id, device_name, photo, preferred_layout = 'performance'
  } = req.body;
  
  // ALTERAÇÃO: Pegamos o boxId que o middleware injetou na requisição.
  const boxId = req.boxId;

  if (!name || !max_hr) {
    return res.status(400).json({ error: 'Nome e max_hr são obrigatórios' });
  }

  try {
    const nameLower = name.trim().toLowerCase();

    // ALTERAÇÃO: A verificação de duplicata agora considera o box_id.
    // Isso permite que boxes diferentes tenham alunos com o mesmo nome.
    const existing = await pool.query(
      'SELECT id FROM participants WHERE name_lower = $1 AND box_id = $2',
      [nameLower, boxId]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Já existe aluno com esse nome neste box' });
    }

    // ALTERAÇÃO: Substituímos o "1" hardcoded pelo placeholder "$1" para o box_id.
    // Os outros placeholders foram renumerados.
    const result = await pool.query(
      `INSERT INTO participants (
        box_id, name, name_lower, age, weight, height_cm, gender, resting_hr, email,
        use_tanaka, max_hr, historical_max_hr, device_id, device_name, photo, preferred_layout,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW())
      RETURNING *`,
      [
        boxId, // ALTERAÇÃO: Passamos o boxId como o primeiro valor.
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

// PUT - Edita aluno
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  // ALTERAÇÃO: Pegamos o boxId que o middleware injetou na requisição.
  const boxId = req.boxId;
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
      values.push(photo);
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

    // ALTERAÇÃO: Adicionamos "AND box_id = ..." na cláusula WHERE para segurança.
    query += ` WHERE id = $${paramIndex} AND box_id = $${paramIndex + 1} RETURNING *`;
    values.push(id, boxId); // ALTERAÇÃO: Adicionamos o id do aluno e o id do box aos valores.

    const result = await pool.query(query, values);

    if (result.rowCount === 0) {
      // A mensagem de erro é genérica por segurança.
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
  // ALTERAÇÃO: Pegamos o boxId que o middleware injetou na requisição.
  const boxId = req.boxId;

  try {
    // ALTERAÇÃO: Adicionamos "AND box_id = $2" para garantir que um box só possa deletar seus próprios alunos.
    const result = await pool.query('DELETE FROM participants WHERE id = $1 AND box_id = $2 RETURNING id', [id, boxId]);
    if (result.rowCount === 0) {
      // A mensagem de erro é genérica por segurança.
      return res.status(404).json({ error: 'Aluno não encontrado' });
    }

    res.json({ success: true, message: 'Aluno excluído com sucesso' });
  } catch (err) {
    console.error('Erro ao excluir:', err);
    res.status(500).json({ error: 'Erro ao excluir aluno' });
  }
});
module.exports.getParticipantById = getParticipantById;

module.exports = router;
