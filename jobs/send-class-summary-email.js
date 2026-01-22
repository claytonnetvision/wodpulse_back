// jobs/send-class-summary-email.js
const { Pool } = require('pg');
const nodemailer = require('nodemailer');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Configuração do transporter (lê do .env)
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'ns1234.hostgator.com',
  port: Number(process.env.EMAIL_PORT) || 465,
  secure: process.env.EMAIL_SECURE === 'true' || true, // true para porta 465
  auth: {
    user: process.env.EMAIL_USER || 'contato@cfv6.com.br',
    pass: process.env.EMAIL_PASS || 'Academiacross@12',
  },
  debug: true,          // liga logs detalhados (útil para debug, pode remover depois)
  logger: true,
});

/**
 * Envia e-mail de resumo personalizado para cada participante da sessão
 * @param {number} sessionId ID da sessão que acabou de terminar
 */
async function sendSummaryEmailsAfterClass(sessionId) {
  try {
    console.log(`[EMAIL JOB] Iniciando envio para sessão ${sessionId}`);

    // 1. Dados da sessão
    const sessionRes = await pool.query(`
      SELECT 
        id, class_name, date_start, date_end, duration_minutes
      FROM sessions 
      WHERE id = $1
    `, [sessionId]);

    if (sessionRes.rowCount === 0) {
      console.warn(`[EMAIL JOB] Sessão ${sessionId} não encontrada`);
      return;
    }

    const session = sessionRes.rows[0];
    const classDate = new Date(session.date_start).toLocaleDateString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric'
    });

    // 2. Participantes com e-mail válido
    const participantsRes = await pool.query(`
      SELECT 
        p.id,
        p.name,
        p.email,
        sp.calories_total AS calories,
        sp.queima_points,
        sp.vo2_time_seconds,
        sp.min_red,
        sp.avg_hr,
        sp.max_hr_reached,
        sp.trimp_total,
        sp.epoc_estimated,
        sp.real_resting_hr
      FROM session_participants sp
      JOIN participants p ON p.id = sp.participant_id
      WHERE sp.session_id = $1
        AND p.email IS NOT NULL 
        AND p.email != ''
        AND p.email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'
    `, [sessionId]);

    if (participantsRes.rowCount === 0) {
      console.log(`[EMAIL JOB] Nenhum participante com e-mail válido na sessão ${sessionId}`);
      return;
    }

    console.log(`[EMAIL JOB] Enviando para ${participantsRes.rowCount} alunos`);

    // 3. Enviar para cada aluno
    for (const aluno of participantsRes.rows) {
      // Busca o treino anterior (último antes dessa data)
      const prevRes = await pool.query(`
        SELECT 
          sp.calories_total AS calories,
          sp.queima_points,
          sp.vo2_time_seconds,
          sp.min_red,
          sp.max_hr_reached,
          sp.real_resting_hr,
          sp.trimp_total,
          sp.epoc_estimated
        FROM session_participants sp
        JOIN sessions s ON s.id = sp.session_id
        WHERE sp.participant_id = $1
          AND s.date_start < $2
        ORDER BY s.date_start DESC
        LIMIT 1
      `, [aluno.id, session.date_start]);

      const prev = prevRes.rows[0] || {
        calories: 0,
        queima_points: 0,
        vo2_time_seconds: 0,
        min_red: 0,
        max_hr_reached: 0,
        real_resting_hr: null,
        trimp_total: 0,
        epoc_estimated: 0
      };

      // Cálculo de percentual de melhora na FC máxima (exemplo de intensidade)
      const melhoraFcMaxPct = prev.max_hr_reached > 0 
        ? Math.round(((aluno.max_hr_reached - prev.max_hr_reached) / prev.max_hr_reached) * 100) 
        : 0;

      // Frase divertida: calorias equivalentes a pão de queijo (~80 kcal cada)
      const paesDeQueijo = Math.round(aluno.calories / 80);
      const caloriasDivertido = paesDeQueijo > 0 
        ? `Você queimou ${Math.round(aluno.calories)} kcal — equivalente a cerca de ${paesDeQueijo} pão de queijo! 🧀🔥` 
        : `Você queimou ${Math.round(aluno.calories)} kcal — continue firme pra queimar mais! 💪`;

      // === INTEGRAÇÃO GEMINI - AGORA COM TIMEOUT E ESPERA CORRETA ===
      let comentarioIA = 'Cada treino soma. Mantenha o foco e os números vão subir cada vez mais! 💪'; // fallback

      try {
        console.log(`[GEMINI] Iniciando avaliação para ${aluno.name}`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000); // Timeout de 8 segundos

        const geminiResponse = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              contents: [{
                parts: [{
                  text: `Você é um treinador experiente de CrossFit, corrida e esportes. Analise esses dados da aula de hoje e gere um comentário técnico, motivacional e positivo de 4 a 6 linhas. Destaque melhora, intensidade, recuperação e dê 1 dica prática pro próximo treino. Use tom encorajador e linguagem simples.

                  Dados de hoje:
                  - Calorias: ${Math.round(aluno.calories)} kcal
                  - Queima Points: ${Math.round(aluno.queima_points)}
                  - Zona Vermelha: ${Math.round(aluno.min_red)} min
                  - Tempo VO₂: ${Math.round(aluno.vo2_time_seconds / 60)} min
                  - TRIMP: ${Number(aluno.trimp_total || 0).toFixed(1)}
                  - EPOC: ${Math.round(aluno.epoc_estimated || 0)} kcal
                  - FC Média: ${Math.round(aluno.avg_hr || 0)} bpm
                  - FC Máxima: ${Math.round(aluno.max_hr_reached || 0)} bpm
                  - FC Repouso: ${Math.round(aluno.real_resting_hr || 0)} bpm

                  Dados do treino anterior:
                  - Calorias: ${Math.round(prev.calories)}
                  - Queima Points: ${Math.round(prev.queima_points)}
                  - Zona Vermelha: ${Math.round(prev.min_red)} min
                  - FC Máxima: ${Math.round(prev.max_hr_reached || 0)} bpm

                  Nome do aluno: ${aluno.name.split(' ')[0]}
                  Data da aula: ${classDate}`
                }]
              }],
              generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 150
              }
            })
          }
        );

        clearTimeout(timeoutId);

        if (!geminiResponse.ok) {
          throw new Error(`Gemini HTTP error: ${geminiResponse.status}`);
        }

        const json = await geminiResponse.json();

        if (json.candidates && json.candidates[0]?.content?.parts?.[0]?.text) {
          comentarioIA = json.candidates[0].content.parts[0].text.trim();
          console.log(`[GEMINI OK] Comentário gerado para ${aluno.name}: ${comentarioIA.substring(0, 100)}...`);
        } else {
          console.warn(`[GEMINI] Resposta inválida para ${aluno.name}`);
        }
      } catch (err) {
        console.error(`[GEMINI ERRO] Falha para ${aluno.name}: ${err.message}`);
        // Fallback mantido
      }

      // Agora monta o HTML DEPOIS de tentar o Gemini
      const html = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Seu resumo de treino - V6 WODPulse</title>
  <style>
    body { font-family: Arial, Helvetica, sans-serif; background: #f4f4f4; margin:0; padding:20px; color:#333; }
    .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
    .header { background: #FF9800; color: white; padding: 25px 20px; text-align: center; }
    .header h1 { margin: 0; font-size: 28px; }
    .content { padding: 25px; line-height: 1.6; }
    .highlight { color: #FF5722; font-weight: bold; }
    .metric { margin: 12px 0; font-size: 16px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th, td { padding: 12px; text-align: center; border: 1px solid #ddd; }
    th { background: #FF9800; color: white; }
    .comment { margin: 25px 0; padding: 20px; background: #fff8e1; border-left: 5px solid #FF9800; border-radius: 6px; }
    .metrics-info { margin: 25px 0; padding: 20px; background: #f0f8ff; border-left: 5px solid #2196F3; border-radius: 6px; }
    .metrics-info h4 { margin-top: 0; color: #2196F3; }
    .metrics-info ul { margin: 10px 0; padding-left: 20px; font-size: 14px; }
    .metrics-info li { margin-bottom: 8px; }
    .footer { text-align: center; padding: 20px; font-size: 14px; color: #777; border-top: 1px solid #eee; }
    .improvement { color: #4CAF50; font-weight: bold; }
    @media (max-width: 600px) { .container { margin: 10px; } }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>V6 WODPulse</h1>
      <p>Seu resumo da aula de ${classDate}</p>
    </div>

    <div class="content">
      <h2>Parabéns, ${aluno.name.split(' ')[0]}!</h2>
      <p>Você completou mais uma aula com garra. Veja como foi seu desempenho hoje:</p>

      <h3>Desempenho de hoje</h3>
      <div class="metric">🔥 Calorias queimadas: <span class="highlight">${Math.round(aluno.calories)} kcal</span></div>
      <div class="metric">${caloriasDivertido}</div>
      <div class="metric">Queima Points: <span class="highlight">${Math.round(aluno.queima_points)}</span></div>
      <div class="metric">Tempo na Zona Vermelha: <span class="highlight">${Math.round(aluno.min_red)} min</span></div>
      <div class="metric">Tempo em VO₂ Máx: <span class="highlight">${Math.round(aluno.vo2_time_seconds / 60)} min</span></div>
      <div class="metric">TRIMP Total: <span class="highlight">${Number(aluno.trimp_total || 0).toFixed(1)}</span></div>
      <div class="metric">EPOC Estimado: <span class="highlight">${Math.round(aluno.epoc_estimated || 0)} kcal</span></div>
      <div class="metric">FC Média: <span class="highlight">${Math.round(aluno.avg_hr || 0)} bpm</span></div>
      <div class="metric">FC Máxima atingida: <span class="highlight">${Math.round(aluno.max_hr_reached || 0)} bpm</span></div>
      <div class="metric">FC Repouso real: <span class="highlight">${Math.round(aluno.real_resting_hr || '--')} bpm</span></div>

      <h3>Comparativo com o treino anterior</h3>
      <table>
        <tr>
          <th>Métrica</th>
          <th>Hoje</th>
          <th>Anterior</th>
          <th>Diferença</th>
        </tr>
        <tr>
          <td>Calorias</td>
          <td>${Math.round(aluno.calories)}</td>
          <td>${Math.round(prev.calories)}</td>
          <td style="color: ${aluno.calories > prev.calories ? '#4CAF50' : '#f44336'}">
            ${aluno.calories > prev.calories ? '+' : ''}${Math.round(aluno.calories - prev.calories)}
          </td>
        </tr>
        <tr>
          <td>Queima Points</td>
          <td>${Math.round(aluno.queima_points)}</td>
          <td>${Math.round(prev.queima_points)}</td>
          <td style="color: ${aluno.queima_points > prev.queima_points ? '#4CAF50' : '#f44336'}">
            ${aluno.queima_points > prev.queima_points ? '+' : ''}${Math.round(aluno.queima_points - prev.queima_points)}
          </td>
        </tr>
        <tr>
          <td>Zona Vermelha (min)</td>
          <td>${Math.round(aluno.min_red)}</td>
          <td>${Math.round(prev.min_red)}</td>
          <td style="color: ${aluno.min_red > prev.min_red ? '#4CAF50' : '#f44336'}">
            ${aluno.min_red > prev.min_red ? '+' : ''}${Math.round(aluno.min_red - prev.min_red)}
          </td>
        </tr>
        <tr>
          <td>FC Máxima (bpm)</td>
          <td>${Math.round(aluno.max_hr_reached || 0)}</td>
          <td>${Math.round(prev.max_hr_reached || 0)}</td>
          <td style="color: ${aluno.max_hr_reached > prev.max_hr_reached ? '#4CAF50' : '#f44336'}">
            ${aluno.max_hr_reached > prev.max_hr_reached ? '+' : ''}${Math.round(aluno.max_hr_reached - prev.max_hr_reached)}
            ${melhoraFcMaxPct > 0 ? ` <span class="improvement">(+${melhoraFcMaxPct}% mais intenso!)</span>` : ''}
          </td>
        </tr>
        <tr>
          <td>FC Repouso (bpm)</td>
          <td>${Math.round(aluno.real_resting_hr || '--')}</td>
          <td>${Math.round(prev.real_resting_hr || '--')}</td>
          <td style="color: ${aluno.real_resting_hr && prev.real_resting_hr && aluno.real_resting_hr < prev.real_resting_hr ? '#4CAF50' : '#f44336'}">
            ${aluno.real_resting_hr && prev.real_resting_hr 
              ? (aluno.real_resting_hr < prev.real_resting_hr ? 'Melhorou (mais baixa)' : 'Aumentou') 
              : '--'}
          </td>
        </tr>
        <tr>
          <td>Tempo VO₂ (min)</td>
          <td>${Math.round(aluno.vo2_time_seconds / 60)}</td>
          <td>${Math.round(prev.vo2_time_seconds / 60)}</td>
          <td style="color: ${aluno.vo2_time_seconds > prev.vo2_time_seconds ? '#4CAF50' : '#f44336'}">
            ${aluno.vo2_time_seconds > prev.vo2_time_seconds ? '+' : ''}${Math.round((aluno.vo2_time_seconds - prev.vo2_time_seconds) / 60)}
          </td>
        </tr>
        <tr>
          <td>TRIMP Total</td>
          <td>${Number(aluno.trimp_total || 0).toFixed(1)}</td>
          <td>${Number(prev.trimp_total || 0).toFixed(1)}</td>
          <td style="color: ${aluno.trimp_total > prev.trimp_total ? '#4CAF50' : '#f44336'}">
            ${aluno.trimp_total > prev.trimp_total ? '+' : ''}${Number(aluno.trimp_total - prev.trimp_total).toFixed(1)}
          </td>
        </tr>
        <tr>
          <td>EPOC Estimado (kcal)</td>
          <td>${Math.round(aluno.epoc_estimated || 0)}</td>
          <td>${Math.round(prev.epoc_estimated || 0)}</td>
          <td style="color: ${aluno.epoc_estimated > prev.epoc_estimated ? '#4CAF50' : '#f44336'}">
            ${aluno.epoc_estimated > prev.epoc_estimated ? '+' : ''}${Math.round(aluno.epoc_estimated - prev.epoc_estimated)}
          </td>
        </tr>
      </table>

      <div class="comment">
        <strong>Comentário do treinador (com ajuda da IA):</strong><br><br>
        ${comentarioIA}
      </div>

      <div class="metrics-info">
        <h4>Entenda suas métricas</h4>
        <ul>
          <li><strong>EPOC (Dívida de Oxigênio Pós-Treino):</strong> É o consumo extra de oxigênio que seu corpo usa após o treino para se recuperar, queimando calorias mesmo em repouso. Benefício: Aumenta o metabolismo basal e melhora a recuperação muscular — quanto maior, melhor sua adaptação ao treino!</li>
          <li><strong>VO₂ Máx:</strong> Mede o tempo em que você atinge o pico de consumo de oxigênio (92%+ da FC máxima). Benefício: Treina o sistema aeróbico de elite, aumentando resistência e performance em WODs longos, como sprints ou AMRAPs.</li>
          <li><strong>Zona Vermelha:</strong> FC acima de 90% da máxima — zona anaeróbica intensa, onde você usa glicogênio rápido para explosões de energia. Benefício: Desenvolve fibras musculares rápidas, melhora velocidade e força máxima, ideal para CrossFit de alta intensidade (mas use com moderação para evitar fadiga).</li>
          <li><strong>Frequência Cardíaca (FC):</strong> Inclui FC média, máxima e repouso — monitora a intensidade e recuperação do coração. Benefício: Ajuda a personalizar treinos, otimizar zonas de queima de gordura e prevenir overtraining; FC repouso baixa indica bom condicionamento cardiovascular.</li>
          <li><strong>Queima Points:</strong> Pontos personalizados baseados em TRIMP e calorias, medindo a "carga de treino" total. Benefício: Motiva progresso semanal, rastreando eficiência energética e adaptação ao CrossFit — mais pontos = treino mais produtivo!</li>
        </ul>
      </div>
    </div>

    <div class="footer">
      V6 CrossFit • Belo Horizonte • contato@cfv6.com.br
    </div>
  </div>
</body>
</html>
      `;

      // Envio real (agora depois do await do Gemini)
      await transporter.sendMail({
        from: `"V6 WODPulse" <${process.env.EMAIL_USER}>`,
        to: aluno.email,
        subject: `V6 - Seu resumo do treino de ${classDate}`,
        html: html,
      });

      console.log(`[EMAIL OK] Enviado para ${aluno.name} (${aluno.email})`);
    }

    console.log(`[EMAIL JOB] Finalizado - ${participantsRes.rowCount} e-mails enviados para sessão ${sessionId}`);
  } catch (err) {
    console.error('[EMAIL JOB] Erro geral:', err.stack || err.message);
  }
}

module.exports = { sendSummaryEmailsAfterClass };