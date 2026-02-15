const express = require("express");
const router = express.Router();

module.exports = function(pool) {
  // Middleware de Autenticação Interno (Cópia fiel do seu social.js)
  const validateDBSession = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];
    
    console.log('[CHALLENGE AUTH] Tentando autenticar sessão...');
    if (!token) {
      console.log('[CHALLENGE AUTH] Erro: Token não fornecido.');
      return res.status(401).json({ error: 'Token não fornecido' });
    }
    
    try {
      const result = await pool.query(`
        SELECT s.*, p.id as participant_id, p.name, p.box_id 
        FROM social_sessions s
        JOIN participants p ON s.participant_id = p.id
        WHERE s.session_token = $1 AND s.expires_at > NOW()
        LIMIT 1
      `, [token]);
      
      if (result.rows.length === 0) {
        console.log('[CHALLENGE AUTH] Erro: Sessão inválida ou expirada.');
        return res.status(401).json({ error: 'Sessão inválida' });
      }
      console.log(`[CHALLENGE AUTH] Sessão válida para participant_id: ${result.rows[0].participant_id}`);
      
      req.user = result.rows[0];
      next();
    } catch (err) {
      console.error('[CHALLENGE AUTH] Erro interno de autenticação:', err);
      res.status(500).json({ error: 'Erro de auth interno' });
    }
  };

  router.post("/create", validateDBSession, async (req, res) => {
    const { title, startDate, endDate, invitedParticipants } = req.body;
    const creatorId = req.user.participant_id;

    console.log(`[CHALLENGE DEBUG] Iniciando criação: "${title}" por usuário ${creatorId}`);

    if (!title || !startDate || !endDate || !invitedParticipants || invitedParticipants.length === 0) {
      console.log("[CHALLENGE DEBUG] Erro: Dados incompletos.");
      return res.status(400).json({ error: "Dados incompletos para criar o desafio." });
    }

    try {
      console.log("[CHALLENGE DEBUG] Inserindo na tabela challenges...");
      const newChallenge = await pool.query(
        "INSERT INTO challenges (creator_id, title, start_date, end_date, status) VALUES ($1, $2, $3, $4, 'pending') RETURNING id",
        [creatorId, title, startDate, endDate]
      );

      const challengeId = newChallenge.rows[0].id;
      console.log(`[CHALLENGE DEBUG] Desafio criado com ID: ${challengeId}`);

      console.log("[CHALLENGE DEBUG] Inserindo criador como participante...");
      await pool.query(
        "INSERT INTO challenge_participants (challenge_id, participant_id, status) VALUES ($1, $2, 'accepted')",
        [challengeId, creatorId]
      );

      console.log(`[CHALLENGE DEBUG] Convidando ${invitedParticipants.length} participantes...`);
      for (const pId of invitedParticipants) {
        await pool.query(
          "INSERT INTO challenge_participants (challenge_id, participant_id, status) VALUES ($1, $2, 'invited')",
          [challengeId, pId]
        );
      }

      console.log(`[CHALLENGE DEBUG] Desafio ${challengeId} criado com sucesso.`);
      res.status(201).json({ success: true, challengeId });
    } catch (err) {
      console.error("[CHALLENGE DEBUG] ERRO AO CRIAR DESAFIO:", err.message);
      res.status(500).json({ error: "Erro interno do servidor ao criar desafio: " + err.message });
    }
  });

  router.get("/top-calories", validateDBSession, async (req, res) => {
    const { days } = req.query;
    let interval = '1 day';
    if (days === '3') interval = '3 days';
    if (days === '7') interval = '7 days';

    console.log(`[CHALLENGE DEBUG] Buscando Top Calorias para os últimos ${interval}`);

    try {
      console.log("[CHALLENGE DEBUG] Executando query de ranking...");
      const result = await pool.query(
        `SELECT p.id, p.name, p.photo, SUM(sp.calories_total) as total_calories
         FROM session_participants sp
         JOIN sessions s ON sp.session_id = s.id
         JOIN participants p ON sp.participant_id = p.id
         WHERE s.date_start >= NOW() - INTERVAL '${interval}'
         GROUP BY p.id, p.name, p.photo
         ORDER BY total_calories DESC
         LIMIT 5`
      );
      console.log(`[CHALLENGE DEBUG] Ranking retornado: ${result.rows.length} registros.`);
      res.json(result.rows);
    } catch (err) {
      console.error("[CHALLENGE DEBUG] Erro ao buscar top calorias:", err.message);
      res.status(500).json({ error: "Erro ao buscar ranking: " + err.message });
    }
  });

  router.get("/my-challenges", validateDBSession, async (req, res) => {
    const userId = req.user.participant_id;
    console.log(`[CHALLENGE DEBUG] Buscando desafios para o usuário ${userId}`);
    try {
      const result = await pool.query(
        `SELECT c.*, cp.status as my_status 
         FROM challenges c 
         JOIN challenge_participants cp ON c.id = cp.challenge_id 
         WHERE cp.participant_id = $1 
         ORDER BY c.created_at DESC`,
        [userId]
      );
      console.log(`[CHALLENGE DEBUG] Desafios encontrados: ${result.rows.length}`);
      res.json(result.rows);
    } catch (err) {
      console.error("[CHALLENGE DEBUG] Erro ao buscar desafios:", err.message);
      res.status(500).json({ error: "Erro ao buscar desafios: " + err.message });
    }
  });

  router.get("/notifications", validateDBSession, async (req, res) => {
    const userId = req.user.participant_id;
    console.log(`[CHALLENGE DEBUG] Buscando notificações para o usuário ${userId}`);
    try {
      const result = await pool.query(
        `SELECT c.id as challenge_id, c.title, p.name as creator_name 
         FROM challenges c 
         JOIN challenge_participants cp ON c.id = cp.challenge_id 
         JOIN participants p ON c.creator_id = p.id 
         WHERE cp.participant_id = $1 AND cp.status = 'invited'`,
        [userId]
      );
      console.log(`[CHALLENGE DEBUG] Notificações encontradas: ${result.rows.length}`);
      res.json(result.rows);
    } catch (err) {
      console.error("[CHALLENGE DEBUG] Erro ao buscar notificações:", err.message);
      res.status(500).json({ error: "Erro ao buscar notificações: " + err.message });
    }
  });

  // SUBSTITUA SUA ROTA /:id/respond POR ESTA
