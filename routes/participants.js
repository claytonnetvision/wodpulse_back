const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// GET - Lista todos os alunos (retorna photo_base64)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, name_lower, age, weight, height_cm, gender, resting_hr, email,
              use_tanaka, max_hr, historical_max_hr, device_id, device_name, photo, preferred_layout,
              created_at, updated_at
       FROM participants
       ORDER BY name ASC`
    );

    const participants = result.rows.map(row => {
      row.photo_base64 = row.photo ? row.photo.toString('base64') : null;
      delete row.photo;
      return row;
    });

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

// POST - Cadastra novo aluno
router.post('/', async (req, res) => {
  const {
    name, age, weight, height_cm, gender, resting_hr, email,
    use_tanaka = false, max_hr, historical_max_hr = 0,
    device_id, device_name, photo, preferred_layout = 'performance'
  } = req.body;

  if (!name || !max_hr) {
    return res.status(400).json({ error: 'Nome e max_hr são obrigatórios' });
  }

  const photoBuffer = photo ? Buffer.from(photo, 'base64') : null;

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
      RETURNING id, name, created_at`,
      [
        name, nameLower, age, weight, height_cm, gender, resting_hr, email,
        use_tanaka, max_hr, historical_max_hr,
        device_id || null, device_name || null,
        photoBuffer, preferred_layout
      ]
    );

    res.status(201).json({
      success: true,
      message: 'Aluno criado',
      participant: result.rows[0]
    });
  } catch (err) {
    console.error('Erro ao criar participante:', err);
    res.status(500).json({ error: 'Erro ao cadastrar' });
  }
});

// PUT - Edita aluno (photo só é sobrescrito se enviado)
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const {
    name, age, weight, height_cm, gender, resting_hr, email,
    use_tanaka, max_hr, historical_max_hr, device_id, device_name, photo, preferred_layout
  } = req.body;

  const photoBuffer = photo !== undefined ? (photo ? Buffer.from(photo, 'base64') : null) : undefined;

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
        photo = COALESCE($14, photo),
        preferred_layout = COALESCE($15, preferred_layout),
        updated_at = NOW()
      WHERE id = $16
      RETURNING id, name, email, device_id, device_name, photo, preferred_layout`,
      [
        name || null, nameLower || null, age, weight, height_cm, gender, resting_hr, email,
        use_tanaka, max_hr, historical_max_hr, device_id, device_name,
        photoBuffer, preferred_layout || null, id
      ]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Aluno não encontrado' });

    const participant = result.rows[0];
    participant.photo_base64 = participant.photo ? participant.photo.toString('base64') : null;
    delete participant.photo;

    res.json({
      success: true,
      message: 'Aluno atualizado',
      participant
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
    await pool.query('DELETE FROM participants WHERE id = $1', [id]);

    res.json({ success: true, message: 'Aluno excluído com sucesso' });
  } catch (err) {
    console.error('Erro ao excluir:', err);
    res.status(500).json({ error: 'Erro ao excluir aluno' });
  }
});

module.exports = router;