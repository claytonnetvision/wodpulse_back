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
          min_zone2, min_zone3, min_zone4, min_zone5,
          trimp_total, calories_total
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
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
          Number(p.min_zone2) || 0,
          Number(p.min_zone3) || 0,
          Number(p.min_zone4) || 0,
          Number(p.min_zone5) || 0,
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
      AVG(sp.epoc_estimated) AS epoc_medio,
      SUM(sp.min_zone2) AS total_min_zone2,
      SUM(sp.min_zone3) AS total_min_zone3,
      SUM(sp.min_zone4) AS total_min_zone4,
      SUM(sp.min_zone5) AS total_min_zone5
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
      sp.real_resting_hr,
      sp.min_zone2,
      sp.min_zone3,
      sp.min_zone4,
      sp.min_zone5
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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
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

// NOVA ROTA PARA LISTAR MODELOS DISPONÍVEIS DO GEMINI
app.get('/test-gemini-models', async (req, res) => {
  console.log('[TEST-GEMINI-MODELS] Rota acessada - listando modelos disponíveis');

  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'GEMINI_API_KEY não encontrada no environment' });
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[TEST-GEMINI-MODELS] Erro ao listar modelos:', response.status, errorText);
      return res.status(response.status).json({ 
        error: 'Falha ao listar modelos',
        status: response.status,
        details: errorText 
      });
    }

    const data = await response.json();
    console.log('[TEST-GEMINI-MODELS] Modelos encontrados:', JSON.stringify(data, null, 2));

    res.json({
      success: true,
      models: data.models || [],
      fullResponse: data
    });
  } catch (err) {
    console.error('[TEST-GEMINI-MODELS] Erro na chamada ListModels:', err.message);
    res.status(500).json({ 
      success: false,
      error: err.message,
      stack: err.stack ? err.stack.substring(0, 500) : 'Sem stack'
    });
  }
});

app.delete('/api/sessions/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM session_participants WHERE session_id = $1', [id]);
    await client.query('DELETE FROM sessions WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Erro ao excluir' });
  } finally {
    client.release();
  }
});

// ── ROTA PARA DETALHES DE UM ALUNO (para edição) ────────────────────────────────
app.get('/api/participants/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM participants WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Aluno não encontrado' });
    }
    res.json({ participant: result.rows[0] });
  } catch (err) {
    console.error('Erro ao buscar aluno:', err);
    res.status(500).json({ error: 'Erro ao buscar aluno' });
  }
});