router.post("/:id/respond", validateDBSession, async (req, res) => {
    const { action } = req.body;
    const challengeId = req.params.id;
    const userId = req.user.participant_id;
    console.log(`[CHALLENGE DEBUG] Respondendo ao desafio ${challengeId}: ${action}`);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Atualiza o status do participante (accepted ou declined)
        await client.query(
            "UPDATE challenge_participants SET status = $1 WHERE challenge_id = $2 AND participant_id = $3",
            [action, challengeId, userId]
        );
        console.log("[CHALLENGE DEBUG] Resposta do participante salva com sucesso.");

        // Se a ação for 'accepted', verifica se o desafio pode iniciar
        if (action === 'accepted') {
            console.log("[CHALLENGE DEBUG] Verificando se todos os participantes aceitaram...");
            const participantsStatus = await client.query(
                "SELECT status FROM challenge_participants WHERE challenge_id = $1",
                [challengeId]
            );

            // Verifica se existe algum participante que ainda não aceitou (está 'invited')
            const allAccepted = participantsStatus.rows.every(p => p.status === 'accepted');

            if (allAccepted) {
                console.log(`[CHALLENGE DEBUG] Todos aceitaram! Iniciando desafio ${challengeId} automaticamente.`);
                await client.query(
                    "UPDATE challenges SET status = 'active' WHERE id = $1 AND status = 'pending'",
                    [challengeId]
                );
            } else {
                console.log("[CHALLENGE DEBUG] Ainda há participantes pendentes.");
            }
        }

        await client.query('COMMIT');
        res.json({ success: true });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("[CHALLENGE DEBUG] Erro ao responder convite:", err.message);
        res.status(500).json({ error: "Erro ao responder convite: " + err.message });
    } finally {
        client.release();
    }
});


  router.post("/:id/start", validateDBSession, async (req, res) => {
    const challengeId = req.params.id;
    const userId = req.user.participant_id;
    console.log(`[CHALLENGE DEBUG] Iniciando desafio ${challengeId} pelo usuário ${userId}`);

    try {
      const check = await pool.query("SELECT creator_id FROM challenges WHERE id = $1", [challengeId]);
      if (check.rows.length === 0) return res.status(404).json({ error: "Desafio não encontrado." });
      
      if (check.rows[0].creator_id !== userId) {
        console.log("[CHALLENGE DEBUG] Erro: Apenas o criador pode iniciar.");
        return res.status(403).json({ error: "Apenas o criador pode iniciar o desafio." });
      }

      await pool.query("UPDATE challenges SET status = 'active' WHERE id = $1", [challengeId]);
      console.log("[CHALLENGE DEBUG] Desafio ativado com sucesso.");
      res.json({ success: true });
    } catch (err) {
      console.error("[CHALLENGE DEBUG] Erro ao iniciar desafio:", err.message);
      res.status(500).json({ error: "Erro ao iniciar desafio: " + err.message });
    }
  });

  router.delete("/:id", validateDBSession, async (req, res) => {
    const challengeId = req.params.id;
    const userId = req.user.participant_id;
    console.log(`[CHALLENGE DEBUG] Excluindo desafio ${challengeId} pelo usuário ${userId}`);

    try {
      const check = await pool.query("SELECT creator_id FROM challenges WHERE id = $1", [challengeId]);
      if (check.rows.length === 0) return res.status(404).json({ error: "Desafio não encontrado." });

      if (check.rows[0].creator_id !== userId) {
        console.log("[CHALLENGE DEBUG] Erro: Apenas o criador pode excluir.");
        return res.status(403).json({ error: "Apenas o criador pode excluir o desafio." });
      }

      await pool.query("DELETE FROM challenges WHERE id = $1", [challengeId]);
      console.log("[CHALLENGE DEBUG] Desafio excluído com sucesso.");
      res.json({ success: true });
    } catch (err) {
      console.error("[CHALLENGE DEBUG] Erro ao excluir desafio:", err.message);
      res.status(500).json({ error: "Erro ao excluir desafio: " + err.message });
    }
  });
