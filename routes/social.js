const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const validateDBSession = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });
  try {
    const result = await pool.query(`
      SELECT s.*, p.id as participant_id, p.name, p.box_id 
      FROM social_sessions s
      JOIN participants p ON s.participant_id = p.id
      WHERE s.session_token = $1 AND s.expires_at > NOW()
      LIMIT 1
    `, [token]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Sessão inválida' });
    req.user = result.rows[0];
    next();
  } catch (err) {
    res.status(500).json({ error: 'Erro de auth' });
  }
};

router.post('/login', async (req, res) => {
  const { email } = req.body;
  try {
    const userRes = await pool.query('SELECT id FROM participants WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'Não encontrado' });
    const participantId = userRes.rows[0].id;
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    await pool.query('INSERT INTO social_sessions (participant_id, session_token, expires_at) VALUES ($1, $2, $3)', [participantId, sessionToken, expiresAt]);
    res.json({ success: true, token: sessionToken, studentId: participantId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/profile', validateDBSession, async (req, res) => {
  try {
    // Busca foto separadamente se necessário para evitar payloads gigantes
    const userRes = await pool.query('SELECT id, name, photo, box_id FROM participants WHERE id = $1', [req.user.participant_id]);
    const user = userRes.rows[0];
    
    const statsRes = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM social_challenges WHERE creator_id = $1 OR opponent_id = $1) as challenges,
        (SELECT COUNT(*) FROM social_matches WHERE user_id_1 = $1 AND status = 'matched') as likes,
        (SELECT COUNT(*) FROM social_matches WHERE (user_id_1 = $1 OR user_id_2 = $1) AND status = 'mutual_match') as matches
    `, [req.user.participant_id]);

    res.json({ ...user, stats: statsRes.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/candidates', validateDBSession, async (req, res) => {
  try {
    // Limitamos a 5 candidatos e otimizamos a query para evitar URI_TOO_LONG
    const result = await pool.query(`
      SELECT id, name, photo, age, box_id 
      FROM participants 
      WHERE id != $1 
      AND photo IS NOT NULL
      ORDER BY RANDOM() LIMIT 5
    `, [req.user.participant_id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/match', validateDBSession, async (req, res) => {
  const { targetId, action } = req.body;
  const userId = req.user.participant_id; // O usuário logado

  try {
    // 1. Registrar a ação do usuário atual (user_id_1 -> targetId)
    await pool.query(
      `INSERT INTO social_matches (user_id_1, user_id_2, status)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id_1, user_id_2) DO UPDATE SET status = $3`,
      [userId, targetId, action === "like" ? "matched" : "rejected"]
    );

    // 2. Se a ação for 'like', verificar se há reciprocidade
    if (action === "like") {
      const reciprocalMatch = await pool.query(
        `SELECT id FROM social_matches
         WHERE user_id_1 = $1 AND user_id_2 = $2 AND status = 'matched'`,
        [targetId, userId] // Verifica se o targetId já curtiu o userId
      );

      if (reciprocalMatch.rows.length > 0) {
        // Match recíproco encontrado! Atualizar ambos os status para 'mutual_match'
        await pool.query(
          `UPDATE social_matches SET status = 'mutual_match'
           WHERE (user_id_1 = $1 AND user_id_2 = $2) OR (user_id_1 = $2 AND user_id_2 = $1)`,
          [userId, targetId]
        );
        // Opcional: Notificar ambos os usuários sobre o match mútuo
        res.json({ success: true, message: "Match mútuo!", mutualMatch: true });
        return;
      }
    }

    res.json({ success: true, message: "Ação registrada." });
  } catch (err) {
    console.error("Erro ao registrar match:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- DESAFIOS ---

router.post('/challenge/create', validateDBSession, async (req, res) => {
  const { opponentIds, type, duration } = req.body;
  try {
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + parseInt(duration));
    for (const oppId of opponentIds) {
      await pool.query('INSERT INTO social_challenges (creator_id, opponent_id, challenge_type, end_date) VALUES ($1, $2, $3, $4)', [req.user.participant_id, oppId, type, endDate]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Listar desafios onde o usuário é criador ou oponente
router.get('/challenges', validateDBSession, async (req, res) => {
  const userId = req.user.participant_id;
  try {
    const result = await pool.query(`
      SELECT 
        c.id, c.challenge_type, c.end_date, c.created_at,
        p1.name as creator_name, p1.photo as creator_photo,
        p2.name as opponent_name, p2.photo as opponent_photo
      FROM social_challenges c
      JOIN participants p1 ON c.creator_id = p1.id
      JOIN participants p2 ON c.opponent_id = p2.id
      WHERE c.creator_id = $1 OR c.opponent_id = $1
      ORDER BY c.created_at DESC
    `, [userId]);
    res.json({ success: true, challenges: result.rows });
  } catch (err) {
    console.error("Erro ao buscar desafios:", err);
    res.status(500).json({ error: err.message });
  }
});

// Novo endpoint para listar matches mútuos
router.get('/mutual-matches', validateDBSession, async (req, res) => {
  const userId = req.user.participant_id;
  try {
    const result = await pool.query(
      `SELECT
          p.id, p.name, p.photo, p.age, p.box_id
       FROM
          social_matches sm
       JOIN
          participants p ON (p.id = sm.user_id_2 AND sm.user_id_1 = $1)
                       OR (p.id = sm.user_id_1 AND sm.user_id_2 = $1)
       WHERE
          sm.status = 'mutual_match'
          AND (sm.user_id_1 = $1 OR sm.user_id_2 = $1)`,
      [userId]
    );
    res.json({ success: true, matches: result.rows });
  } catch (err) {
    console.error("Erro ao buscar matches mútuos:", err);
    res.status(500).json({ error: err.message });
  }
});

router.delete("/challenge/:id", validateDBSession, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.participant_id;

  try {
    // Verifica se o usuário logado é o criador do desafio
    const challengeRes = await pool.query(
      "SELECT creator_id FROM social_challenges WHERE id = $1",
      [id]
    );

    if (challengeRes.rows.length === 0) {
      return res.status(404).json({ error: "Desafio não encontrado" });
    }

    if (challengeRes.rows[0].creator_id !== userId) {
      return res.status(403).json({ error: "Você não tem permissão para excluir este desafio" });
    }

    await pool.query("DELETE FROM social_challenges WHERE id = $1", [id]);
    res.json({ success: true, message: "Desafio excluído com sucesso" });
  } catch (err) {
    console.error("Erro ao excluir desafio:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/challenge/:id/result", validateDBSession, async (req, res) => {
  const { id: challengeId } = req.params;
  const userId = req.user.participant_id;
  const { result_value } = req.body; // Ex: tempo em segundos, peso em kg, repetições

  if (result_value === undefined || result_value === null) {
    return res.status(400).json({ error: "Valor do resultado é obrigatório." });
  }

  try {
    // Verificar se o participante está no desafio
    const participantInChallenge = await pool.query(
      `SELECT id FROM social_challenges
       WHERE id = $1 AND (creator_id = $2 OR opponent_id = $2)`,
      [challengeId, userId]
    );

    if (participantInChallenge.rows.length === 0) {
      return res.status(403).json({ error: "Você não faz parte deste desafio." });
    }

    // Inserir ou atualizar o resultado
    await pool.query(
      `INSERT INTO social_challenge_results (challenge_id, participant_id, result_value, recorded_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (challenge_id, participant_id) DO UPDATE SET result_value = $3, recorded_at = NOW()`,
      [challengeId, userId, result_value]
    );

    res.json({ success: true, message: "Resultado registrado com sucesso!" });
  } catch (err) {
    console.error("Erro ao registrar resultado do desafio:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/challenge/:id/ranking", validateDBSession, async (req, res) => {
  const { id: challengeId } = req.params;

  try {
    // Obter o tipo de desafio para determinar a ordem do ranking
    const challengeTypeRes = await pool.query(
      "SELECT challenge_type FROM social_challenges WHERE id = $1",
      [challengeId]
    );

    if (challengeTypeRes.rows.length === 0) {
      return res.status(404).json({ error: "Desafio não encontrado." });
    }

    const challengeType = challengeTypeRes.rows[0].challenge_type;
    let orderByClause = "scr.result_value ASC"; // Padrão para tempo (menor é melhor)

    // Exemplos de tipos que podem ter ranking decrescente (maior é melhor)
    if (challengeType.includes("Max Weight") || challengeType.includes("Repetições")) {
      orderByClause = "scr.result_value DESC";
    }

    const ranking = await pool.query(
      `SELECT
          p.id as participant_id, p.name, p.photo,
          scr.result_value, scr.recorded_at
       FROM
          social_challenge_results scr
       JOIN
          participants p ON scr.participant_id = p.id
       WHERE
          scr.challenge_id = $1
       ORDER BY ${orderByClause}`,
      [challengeId]
    );

    res.json({ success: true, ranking: ranking.rows, challengeType });
  } catch (err) {
    console.error("Erro ao buscar ranking do desafio:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
