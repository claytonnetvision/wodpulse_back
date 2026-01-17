require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
// const cron = require('node-cron');  // comentado temporariamente para teste

const app = express();
const port = process.env.PORT || 3001;

// CORS explícito e seguro - libera apenas os domínios que você usa
app.use(cors({
  origin: [
    'https://www.infrapower.com.br',                     // seu domínio principal
    'https://wodpulse-front-f2lo92fpz-robson-claytons-projects.vercel.app', // domínio do Vercel (se ainda usar)
    'http://localhost:3000',                              // para testes locais
    'http://127.0.0.1:3000'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204
}));

// Handler explícito para requisições OPTIONS (preflight do CORS)
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

// Ping periódico para manter Neon acordado (plano free - evita suspensão)
setInterval(async () => {
  try {
    await pool.query('SELECT 1');
    console.log('[PING NEON] Sucesso: Banco mantido acordado - SELECT 1 executado');
  } catch (err) {
    console.error('[PING NEON] Falha ao manter banco acordado:', err.message);
  }
}, 4 * 60 * 1000); // 4 minutos (mais curto que o tempo de suspensão do Neon)

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

  // Validação mínima - permite participantsData vazio, mas avisa
  if (!class_name || !date_start || !date_end) {
    console.log('[SESSION] Campos obrigatórios faltando (class_name/date_start/date_end)');
    return res.status(400).json({ error: 'Dados da sessão incompletos (class_name, date_start ou date_end)' });
  }

  if (!participantsData || !Array.isArray(participantsData)) {
    console.log('[SESSION] participantsData inválido ou vazio - salvando aula sem alunos');
    participantsData = [];
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Insere a sessão principal
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

    // Insere resumo de cada aluno (TODOS os campos reais)
    for (const p of participantsData) {
      await client.query(
        `INSERT INTO session_participants (
          session_id, participant_id,
          queima_points, calories, vo2_time_seconds, epoc_estimated,
          real_resting_hr, avg_hr, max_hr_reached, created_at,
          min_gray, min_green, min_blue, min_yellow, min_orange, min_red,
          trimp_total, calories_total
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          sessionId,
          p.participantId,
          Number(p.queima_points) || 0,
          Number(p.calories) || 0,
          Number(p.vo2_time_seconds) || 0,
          Number(p.epoc_estimated) || 0,
          Number(p.real_resting_hr) || null,
          Number(p.avg_hr) || null,
          Number(p.max_hr_reached) || null,
          Number(p.min_gray) || 0,
          Number(p.min_green) || 0,
          Number(p.min_blue) || 0,
          Number(p.min_yellow) || 0,
          Number(p.min_orange) || 0,
          Number(p.min_red) || 0,
          Number(p.trimp_total) || 0,
          Number(p.calories_total) || 0
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