require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors({
  origin: '*',  // Temporário para testes (depois restrinja para o domínio do Vercel)
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
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

  console.log('[SESSION] Dados recebidos do frontend:', JSON.stringify(req.body, null, 2));

  if (!class_name || !date_start || !date_end || !participantsData || !participantsData.length) {
    console.log('[SESSION] Dados incompletos detectados');
    return res.status(400).json({ error: 'Dados incompletos' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Insere a sessão principal (agora com duration_minutes)
    const sessionResult = await client.query(
      `INSERT INTO sessions (box_id, class_name, date_start, date_end, duration_minutes, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING id`,
      [
        box_id || 1,
        class_name,
        date_start,
        date_end,
        Number(duration_minutes) || null   // ← força número ou null
      ]
    );

    const sessionId = sessionResult.rows[0].id;
    console.log('[SESSION] Sessão criada com ID:', sessionId);

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
          Number(p.avg_hr) || null,
          Number(p.min_gray) || 0,
          Number(p.min_green) || 0,
          Number(p.min_blue) || 0,
          Number(p.min_yellow) || 0,
          Number(p.min_orange) || 0,
          Number(p.min_red) || 0,
          Number(p.trimp_total) || 0,
          Number(p.calories_total) || 0,
          Number(p.vo2_time_seconds) || 0,
          Number(p.epoc_estimated) || 0,
          Number(p.real_resting_hr) || null
        ]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({ success: true, sessionId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro completo ao salvar sessão:', err.stack);
    console.error('Mensagem do erro:', err.message);
    console.error('Dados recebidos do frontend:', req.body);
    res.status(500).json({ error: 'Erro ao salvar sessão', details: err.message });
  } finally {
    client.release();
  }
});

app.use('/api/sessions', sessionsRouter);

// Inicia o servidor
app.listen(port, () => {
  console.log(`Backend rodando → http://0.0.0.0:${port}`);
});