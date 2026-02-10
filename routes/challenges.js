const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");

module.exports = function(pool) {
  const authenticateToken = (req, res, next) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];
    if (token == null) return res.sendStatus(401);

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
      if (err) return res.sendStatus(403);
      req.user = user;
      next();
    });
  };

  router.post("/create", authenticateToken, async (req, res) => {
    const { title, startDate, endDate, invitedParticipants } = req.body;
    const creatorId = req.user.id;

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

  router.get("/top-calories", authenticateToken, async (req, res) => {
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

  router.get("/my-challenges", authenticateToken, async (req, res) => {
    const userId = req.user.id;
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

  router.get("/notifications", authenticateToken, async (req, res) => {
    const userId = req.user.id;
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

  router.post("/:id/respond", authenticateToken, async (req, res) => {
    const { action } = req.body;
    const challengeId = req.params.id;
    const userId = req.user.id;
    console.log(`[CHALLENGE DEBUG] Respondendo ao desafio ${challengeId}: ${action}`);

    try {
      await pool.query(
        "UPDATE challenge_participants SET status = $1 WHERE challenge_id = $2 AND participant_id = $3",
        [action, challengeId, userId]
      );
      console.log("[CHALLENGE DEBUG] Resposta salva com sucesso.");
      res.json({ success: true });
    } catch (err) {
      console.error("[CHALLENGE DEBUG] Erro ao responder convite:", err.message);
      res.status(500).json({ error: "Erro ao responder convite: " + err.message });
    }
  });

  router.post("/:id/start", authenticateToken, async (req, res) => {
    const challengeId = req.params.id;
    const userId = req.user.id;
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

  router.delete("/:id", authenticateToken, async (req, res) => {
    const challengeId = req.params.id;
    const userId = req.user.id;
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

  router.get("/:id/ranking", authenticateToken, async (req, res) => {
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

      const ranking = [];
      for (const p of participants.rows) {
        const stats = await pool.query(
          `SELECT SUM(sp.calories_total) as total_calories 
           FROM session_participants sp 
           JOIN sessions s ON sp.session_id = s.id 
           WHERE sp.participant_id = $1 AND s.date_start BETWEEN $2 AND $3`,
          [p.id, challenge.rows[0].start_date, challenge.rows[0].end_date]
        );
        ranking.push({
          id: p.id,
          name: p.name,
          photo: p.photo,
          total_calories: parseFloat(stats.rows[0].total_calories) || 0
        });
      }

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