// ADICIONE ESTA NOVA ROTA AO FINAL DO SEU challenges.js
router.post("/:id/add-participants", validateDBSession, async (req, res) => {
    const challengeId = req.params.id;
    const creatorId = req.user.participant_id;
    const { newParticipantIds } = req.body; // Espera um array de IDs

    if (!newParticipantIds || !Array.isArray(newParticipantIds) || newParticipantIds.length === 0) {
        return res.status(400).json({ error: "É necessário fornecer um array de IDs de novos participantes." });
    }

    console.log(`[CHALLENGE DEBUG] Adicionando ${newParticipantIds.length} novos participantes ao desafio ${challengeId}`);

    try {
        // 1. Verifica se o usuário é o criador do desafio
        const challengeRes = await pool.query("SELECT creator_id FROM challenges WHERE id = $1", [challengeId]);
        if (challengeRes.rows.length === 0) {
            return res.status(404).json({ error: "Desafio não encontrado." });
        }
        if (challengeRes.rows[0].creator_id !== creatorId) {
            return res.status(403).json({ error: "Apenas o criador pode adicionar participantes." });
        }

        // 2. Adiciona os novos participantes com status 'invited'
        // A cláusula ON CONFLICT IGNORE evita erros se o usuário já estiver no desafio
        for (const pId of newParticipantIds) {
            await pool.query(
                `INSERT INTO challenge_participants (challenge_id, participant_id, status) 
                 VALUES ($1, $2, 'invited')
                 ON CONFLICT (challenge_id, participant_id) DO NOTHING`,
                [challengeId, pId]
            );
        }

        console.log(`[CHALLENGE DEBUG] Participantes adicionados com sucesso ao desafio ${challengeId}.`);
        res.status(200).json({ success: true, message: "Convites enviados aos novos participantes." });

    } catch (err) {
        console.error("[CHALLENGE DEBUG] Erro ao adicionar participantes:", err.message);
        res.status(500).json({ error: "Erro interno ao adicionar participantes." });
    }
});

  router.get("/:id/ranking", validateDBSession, async (req, res) => {
    const challengeId = req.params.id;
    console.log(`[CHALLENGE DEBUG] Obtendo ranking do desafio ${challengeId}`);
    try {
      const challenge = await pool.query("SELECT * FROM challenges WHERE id = $1", [challengeId]);
      if (challenge.rows.length === 0) return res.status(404).json({ error: "Desafio não encontrado." });

      const participants = await pool.query(
        `SELECT p.id, p.name, p.photo, cp.status 
         FROM challenge_participants cp 
         JOIN participants p ON cp.participant_id = p.id 
         WHERE cp.challenge_id = $1 AND cp.status = 'accepted'`,
        [challengeId]
      );

      const participantIds = participants.rows.map(p => p.id);

      let rankingStats = [];
      if (participantIds.length > 0) {
        const statsResult = await pool.query(
          `SELECT sp.participant_id as id, SUM(sp.calories_total) as total_calories
           FROM session_participants sp
           JOIN sessions s ON sp.session_id = s.id
           WHERE sp.participant_id = ANY($1::int[]) AND s.date_start BETWEEN $2 AND $3
           GROUP BY sp.participant_id`,
          [participantIds, challenge.rows[0].start_date, challenge.rows[0].end_date]
        );
        rankingStats = statsResult.rows;
      }

      const ranking = participants.rows.map(p => {
        const stats = rankingStats.find(s => s.id === p.id);
        return {
          id: p.id,
          name: p.name,
          photo: p.photo,
          total_calories: parseFloat(stats?.total_calories || 0)
        };
      });

      ranking.sort((a, b) => b.total_calories - a.total_calories);
      console.log(`[CHALLENGE DEBUG] Ranking calculado para ${ranking.length} participantes.`);
      res.json({ challenge: challenge.rows[0], ranking });
    } catch (err) {
      console.error("[CHALLENGE DEBUG] Erro ao obter ranking:", err.message);
      res.status(500).json({ error: "Erro ao obter ranking: " + err.message });
    }
  });

  return router;
};
