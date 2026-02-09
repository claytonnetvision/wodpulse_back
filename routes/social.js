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
    const userRes = await pool.query('SELECT id, name, photo, box_id, progress_privacy, bio, cover_photo FROM participants WHERE id = $1', [req.user.participant_id]);
    const user = userRes.rows[0];
    
    const statsRes = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM social_challenges WHERE creator_id = $1 OR opponent_id = $1) as challenges,
        (SELECT COUNT(*) FROM social_matches WHERE user_id_1 = $1 AND status = 'matched') as likes,
        (SELECT COUNT(*) FROM social_matches WHERE (user_id_1 = $1 OR user_id_2 = $1) AND status = 'mutual_match') as matches
    `, [req.user.participant_id]);

    res.json({ 
      ...user, 
      stats: statsRes.rows[0],
      progress_privacy: user.progress_privacy || 'friends_only'
    });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// --- NOVAS ROTAS DE REDE SOCIAL (FEED, SCRAPS, FOTOS) ---

// Criar Postagem ou Scrap
router.post('/posts', validateDBSession, async (req, res) => {
  const { content, type, privacy, targetUserId } = req.body;
  const userId = req.user.participant_id;

  try {
    const result = await pool.query(
      'INSERT INTO social_posts (user_id, content, type, privacy, target_user_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [userId, content, type || 'feed', privacy || 'public', targetUserId || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao criar postagem:', err);
    res.status(500).json({ error: 'Erro ao criar postagem' });
  }
});

// Buscar Feed (Meus posts + Amigos + Públicos)
router.get('/feed', validateDBSession, async (req, res) => {
  const userId = req.user.participant_id;
  try {
    const result = await pool.query(`
      SELECT p.*, u.name as user_name, u.photo as user_photo 
      FROM social_posts p
      JOIN participants u ON p.user_id = u.id
      WHERE p.type = 'feed' 
      AND (
        p.user_id = $1 
        OR p.privacy = 'public' 
        OR (p.privacy = 'friends' AND EXISTS (
          SELECT 1 FROM social_friends f 
          WHERE (f.requester_id = $1 AND f.target_id = p.user_id AND f.status = 'accepted')
          OR (f.target_id = $1 AND f.requester_id = p.user_id AND f.status = 'accepted')
        ))
      )
      ORDER BY p.created_at DESC
      LIMIT 50
    `, [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao carregar feed:', err);
    res.status(500).json({ error: 'Erro ao carregar feed' });
  }
});

// Buscar Scraps de um usuário
router.get('/scraps/:userId', validateDBSession, async (req, res) => {
  const targetId = req.params.userId;
  try {
    const result = await pool.query(`
      SELECT p.*, u.name as user_name, u.photo as user_photo 
      FROM social_posts p
      JOIN participants u ON p.user_id = u.id
      WHERE p.type = 'scrap' AND p.target_user_id = $1
      ORDER BY p.created_at DESC
    `, [targetId]);
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao carregar scraps:', err);
    res.status(500).json({ error: 'Erro ao carregar scraps' });
  }
});

// Buscar Fotos (Posts que podem ser considerados do álbum)
router.get('/photos/:userId', validateDBSession, async (req, res) => {
  const targetId = req.params.userId;
  try {
    const result = await pool.query(`
      SELECT * FROM social_posts 
      WHERE user_id = $1 AND type = 'photo'
      ORDER BY created_at DESC
    `, [targetId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar fotos' });
  }
});

// --- FIM DAS NOVAS ROTAS ---

router.get('/candidates', validateDBSession, async (req, res) => {
  try {
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
  const userId = req.user.participant_id;

  try {
    await pool.query(
      `INSERT INTO social_matches (user_id_1, user_id_2, status)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id_1, user_id_2) DO UPDATE SET status = $3`,
      [userId, targetId, action === "like" ? "matched" : "rejected"]
    );

    if (action === "like") {
      const reciprocalMatch = await pool.query(
        `SELECT id FROM social_matches
         WHERE user_id_1 = $1 AND user_id_2 = $2 AND status = 'matched'`,
        [targetId, userId]
      );

      if (reciprocalMatch.rows.length > 0) {
        await pool.query(
          `UPDATE social_matches SET status = 'mutual_match'
           WHERE (user_id_1 = $1 AND user_id_2 = $2) OR (user_id_1 = $2 AND user_id_2 = $1)`,
          [userId, targetId]
        );
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
    const validTypes = ['amrap', 'for_time', 'max_reps', 'murph', 'calories_week', 'calories_month'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: 'Tipo de desafio inválido' });
    }
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + parseInt(duration));
    for (const oppId of opponentIds) {
      await pool.query('INSERT INTO social_challenges (creator_id, opponent_id, challenge_type, end_date, status) VALUES ($1, $2, $3, $4, $5)', [req.user.participant_id, oppId, type, endDate, 'pending']);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/challenges', validateDBSession, async (req, res) => {
  const userId = req.user.participant_id;
  try {
    const result = await pool.query(`
      SELECT 
        c.id, c.challenge_type, c.end_date, c.created_at, c.status, c.response_message,
        c.creator_id, c.opponent_id,
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
    res.status(500).json({ error: "Erro interno ao carregar desafios." });
  }
});

