import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  host: process.env.PGHOST || '192.168.0.2',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ThePlayPlus',
  user: process.env.PGUSER || 'gino',
  password: process.env.PGPASSWORD,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => console.error('[db] idle client error:', err.message));

export const query = (text, params) => pool.query(text, params);
