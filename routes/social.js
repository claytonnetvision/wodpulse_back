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
// --- ROTA DE ESTATÍSTICAS DE PROGRESSO (ADICIONAR ESTE BLOCO) ---
router.get('/stats/my-progress', validateDBSession, async (req, res) => {
  const userId = req.user.participant_id;
  try {
    // Calcula total de aulas e calorias
    const sessionsRes = await pool.query(`
      SELECT COUNT(*) as total_sessions, COALESCE(SUM(sp.calories_total), 0) as total_calories
      FROM session_participants sp
      WHERE sp.participant_id = $1
    `, [userId]);

    const sessions = sessionsRes.rows[0];
    const totalSessions = parseInt(sessions.total_sessions) || 0;
    const totalCalories = parseInt(sessions.total_calories) || 0;
    const avgCalories = totalSessions > 0 ? Math.round(totalCalories / totalSessions) : 0;

    // Calcula FC máxima histórica
    const maxHRRes = await pool.query(`
      SELECT COALESCE(MAX(sp.max_hr_reached), 0) as max_hr
      FROM session_participants sp
      WHERE sp.participant_id = $1
    `, [userId]);

    const maxHR = parseInt(maxHRRes.rows[0].max_hr) || 0;

    // Calcula tempo VO2
    const vo2Res = await pool.query(`
      SELECT COALESCE(SUM(sp.vo2_time_seconds), 0) as total_vo2_seconds
      FROM session_participants sp
      WHERE sp.participant_id = $1
    `, [userId]);

    const totalVO2Seconds = parseInt(vo2Res.rows[0].total_vo2_seconds) || 0;
    const totalVO2Minutes = Math.round(totalVO2Seconds / 60);

    res.json({
      success: true,
      data: {
        total_sessions: totalSessions,
        total_calories: totalCalories,
        avg_calories: avgCalories,
        max_hr: maxHR,
        total_vo2_time: totalVO2Minutes
      }
    });
  } catch (err) {
    console.error('Erro ao carregar progresso:', err);
    res.status(500).json({ error: 'Erro ao carregar progresso' });
  }
});

// --- POSTS COM SUPORTE A FOTOS ---

router.post('/posts', validateDBSession, async (req, res) => {
  const { content, type, privacy, targetUserId, photoData } = req.body;
  const userId = req.user.participant_id;

  try {
    const result = await pool.query(
      'INSERT INTO social_posts (user_id, content, type, privacy, target_user_id, photo_data) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [userId, content, type || 'feed', privacy || 'public', targetUserId || null, photoData || null]
    );
    
    // Processar menções (@username) - Melhorado
    if (content) {
      const mentions = content.match(/@([\w\u00C0-\u017F]+)/g) || [];
      for (const mention of mentions) {
        const username = mention.substring(1);
        const mentionedUserRes = await pool.query(
          'SELECT id FROM participants WHERE LOWER(name) LIKE LOWER($1) OR LOWER(name) LIKE LOWER($2) LIMIT 1',
          [`${username}%`, `% ${username}%`]
        );
        if (mentionedUserRes.rows.length > 0) {
          await pool.query(
            'INSERT INTO social_notifications (user_id, from_user_id, type, related_id) VALUES ($1, $2, $3, $4)',
            [mentionedUserRes.rows[0].id, userId, 'mention', result.rows[0].id]
          );
        }
      }
    }

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao criar postagem:', err);
    res.status(500).json({ error: 'Erro ao criar postagem' });
  }
});

// --- EXCLUIR POSTAGEM ---

