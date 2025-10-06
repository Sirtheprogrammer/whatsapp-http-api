import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://sirtheprogrammer:91JDib75NISrkKNZ4Aakhyyzz7aBPh77@dpg-d3ge05p5pdvs73ee0040-a.oregon-postgres.render.com/whatssession';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function init() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        auth_json JSONB,
        last_status JSONB,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    // Ensure column exists for older DBs
    try {
      await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_status JSONB`);
    } catch (e) {
      // ignore
    }
  } finally {
    client.release();
  }
}

async function saveSession(id, authJson) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `INSERT INTO sessions (id, auth_json, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (id) DO UPDATE SET auth_json = $2, updated_at = now()`,
      [id, authJson]
    );
    return res.rowCount;
  } finally {
    client.release();
  }
}

async function saveLastStatus(id, lastStatus) {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO sessions (id, last_status, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (id) DO UPDATE SET last_status = $2, updated_at = now()`,
      [id, lastStatus]
    );
  } finally {
    client.release();
  }
}

async function loadLastStatus(id) {
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT last_status FROM sessions WHERE id = $1', [id]);
    return res.rows[0]?.last_status || null;
  } finally {
    client.release();
  }
}

async function loadSession(id) {
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT auth_json FROM sessions WHERE id = $1', [id]);
    return res.rows[0]?.auth_json || null;
  } finally {
    client.release();
  }
}

async function deleteSession(id) {
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM sessions WHERE id = $1', [id]);
  } finally {
    client.release();
  }
}

async function listSessions() {
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT id, created_at, updated_at FROM sessions ORDER BY updated_at DESC');
    return res.rows;
  } finally {
    client.release();
  }
}

export default {
  init,
  saveSession,
  loadSession,
  deleteSession,
  listSessions,
  pool
};
