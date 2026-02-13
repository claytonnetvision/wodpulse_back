require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3001;
const { gerarAnaliseGemini } = require('./utils/gemini');
const socialRouter = require('./routes/social');
const challengeRoutes = require('./routes/challenges');

// --- Importando os middlewares no topo ---
const authenticateMiddleware = require('./routes/middleware/auth');
const { authenticateSuperAdmin } = require('./routes/middleware/superAdminAuth');

// Middleware CORS manual (mais robusto no Render)
app.use((req, res, next) => {
  const allowedOrigins = [
    'https://www.infrapower.com.br',
    'https://wodpulse-front-f2lo92fpz-robson-claytons-projects.vercel.app',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ];

  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin )) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'https://www.infrapower.com.br' );
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
});

app.options('*', cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect()
  .then(() => console.log('→ Conectado ao PostgreSQL (Neon)'))
  .catch(err => console.error('Erro ao conectar no banco:', err.stack));

app.use((req, res, next) => {
  if (req.url.includes('/api/challenges')) {
    console.log(`[INDEX DEBUG] Requisição recebida: ${req.method} ${req.url}`);
  }
  next();
});

setInterval(async () => {
  try {
    await pool.query('SELECT 1');
    console.log('[PING NEON] Sucesso: Banco mantido acordado - SELECT 1 executado');
  } catch (err) {
    console.error('[PING NEON] Falha ao manter banco acordado:', err.message);
  }
}, 4 * 60 * 1000);

app.get('/', (req, res) => {
  res.json({ 
    status: 'WODPulse Backend online', 
    time: new Date().toISOString() 
  });
});


// --- BLOCO DE REGISTRO DE ROTAS (VERSÃO FINAL CORRIGIDA) ---

const bodyProgressRouter = require('./routes/body-progress');

// 1. Rota de login do instrutor (pública)
app.use('/api/auth', require('./routes/auth'));

// 2. Rotas PÚBLICAS para o link do e-mail
app.use('/api/public/participants', require('./routes/public-participants'));
// A rota pública para body-progress agora é tratada aqui, sem proteção
app.get('/api/public/body-progress', bodyProgressRouter);

// 3. Rotas de Super Admin (protegidas)
app.use('/api/superadmin', authenticateSuperAdmin, require('./routes/superadmin'));

// 4. Rotas de Instrutor (protegidas)
app.use('/api/participants', authenticateMiddleware, require('./routes/participants'));
// A rota para criar/editar/deletar progresso corporal continua protegida
app.use('/api/body-progress', authenticateMiddleware, bodyProgressRouter);

// 5. Rotas de Sessões (protegidas)
const sessionsRouter = express.Router();
app.use('/api/sessions', authenticateMiddleware, sessionsRouter);

// 6. Rotas de Social e Challenges (lógica própria)
app.use('/api/social', socialRouter);
app.use('/api/challenges', challengeRoutes);

// --- FIM DO BLOCO DE REGISTRO ---



// --- FIM DO AJUSTE ---


// Novo endpoint para análise de progresso corporal (agora protegido)
app.post('/api/ai-analyze-body-progress', authenticateMiddleware, async (req, res) => {
  try {
    const { aluno, antes, depois } = req.body;

    if (!aluno || !antes || !depois) {
      return res.status(400).json({ error: 'Dados incompletos' });
    }

    const pesoDiff = (depois.measures.peso || 0) - (antes.measures.peso || 0);
    const cinturaDiff = (depois.measures['circ-cintura'] || 0) - (antes.measures['circ-cintura'] || 0);
    const abdomenDiff = (depois.measures['circ-abdomen'] || 0) - (antes.measures['circ-abdomen'] || 0);
    const dataAntes = new Date(antes.date).toLocaleDateString('pt-BR');
    const dataDepois = new Date(depois.date).toLocaleDateString('pt-BR');

    const prompt = `Você é um treinador físico experiente e técnico do WODPulse.

Analise a evolução corporal do aluno ${aluno.name} (${aluno.age} anos, gênero ${aluno.gender === 'M' ? 'masculino' : 'feminino'}).

Registro anterior: ${dataAntes}
Registro atual: ${dataDepois}

Principais mudanças medidas:
- Peso: ${pesoDiff > 0 ? '+' : ''}${pesoDiff.toFixed(1)} kg
- Cintura: ${cinturaDiff > 0 ? '+' : ''}${cinturaDiff.toFixed(1)} cm
- Abdômen: ${abdomenDiff > 0 ? '+' : ''}${abdomenDiff.toFixed(1)} cm

Você tem acesso às fotos de antes e depois (várias ângulos). Analise visualmente:
- Mudanças na definição muscular
- Redução/aumento de gordura (visceral e subcutânea)
- Postura, simetria, volume muscular
- Qualquer sinal de progresso ou estagnação

Forneça um relatório técnico e motivacional em português, com:
1. Resumo geral da evolução (recomposição, perda de gordura, ganho muscular etc.)
2. Análise detalhada das medidas e dobras
3. Análise visual das fotos (seja específico: "visível redução de gordura abdominal", "melhora na definição dos ombros" etc.)
4. Recomendações práticas para os próximos 30-60 dias (treino, nutrição, recuperação)
5. Tom positivo, encorajador e profissional

Use Markdown leve (**negrito**, listas). Máximo 600 palavras.`;

    const todasFotos = [...(antes.photos || []), ...(depois.photos || [])];
    const { analysis, model } = await gerarAnaliseGemini(prompt, todasFotos);
    res.json({ analysis, model });
  } catch (err) {
    console.error('[AI BODY PROGRESS ERROR]', err);
    res.status(500).json({ error: 'Erro ao gerar análise' });
  }
});

// --- ROTAS DE SESSIONS AGORA DENTRO DO sessionsRouter ---

sessionsRouter.post('/', async (req, res) => {
  const { class_name, date_start, date_end, duration_minutes, participantsData } = req.body;
  const boxId = req.boxId;

  console.log(`[SESSION] Dados recebidos para o Box ID: ${boxId}`, JSON.stringify(req.body, null, 2));

  if (!class_name || !date_start || !date_end) {
    return res.status(400).json({ error: 'Dados da sessão incompletos (class_name, date_start ou date_end)' });
  }

  if (!participantsData || !Array.isArray(participantsData)) {
    participantsData = [];
  }

  let durationSeconds = 0;
  try {
    const start = new Date(date_start);
    const end = new Date(date_end);
    if (!isNaN(start) && !isNaN(end) && end > start) {
      durationSeconds = Math.floor((end - start) / 1000);
    } else {
      durationSeconds = 0;
    }
  } catch (err) {
    durationSeconds = 0;
  }

  const isManualClass = class_name && (class_name.toLowerCase().includes('manual') || class_name === 'Aula Manual');

  if (isManualClass && durationSeconds < 240) {
    const minutes = Math.floor(durationSeconds / 60);
    const seconds = durationSeconds % 60;
    const durationStr = `${minutes}min${seconds.toString().padStart(2, '0')}s`;
    console.log(`[DISCARD] Aula manual curta descartada - duração: ${durationStr}`);
    return res.status(200).json({ success: false, skipped: true, reason: 'Aula com menos de 4 minutos – não registrada' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sessionResult = await client.query(
      `INSERT INTO sessions (box_id, class_name, date_start, date_end, duration_minutes, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING id`,
      [boxId, class_name, date_start, date_end, Number(duration_minutes) || null]
    );
    const sessionId = sessionResult.rows[0].id;

    for (const p of participantsData) {
      await client.query(
        `INSERT INTO session_participants (
          session_id, participant_id, queima_points, calories, vo2_time_seconds, epoc_estimated,
          real_resting_hr, avg_hr, max_hr_reached, created_at, min_gray, min_green, min_blue, 
          min_yellow, min_orange, min_red, min_zone2, min_zone3, min_zone4, min_zone5, 
          trimp_total, calories_total
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
        [
          sessionId, p.participantId, Number(p.queima_points) || 0, Number(p.calories) || 0,
          Number(p.vo2_time_seconds) || 0, Number(p.epoc_estimated) || 0, Number(p.real_resting_hr) || null,
          Number(p.avg_hr) || null, Number(p.max_hr_reached) || null, Number(p.min_gray) || 0,
          Number(p.min_green) || 0, Number(p.min_blue) || 0, Number(p.min_yellow) || 0,
          Number(p.min_orange) || 0, Number(p.min_red) || 0, Number(p.min_zone2) || 0,
          Number(p.min_zone3) || 0, Number(p.min_zone4) || 0, Number(p.min_zone5) || 0,
          Number(p.trimp_total) || 0, Number(p.calories_total) || 0
        ]
      );
    }
    await client.query('COMMIT');
    const { sendSummaryEmailsAfterClass } = require('./jobs/send-class-summary-email');
    sendSummaryEmailsAfterClass(sessionId).catch(err => console.error(`[EMAIL ASYNC] Falha: ${err.message || err}`));
    res.status(201).json({ success: true, sessionId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao salvar sessão:', err.stack);
    res.status(500).json({ error: 'Erro ao salvar sessão', details: err.message });
  } finally {
    client.release();
  }
});

sessionsRouter.get('/', async (req, res) => {
  const { start_date, end_date, participant_id, limit = 50 } = req.query;
  const boxId = req.boxId;
  let queryText = `
    SELECT s.id, s.class_name, s.date_start, s.date_end, s.duration_minutes, COUNT(sp.participant_id) AS participant_count
    FROM sessions s
    LEFT JOIN session_participants sp ON s.id = sp.session_id
    WHERE s.box_id = $1`;
  const params = [boxId];
  let paramIndex = 2;
  if (start_date) {
    queryText += ` AND s.date_start >= $${paramIndex++}`;
    params.push(start_date);
  }
  if (end_date) {
    queryText += ` AND s.date_end <= $${paramIndex++}`;
    params.push(end_date + ' 23:59:59');
  }
  if (participant_id) {
    queryText += ` AND EXISTS (SELECT 1 FROM session_participants sp2 WHERE sp2.session_id = s.id AND sp2.participant_id = $${paramIndex++})`;
    params.push(Number(participant_id));
  }
  queryText += ` GROUP BY s.id ORDER BY s.date_start DESC LIMIT $${paramIndex}`;
  params.push(Number(limit) || 50);
  try {
    const result = await pool.query(queryText, params);
    res.json({ sessions: result.rows });
  } catch (err) {
    console.error('Erro ao listar sessões:', err.stack);
    res.status(500).json({ error: 'Erro interno ao buscar sessões' });
  }
});

sessionsRouter.get('/:id', async (req, res) => {
  const sessionId = req.params.id;
  const boxId = req.boxId;
  try {
    const sessionRes = await pool.query(`SELECT id, class_name, date_start, date_end, duration_minutes FROM sessions WHERE id = $1 AND box_id = $2`, [sessionId, boxId]);
    if (sessionRes.rowCount === 0) {
      return res.status(404).json({ error: 'Sessão não encontrada' });
    }
    const participantsRes = await pool.query(`
      SELECT p.id, p.name, p.photo, p.preferred_layout, sp.calories_total, sp.queima_points, sp.vo2_time_seconds,
             sp.min_red, sp.avg_hr, sp.max_hr_reached, sp.trimp_total, sp.epoc_estimated, sp.real_resting_hr
      FROM session_participants sp
      JOIN participants p ON p.id = sp.participant_id
      WHERE sp.session_id = $1`, [sessionId]);
    const participants = participantsRes.rows.map(row => ({ ...row, photo_base64: row.photo || null, photo: undefined }));
    res.json({ session: sessionRes.rows[0], participants });
  } catch (err) {
    console.error('Erro ao buscar detalhes da sessão:', err.stack);
    res.status(500).json({ error: 'Erro ao buscar sessão' });
  }
});

sessionsRouter.get('/ranking-semanal', async (req, res) => {
    const { gender, metric = 'queima_points', limit = 10 } = req.query;
    const boxId = req.boxId;
    const today = new Date();
    const dayOfWeek = today.getDay();
    const diff = today.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
    const monday = new Date(today.setDate(diff));
    monday.setHours(0, 0, 0, 0);
    const nextMonday = new Date(monday);
    nextMonday.setDate(nextMonday.getDate() + 7);
    const mondayStr = monday.toISOString().split('T')[0];
    const nextMondayStr = nextMonday.toISOString().split('T')[0];
    let queryText = `
        SELECT p.id, p.name, p.gender, p.photo, p.preferred_layout,
               SUM(sp.queima_points) AS total_queima_points, SUM(sp.calories_total) AS total_calorias,
               SUM(sp.vo2_time_seconds) AS total_vo2_seconds, MAX(sp.max_hr_reached) AS max_hr_reached,
               SUM(sp.trimp_total) AS total_trimp
        FROM session_participants sp
        JOIN sessions s ON sp.session_id = s.id
        JOIN participants p ON sp.participant_id = p.id
        WHERE s.date_start >= $1 AND s.date_start < $2 AND s.box_id = $3`;
    const params = [mondayStr, nextMondayStr, boxId];
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
    queryText += ` GROUP BY p.id, p.name, p.gender, p.photo, p.preferred_layout ORDER BY ${orderBy} DESC LIMIT $${params.length + 1}`;
    params.push(Number(limit));
    try {
        const result = await pool.query(queryText, params);
        const rankings = result.rows.map(row => ({ ...row, photo_base64: row.photo || null, photo: undefined }));
        res.json({ week_start: mondayStr, rankings });
    } catch (err) {
        console.error('Erro no ranking semanal:', err.stack);
        res.status(500).json({ error: 'Erro ao calcular ranking', details: err.message });
    }
});

// Rota de deleção agora está no sessionsRouter
sessionsRouter.delete('/:id', async (req, res) => {
    const { id } = req.params;
    const boxId = req.boxId;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const sessionCheck = await client.query('SELECT id FROM sessions WHERE id = $1 AND box_id = $2', [id, boxId]);
        if (sessionCheck.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Sessão não encontrada ou não pertence a este box' });
        }
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

// As rotas de ranking e histórico agora também são protegidas pelo middleware
app.get('/api/participants/ranking-acumulado', authenticateMiddleware, async (req, res) => {
    const { alunoId, inicio, fim } = req.query;
    const boxId = req.boxId;
    let query = `
        SELECT p.name AS aluno, COUNT(DISTINCT sp.session_id) AS qtd_aulas, SUM(sp.calories_total) AS total_calorias,
               SUM(sp.vo2_time_seconds) AS total_vo2_seg, AVG(sp.avg_hr) AS fc_media_geral, MAX(sp.max_hr_reached) AS fc_max_geral,
               SUM(sp.min_red) AS total_tempo_vermelho_min, SUM(sp.queima_points) AS total_queima_points,
               AVG(sp.trimp_total) AS trimp_medio, AVG(sp.epoc_estimated) AS epoc_medio, SUM(sp.min_zone2) AS total_min_zone2,
               SUM(sp.min_zone3) AS total_min_zone3, SUM(sp.min_zone4) AS total_min_zone4, SUM(sp.min_zone5) AS total_min_zone5
        FROM participants p
        LEFT JOIN session_participants sp ON sp.participant_id = p.id
        LEFT JOIN sessions s ON s.id = sp.session_id
        WHERE p.box_id = $1`;
    const params = [boxId];
    let paramIndex = 2;
    if (alunoId) {
        query += ` AND p.id = $${paramIndex++}`;
        params.push(alunoId);
    }
    if (inicio) {
        query += ` AND s.date_start >= $${paramIndex++}`;
        params.push(inicio);
    }
    if (fim) {
        query += ` AND s.date_start <= $${paramIndex++}`;
        params.push(fim);
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

app.get('/api/sessions/historico', authenticateMiddleware, async (req, res) => {
    const { alunoId, inicio, fim } = req.query;
    const boxId = req.boxId;
    let query = `
        SELECT s.id AS id_sessao, s.class_name, s.date_start, s.date_end, s.duration_minutes, p.name AS aluno,
               sp.calories_total, sp.vo2_time_seconds, sp.avg_hr, sp.max_hr_reached, sp.min_red, sp.queima_points,
               sp.trimp_total, sp.epoc_estimated, sp.real_resting_hr, sp.min_zone2, sp.min_zone3, sp.min_zone4,
               sp.min_zone5, sp.ia_comment
        FROM sessions s
        JOIN session_participants sp ON sp.session_id = s.id
        JOIN participants p ON p.id = sp.participant_id
        WHERE s.box_id = $1`;
    const params = [boxId];
    let paramIndex = 2;
    if (alunoId) {
        query += ` AND p.id = $${paramIndex++}`;
        params.push(alunoId);
    }
    if (inicio) {
        query += ` AND s.date_start >= $${paramIndex++}`;
        params.push(inicio);
    }
    if (fim) {
        query += ` AND s.date_start <= $${paramIndex++}`;
        params.push(fim);
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

// Rotas de teste do Gemini (mantidas como estão)
app.get('/test-gemini', async (req, res) => {
  console.log('[TEST-GEMINI] Rota acessada - iniciando teste');

  try {
    console.log('[TEST-GEMINI] Verificando se a chave GEMINI_API_KEY existe no environment...');
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY não encontrada no environment variables');
    }
    console.log('[TEST-GEMINI] Chave encontrada (não mostro o valor por segurança)');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

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
        } )
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

app.get('/test-gemini-lite', async (req, res) => {
  console.log('[TEST-GEMINI-LITE] Rota acessada - testando gemini-2.5-flash-lite');

  try {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY não encontrada');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

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
        } )
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

app.get('/test-gemini-email-prompt', async (req, res) => {
  console.log('[TEST-GEMINI-EMAIL] Rota acessada - simulando prompt completo do e-mail');

  try {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY não encontrada');
    }

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
    const timeoutId = setTimeout(() => controller.abort(), 45000);

   // ... continuação do arquivo index.js

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
              text: `Você é um treinador experiente de CrossFit, corrida e esportes. Analise esses dados da aula de hoje e do treino anterior e gere um comentário técnico, motivacional e positivo de 6 a 9 linhas completas. Destaque a duração da aula (${aulaDuracaoMin} minutos ) em relação à intensidade geral, tempo nas zonas 2, 3, 4 e 5, melhora ou piora no comparativo, recuperação e dê 1 ou 2 dicas práticas pro próximo treino. Use tom encorajador, linguagem simples e direta. Não corte o texto, escreva o comentário completo.

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

app.listen(port, () => {
  console.log(`Backend rodando → http://0.0.0.0:${port}` );
});

