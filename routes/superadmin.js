// Arquivo: backend/routes/superadmin.js (VERSÃO CORRIGIDA E COMPLETA)

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- ROTAS DE GERENCIAMENTO (Seu código original, mantido 100%) ---

// ROTA PARA CRIAR UM NOVO BOX
router.post('/create-box', async (req, res) => {
    const { name, slug } = req.body;
    if (!name || !slug) {
        return res.status(400).json({ error: 'Nome e Slug são obrigatórios.' });
    }

    try {
        const result = await pool.query(
            'INSERT INTO boxes (name, slug, active) VALUES ($1, $2, true) RETURNING *',
            [name, slug.toLowerCase()]
        );
        res.status(201).json({ success: true, message: 'Box criado com sucesso!', box: result.rows[0] });
    } catch (err) {
        console.error('Erro ao criar box:', err);
        if (err.code === '23505') { // Código de erro para violação de unicidade
            return res.status(409).json({ error: 'Este Slug já está em uso.' });
        }
        res.status(500).json({ error: 'Erro interno ao criar o box.' });
    }
});

// ROTA PARA CRIAR UM NOVO USUÁRIO ADMIN DE BOX
router.post('/create-user', async (req, res) => {
    const { box_id, username, password, role = 'admin' } = req.body;
    if (!box_id || !username || !password) {
        return res.status(400).json({ error: 'Box ID, Username e Senha são obrigatórios.' });
    }

    try {
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);

        const result = await pool.query(
            'INSERT INTO users (box_id, username, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, username, role, box_id',
            [box_id, username, password_hash, role]
        );
        res.status(201).json({ success: true, message: 'Usuário admin criado com sucesso!', user: result.rows[0] });
    } catch (err) {
        console.error('Erro ao criar usuário:', err);
        if (err.code === '23505') {
            return res.status(409).json({ error: 'Este nome de usuário já existe.' });
        }
        res.status(500).json({ error: 'Erro interno ao criar usuário.' });
    }
});

// ROTA PARA ALTERAR A SENHA DE UM USUÁRIO
router.put('/change-password', async (req, res) => {
    const { user_id, new_password } = req.body;
    if (!user_id || !new_password) {
        return res.status(400).json({ error: 'ID do usuário e nova senha são obrigatórios.' });
    }

    try {
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(new_password, salt);

        const result = await pool.query(
            'UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id, username',
            [password_hash, user_id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }

        res.json({ success: true, message: `Senha do usuário ${result.rows[0].username} alterada com sucesso!` });
    } catch (err) {
        console.error('Erro ao alterar senha:', err);
        res.status(500).json({ error: 'Erro interno ao alterar senha.' });
    }
});

// ROTA PARA LISTAR TODOS OS BOXES
router.get('/all-boxes', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM boxes ORDER BY name ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Erro ao buscar boxes.' });
    }
});

// ROTA PARA LISTAR TODOS OS USUÁRIOS
router.get('/all-users', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, username, role, box_id FROM users ORDER BY username ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Erro ao buscar usuários.' });
    }
});

// --- ROTAS DE VISUALIZAÇÃO E DELEÇÃO (NOVAS) ---

// ROTA PARA LISTAR TODOS os participantes de TODOS os boxes
router.get('/all-participants', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, box_id, name, email, device_name, device_id 
            FROM participants 
            ORDER BY box_id, name ASC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Erro ao buscar todos os participantes:', err);
        res.status(500).json({ error: 'Erro interno' });
    }
});

// ROTA PARA LISTAR TODAS as sessões de TODOS os boxes
router.get('/all-sessions', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT s.id, s.box_id, s.class_name, s.date_start, s.duration_minutes, COUNT(sp.participant_id) AS participant_count
            FROM sessions s
            LEFT JOIN session_participants sp ON s.id = sp.session_id
            GROUP BY s.id
            ORDER BY s.date_start DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Erro ao buscar todas as sessões:', err);
        res.status(500).json({ error: 'Erro interno' });
    }
});

// ROTA PARA VER DETALHES de UMA sessão (sem filtro de box)
router.get('/session-details/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const sessionRes = await pool.query(`SELECT * FROM sessions WHERE id = $1`, [id]);
        if (sessionRes.rowCount === 0) return res.status(404).json({ error: 'Sessão não encontrada' });

        const participantsRes = await pool.query(`
            SELECT p.name, sp.calories_total, sp.queima_points, sp.trimp_total
            FROM session_participants sp
            JOIN participants p ON p.id = sp.participant_id
            WHERE sp.session_id = $1
        `, [id]);

        res.json({ session: sessionRes.rows[0], participants: participantsRes.rows });
    } catch (err) {
        console.error('Erro ao buscar detalhes da sessão (superadmin):', err);
        res.status(500).json({ error: 'Erro interno' });
    }
});

// ROTA PARA DELETAR UM BOX (e tudo associado a ele em cascata)
router.delete('/delete-box/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('DELETE FROM boxes WHERE id = $1 RETURNING name', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Box não encontrado.' });
        }
        res.json({ success: true, message: `Box "${result.rows[0].name}" e todos os seus dados foram excluídos.` });
    } catch (err) {
        console.error('Erro ao deletar box:', err);
        res.status(500).json({ error: 'Erro interno ao deletar o box.' });
    }
});

// ROTA PARA DELETAR UM USUÁRIO ADMIN
router.delete('/delete-user/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING username', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }
        res.json({ success: true, message: `Usuário "${result.rows[0].username}" foi excluído.` });
    } catch (err) {
        console.error('Erro ao deletar usuário:', err);
        res.status(500).json({ error: 'Erro interno ao deletar usuário.' });
    }
});

// ROTA PARA DELETAR UM PARTICIPANTE (aluno)
router.delete('/delete-participant/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM participants WHERE id = $1', [id]);
        res.json({ success: true, message: 'Aluno excluído com sucesso.' });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao excluir aluno.' });
    }
});

// ROTA PARA DELETAR UMA SESSÃO (aula)
router.delete('/delete-session/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM sessions WHERE id = $1', [id]);
        res.json({ success: true, message: 'Aula excluída com sucesso.' });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao excluir aula.' });
    }
});

module.exports = router;
