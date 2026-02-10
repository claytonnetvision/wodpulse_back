const express = require("express");
const router = express.Router();
const pool = require("../db"); // Assumindo que seu pool de conexão está em ../db.js
const jwt = require("jsonwebtoken");

// Middleware para verificar o token JWT
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (token == null) return res.sendStatus(401); // Se não houver token, não autorizado

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403); // Token inválido
    req.user = user;
    next();
  });
};

// Rota para criar um novo desafio
router.post("/create", authenticateToken, async (req, res) => {
  const { title, startDate, endDate, invitedParticipants } = req.body;
  const creatorId = req.user.id; // ID do usuário logado

  if (!title || !startDate || !endDate || !invitedParticipants || invitedParticipants.length === 0) {
    return res.status(400).json({ error: "Dados incompletos para criar o desafio." });
  }

  try {
    // 1. Criar o desafio principal
    const newChallenge = await pool.query(
      "INSERT INTO challenges (creator_id, title, start_date, end_date) VALUES ($1, $2, $3, $4) RETURNING *",
      [creatorId, title, startDate, endDate]
    );
const challengeId = newChallenge.rows[0].id;

    // 2. Adicionar o criador como participante aceito
    await pool.query(
      "INSERT INTO challenge_participants (challenge_id, participant_id, status) VALUES ($1, $2, 'accepted')",
      [challengeId, creatorId]
    );

    // 3. Adicionar os participantes convidados
    for (const participantId of invitedParticipants) {
      // Verificar se o participante já está em um desafio ativo no mesmo período
      const existingChallenge = await pool.query(
        `SELECT c.id FROM challenges c
         JOIN challenge_participants cp ON c.id = cp.challenge_id
         WHERE cp.participant_id = $1
         AND c.status = 'active'
         AND (c.start_date, c.end_date) OVERLAPS ($2::timestamp, $3::timestamp)`, // Verifica sobreposição de datas
        [participantId, startDate, endDate]
      );

      if (existingChallenge.rows.length > 0) {
        // Se já estiver em um desafio, não convida e pode logar ou retornar um aviso
        console.warn(`Participante ${participantId} já está em um desafio ativo no período.`);
        // Opcional: retornar um erro específico ou apenas ignorar este participante
        continue;
      }

      await pool.query(
        "INSERT INTO challenge_participants (challenge_id, participant_id, status) VALUES ($1, $2, 'invited')",
        [challengeId, participantId]
      );
      // TODO: Enviar notificação para o participante convidado
    }

    res.status(201).json({ message: "Desafio criado com sucesso!", challenge: newChallenge.rows[0] });
  } catch (err) {
    console.error("Erro ao criar desafio:", err);
    res.status(500).json({ error: "Erro interno do servidor ao criar desafio." });
  }
});

// Rota para iniciar um desafio (mudar status para 'active')
router.post("/:id/start", authenticateToken, async (req, res) => {
  const challengeId = req.params.id;
  const userId = req.user.id;

  try {
    const challenge = await pool.query("SELECT * FROM challenges WHERE id = $1 AND creator_id = $2", [challengeId, userId]);

    if (challenge.rows.length === 0) {
      return res.status(404).json({ error: "Desafio não encontrado ou você não é o criador." });
    }

    if (challenge.rows[0].status !== 'pending') {
      return res.status(400).json({ error: "Desafio já foi iniciado ou finalizado." });
    }

    await pool.query("UPDATE challenges SET status = 'active', start_date = NOW() WHERE id = $1", [challengeId]);
    res.json({ message: "Desafio iniciado com sucesso!" });
  } catch (err) {
    console.error("Erro ao iniciar desafio:", err);
    res.status(500).json({ error: "Erro interno do servidor ao iniciar desafio." });
  }
});

// Rota para excluir um desafio
router.delete("/:id", authenticateToken, async (req, res) => {
  const challengeId = req.params.id;
  const userId = req.user.id;

  try {
    const challenge = await pool.query("SELECT * FROM challenges WHERE id = $1 AND creator_id = $2", [challengeId, userId]);

    if (challenge.rows.length === 0) {
      return res.status(404).json({ error: "Desafio não encontrado ou você não é o criador." });
    }

    // CASCADE DELETE na tabela challenge_participants será ativado
    await pool.query("DELETE FROM challenges WHERE id = $1", [challengeId]);
    res.json({ message: "Desafio excluído com sucesso." });
  } catch (err) {
    console.error("Erro ao excluir desafio:", err);
    res.status(500).json({ error: "Erro interno do servidor ao excluir desafio." });
  }
});

// Rota para obter o ranking de um desafio específico
router.get("/:id/ranking", authenticateToken, async (req, res) => {
  const challengeId = req.params.id;

  try {
    const challenge = await pool.query("SELECT * FROM challenges WHERE id = $1", [challengeId]);
    if (challenge.rows.length === 0) {
      return res.status(404).json({ error: "Desafio não encontrado." });
    }

    const { start_date, end_date, status } = challenge.rows[0];

    // Se o desafio não estiver ativo ou finalizado, o ranking pode não ser calculado
    if (status === 'pending') {
        return res.status(200).json({ message: "Desafio ainda não iniciado.", ranking: [] });
    }

    // Calcular calorias dos participantes do desafio dentro do período
    const ranking = await pool.query(
      `SELECT p.id, p.name, p.photo,
              SUM(CASE WHEN s.date_start BETWEEN $2 AND $3 THEN sp.calories_total ELSE 0 END) AS total_calories
       FROM challenge_participants cp
       JOIN participants p ON cp.participant_id = p.id
       LEFT JOIN session_participants sp ON p.name = sp.aluno -- Usar p.name = sp.aluno para ligar com o histórico
       LEFT JOIN sessions s ON sp.session_id = s.id
       WHERE cp.challenge_id = $1 AND cp.status = 'accepted'
       GROUP BY p.id, p.name, p.photo
       ORDER BY total_calories DESC`,
      [challengeId, start_date, end_date]
    );

    res.json({ challenge: challenge.rows[0], ranking: ranking.rows });
  } catch (err) {
    console.error("Erro ao obter ranking do desafio:", err);
    res.status(500).json({ error: "Erro interno do servidor ao obter ranking do desafio." });
  }
});

// Rota para obter o ranking geral de calorias (Top 5)
router.get("/top-calories", authenticateToken, async (req, res) => {
  const { days } = req.query; // Pode ser '1', '3', '7' para 1 dia, 3 dias, 7 dias
  let dateFilter = '1 day';

  if (days === '3') dateFilter = '3 days';
  if (days === '7') dateFilter = '7 days';

  try {
    const topCalories = await pool.query(
      `SELECT p.id, p.name, p.photo, SUM(sp.calories_total) AS total_calories
       FROM session_participants sp
       JOIN sessions s ON sp.session_id = s.id
       JOIN participants p ON sp.aluno = p.name -- Ligação pelo nome do aluno
       WHERE s.date_start >= NOW() - INTERVAL '${dateFilter}'
       GROUP BY p.id, p.name, p.photo
       ORDER BY total_calories DESC
       LIMIT 5`
    );
    res.json(topCalories.rows);
  } catch (err) {
    console.error("Erro ao obter top calorias:", err);
    res.status(500).json({ error: "Erro interno do servidor ao obter top calorias." });
  }
});

module.exports = router;