router.delete('/posts/:postId', validateDBSession, async (req, res) => {
  const { postId } = req.params;
  const userId = req.user.participant_id;

  try {
    // Verifica se o post existe e se pertence ao usuário
    const postRes = await pool.query('SELECT user_id FROM social_posts WHERE id = $1', [postId]);
    if (postRes.rows.length === 0) {
      return res.status(404).json({ error: 'Postagem não encontrada' });
    }

    if (postRes.rows[0].user_id !== userId) {
      return res.status(403).json({ error: 'Você não tem permissão para excluir esta postagem' });
    }

    // Deleta as reações associadas
    await pool.query('DELETE FROM social_post_reactions WHERE post_id = $1', [postId]);

    // Deleta as notificações associadas
    await pool.query('DELETE FROM social_notifications WHERE related_id = $1 AND type IN ($2, $3, $4)', [postId, 'mention', 'like', 'dislike']);

    // Deleta a postagem
    await pool.query('DELETE FROM social_posts WHERE id = $1', [postId]);

    res.json({ success: true, message: 'Postagem excluída com sucesso' });
  } catch (err) {
    console.error('Erro ao excluir postagem:', err);
    res.status(500).json({ error: 'Erro ao excluir postagem' });
  }
});

router.get('/feed', validateDBSession, async (req, res) => {
  const userId = req.user.participant_id;
  try {
    const result = await pool.query(`
      SELECT p.*, u.name as user_name, u.photo as user_photo,
        (SELECT COUNT(*) FROM social_post_reactions WHERE post_id = p.id AND reaction_type = 'like') as likes_count,
        (SELECT COUNT(*) FROM social_post_reactions WHERE post_id = p.id AND reaction_type = 'dislike') as dislikes_count,
        (SELECT reaction_type FROM social_post_reactions WHERE post_id = p.id AND user_id = $1) as user_reaction
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
    // Adiciona flag de autoria para o frontend saber se pode deletar
    const resultWithAuth = result.rows.map(post => ({
      ...post,
      isAuthor: post.user_id === userId
    }));
    res.json(resultWithAuth);
  } catch (err) {
    console.error('Erro ao carregar feed:', err);
    res.status(500).json({ error: 'Erro ao carregar feed' });
  }
});

router.get('/scraps/:userId', validateDBSession, async (req, res) => {
  const targetId = req.params.userId;
  const currentUserId = req.user.participant_id;
  try {
    const result = await pool.query(`
      SELECT p.*, u.name as user_name, u.photo as user_photo 
      FROM social_posts p
      JOIN participants u ON p.user_id = u.id
      WHERE p.type = 'scrap' AND p.target_user_id = $1
      ORDER BY p.created_at DESC
    `, [targetId]);
    // Adiciona flag de autoria para o frontend saber se pode deletar
    const resultWithAuth = result.rows.map(post => ({
      ...post,
      isAuthor: post.user_id === currentUserId
    }));
    res.json(resultWithAuth);
  } catch (err) {
    console.error('Erro ao carregar scraps:', err);
    res.status(500).json({ error: 'Erro ao carregar scraps' });
  }
});

// --- SISTEMA DE REAÇÕES (CURTIR/NÃO CURTIR) ---

// --- NOTIFICAÇÕES ---

router.get('/notifications', validateDBSession, async (req, res) => {
  const userId = req.user.participant_id;
  try {
    const result = await pool.query(`
      SELECT n.*, p.name as from_user_name, p.photo as from_user_photo
      FROM social_notifications n
      JOIN participants p ON n.from_user_id = p.id
      WHERE n.user_id = $1
      ORDER BY n.created_at DESC
      LIMIT 20
    `, [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao carregar notificações:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/posts/:postId/react', validateDBSession, async (req, res) => {
  const { postId } = req.params;
  const { reactionType } = req.body;
  const userId = req.user.participant_id;

  if (!['like', 'dislike'].includes(reactionType)) {
    return res.status(400).json({ error: 'Tipo de reação inválido' });
  }

  try {
    // Verifica se já existe reação
    const existingRes = await pool.query(
      'SELECT * FROM social_post_reactions WHERE post_id = $1 AND user_id = $2',
      [postId, userId]
    );

    if (existingRes.rows.length > 0) {
      // Se a reação é igual, remove; se é diferente, atualiza
      if (existingRes.rows[0].reaction_type === reactionType) {
        await pool.query('DELETE FROM social_post_reactions WHERE post_id = $1 AND user_id = $2', [postId, userId]);
        return res.json({ success: true, message: 'Reação removida' });
      } else {
        await pool.query('UPDATE social_post_reactions SET reaction_type = $1 WHERE post_id = $2 AND user_id = $3', [reactionType, postId, userId]);
        return res.json({ success: true, message: 'Reação atualizada' });
      }
    } else {
      // Insere nova reação
      await pool.query(
        'INSERT INTO social_post_reactions (post_id, user_id, reaction_type) VALUES ($1, $2, $3)',
        [postId, userId, reactionType]
      );

      // Cria notificação para o autor do post
      const postRes = await pool.query('SELECT user_id FROM social_posts WHERE id = $1', [postId]);
      if (postRes.rows.length > 0 && postRes.rows[0].user_id !== userId) {
        await pool.query(
          'INSERT INTO social_notifications (user_id, from_user_id, type, related_id) VALUES ($1, $2, $3, $4)',
          [postRes.rows[0].user_id, userId, reactionType === 'like' ? 'like' : 'dislike', postId]
        );
      }

      return res.status(201).json({ success: true, message: 'Reação registrada' });
    }
  } catch (err) {
    console.error('Erro ao reagir:', err);
    res.status(500).json({ error: 'Erro ao registrar reação' });
  }
});

// --- FOTOS (ÁLBUM) ---

router.post('/photos/upload', validateDBSession, async (req, res) => {
  const { photoData, description, privacy } = req.body;
  const userId = req.user.participant_id;

  if (!photoData) {
    return res.status(400).json({ error: 'Foto é obrigatória' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO social_photos (user_id, photo_data, description, privacy) VALUES ($1, $2, $3, $4) RETURNING *',
      [userId, photoData, description || '', privacy || 'public']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao fazer upload de foto:', err);
    res.status(500).json({ error: 'Erro ao fazer upload' });
  }
});

router.post('/photos/:photoId/post-to-feed', validateDBSession, async (req, res) => {
  const { photoId } = req.params;
  const userId = req.user.participant_id;
  const { caption, privacy } = req.body;

  try {
    // Busca a foto
    const photoRes = await pool.query('SELECT * FROM social_photos WHERE id = $1 AND user_id = $2', [photoId, userId]);
    if (photoRes.rows.length === 0) {
      return res.status(404).json({ error: 'Foto não encontrada' });
    }

    const photo = photoRes.rows[0];

    // Cria um post no feed com a foto
    const postRes = await pool.query(
      'INSERT INTO social_posts (user_id, content, type, privacy, photo_data) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [userId, caption || '', 'feed', privacy || 'public', photo.photo_data]
    );

    res.json({ success: true, post: postRes.rows[0] });
  } catch (err) {
    console.error('Erro ao postar foto:', err);
    res.status(500).json({ error: 'Erro ao postar foto' });
  }
});

router.get('/photos/:userId', validateDBSession, async (req, res) => {
  const targetId = req.params.userId;
  const currentUserId = req.user.participant_id;

  try {
    const result = await pool.query(`
      SELECT * FROM social_photos 
      WHERE user_id = $1 
      AND (privacy = 'public' OR user_id = $2 OR (privacy = 'friends' AND EXISTS (
        SELECT 1 FROM social_friends f 
        WHERE (f.requester_id = $2 AND f.target_id = $1 AND f.status = 'accepted')
        OR (f.target_id = $2 AND f.requester_id = $1 AND f.status = 'accepted')
      )))
      ORDER BY created_at DESC
    `, [targetId, currentUserId]);
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao carregar fotos:', err);
    res.status(500).json({ error: 'Erro ao carregar fotos' });
  }
});

router.get('/notifications', validateDBSession, async (req, res) => {
  const userId = req.user.participant_id;
  try {
    const result = await pool.query(`
      SELECT n.*, p.name as from_user_name, p.photo as from_user_photo
      FROM social_notifications n
      JOIN participants p ON n.from_user_id = p.id
      WHERE n.user_id = $1
      ORDER BY n.created_at DESC
      LIMIT 20
    `, [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao carregar notificações:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/matches/list', validateDBSession, async (req, res) => {
  const userId = req.user.participant_id;
  try {
    const mutualRes = await pool.query(`
      SELECT p.id, p.name, p.photo, p.age, p.box_id, 'mutual' as match_type
      FROM social_matches sm
      JOIN participants p ON (p.id = sm.user_id_2 AND sm.user_id_1 = $1) OR (p.id = sm.user_id_1 AND sm.user_id_2 = $1)
      WHERE sm.status = 'mutual_match' AND (sm.user_id_1 = $1 OR sm.user_id_2 = $1)
      ORDER BY sm.created_at DESC
    `, [userId]);

    const likesReceivedRes = await pool.query(`
      SELECT p.id, p.name, p.photo, p.age, p.box_id, 'received' as match_type
      FROM social_matches sm
      JOIN participants p ON p.id = sm.user_id_1
      WHERE sm.user_id_2 = $1 AND sm.status = 'matched'
      ORDER BY sm.created_at DESC
    `, [userId]);

    const likesSentRes = await pool.query(`
      SELECT p.id, p.name, p.photo, p.age, p.box_id, 'sent' as match_type
      FROM social_matches sm
      JOIN participants p ON p.id = sm.user_id_2
      WHERE sm.user_id_1 = $1 AND sm.status = 'matched'
      ORDER BY sm.created_at DESC
    `, [userId]);

    res.json({
      mutualMatches: mutualRes.rows,
      likesReceived: likesReceivedRes.rows,
      likesSent: likesSentRes.rows
    });
  } catch (err) {
    console.error('Erro ao carregar lista de matches:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/candidates', validateDBSession, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, photo, age, box_id 
      FROM participants 
      WHERE id != $1 
      AND photo IS NOT NULL
      ORDER BY RANDOM()
      LIMIT 5
    `, [req.user.participant_id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/match', validateDBSession, async (req, res) => {
  const { targetId, action } = req.body;
  const userId = req.user.participant_id;

  try {
    // Registra a ação (like ou dislike)
    await pool.query(
      `INSERT INTO social_matches (user_id_1, user_id_2, status)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id_1, user_id_2) DO UPDATE SET status = $3`,
      [userId, targetId, action === "like" ? "matched" : "rejected"]
    );

    if (action === "like") {
      // Verifica se o outro usuário já deu like
      const reciprocalMatch = await pool.query(
        `SELECT id FROM social_matches WHERE user_id_1 = $1 AND user_id_2 = $2 AND status = 'matched'`,
        [targetId, userId]
      );

      if (reciprocalMatch.rows.length > 0) {
        // Match mútuo!
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
    res.status(500).json({ error: err.message });
  }
});

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
      await pool.query(
        'INSERT INTO social_challenges (creator_id, opponent_id, challenge_type, end_date, status) VALUES ($1, $2, $3, $4, $5)',
        [req.user.participant_id, oppId, type, endDate, 'pending']
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/challenges', validateDBSession, async (req, res) => {
  const userId = req.user.participant_id;
  try {
    const result = await pool.query(`
      SELECT c.id, c.challenge_type, c.end_date, c.created_at, c.status, c.response_message,
        c.creator_id, c.opponent_id, p1.name as creator_name, p1.photo as creator_photo,
        p2.name as opponent_name, p2.photo as opponent_photo
      FROM social_challenges c
      JOIN participants p1 ON c.creator_id = p1.id
      JOIN participants p2 ON c.opponent_id = p2.id
      WHERE c.creator_id = $1 OR c.opponent_id = $1
      ORDER BY c.created_at DESC
    `, [userId]);
    res.json({ success: true, challenges: result.rows });
  } catch (err) {
    console.error("Erro ao carregar desafios:", err);
    res.status(500).json({ error: "Erro interno ao carregar desafios." });
  }
});

router.get('/participants-for-challenges', validateDBSession, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, photo 
      FROM participants 
      WHERE id != $1 
      AND photo IS NOT NULL
      ORDER BY name ASC
    `, [req.user.participant_id]);
    res.json({ success: true, participants: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/mutual-matches", validateDBSession, async (req, res) => {
  const userId = req.user.participant_id;
  try {
    const result = await pool.query(
      `SELECT p.id, p.name, p.photo, p.age, p.box_id
       FROM social_matches sm
       JOIN participants p ON (p.id = sm.user_id_2 AND sm.user_id_1 = $1) OR (p.id = sm.user_id_1 AND sm.user_id_2 = $1)
       WHERE sm.status = 'mutual_match' AND (sm.user_id_1 = $1 OR sm.user_id_2 = $1)`,
      [userId]
    );
    res.json({ success: true, matches: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/challenge/:id/respond", validateDBSession, async (req, res) => {
  const { id: challengeId } = req.params;
  const userId = req.user.participant_id;
  const { action, message } = req.body;

  try {
    const challengeRes = await pool.query(
      "SELECT opponent_id FROM social_challenges WHERE id = $1",
      [challengeId]
    );

    if (challengeRes.rows.length === 0) {
      return res.status(404).json({ error: "Desafio não encontrado." });
    }

    if (challengeRes.rows[0].opponent_id !== userId) {
      return res.status(403).json({ error: "Acesso negado." });
    }

    const newStatus = action === 'accept' ? 'accepted' : 'rejected';
    await pool.query(
      "UPDATE social_challenges SET status = $1, response_message = $2 WHERE id = $3",
      [newStatus, message, challengeId]
    );

    res.json({ success: true, message: `Desafio ${newStatus}!` });
  } catch (err) {
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

router.get('/public-profile/:id', validateDBSession, async (req, res) => {
  const { id } = req.params;
  const currentUserId = req.user.participant_id;

  if (parseInt(id) === currentUserId) {
    // Se for o próprio usuário, redireciona ou retorna erro (opcional)
  }

    try {
    // COMENTADO PARA LIBERAR ACESSO PÚBLICO
    /*
    const matchCheck = await pool.query(`
      SELECT 1 FROM social_matches 
      WHERE status = 'mutual_match' 
      AND ((user_id_1 = $1 AND user_id_2 = $2) OR (user_id_1 = $2 AND user_id_2 = $1))
    `, [currentUserId, id]);

    if (matchCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Acesso negado – apenas matches mútuos' });
    }
    */

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
// ... (todo o seu código existente do social.js) ...

// ROTA NOVA: Rota segura para o histórico de treinos do aluno
// Usa o middleware `validateDBSession` que já existe neste arquivo.
router.get('/my-sessions-history', validateDBSession, async (req, res) => {
  // req.user.participant_id vem do token do aluno, garantindo que ele só veja os seus próprios dados.
  const alunoId = req.user.participant_id;

  try {
    const historicoRes = await pool.query(
      `SELECT s.id AS id_sessao, s.class_name, s.date_start, s.duration_minutes,
              sp.calories_total, sp.avg_hr, sp.max_hr_reached, sp.min_red, sp.queima_points,
              sp.trimp_total, sp.epoc_estimated, sp.real_resting_hr, sp.min_zone2,
              sp.min_zone3, sp.min_zone4, sp.min_zone5, sp.ia_comment
       FROM sessions s
       JOIN session_participants sp ON sp.session_id = s.id
       WHERE sp.participant_id = $1
       ORDER BY s.date_start DESC`,
      [alunoId]
    );

    res.json(historicoRes.rows);

  } catch (err) {
    console.error('Erro ao carregar histórico de sessões do aluno:', err);
    res.status(500).json({ error: 'Erro interno ao buscar histórico de sessões.' });
  }
});

module.exports = router;

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