// Lista participantes para desafios (com foto)
router.get('/participants-for-challenges', validateDBSession, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, photo 
      FROM participants 
      WHERE id != $1 AND photo IS NOT NULL
      ORDER BY name ASC
    `, [req.user.participant_id]);

    res.json({ success: true, participants: result.rows });
  } catch (err) {
    console.error('Erro ao listar participantes para desafios:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/mutual-matches", validateDBSession, async (req, res) => {
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

router.post("/challenge/:id/respond", validateDBSession, async (req, res) => {
  const { id: challengeId } = req.params;
  const userId = req.user.participant_id;
  const { action, message } = req.body;

  try {
    const challengeRes = await pool.query(
      "SELECT creator_id, opponent_id FROM social_challenges WHERE id = $1",
      [challengeId]
    );

    if (challengeRes.rows.length === 0) {
      return res.status(404).json({ error: "Desafio não encontrado." });
    }

    if (challengeRes.rows[0].opponent_id !== userId) {
      return res.status(403).json({ error: "Você não é o oponente deste desafio." });
    }

    const newStatus = action === 'accept' ? 'accepted' : 'rejected';

    await pool.query(
      "UPDATE social_challenges SET status = $1, response_message = $2 WHERE id = $3",
      [newStatus, message, challengeId]
    );

    res.json({ success: true, message: `Desafio ${newStatus} com sucesso!` });
  } catch (err) {
    console.error("Erro ao responder desafio:", err);
    res.status(500).json({ error: err.message });
  }
});

router.delete("/challenge/:id", validateDBSession, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.participant_id;

  try {
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

    await pool.query("DELETE FROM social_challenges WHERE id = $1 AND creator_id = $2", [id, userId]);
    res.json({ success: true, message: "Desafio excluído com sucesso" });
  } catch (err) {
    console.error("Erro ao excluir desafio:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/challenges/bulk-delete", validateDBSession, async (req, res) => {
  const { challengeIds } = req.body;
  const userId = req.user.participant_id;

  if (!Array.isArray(challengeIds) || challengeIds.length === 0) {
    return res.status(400).json({ error: "IDs de desafios inválidos." });
  }

  try {
    const result = await pool.query(
      `DELETE FROM social_challenges WHERE id = ANY($1::int[]) AND creator_id = $2 RETURNING id`,
      [challengeIds, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Nenhum desafio encontrado ou sem permissão." });
    }

    res.json({ success: true, message: `${result.rows.length} desafios excluídos com sucesso.` });
  } catch (err) {
    console.error("Erro ao excluir desafios em massa:", err);
    res.status(500).json({ error: err.message });
  }
});

// Perfil público (match mútuo)
router.get('/public-profile/:id', validateDBSession, async (req, res) => {
  const { id } = req.params;
  const currentUserId = req.user.participant_id;

  if (parseInt(id) === currentUserId) {
    // Se for o próprio usuário, redireciona ou retorna erro (opcional)
  }

  try {
    const matchCheck = await pool.query(`
      SELECT 1 FROM social_matches 
      WHERE status = 'mutual_match' 
      AND ((user_id_1 = $1 AND user_id_2 = $2) OR (user_id_1 = $2 AND user_id_2 = $1))
    `, [currentUserId, id]);

    if (matchCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Acesso negado – apenas matches mútuos' });
    }

    const userRes = await pool.query(`
      SELECT id, name, photo, age, box_id, bio, cover_photo 
      FROM participants 
      WHERE id = $1
    `, [id]);

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const user = userRes.rows[0];
    const statsRes = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM social_challenges WHERE creator_id = $1 OR opponent_id = $1) as challenges,
        (SELECT COUNT(*) FROM social_matches WHERE user_id_1 = $1 AND status = 'matched') as likes,
        (SELECT COUNT(*) FROM social_matches WHERE (user_id_1 = $1 OR user_id_2 = $1) AND status = 'mutual_match') as matches
    `, [id]);

    res.json({ ...user, stats: statsRes.rows[0] });
  } catch (err) {
    console.error('Erro public-profile:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Privacidade
router.post('/privacy/set', validateDBSession, async (req, res) => {
  const { privacy } = req.body;
  if (!['public', 'friends_only', 'private'].includes(privacy)) {
    return res.status(400).json({ error: 'Valor inválido' });
  }
  try {
    await pool.query('UPDATE participants SET progress_privacy = $1 WHERE id = $2', [privacy, req.user.participant_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Amizades
router.post('/friend/request', validateDBSession, async (req, res) => {
  const { targetId } = req.body;
  const userId = req.user.participant_id;
  if (parseInt(targetId) === userId) return res.status(400).json({ error: 'Não pode adicionar você mesmo' });

  try {
    const existing = await pool.query('SELECT status FROM social_friends WHERE (requester_id = $1 AND target_id = $2) OR (requester_id = $2 AND target_id = $1)', [userId, targetId]);
    if (existing.rows.length > 0 && existing.rows[0].status === 'accepted') {
      return res.json({ success: true, message: 'Já são amigos' });
    }

    await pool.query(
      'INSERT INTO social_friends (requester_id, target_id, status) VALUES ($1, $2, $3) ON CONFLICT (requester_id, target_id) DO UPDATE SET status = $3',
      [userId, targetId, 'pending']
    );
    res.json({ success: true, message: 'Pedido enviado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/friend/respond', validateDBSession, async (req, res) => {
  const { requesterId, action } = req.body;
  const userId = req.user.participant_id;

  try {
    if (action === 'accept') {
      await pool.query('UPDATE social_friends SET status = $1 WHERE requester_id = $2 AND target_id = $3', ['accepted', requesterId, userId]);
    } else {
      await pool.query('DELETE FROM social_friends WHERE requester_id = $2 AND target_id = $3', [requesterId, userId]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/friends', validateDBSession, async (req, res) => {
  const userId = req.user.participant_id;
  try {
    const pendingRes = await pool.query(`
      SELECT p.id, p.name, p.photo 
      FROM social_friends f 
      JOIN participants p ON f.requester_id = p.id
      WHERE f.target_id = $1 AND f.status = 'pending'
      ORDER BY f.created_at DESC
    `, [userId]);

    const friendsRes = await pool.query(`
      SELECT p.id, p.name, p.photo
      FROM social_friends f 
      JOIN participants p ON 
        (f.requester_id = $1 AND f.target_id = p.id) OR 
        (f.target_id = $1 AND f.requester_id = p.id)
      WHERE f.status = 'accepted'
      AND p.id != $1
      ORDER BY f.created_at DESC
    `, [userId]);

    res.json({
      pendingRequests: pendingRes.rows,
      confirmedFriends: friendsRes.rows
    });
  } catch (err) {
    console.error('Erro em /friends:', err);
    res.status(500).json({ error: 'Erro ao carregar amigos/pedidos' });
  }
});

router.get('/is-friend/:id', validateDBSession, async (req, res) => {
  const targetId = parseInt(req.params.id);
  const userId = req.user.participant_id;
  if (targetId === userId) return res.json({ isFriend: true });

  try {
    const result = await pool.query(`
      SELECT status FROM social_friends 
      WHERE (requester_id = $1 AND target_id = $2) OR (requester_id = $2 AND target_id = $1)
    `, [userId, targetId]);
    const isFriend = result.rows.length > 0 && result.rows[0].status === 'accepted';
    res.json({ isFriend });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/challenge/:id/result", validateDBSession, async (req, res) => {
  const { id: challengeId } = req.params;
  const userId = req.user.participant_id;
  const { result_value } = req.body;

  if (result_value === undefined || result_value === null) {
    return res.status(400).json({ error: "O valor do resultado é obrigatório." });
  }

  try {
    await pool.query(
      `INSERT INTO social_challenge_results (challenge_id, participant_id, result_value)
       VALUES ($1, $2, $3)
       ON CONFLICT (challenge_id, participant_id) DO UPDATE SET result_value = $3`,
      [challengeId, userId, result_value]
    );
    res.json({ success: true, message: "Resultado registrado com sucesso!" });
  } catch (err) {
    console.error("Erro ao registrar resultado:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/challenge/:id/calories-summary', validateDBSession, async (req, res) => {
  const challengeId = parseInt(req.params.id);
  const userId = req.user.participant_id;

  try {
    const challengeRes = await pool.query('SELECT * FROM social_challenges WHERE id = $1', [challengeId]);
    if (challengeRes.rows.length === 0) return res.status(404).json({ error: 'Desafio não encontrado' });

    const c = challengeRes.rows[0];
    if (c.status !== 'accepted') return res.status(400).json({ error: 'Desafio não aceito' });
    if (![c.creator_id, c.opponent_id].includes(userId)) return res.status(403).json({ error: 'Sem acesso' });

    if (!c.challenge_type.startsWith('calories_')) return res.status(400).json({ error: 'Não é desafio de calorias' });

    const days = c.challenge_type === 'calories_week' ? 7 : 30;
    const startDate = new Date(c.end_date);
    startDate.setDate(startDate.getDate() - days);

    const caloriesRes = await pool.query(`
      SELECT COALESCE(SUM(sp.calories_total), 0) as total
      FROM sessions s
      JOIN session_participants sp ON s.id = sp.session_id
      WHERE sp.participant_id = $1
        AND s.date_start >= $2
        AND s.date_start <= $3
    `, [userId, startDate, c.end_date]);

    const totalCalories = parseFloat(caloriesRes.rows[0].total);

    await pool.query(`
      INSERT INTO social_challenge_results (challenge_id, participant_id, result_value)
      VALUES ($1, $2, $3::text)
      ON CONFLICT (challenge_id, participant_id) DO UPDATE SET result_value = $3::text
    `, [challengeId, userId, totalCalories]);

    res.json({ totalCalories });
  } catch (err) {
    console.error('Erro calories-summary:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/challenge/:id/ranking", validateDBSession, async (req, res) => {
  const { id: challengeId } = req.params;

  try {
    const challengeRes = await pool.query("SELECT challenge_type FROM social_challenges WHERE id = $1", [challengeId]);
    if (challengeRes.rows.length === 0) return res.status(404).json({ error: "Desafio não encontrado" });
    
    const type = challengeRes.rows[0].challenge_type.toLowerCase();
    const isTimeBased = type.includes("time") || type.includes("murph");
    const isCalories = type.startsWith('calories_');
    const isHigherBetter = isCalories || type === 'amrap' || type === 'max_reps';
    const orderBy = isHigherBetter ? "DESC" : (isTimeBased ? "ASC" : "DESC");

    const result = await pool.query(
      `SELECT r.result_value, p.name, p.photo
       FROM social_challenge_results r
       JOIN participants p ON r.participant_id = p.id
       WHERE r.challenge_id = $1
       ORDER BY r.result_value ${orderBy} NULLS LAST`,
      [challengeId]
    );

    res.json({ success: true, ranking: result.rows });
  } catch (err) {
    console.error("Erro ao buscar ranking:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/profile/update', validateDBSession, async (req, res) => {
  const { bio, cover_photo } = req.body;
  try {
    const fields = [];
    const values = [];
    let idx = 1;
    if (bio !== undefined) { fields.push(`bio = $${idx++}`); values.push(bio); }
    if (cover_photo !== undefined) { fields.push(`cover_photo = $${idx++}`); values.push(cover_photo); }
    values.push(req.user.participant_id);
    await pool.query(`UPDATE participants SET ${fields.join(', ')} WHERE id = $${idx}`, values);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/search-users', validateDBSession, async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.json({ users: [] });

  try {
    const result = await pool.query(`
      SELECT id, name, photo, box_id 
      FROM participants 
      WHERE LOWER(name) LIKE LOWER($1)
      AND id != $2
      ORDER BY name ASC
      LIMIT 20
    `, [`%${q.trim()}%`, req.user.participant_id]);

    res.json({ users: result.rows });
  } catch (err) {
    console.error('Erro search-users:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
