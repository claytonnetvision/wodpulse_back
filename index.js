require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3001;

// CORS explícito e seguro - libera apenas os domínios que você usa
app.use(cors({
  origin: [
    'https://www.infrapower.com.br',
    'https://wodpulse-front-f2lo92fpz-robson-claytons-projects.vercel.app',
    'http://localhost:3000',
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

// Ping periódico para manter Neon acordado (plano free)
setInterval(async () => {
  try {
    await pool.query('SELECT 1');
    console.log('[PING NEON] Sucesso: Banco mantido acordado - SELECT 1 executado');
  } catch (err) {
    console.error('[PING NEON] Falha ao manter banco acordado:', err.message);
  }
}, 4 * 60 * 1000); // 4 minutos

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

// Rotas para sessões
const sessionsRouter = express.Router();

// POST /api/sessions - Salva sessão
sessionsRouter.post('/', async (req, res) => {
  const { class_name, date_start, date_end, duration_minutes, box_id, participantsData } = req.body;

  console.log('[SESSION] Dados recebidos do frontend:', JSON.stringify(req.body, null, 2));

  if (!class_name || !date_start || !date_end) {
    console.log('[SESSION] Campos obrigatórios faltando');
    return res.status(400).json({ error: 'Dados da sessão incompletos (class_name, date_start ou date_end)' });
  }

  if (!participantsData || !Array.isArray(participantsData)) {
    console.log('[SESSION] participantsData inválido ou vazio - salvando aula sem alunos');
    participantsData = [];
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
          real_resting_hr, avg_hr, max_hr_reached, created_at,
          min_gray, min_green, min_blue, min_yellow, min_orange, min_red,
          trimp_total, calories_total
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          sessionId,
          p.participantId,
          Number(p.queimaPoints) || 0,          // ALTERADO AQUI: de queima_points → queimaPoints
          Number(p.calories) || 0,
          Number(p.vo2TimeSeconds) || 0,        // ALTERADO AQUI: de vo2_time_seconds → vo2TimeSeconds
          Number(p.epocEstimated) || 0,         // ALTERADO AQUI: de epoc_estimated → epocEstimated
          Number(p.realRestingHR) || null,      // ALTERADO AQUI: tentativa de nome compatível com frontend
          Number(p.avgHR) || null,              // ALTERADO AQUI: de avg_hr → avgHR
          Number(p.maxHRReached) || null,       // ALTERADO AQUI: de max_hr_reached → maxHRReached
          Number(p.minGray) || 0,
          Number(p.minGreen) || 0,
          Number(p.minBlue) || 0,
          Number(p.minYellow) || 0,
          Number(p.minOrange) || 0,
          Number(p.minRed) || 0,
          Number(p.trimpPoints) || 0,           // ALTERADO AQUI: de trimp_total → trimpPoints
          Number(p.calories) || 0               // mantido (calories_total usa calories por enquanto)
        ]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({ success: true, sessionId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao salvar sessão:', err.stack);
    res.status(500).json({ error: 'Erro ao salvar sessão', details: err.message });
  } finally {
    client.release();
  }
});

// GET /api/sessions - Lista sessões com filtros
sessionsRouter.get('/', async (req, res) => {
  const { start_date, end_date, participant_id, limit = 50 } = req.query;

  let queryText = `
    SELECT 
      s.id,
      s.class_name,
      s.date_start,
      s.date_end,
      s.duration_minutes,
      COUNT(sp.participant_id) AS participant_count
    FROM sessions s
    LEFT JOIN session_participants sp ON s.id = sp.session_id
    WHERE 1=1
  `;
  const params = [];
  let paramIndex = 1;

  if (start_date) {
    queryText += ` AND s.date_start >= $${paramIndex}`;
    params.push(start_date);
    paramIndex++;
  }
  if (end_date) {
    queryText += ` AND s.date_end <= $${paramIndex}`;
    params.push(end_date + ' 23:59:59');
    paramIndex++;
  }
  if (participant_id) {
    queryText += ` AND EXISTS (
      SELECT 1 FROM session_participants sp2 
      WHERE sp2.session_id = s.id AND sp2.participant_id = $${paramIndex}
    )`;
    params.push(Number(participant_id));
    paramIndex++;
  }

  queryText += ` 
    GROUP BY s.id 
    ORDER BY s.date_start DESC 
    LIMIT $${paramIndex}
  `;
  params.push(Number(limit) || 50);

  try {
    const result = await pool.query(queryText, params);
    res.json({ sessions: result.rows });
  } catch (err) {
    console.error('Erro ao listar sessões:', err.stack);
    res.status(500).json({ error: 'Erro interno ao buscar sessões' });
  }
});

// GET /api/sessions/:id - Detalhes completos de uma sessão
sessionsRouter.get('/:id', async (req, res) => {
  const sessionId = req.params.id;

  try {
    const sessionRes = await pool.query(
      `SELECT * FROM sessions WHERE id = $1`,
      [sessionId]
    );
    if (sessionRes.rowCount === 0) {
      return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    const participantsRes = await pool.query(
      `SELECT 
         sp.*,
         p.name,
         p.gender,
         p.age,
         p.weight,
         p.height_cm
       FROM session_participants sp
       JOIN participants p ON sp.participant_id = p.id
       WHERE sp.session_id = $1`,
      [sessionId]
    );

    res.json({
      session: sessionRes.rows[0],
      participants: participantsRes.rows
    });
  } catch (err) {
    console.error('Erro ao buscar sessão detalhada:', err.stack);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// GET /api/participants/:id/history - Histórico de um aluno
sessionsRouter.get('/participants/:id/history', async (req, res) => {
  const participantId = req.params.id;
  const { limit = 10 } = req.query;

  try {
    const history = await pool.query(
      `SELECT 
         s.id AS session_id,
         s.class_name,
         s.date_start,
         s.date_end,
         sp.queima_points,
         sp.calories_total AS calories,
         sp.vo2_time_seconds,
         sp.avg_hr,
         sp.max_hr_reached,
         sp.min_red
       FROM session_participants sp
       JOIN sessions s ON sp.session_id = s.id
       WHERE sp.participant_id = $1
       ORDER BY s.date_start DESC
       LIMIT $2`,
      [participantId, Number(limit)]
    );

    res.json({ history: history.rows });
  } catch (err) {
    console.error('Erro ao buscar histórico do participante:', err.stack);
    res.status(500).json({ error: 'Erro ao buscar histórico' });
  }
});

// NOVA ROTA: Apagar TODAS as aulas (sessions + participações)
sessionsRouter.delete('/delete-all', async (req, res) => {
  try {
    await pool.query('DELETE FROM session_participants');
    await pool.query('DELETE FROM sessions');
    console.log('[DELETE ALL] Todas as sessões e participações apagadas com sucesso');
    res.json({ success: true, message: 'Todas as aulas apagadas' });
  } catch (err) {
    console.error('[DELETE ALL] Erro ao apagar tudo:', err.stack);
    res.status(500).json({ error: 'Erro ao apagar aulas', details: err.message });
  }
});

// DEBUG: Rota para confirmar deploy
app.get('/api/debug-test', (req, res) => {
  res.json({ 
    message: 'Deploy atualizado com sucesso - rota debug OK',
    time: new Date().toISOString()
  });
});

// GET /api/rankings/weekly - Ranking semanal
sessionsRouter.get('/rankings/weekly', async (req, res) => {
  const { week_start, metric = 'queima_points', gender, limit = 20 } = req.query;

  let monday;
  if (week_start) {
    monday = week_start;
  } else {
    const today = new Date();
    const day = today.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    monday = new Date(today);
    monday.setDate(today.getDate() + diff);
    monday = monday.toISOString().split('T')[0];
  }

  const nextMonday = new Date(monday);
  nextMonday.setDate(nextMonday.getDate() + 7);
  const nextMondayStr = nextMonday.toISOString().split('T')[0];

  let queryText = `
    SELECT 
      p.id,
      p.name,
      p.gender,
      SUM(sp.queima_points) AS total_queima_points,
      SUM(sp.calories_total) AS total_calories,
      SUM(sp.vo2_time_seconds) AS total_vo2_seconds,
      MAX(sp.max_hr_reached) AS max_hr_reached,
      SUM(sp.trimp_total) AS total_trimp
    FROM session_participants sp
    JOIN sessions s ON sp.session_id = s.id
    JOIN participants p ON sp.participant_id = p.id
    WHERE s.date_start >= $1 
      AND s.date_start < $2
  `;
  const params = [monday, nextMondayStr];

  if (gender) {
    queryText += ` AND p.gender = $${params.length + 1}`;
    params.push(gender);
  }

  let orderBy;
  if (metric === 'calories') orderBy = 'total_calories';
  else if (metric === 'vo2') orderBy = 'total_vo2_seconds';
  else if (metric === 'maxhr') orderBy = 'max_hr_reached';
  else if (metric === 'trimp') orderBy = 'total_trimp';
  else orderBy = 'total_queima_points';

  queryText += `
    GROUP BY p.id, p.name, p.gender
    ORDER BY ${orderBy} DESC
    LIMIT $${params.length + 1}
  `;
  params.push(Number(limit));

  try {
    const result = await pool.query(queryText, params);
    res.json({
      week_start: monday,
      rankings: result.rows
    });
  } catch (err) {
    console.error('Erro no ranking semanal:', err.stack);
    res.status(500).json({ error: 'Erro ao calcular ranking', details: err.message });
  }
});

// Ranking acumulado por aluno
app.get('/api/participants/ranking-acumulado', async (req, res) => {
  const { alunoId, inicio, fim } = req.query;

  let query = `
    SELECT 
      p.name AS aluno,
      COUNT(DISTINCT sp.session_id) AS qtd_aulas,
      SUM(sp.calories_total) AS total_calorias,
      SUM(sp.vo2_time_seconds) AS total_vo2_seg,
      AVG(sp.avg_hr) AS fc_media_geral,
      MAX(sp.max_hr_reached) AS fc_max_geral,
      SUM(sp.min_red) AS total_tempo_vermelho_min,
      SUM(sp.queima_points) AS total_queima_points,
      AVG(sp.trimp_total) AS trimp_medio,
      AVG(sp.epoc_estimated) AS epoc_medio
    FROM participants p
    LEFT JOIN session_participants sp ON sp.participant_id = p.id
    LEFT JOIN sessions s ON s.id = sp.session_id
    WHERE 1=1
  `;
  const params = [];
  let paramIndex = 1;

  if (alunoId) {
    query += ` AND p.id = $${paramIndex}`;
    params.push(alunoId);
    paramIndex++;
  }
  if (inicio) {
    query += ` AND s.date_start >= $${paramIndex}`;
    params.push(inicio);
    paramIndex++;
  }
  if (fim) {
    query += ` AND s.date_start <= $${paramIndex}`;
    params.push(fim);
    paramIndex++;
  }

  query += ` GROUP BY p.name ORDER BY total_calorias DESC`;

  try {
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Erro no ranking acumulado:', err);
    res.status(500).json({ error: 'Erro ao buscar ranking acumulado' });
  }
});

// Histórico detalhado por aula
app.get('/api/sessions/historico', async (req, res) => {
  const { alunoId, inicio, fim } = req.query;

  let query = `
    SELECT 
      s.id AS id_sessao,
      s.class_name,
      s.date_start,
      s.date_end,
      s.duration_minutes,
      p.name AS aluno,
      sp.calories_total,
      sp.vo2_time_seconds,
      sp.avg_hr,
      sp.max_hr_reached,
      sp.min_red,
      sp.queima_points,
      sp.trimp_total,
      sp.epoc_estimated,
      sp.real_resting_hr
    FROM sessions s
    JOIN session_participants sp ON sp.session_id = s.id
    JOIN participants p ON p.id = sp.participant_id
    WHERE 1=1
  `;
  const params = [];
  let paramIndex = 1;

  if (alunoId) {
    query += ` AND p.id = $${paramIndex}`;
    params.push(alunoId);
    paramIndex++;
  }
  if (inicio) {
    query += ` AND s.date_start >= $${paramIndex}`;
    params.push(inicio);
    paramIndex++;
  }
  if (fim) {
    query += ` AND s.date_start <= $${paramIndex}`;
    params.push(fim);
    paramIndex++;
  }

  query += ` ORDER BY s.date_start DESC`;

  try {
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Erro no histórico detalhado:', err);
    res.status(500).json({ error: 'Erro ao buscar histórico' });
  }
});

// Monta o router de sessions
app.use('/api/sessions', sessionsRouter);

// Inicia o servidor
app.listen(port, () => {
  console.log(`Backend rodando → http://0.0.0.0:${port}`);
});