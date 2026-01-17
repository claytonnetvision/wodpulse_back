require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Conexão com Neon PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Testa conexão ao iniciar
pool.connect()
  .then(() => console.log('→ Conectado ao PostgreSQL (Neon)'))
  .catch(err => console.error('Erro ao conectar no banco:', err.stack));

// Rota de teste simples
app.get('/', (req, res) => {
  res.json({ 
    status: 'WODPulse Backend online', 
    time: new Date().toISOString() 
  });
});

// Rotas de autenticação
app.use('/api/auth', require('./routes/auth'));

// Rota para participantes
app.use('/api/participants', require('./routes/participants'));

// Rota para sessões (finalização de aula)
const sessionsRouter = express.Router();

// POST /api/sessions - Salva sessão com nomes corretos das colunas
sessionsRouter.post('/', async (req, res) => {
  const { class_name, date_start, date_end, duration_minutes, box_id, participantsData } = req.body;

  if (!class_name || !date_start || !date_end || !participantsData || !participantsData.length) {
    return res.status(400).json({ error: 'Dados incompletos' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Insere a sessão principal (usando date_start e date_end)
    const sessionResult = await client.query(
      `INSERT INTO sessions (box_id, class_name, date_start, date_end, duration_minutes, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING id`,
      [box_id || 1, class_name, date_start, date_end, duration_minutes]
    );

    const sessionId = sessionResult.rows[0].id;

    // Insere resumo de cada aluno
    for (const p of participantsData) {
      await client.query(
        `INSERT INTO session_participants (
          session_id, participant_id, avg_hr,
          min_gray, min_green, min_blue, min_yellow, min_orange, min_red,
          trimp_total, calories_total, vo2_time_seconds, epoc_estimated,
          real_resting_hr, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())`,
        [
          sessionId,
          p.participantId,
          p.avg_hr || null,
          p.min_gray || 0,
          p.min_green || 0,
          p.min_blue || 0,
          p.min_yellow || 0,
          p.min_orange || 0,
          p.min_red || 0,
          p.trimp_total || 0,
          p.calories_total || 0,
          p.vo2_time_seconds || 0,
          p.epoc_estimated || 0,
          p.real_resting_hr || null
        ]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({ success: true, sessionId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao salvar sessão:', err);
    res.status(500).json({ error: 'Erro ao salvar sessão' });
  } finally {
    client.release();
  }
});

app.use('/api/sessions', sessionsRouter);

// Inicia o servidor
app.listen(port, () => {
  console.log(`Backend rodando → http://0.0.0.0:${port}`);
});