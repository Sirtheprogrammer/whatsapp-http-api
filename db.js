import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://sirtheprogrammer:91JDib75NISrkKNZ4Aakhyyzz7aBPh77@dpg-d3ge05p5pdvs73ee0040-a.oregon-postgres.render.com/wtssession';

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
        webhooks JSONB,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    // messages table for persisted incoming messages
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        from_jid TEXT,
        is_group BOOLEAN DEFAULT FALSE,
        timestamp_ms BIGINT,
        text TEXT,
        raw JSONB,
        delivered BOOLEAN DEFAULT FALSE,
        delivered_at TIMESTAMPTZ,
        delivery_attempts INTEGER DEFAULT 0,
        last_delivery_error TEXT,
        pending_webhook TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    // ensure columns exist for older DBs
    try {
      await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivered BOOLEAN DEFAULT FALSE`);
      await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ`);
      await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery_attempts INTEGER DEFAULT 0`);
      await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS last_delivery_error TEXT`);
      await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS pending_webhook TEXT`);
    } catch (e) {
      // ignore
    }
    // Ensure column exists for older DBs
    try {
      await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_status JSONB`);
      await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS webhooks JSONB`);
    } catch (e) {
      // ignore
    }
  } finally {
    client.release();
  }
}

async function saveMessage(sessionId, message) {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO messages (id, session_id, from_jid, is_group, timestamp_ms, text, raw, delivered, delivery_attempts, last_delivery_error, pending_webhook)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO NOTHING`,
      [message.id, sessionId, message.from, message.isGroup, message.timestamp, message.text, message.raw, message.delivered || false, message.delivery_attempts || 0, message.last_delivery_error || null, message.pending_webhook || null]
    );
  } finally {
    client.release();
  }
}

async function getMessages(sessionId, opts = {}) {
  const client = await pool.connect();
  try {
    const { limit = 50, since, type } = opts;
    const vals = [sessionId];
    let idx = 2;
    let where = 'WHERE session_id = $1';

    if (type === 'group') {
      where += ` AND is_group = true`;
    } else if (type === 'individual') {
      where += ` AND is_group = false`;
    }

    if (since) {
      where += ` AND timestamp_ms >= $${idx}`;
      vals.push(since);
      idx++;
    }

    vals.push(Math.min(500, Math.max(1, Number(limit) || 50)));

    const q = `SELECT id, from_jid, is_group, timestamp_ms, text, delivered, delivery_attempts, last_delivery_error, pending_webhook FROM messages ${where} ORDER BY timestamp_ms DESC LIMIT $${idx}`;
    const res = await client.query(q, vals);
    return res.rows.map(r => ({ id: r.id, from: r.from_jid, isGroup: r.is_group, timestamp: Number(r.timestamp_ms), text: r.text, delivered: !!r.delivered, deliveryAttempts: r.delivery_attempts || 0, lastDeliveryError: r.last_delivery_error || null, pendingWebhook: r.pending_webhook || null }));
  } finally {
    client.release();
  }
}

async function getMessagesByIds(ids = [], sessionId) {
  if (!ids || ids.length === 0) return [];
  const client = await pool.connect();
  try {
    const vals = [ids];
    let q = `SELECT id, from_jid, is_group, timestamp_ms, text, delivered, delivery_attempts, last_delivery_error, pending_webhook FROM messages WHERE id = ANY($1)`;
    if (sessionId) {
      q += ` AND session_id = '${sessionId.replace(/'/g, "''")}'`;
    }
    const res = await client.query(q, vals);
    return res.rows.map(r => ({ id: r.id, from: r.from_jid, isGroup: r.is_group, timestamp: Number(r.timestamp_ms), text: r.text, delivered: !!r.delivered, deliveryAttempts: r.delivery_attempts || 0, lastDeliveryError: r.last_delivery_error || null, pendingWebhook: r.pending_webhook || null }));
  } finally {
    client.release();
  }
}

async function updateMessageDelivery(id, { delivered = false, pending_webhook = null, last_delivery_error = null } = {}) {
  const client = await pool.connect();
  try {
    // increment attempts and set delivered/pending/error accordingly
    await client.query(
      `UPDATE messages SET
         delivery_attempts = COALESCE(delivery_attempts,0) + 1,
         delivered = $2,
         delivered_at = CASE WHEN $2 THEN now() ELSE delivered_at END,
         last_delivery_error = $3,
         pending_webhook = $4
       WHERE id = $1`,
      [id, delivered, last_delivery_error, pending_webhook]
    );
  } finally {
    client.release();
  }
}

async function getUndeliveredMessages(sessionId, webhook) {
  const client = await pool.connect();
  try {
    const vals = [sessionId];
    let q = `SELECT id, from_jid, is_group, timestamp_ms, text, delivered, delivery_attempts, last_delivery_error, pending_webhook FROM messages WHERE session_id = $1 AND (delivered = false OR pending_webhook IS NOT NULL)`;
    if (webhook) {
      vals.push(webhook);
      q += ` AND pending_webhook = $2`;
    }
    q += ` ORDER BY timestamp_ms DESC`;
    const res = await client.query(q, vals);
    return res.rows.map(r => ({ id: r.id, from: r.from_jid, isGroup: r.is_group, timestamp: Number(r.timestamp_ms), text: r.text, delivered: !!r.delivered, deliveryAttempts: r.delivery_attempts || 0, lastDeliveryError: r.last_delivery_error || null, pendingWebhook: r.pending_webhook || null }));
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

async function saveWebhooks(id, webhooks) {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO sessions (id, webhooks, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (id) DO UPDATE SET webhooks = $2, updated_at = now()`,
      [id, webhooks]
    );
  } finally {
    client.release();
  }
}

async function loadWebhooks(id) {
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT webhooks FROM sessions WHERE id = $1', [id]);
    return res.rows[0]?.webhooks || null;
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
  saveLastStatus,
  loadLastStatus,
  saveWebhooks,
  loadWebhooks,
  saveMessage,
  getMessages,
  getMessagesByIds,
  updateMessageDelivery,
  getUndeliveredMessages,
  pool
};
