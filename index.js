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

  // ── PROTEÇÃO: descartar aulas manuais muito curtas ────────────────────────────────
  let durationSeconds = 0;
  try {
    const start = new Date(date_start);
    const end = new Date(date_end);
    if (!isNaN(start) && !isNaN(end) && end > start) {
      durationSeconds = Math.floor((end - start) / 1000); // segundos
    } else {
      console.warn('[SESSION] Datas inválidas ou end < start → duração assumida como 0');
      durationSeconds = 0;
    }
  } catch (err) {
    console.error('[SESSION] Erro ao calcular duração:', err.message);
    durationSeconds = 0;
  }

  const isManualClass = 
    class_name && 
    (class_name.toLowerCase().includes('manual') || 
     class_name === 'Aula Manual');

  if (isManualClass && durationSeconds < 240) {  // menos de 4 minutos (240 segundos)
    const minutes = Math.floor(durationSeconds / 60);
    const seconds = durationSeconds % 60;
    const durationStr = `${minutes}min${seconds.toString().padStart(2, '0')}s`;

    console.log(
      `[DISCARD] Aula manual curta descartada - ` +
      `duração: ${durationStr} - ` +
      `class: "${class_name}" - ` +
      `${new Date().toISOString()}`
    );

    return res.status(200).json({
      success: false,
      skipped: true,
      reason: 'Aula com menos de 4 minutos – não registrada'
    });
  }

  // Se chegou aqui → ou não é manual, ou tem ≥ 4 minutos → prossegue normal
  console.log(`[SESSION] Aula válida - duração: ${Math.floor(durationSeconds / 60)}min${durationSeconds % 60}s`);

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

    // Envia e-mails em background (não trava a resposta HTTP para o frontend)
    const { sendSummaryEmailsAfterClass } = require('./jobs/send-class-summary-email');
    sendSummaryEmailsAfterClass(sessionId)
      .catch(err => {
        console.error(`[EMAIL ASYNC] Falha ao enviar e-mails para sessão ${sessionId}:`, err.message || err);
      });

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
    const sessionRes = await pool.query(`
      SELECT 
        id, class_name, date_start, date_end, duration_minutes
      FROM sessions 
      WHERE id = $1
    `, [sessionId]);

    if (sessionRes.rowCount === 0) {
      return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    const participantsRes = await pool.query(`
      SELECT 
        p.id, p.name,
        sp.calories_total, sp.queima_points, sp.vo2_time_seconds,
        sp.min_red, sp.avg_hr, sp.max_hr_reached, sp.trimp_total,
        sp.epoc_estimated, sp.real_resting_hr
      FROM session_participants sp
      JOIN participants p ON p.id = sp.participant_id
      WHERE sp.session_id = $1
    `, [sessionId]);

    res.json({
      session: sessionRes.rows[0],
      participants: participantsRes.rows
    });
  } catch (err) {
    console.error('Erro ao buscar detalhes da sessão:', err.stack);
    res.status(500).json({ error: 'Erro ao buscar sessão' });
  }
});

// Ranking semanal (exemplo completo baseado no seu código truncado)
sessionsRouter.get('/ranking-semanal', async (req, res) => {
  const { gender, metric = 'queima_points', limit = 10 } = req.query;

  const today = new Date();
  const monday = new Date(today.setDate(today.getDate() - today.getDay() + 1));
  monday.setHours(0, 0, 0, 0);
  const nextMonday = new Date(monday);
  nextMonday.setDate(nextMonday.getDate() + 7);
  const nextMondayStr = nextMonday.toISOString().split('T')[0];
  const mondayStr = monday.toISOString().split('T')[0];

  let queryText = `
    SELECT 
      p.id, p.name, p.gender,
      SUM(sp.queima_points) AS total_queima_points,
      SUM(sp.calories_total) AS total_calorias,
      SUM(sp.vo2_time_seconds) AS total_vo2_seconds,
      MAX(sp.max_hr_reached) AS max_hr_reached,
      SUM(sp.trimp_total) AS total_trimp
    FROM session_participants sp
    JOIN sessions s ON sp.session_id = s.id
    JOIN participants p ON sp.participant_id = p.id
    WHERE s.date_start >= $1 
      AND s.date_start < $2
  `;
  const params = [mondayStr, nextMondayStr];

  if (gender) {
    queryText += ` AND p.gender = $${params.length + 1}`;
    params.push(gender);
  }

  let orderBy;
  if (metric === 'calories') orderBy = 'total_calorias';
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
      week_start: mondayStr,
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

// ROTA DE TESTE PARA GEMINI (com logs extras para debug)
app.get('/test-gemini', async (req, res) => {
  console.log('[TEST-GEMINI] Rota acessada - iniciando teste');

  try {
    console.log('[TEST-GEMINI] Verificando se a chave GEMINI_API_KEY existe no environment...');
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY não encontrada no environment variables');
    }
    console.log('[TEST-GEMINI] Chave encontrada (não mostro o valor por segurança)');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 segundos de timeout

    console.log('[TEST-GEMINI] Preparando request para Gemini API...');

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{
            parts: [{ text: 'Teste simples: responda apenas com "Gemini está funcionando perfeitamente!" se tudo estiver ok.' }]
          }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 50
          }
        })
      }
    );

    clearTimeout(timeoutId);

    console.log('[TEST-GEMINI] Resposta HTTP recebida com status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[TEST-GEMINI] Erro HTTP da API:', response.status, errorText);
      throw new Error(`Gemini retornou erro HTTP ${response.status}: ${errorText}`);
    }

    const json = await response.json();
    console.log('[TEST-GEMINI] JSON completo da resposta:', JSON.stringify(json, null, 2));

    const textoResposta = json.candidates?.[0]?.content?.parts?.[0]?.text || 'Sem texto na resposta';

    console.log('[TEST-GEMINI] Texto gerado pela IA:', textoResposta);

    res.json({
      success: true,
      resposta: textoResposta,
      status: response.status,
      jsonCompleto: json
    });
  } catch (err) {
    console.error('[TEST-GEMINI] Erro completo no teste:', err.message);
    if (err.name === 'AbortError') {
      console.error('[TEST-GEMINI] Timeout: Gemini demorou mais de 10 segundos');
    }
    res.status(500).json({
      success: false,
      error: err.message,
      stack: err.stack ? err.stack.substring(0, 500) : 'Sem stack'
    });
  }
});

// Monta o router de sessions
app.use('/api/sessions', sessionsRouter);

// Inicia o servidor
app.listen(port, () => {
  console.log(`Backend rodando → http://0.0.0.0:${port}`);
});