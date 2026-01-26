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

    // 1. Dados da sessão (inclui duration_minutes)
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

    // Duração da aula (já salva ou calculada como fallback)
    const aulaDuracaoMin = session.duration_minutes || 
      Math.round((new Date(session.date_end) - new Date(session.date_start)) / 60000);

    // 2. Participantes com e-mail válido (com zonas)
    const participantsRes = await pool.query(`
      SELECT 
        p.id,
        p.name,
        p.email,
        sp.calories_total AS calories,
        sp.queima_points,
        sp.vo2_time_seconds,
        sp.min_red,
        sp.min_zone2,
        sp.min_zone3,
        sp.min_zone4,
        sp.min_zone5,
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

    // ADIÇÃO PARA DEBUG: Verifica se a chave Gemini existe antes de tentar usar
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY.trim() === '') {
      console.error('[GEMINI DEBUG] GEMINI_API_KEY NÃO ESTÁ DEFINIDA ou está vazia no ambiente');
    }

    // 3. Enviar para cada aluno
    for (const aluno of participantsRes.rows) {
      // Busca o treino anterior
      const prevRes = await pool.query(`
        SELECT 
          sp.calories_total AS calories,
          sp.queima_points,
          sp.vo2_time_seconds,
          sp.min_red,
          sp.min_zone2,
          sp.min_zone3,
          sp.min_zone4,
          sp.min_zone5,
          sp.avg_hr,
          sp.max_hr_reached,
          sp.trimp_total,
          sp.epoc_estimated,
          sp.real_resting_hr
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
        min_zone2: 0,
        min_zone3: 0,
        min_zone4: 0,
        min_zone5: 0,
        avg_hr: 0,
        max_hr_reached: 0,
        trimp_total: 0,
        epoc_estimated: 0,
        real_resting_hr: null
      };

      // Cálculo de percentual de melhora na FC máxima
      const melhoraFcMaxPct = prev.max_hr_reached > 0 
        ? Math.round(((aluno.max_hr_reached - prev.max_hr_reached) / prev.max_hr_reached) * 100) 
        : 0;

      // Frase divertida sobre calorias
      const paesDeQueijo = Math.round(aluno.calories / 80);
      const caloriasDivertido = paesDeQueijo > 0 
        ? `Você queimou ${Math.round(aluno.calories)} kcal — equivalente a cerca de ${paesDeQueijo} pão de queijo! 🧀🔥` 
        : `Você queimou ${Math.round(aluno.calories)} kcal — continue firme pra queimar mais! 💪`;

      // === INTEGRAÇÃO GEMINI (prompt atualizado com duração da aula) ===
      let comentarioIA = 'Cada treino soma. Mantenha o foco e os números vão subir cada vez mais! 💪'; // fallback

      try {
        console.log(`[GEMINI] Iniciando avaliação para ${aluno.name} (session ${sessionId})`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // ADIÇÃO: Aumentado para 30 segundos

        // ADIÇÃO PARA DEBUG
        console.log(`[GEMINI DEBUG] Chave Gemini presente? ${!!process.env.GEMINI_API_KEY}`);

        const geminiResponse = await fetch(
`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
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

        // ADIÇÃO PARA DEBUG: Mostra o status HTTP
        console.log(`[GEMINI DEBUG] Status HTTP: ${geminiResponse.status}`);

        if (!geminiResponse.ok) {
          const errorText = await geminiResponse.text();
          console.error(`[GEMINI ERRO] HTTP ${geminiResponse.status}: ${errorText}`);
          throw new Error(`Gemini retornou erro HTTP ${geminiResponse.status}: ${errorText}`);
        }

        const json = await geminiResponse.json();

        if (json.candidates && json.candidates[0]?.content?.parts?.[0]?.text) {
          comentarioIA = json.candidates[0].content.parts[0].text.trim();
          console.log(`[GEMINI OK] Comentário gerado para ${aluno.name} (tamanho: ${comentarioIA.length} chars)`);
        } else {
          console.warn(`[GEMINI] Resposta sem candidates/text válido para ${aluno.name} - usando fallback`);
        }
      } catch (err) {
        console.error(`[GEMINI ERRO] Falha para ${aluno.name}: ${err.message}`);
        if (err.name === 'AbortError') {
          console.error('[GEMINI ERRO] Timeout após 30 segundos');
        }
      }

      // Monta o HTML com duração da aula e novas zonas
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

      <h3>Duração da Aula</h3>
      <div class="metric">Tempo total: <span class="highlight">${aulaDuracaoMin} minutos</span></div>

      <h3>Desempenho de hoje</h3>
      <div class="metric">🔥 Calorias queimadas: <span class="highlight">${Math.round(aluno.calories)} kcal</span></div>
      <div class="metric">${caloriasDivertido}</div>
      <div class="metric">Queima Points: <span class="highlight">${Math.round(aluno.queima_points)}</span></div>

      <!-- Tempos por zona -->
      <div class="metric">Zona 2 (60-70%): <span class="highlight">${Math.round(aluno.min_zone2)} min</span></div>
      <div class="metric">Zona 3 (70-80%): <span class="highlight">${Math.round(aluno.min_zone3)} min</span></div>
      <div class="metric">Zona 4 (80-90%): <span class="highlight">${Math.round(aluno.min_zone4)} min</span></div>
      <div class="metric">Zona 5 (>90%): <span class="highlight">${Math.round(aluno.min_zone5)} min</span></div>

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
          <td>Zona 2 (60-70%)</td>
          <td>${Math.round(aluno.min_zone2)}</td>
          <td>${Math.round(prev.min_zone2)}</td>
          <td style="color: ${aluno.min_zone2 > prev.min_zone2 ? '#4CAF50' : '#f44336'}">
            ${aluno.min_zone2 > prev.min_zone2 ? '+' : ''}${Math.round(aluno.min_zone2 - prev.min_zone2)}
          </td>
        </tr>
        <tr>
          <td>Zona 3 (70-80%)</td>
          <td>${Math.round(aluno.min_zone3)}</td>
          <td>${Math.round(prev.min_zone3)}</td>
          <td style="color: ${aluno.min_zone3 > prev.min_zone3 ? '#4CAF50' : '#f44336'}">
            ${aluno.min_zone3 > prev.min_zone3 ? '+' : ''}${Math.round(aluno.min_zone3 - prev.min_zone3)}
          </td>
        </tr>
        <tr>
          <td>Zona 4 (80-90%)</td>
          <td>${Math.round(aluno.min_zone4)}</td>
          <td>${Math.round(prev.min_zone4)}</td>
          <td style="color: ${aluno.min_zone4 > prev.min_zone4 ? '#4CAF50' : '#f44336'}">
            ${aluno.min_zone4 > prev.min_zone4 ? '+' : ''}${Math.round(aluno.min_zone4 - prev.min_zone4)}
          </td>
        </tr>
        <tr>
          <td>Zona 5 (>90%)</td>
          <td>${Math.round(aluno.min_zone5)}</td>
          <td>${Math.round(prev.min_zone5)}</td>
          <td style="color: ${aluno.min_zone5 > prev.min_zone5 ? '#4CAF50' : '#f44336'}">
            ${aluno.min_zone5 > prev.min_zone5 ? '+' : ''}${Math.round(aluno.min_zone5 - prev.min_zone5)}
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
        <h4>Entenda suas zonas de treinamento</h4>
        <ul>
          <li><strong>Zona 2 (60-70% FCmáx):</strong> Aeróbica leve — ótima para construir base cardiovascular, queima gordura e recuperação ativa.</li>
          <li><strong>Zona 3 (70-80% FCmáx):</strong> Aeróbica moderada — melhora resistência e eficiência cardíaca, ideal para treinos longos e WODs de ritmo constante.</li>
          <li><strong>Zona 4 (80-90% FCmáx):</strong> Limiar anaeróbico — aumenta capacidade de sustentar alta intensidade, essencial para melhorar performance em AMRAPs e sprints.</li>
          <li><strong>Zona 5 (>90% FCmáx):</strong> Máxima/VO2 — treina potência anaeróbica e VO2 máximo, mas use com moderação para evitar fadiga excessiva.</li>
          <li><strong>TRIMP / EPOC:</strong> Medem carga total do treino e recuperação pós-treino — quanto maior, maior o estímulo e benefício a longo prazo.</li>
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

      // Envio real
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