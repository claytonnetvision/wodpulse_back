// Arquivo: backend/routes/superadmin.js

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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

module.exports = router;
