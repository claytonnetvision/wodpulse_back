require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const cron = require('node-cron');

const app = express();
const port = process.env.PORT || 3001;

// CORS corrigido e explícito
app.use(cors({
  origin: ['https://www.infrapower.com.br', 'http://localhost:3000'],  // seu domínio + localhost
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204
}));

// Handler explícito para OPTIONS (preflight)
app.options('*', cors());

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

// POST /api/sessions - Salva sessão com TODOS os campos
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

    const sessionResult = await client.query(
      `INSERT INTO sessions (box_id, class_name, date_start, date_end, duration_minutes, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING id`,
      [
        box_id || 1,
        class_name,
        date_start,
        date_end,
        Number(duration_minutes) || null
      ]
    );

    const sessionId = sessionResult.rows[0].id;
    console.log('[SESSION] Sessão criada com ID:', sessionId);

    for (const p of participantsData) {
      await client.query(
        `INSERT INTO session_participants (
          session_id, participant_id,
          queima_points, calories, vo2_time_seconds, epoc_estimated,
          real_resting_hr, avg_hr, max_hr_reached, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
        [
          sessionId,
          p.participantId,
          Number(p.trimp_total) || 0,
          Number(p.calories_total) || 0,
          Number(p.vo2_time_seconds) || 0,
          Number(p.epoc_estimated) || 0,
          Number(p.real_resting_hr) || null,
          Number(p.avg_hr) || null,
          Number(p.max_hr_reached) || null
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

// CRON JOB - Limpeza automática de dados antigos (>30 dias)
cron.schedule('0 3 * * *', async () => {
  console.log('[CRON] Iniciando limpeza de dados antigos (>30 dias)...');
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  try {
    const sessionsDeleted = await pool.query(
      'DELETE FROM sessions WHERE date_start < $1 RETURNING id',
      [thirtyDaysAgo]
    );
    console.log(`[CRON] Sessões deletadas: ${sessionsDeleted.rowCount}`);

    const spDeleted = await pool.query(
      'DELETE FROM session_participants WHERE created_at < $1 RETURNING id',
      [thirtyDaysAgo]
    );
    console.log(`[CRON] Resumos deletados: ${spDeleted.rowCount}`);

    try {
      const restingDeleted = await pool.query(
        'DELETE FROM resting_hr_measurements WHERE measured_at < $1 RETURNING id',
        [thirtyDaysAgo]
      );
      console.log(`[CRON] Medições de repouso deletadas: ${restingDeleted.rowCount}`);
    } catch (restingErr) {
      console.warn('[CRON] Tabela resting_hr_measurements não encontrada ou erro:', restingErr.message);
    }

    console.log('[CRON] Limpeza concluída com sucesso.');
  } catch (err) {
    console.error('[CRON] Erro durante a limpeza:', err.stack);
  }
});

// Inicia o servidor
app.listen(port, () => {
  console.log(`Backend rodando → http://0.0.0.0:${port}`);
});