// ── ROTA PARA EDITAR ALUNO (PUT) ────────────────────────────────────────────────
app.put('/api/participants/:id', async (req, res) => {
  const { id } = req.params;
  const {
    name, age, weight, height_cm, gender, email, use_tanaka,
    max_hr, historical_max_hr, device_id, device_name
  } = req.body;

  try {
    const result = await pool.query(
      `UPDATE participants 
       SET name = $1, age = $2, weight = $3, height_cm = $4, gender = $5, 
           email = $6, use_tanaka = $7, max_hr = $8, historical_max_hr = $9,
           device_id = $10, device_name = $11
       WHERE id = $12
       RETURNING *`,
      [name, age, weight, height_cm, gender, email, use_tanaka, max_hr, historical_max_hr, device_id, device_name, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Aluno não encontrado' });
    }

    res.json({ participant: result.rows[0] });
  } catch (err) {
    console.error('Erro ao editar aluno:', err);
    res.status(500).json({ error: 'Erro ao editar aluno' });
  }
});

// ── ROTA PARA LISTAR TODAS SESSÕES (simples, sem filtro pesado) ─────────────────
app.get('/api/sessions', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id, class_name, date_start, date_end, duration_minutes,
        (SELECT COUNT(*) FROM session_participants WHERE session_id = s.id) as participant_count
      FROM sessions s
      ORDER BY date_start DESC
      LIMIT 100
    `);
    res.json({ sessions: result.rows });
  } catch (err) {
    console.error('Erro ao listar sessões:', err);
    res.status(500).json({ error: 'Erro ao listar sessões' });
  }
});

// ── DETALHES DE UMA SESSÃO ────────────────────────────────
app.get('/api/sessions/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const sessionRes = await pool.query('SELECT * FROM sessions WHERE id = $1', [id]);
    if (sessionRes.rowCount === 0) return res.status(404).json({ error: 'Sessão não encontrada' });

    const participantsRes = await pool.query(`
      SELECT 
        p.id, p.name, p.age, p.weight, p.height_cm, p.gender,
        sp.*
      FROM session_participants sp
      JOIN participants p ON p.id = sp.participant_id
      WHERE sp.session_id = $1
    `, [id]);

    res.json({
      session: sessionRes.rows[0],
      participants: participantsRes.rows
    });
  } catch (err) {
    console.error('Erro detalhes sessão:', err);
    res.status(500).json({ error: 'Erro ao buscar detalhes da sessão' });
  }
});

// Monta o router de sessions
app.use('/api/sessions', sessionsRouter);

// ────────────────────────────────────────────────────────────────
// NOVAS ROTAS DE TESTE PARA MODELOS GEMINI (sem alterar nada existente)
// ────────────────────────────────────────────────────────────────

// Teste com gemini-2.5-flash-lite (recomendado para menos 503)
app.get('/test-gemini-lite', async (req, res) => {
  console.log('[TEST-GEMINI-LITE] Rota acessada - testando gemini-2.5-flash-lite');

  try {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY não encontrada');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{
            parts: [{ text: 'Teste Gemini 2.5 Flash-Lite: responda apenas com "Lite está funcionando 100%!" se ok.' }]
          }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 50
          }
        })
      }
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const json = await response.json();
    const texto = json.candidates?.[0]?.content?.parts?.[0]?.text || 'Sem resposta';

    res.json({
      success: true,
      resposta: texto.trim(),
      model: 'gemini-2.5-flash-lite',
      status: response.status,
      jsonCompleto: json
    });
  } catch (err) {
    console.error('[TEST-GEMINI-LITE] Erro:', err.message);
    res.status(500).json({
      success: false,
      error: err.message,
      model: 'gemini-2.5-flash-lite'
    });
  }
});

// Teste com gemini-1.5-flash (para comparar com o que você usava antes)
app.get('/test-gemini-15flash', async (req, res) => {
  console.log('[TEST-GEMINI-1.5] Rota acessada - testando gemini-1.5-flash');

  try {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY não encontrada');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{
            parts: [{ text: 'Teste Gemini 1.5 Flash: responda apenas com "1.5 Flash ok!" se tudo certo.' }]
          }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 50
          }
        })
      }
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const json = await response.json();
    const texto = json.candidates?.[0]?.content?.parts?.[0]?.text || 'Sem resposta';

    res.json({
      success: true,
      resposta: texto.trim(),
      model: 'gemini-1.5-flash',
      status: response.status,
      jsonCompleto: json
    });
  } catch (err) {
    console.error('[TEST-GEMINI-1.5] Erro:', err.message);
    res.status(500).json({
      success: false,
      error: err.message,
      model: 'gemini-1.5-flash'
    });
  }
});
// Rota de teste REALISTA do prompt do e-mail (simula send-class-summary-email.js)
app.get('/test-gemini-email-prompt', async (req, res) => {
  console.log('[TEST-GEMINI-EMAIL] Rota acessada - simulando prompt completo do e-mail');

  try {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY não encontrada');
    }

    // ── Dados simulados (copie/colou do seu log real ou ajuste como quiser) ──
    const aulaDuracaoMin = 60;
    const aluno = {
      name: 'Robson',
      calories: 563,
      queima_points: 0,
      vo2_time_seconds: 0,
      min_red: 0,
      min_zone2: 9,
      min_zone3: 0,
      min_zone4: 1,
      min_zone5: 0,
      avg_hr: 114,
      max_hr_reached: 155,
      real_resting_hr: 61,
      trimp_total: 0,
      epoc_estimated: 2
    };

    const prev = {
      calories: 71,
      queima_points: 0,
      vo2_time_seconds: 0,
      min_red: 0,
      min_zone2: 0,
      min_zone3: 0,
      min_zone4: 0,
      min_zone5: 0,
      avg_hr: 0,
      max_hr_reached: 93,
      real_resting_hr: 77,
      trimp_total: 0,
      epoc_estimated: 0
    };

    const classDate = '28/01/2026';

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000); // 45s para prompts longos

    console.log('[TEST-GEMINI-EMAIL] Enviando prompt completo para Gemini...');

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `Você é um treinador experiente de CrossFit, corrida e esportes. Analise esses dados da aula de hoje e do treino anterior e gere um comentário técnico, motivacional e positivo de 6 a 9 linhas completas. Destaque a duração da aula (${aulaDuracaoMin} minutos) em relação à intensidade geral, tempo nas zonas 2, 3, 4 e 5, melhora ou piora no comparativo, recuperação e dê 1 ou 2 dicas práticas pro próximo treino. Use tom encorajador, linguagem simples e direta. Não corte o texto, escreva o comentário completo.

Dados de hoje:
- Duração da aula: ${aulaDuracaoMin} minutos
- Calorias: ${Math.round(aluno.calories)} kcal
- Queima Points: ${Math.round(aluno.queima_points)}
- Zona 2 (60-70%): ${Math.round(aluno.min_zone2)} min
- Zona 3 (70-80%): ${Math.round(aluno.min_zone3)} min
- Zona 4 (80-90%): ${Math.round(aluno.min_zone4)} min
- Zona 5 (>90%): ${Math.round(aluno.min_zone5)} min
- Tempo VO₂ Máx: ${Math.round(aluno.vo2_time_seconds / 60)} min
- TRIMP Total: ${Number(aluno.trimp_total || 0).toFixed(1)}
- EPOC Estimado (queima pós-treino): ${Math.round(aluno.epoc_estimated || 0)} kcal
- FC Média: ${Math.round(aluno.avg_hr || 0)} bpm
- FC Máxima atingida: ${Math.round(aluno.max_hr_reached || 0)} bpm
- FC Repouso real: ${Math.round(aluno.real_resting_hr || 0)} bpm

Dados do treino anterior (comparativo):
- Calorias: ${Math.round(prev.calories)} kcal
- Queima Points: ${Math.round(prev.queima_points)}
- Zona 2 (60-70%): ${Math.round(prev.min_zone2)} min
- Zona 3 (70-80%): ${Math.round(prev.min_zone3)} min
- Zona 4 (80-90%): ${Math.round(prev.min_zone4)} min
- Zona 5 (>90%): ${Math.round(prev.min_zone5)} min
- Tempo VO₂ Máx: ${Math.round(prev.vo2_time_seconds / 60)} min
- TRIMP Total: ${Number(prev.trimp_total || 0).toFixed(1)}
- EPOC Estimado (queima pós-treino): ${Math.round(prev.epoc_estimated || 0)} kcal
- FC Média: ${Math.round(prev.avg_hr || 0)} bpm
- FC Máxima atingida: ${Math.round(prev.max_hr_reached || 0)} bpm
- FC Repouso real: ${Math.round(prev.real_resting_hr || 0)} bpm

Nome do aluno: ${aluno.name.split(' ')[0]}
Data da aula de hoje: ${classDate}`
            }]
          }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 8192
          }
        })
      }
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[TEST-GEMINI-EMAIL] Erro:', response.status, errorText);
      throw new Error(`Gemini retornou ${response.status}: ${errorText}`);
    }

    const json = await response.json();
    const comentario = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'Sem comentário gerado';

    console.log('[TEST-GEMINI-EMAIL] Comentário gerado:', comentario.substring(0, 200) + '...');

    res.json({
      success: true,
      comentario_gerado: comentario,
      model: 'gemini-2.5-flash-lite',
      duracao: aulaDuracaoMin,
      status: response.status
    });
  } catch (err) {
    console.error('[TEST-GEMINI-EMAIL] Falha:', err.message);
    res.status(500).json({
      success: false,
      error: err.message,
      model: 'gemini-2.5-flash-lite'
    });
  }
});


// ────────────────────────────────────────────────────────────────
// ROTA DE TESTE PARA DEEPSEEK API (valida a chave e o endpoint)
// Acesse: /test-deepseek
// ────────────────────────────────────────────────────────────────
app.get('/test-deepseek', async (req, res) => {
  console.log('[TEST-DEEPSEEK] Rota acessada - validando API key');

  try {
    // Verifica se a chave existe no environment (Render ou .env)
    if (!process.env.DEEPSEEK_API_KEY) {
      console.error('[TEST-DEEPSEEK] DEEPSEEK_API_KEY não encontrada no environment');
      return res.status(500).json({
        success: false,
        error: 'DEEPSEEK_API_KEY não configurada no Render / .env'
      });
    }

    console.log('[TEST-DEEPSEEK] Chave encontrada, enviando teste simples...');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000); // 20 segundos de timeout

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'user',
            content: 'Teste simples: responda apenas com "DeepSeek API está funcionando perfeitamente!" se tudo estiver ok.'
          }
        ],
        temperature: 0.7,
        max_tokens: 50,
        stream: false
      })
    });

    clearTimeout(timeoutId);

    console.log('[TEST-DEEPSEEK] Status HTTP recebido:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[TEST-DEEPSEEK] Erro na API:', response.status, errorText);
      return res.status(response.status).json({
        success: false,
        error: `DeepSeek retornou erro HTTP ${response.status}: ${errorText}`
      });
    }

    const json = await response.json();
    console.log('[TEST-DEEPSEEK] Resposta completa:', JSON.stringify(json, null, 2));

    const textoResposta = json.choices?.[0]?.message?.content?.trim() || 'Sem texto na resposta';

    res.json({
      success: true,
      resposta: textoResposta,
      model: 'deepseek-chat',
      status: response.status,
      jsonCompleto: json
    });

  } catch (err) {
    console.error('[TEST-DEEPSEEK] Erro completo:', err.message);
    if (err.name === 'AbortError') {
      console.error('[TEST-DEEPSEEK] Timeout: DeepSeek demorou mais de 20 segundos');
    }
    res.status(500).json({
      success: false,
      error: err.message,
      stack: err.stack ? err.stack.substring(0, 300) : 'Sem stack'
    });
  }
});

// ────────────────────────────────────────────────────────────────
// ROTA DE TESTE PARA OPENROUTER API (valida chave e endpoint)
// Acesse: https://wodpulse-back.onrender.com/test-openrouter
// ────────────────────────────────────────────────────────────────
app.get('/test-openrouter', async (req, res) => {
  console.log('[TEST-OPENROUTER] Rota acessada - validando API key');

  try {
    if (!process.env.OPENROUTER_API_KEY) {
      console.error('[TEST-OPENROUTER] OPENROUTER_API_KEY não encontrada');
      return res.status(500).json({
        success: false,
        error: 'OPENROUTER_API_KEY não configurada no Render / .env'
      });
    }

    console.log('[TEST-OPENROUTER] Chave encontrada, enviando teste simples...');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://wodpulse.com', // opcional, mas ajuda no tracking
        'X-Title': 'WODPulse Test'              // opcional
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'nousresearch/hermes-3-llama-3.1-405b:free', // modelo free grande e bom
        messages: [
          {
            role: 'user',
            content: 'Teste simples OpenRouter: responda apenas com "OpenRouter está funcionando 100%!" se tudo ok.'
          }
        ],
        temperature: 0.7,
        max_tokens: 50
      })
    });

    clearTimeout(timeoutId);

    console.log('[TEST-OPENROUTER] Status HTTP:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[TEST-OPENROUTER] Erro:', response.status, errorText);
      return res.status(response.status).json({
        success: false,
        error: `OpenRouter retornou HTTP ${response.status}: ${errorText}`
      });
    }

    const json = await response.json();
    const texto = json.choices?.[0]?.message?.content?.trim() || 'Sem resposta';

    res.json({
      success: true,
      resposta: texto,
      model: 'meta-llama/llama-3.1-8b-instruct:free',
      status: response.status,
      jsonCompleto: json
    });

  } catch (err) {
    console.error('[TEST-OPENROUTER] Erro completo:', err.message);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});
// ────────────────────────────────────────────────────────────────
// ROTA DE TESTE PARA GROQ API (valida chave e endpoint)
// Acesse: https://wodpulse-back.onrender.com/test-groq
// ────────────────────────────────────────────────────────────────
app.get('/test-groq', async (req, res) => {
  console.log('[TEST-GROQ] Rota acessada - validando API key');

  try {
    if (!process.env.GROQ_API_KEY) {
      console.error('[TEST-GROQ] GROQ_API_KEY não encontrada no environment');
      return res.status(500).json({
        success: false,
        error: 'GROQ_API_KEY não configurada no Render / .env'
      });
    }

    console.log('[TEST-GROQ] Chave encontrada, enviando teste simples...');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000); // 20 segundos timeout

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'llama-3.1-70b-versatile',  // modelo free mais forte e rápido no Groq
        messages: [
          {
            role: 'user',
            content: 'Teste simples Groq: responda apenas com "Groq API está funcionando perfeitamente!" se tudo estiver ok.'
          }
        ],
        temperature: 0.7,
        max_tokens: 50
      })
    });

    clearTimeout(timeoutId);

    console.log('[TEST-GROQ] Status HTTP recebido:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[TEST-GROQ] Erro na API:', response.status, errorText);
      return res.status(response.status).json({
        success: false,
        error: `Groq retornou erro HTTP ${response.status}: ${errorText}`
      });
    }

    const json = await response.json();
    console.log('[TEST-GROQ] Resposta completa:', JSON.stringify(json, null, 2));

    const textoResposta = json.choices?.[0]?.message?.content?.trim() || 'Sem texto na resposta';

    res.json({
      success: true,
      resposta: textoResposta,
      model: 'llama-3.3-70b-versatile',
      status: response.status,
      jsonCompleto: json
    });

  } catch (err) {
    console.error('[TEST-GROQ] Erro completo:', err.message);
    if (err.name === 'AbortError') {
      console.error('[TEST-GROQ] Timeout: Groq demorou mais de 20 segundos');
    }
    res.status(500).json({
      success: false,
      error: err.message,
      stack: err.stack ? err.stack.substring(0, 300) : 'Sem stack'
    });
  }
});
// Inicia o servidor
app.listen(port, () => {
  console.log(`Backend rodando → http://0.0.0.0:${port}`);
});