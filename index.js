require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Conexão com Neon PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // necessário pro Neon
});

// Teste de conexão ao iniciar
pool.connect()
  .then(() => console.log('→ Conectado ao PostgreSQL (Neon)'))
  .catch(err => console.error('Erro ao conectar no banco:', err));

// Rotas
app.get('/', (req, res) => {
  res.json({ status: 'WODPulse Backend online', time: new Date() });
});

app.use('/api/auth', require('./routes/auth'));

app.listen(port, () => {
  console.log(`Backend rodando → http://localhost:${port}`);
});