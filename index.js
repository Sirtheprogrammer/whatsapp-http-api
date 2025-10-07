import express from 'express';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import db from './db.js';
import registerStatusRoutes from './functions/status.js';

class SessionManager {
  constructor() {
    this.app = express();
    this.sockets = new Map(); // sessionId -> { sock, isConnected, saveCreds }
    this.authDir = './auth_sessions';

    // Record when the server instance was created so we can show uptime on the root page
    this.startTime = Date.now();

    if (!fs.existsSync(this.authDir)) fs.mkdirSync(this.authDir, { recursive: true });

  // store received messages per session in-memory (small cache)
  // structure: { [sessionId]: [ { id, from, isGroup, timestamp, text, raw } ] }
  this.receivedMessages = new Map();

    this.setupExpress();
    // initialize DB and restore sessions
    db.init().then(() => this.restoreSessions()).catch(err => {
      console.error('Failed to initialize DB or restore sessions:', err);
      process.exit(1);
    });
  }

  // Restore sessions previously saved in the DB
  async restoreSessions() {
    try {
      const rows = await db.listSessions();
      for (const r of rows) {
        const id = r.id;
        // load persisted auth to check if session appears paired
        let saved = await db.loadSession(id).catch(() => null);
        let hasCreds = saved && (saved['creds.json']?.me || saved.creds?.me);
        // Fallback: if DB doesn't have creds, check filesystem for creds.json
        if (!hasCreds) {
          const folder = path.join(this.authDir, id);
          const credsPath = path.join(folder, 'creds.json');
          if (fs.existsSync(credsPath)) {
            try {
              const data = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
              if (data && data.me) {
                hasCreds = true;
                // ensure DB is updated with filesystem state for future restarts
                const out = {};
                const files = fs.readdirSync(folder);
                for (const f of files) {
                  try {
                    out[f] = JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8'));
                  } catch (e) { /* ignore parse errors */ }
                }
                saved = out;
                await db.saveSession(id, out).catch(e => console.error('Failed to save session from fs to DB', id, e));
              }
            } catch (e) {
              // ignore parse errors
            }
          }
        }
        if (!hasCreds) {
          console.log(`Skipping restore for ${id} - no credentials present`);
          continue;
        }
        // start each paired session but don't block startup
        this.startSession(id).then(() => {
          console.log(`Restored session ${id}`);
        }).catch(err => {
          console.error(`Failed to restore session ${id}:`, err.message || err);
        });
      }
      // Also scan filesystem for any auth folders not present in DB and restore them
      try {
        const folders = fs.readdirSync(this.authDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
        const dbIds = new Set(rows.map(r => r.id));
        for (const id of folders) {
          if (dbIds.has(id)) continue;
          const credsPath = path.join(this.authDir, id, 'creds.json');
          if (!fs.existsSync(credsPath)) continue;
          try {
            const data = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
            if (data && data.me) {
              // import into DB and start session
              const out = {};
              const files = fs.readdirSync(path.join(this.authDir, id));
              for (const f of files) {
                try { out[f] = JSON.parse(fs.readFileSync(path.join(this.authDir, id, f), 'utf8')); } catch (e) { }
              }
              await db.saveSession(id, out).catch(e => console.error('Failed to import session from fs to DB', id, e));
              this.startSession(id).then(() => console.log(`Imported and restored session ${id}`)).catch(err => console.error(`Failed to restore imported session ${id}:`, err));
            }
          } catch (e) { /* ignore parse errors */ }
        }
      } catch (e) {
        // ignore filesystem scan errors
      }
    } catch (err) {
      console.error('Failed to load sessions from DB:', err.message || err);
    }
  }

  setupExpress() {
    // Middleware
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    
    // Basic security headers
    this.app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      next();
    });

    // Routes
  this.setupRoutes();
  // mount status/broadcast routes
  this.app.use('/', registerStatusRoutes(this));
    
    // Error handling middleware
    this.app.use(this.errorHandler);
  }

  setupRoutes() {
    // Root page: simple HTML showing uptime and copyright
    this.app.get('/', (req, res) => {
      const uptimeMs = Date.now() - this.startTime;
      const seconds = Math.floor(uptimeMs / 1000) % 60;
      const minutes = Math.floor(uptimeMs / 60000) % 60;
      const hours = Math.floor(uptimeMs / 3600000);
      const pretty = `${hours}h ${minutes}m ${seconds}s`;
      const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>whatsapp-hhtp-api</title>
    <style>body{font-family:Arial,Helvetica,sans-serif;background:#f7f7f7;color:#222;display:flex;align-items:center;justify-content:center;height:100vh;margin:0} .card{background:#fff;padding:24px;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,0.08);max-width:420px;text-align:center} h1{margin:0 0 8px;font-size:20px} p{margin:6px 0;color:#555} footer{margin-top:12px;font-size:12px;color:#999}</style>
  </head>
  <body>
    <div class="card">
      <h1>whatsapp-http-api</h1>
      <p>API uptime: <strong>${pretty}</strong></p>
      <footer>© made by codeskytz</footer>
    </div>
  </body>
</html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    });
    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'ok', 
        connected: this.isConnected,
        timestamp: new Date().toISOString()
      });
    });

    // Diagnostic: get last status sent by a session
    this.app.get('/sessions/:id/status/last', (req, res) => {
      const id = req.params.id;
      if (!id) return res.status(400).json({ error: 'Session ID required' });
      const s = this.sockets.get(id);
      if (!s) return res.status(404).json({ error: 'Session not found' });
      (async () => {
        if (s.lastStatus) return res.json({ lastStatus: s.lastStatus });
        try {
          const last = await db.loadLastStatus(id).catch(() => null);
          return res.json({ lastStatus: last || null });
        } catch (e) {
          return res.json({ lastStatus: null });
        }
      })();
    });

    // Get received messages for a session
    // Query params:
    // - type=group|individual (optional)
    // - limit=number (optional, default 50)
    // - since=unix ms timestamp (optional)
    this.app.get('/sessions/:id/messages', async (req, res) => {
      try {
        const sessionId = req.params.id;
        if (!sessionId) return res.status(400).json({ error: 'Session ID required' });

        const { type, limit, since } = req.query;
        const opts = { type: type || undefined, limit: Number(limit) || 50, since: since ? Number(since) : undefined };

        try {
          const rows = await db.getMessages(sessionId, opts);
          return res.json({ count: rows.length, messages: rows });
        } catch (e) {
          // fallback to in-memory cache
          const all = this.receivedMessages.get(sessionId) || [];
          let results = all.slice();
          if (opts.type === 'group') results = results.filter(m => m.isGroup);
          if (opts.type === 'individual') results = results.filter(m => !m.isGroup);
          if (opts.since) results = results.filter(m => m.timestamp >= opts.since);
          const lim = Math.min(500, Math.max(1, opts.limit || 50));
          results = results.slice(0, lim);
          const sanitized = results.map(r => ({ id: r.id, from: r.from, isGroup: r.isGroup, timestamp: r.timestamp, text: r.text }));
          return res.json({ count: sanitized.length, messages: sanitized });
        }
      } catch (err) {
        console.error('Failed to list messages:', err);
        res.status(500).json({ error: 'Failed to get messages', details: err.message });
      }
    });

    // Session management
    this.app.post('/sessions', this.createSession.bind(this));
    this.app.get('/sessions', this.listSessions.bind(this));
    // Get or set webhooks for a session
    this.app.get('/sessions/:id/webhooks', async (req, res) => {
      const sessionId = req.params.id;
      if (!sessionId) return res.status(400).json({ error: 'Session ID required' });
      try {
        const w = await db.loadWebhooks(sessionId).catch(() => null);
        res.json({ webhooks: w || {} });
      } catch (e) {
        res.status(500).json({ error: 'Failed to load webhooks', details: e.message });
      }
    });

    this.app.post('/sessions/:id/webhooks', async (req, res) => {
      const sessionId = req.params.id;
      if (!sessionId) return res.status(400).json({ error: 'Session ID required' });
      const { incoming, group, status } = req.body;
      const payload = { incoming: incoming || null, group: group || null, status: status || null };
      try {
        await db.saveWebhooks(sessionId, payload);
        res.json({ success: true, webhooks: payload });

        // asynchronously attempt to deliver any undelivered messages to the newly set webhooks
        (async () => {
          try {
            // if incoming webhook set, forward undelivered individual messages
            if (incoming) {
              const pending = await db.getUndeliveredMessages(sessionId);
              for (const m of pending) {
                // forward only individual messages (not groups)
                if (m.isGroup) continue;
                try {
                  const payload = this.buildWebhookPayload(m);
                  await this.postToWebhook(incoming, payload);
                  await db.updateMessageDelivery(m.id, { delivered: true, pending_webhook: null, last_delivery_error: null }).catch(() => null);
                } catch (e) {
                  await db.updateMessageDelivery(m.id, { delivered: false, pending_webhook: incoming, last_delivery_error: String(e.message || e) }).catch(() => null);
                }
              }
            }

            // if group webhook set, forward undelivered group messages
            if (group) {
              const pending = await db.getUndeliveredMessages(sessionId);
              for (const m of pending) {
                if (!m.isGroup) continue;
                try {
                  const payload = this.buildWebhookPayload(m);
                  await this.postToWebhook(group, payload);
                  await db.updateMessageDelivery(m.id, { delivered: true, pending_webhook: null, last_delivery_error: null }).catch(() => null);
                } catch (e) {
                  await db.updateMessageDelivery(m.id, { delivered: false, pending_webhook: group, last_delivery_error: String(e.message || e) }).catch(() => null);
                }
              }
            }
          } catch (err) {
            console.error('Failed to forward pending messages after webhook update', err);
          }
        })();
      } catch (e) {
        res.status(500).json({ error: 'Failed to save webhooks', details: e.message });
      }
    });
    
    // Partially update webhooks for a session (body may contain incoming, group, status)
    this.app.patch('/sessions/:id/webhooks', async (req, res) => {
      const sessionId = req.params.id;
      if (!sessionId) return res.status(400).json({ error: 'Session ID required' });
      const { incoming, group, status } = req.body || {};
      try {
        // load existing and merge
        const existing = await db.loadWebhooks(sessionId).catch(() => ({})) || {};
        const merged = Object.assign({}, existing);
        if (typeof incoming !== 'undefined') merged.incoming = incoming;
        if (typeof group !== 'undefined') merged.group = group;
        if (typeof status !== 'undefined') merged.status = status;
        await db.saveWebhooks(sessionId, merged);
        res.json({ success: true, webhooks: merged });
      } catch (e) {
        res.status(500).json({ error: 'Failed to update webhooks', details: e.message });
      }
    });

    // Delete webhooks: body optional { type: 'incoming'|'group'|'status' }. If no type, clear all webhooks for session.
    this.app.delete('/sessions/:id/webhooks', async (req, res) => {
      const sessionId = req.params.id;
      if (!sessionId) return res.status(400).json({ error: 'Session ID required' });
      const { type } = req.body || {};
      try {
        const existing = await db.loadWebhooks(sessionId).catch(() => ({})) || {};
        if (!type) {
          // clear all
          await db.saveWebhooks(sessionId, {});
          return res.json({ success: true, webhooks: {} });
        }
        if (!['incoming', 'group', 'status'].includes(type)) return res.status(400).json({ error: 'Invalid webhook type' });
        const copy = Object.assign({}, existing);
        delete copy[type];
        await db.saveWebhooks(sessionId, copy);
        res.json({ success: true, webhooks: copy });
      } catch (e) {
        res.status(500).json({ error: 'Failed to delete webhooks', details: e.message });
      }
    });
    this.app.post('/sessions/:id/pair-request', this.handlePairRequest.bind(this));
    this.app.post('/sessions/:id/send-message', this.handleSendMessage.bind(this));
    // forward messages to an arbitrary webhook immediately (body: { webhook, ids?: [id,...] })
    this.app.post('/sessions/:id/forward', async (req, res) => {
      const sessionId = req.params.id;
      const { webhook, ids } = req.body || {};
      if (!sessionId) return res.status(400).json({ error: 'Session ID required' });
      if (!webhook) return res.status(400).json({ error: 'Webhook URL required in body' });
      try {
        const messages = ids && Array.isArray(ids) && ids.length ? await db.getMessagesByIds(ids, sessionId) : await db.getMessages(sessionId, { limit: 50 });
        const results = [];
        for (const m of messages) {
          try {
            const payload = this.buildWebhookPayload(m);
            await this.postToWebhook(webhook, payload);
            await db.updateMessageDelivery(m.id, { delivered: true, pending_webhook: null, last_delivery_error: null });
            results.push({ id: m.id, status: 'delivered' });
          } catch (e) {
            await db.updateMessageDelivery(m.id, { delivered: false, pending_webhook: webhook, last_delivery_error: String(e.message || e) }).catch(() => null);
            results.push({ id: m.id, status: 'pending', error: String(e.message || e) });
          }
        }
        res.json({ results });
      } catch (e) {
        res.status(500).json({ error: 'Failed to forward messages', details: e.message });
      }
    });

    // list undelivered or pending messages
    this.app.get('/sessions/:id/undelivered', async (req, res) => {
      const sessionId = req.params.id;
      if (!sessionId) return res.status(400).json({ error: 'Session ID required' });
      try {
        const rows = await db.getUndeliveredMessages(sessionId);
        res.json({ count: rows.length, messages: rows });
      } catch (e) {
        res.status(500).json({ error: 'Failed to list undelivered messages', details: e.message });
      }
    });

    // retry forwarding specific messages (body: { ids?: [id,...], webhook?: url })
    this.app.post('/sessions/:id/forward/retry', async (req, res) => {
      const sessionId = req.params.id;
      const { ids, webhook } = req.body || {};
      if (!sessionId) return res.status(400).json({ error: 'Session ID required' });
      try {
        const messages = ids && Array.isArray(ids) && ids.length ? await db.getMessagesByIds(ids, sessionId) : await db.getUndeliveredMessages(sessionId, webhook);
        const results = [];
        for (const m of messages) {
          const target = webhook || m.pendingWebhook || null;
          if (!target) {
            results.push({ id: m.id, status: 'skipped', reason: 'no webhook configured' });
            continue;
          }
          try {
            const payload = this.buildWebhookPayload(m);
            await this.postToWebhook(target, payload);
            await db.updateMessageDelivery(m.id, { delivered: true, pending_webhook: null, last_delivery_error: null });
            results.push({ id: m.id, status: 'delivered' });
          } catch (e) {
            await db.updateMessageDelivery(m.id, { delivered: false, pending_webhook: target, last_delivery_error: String(e.message || e) }).catch(() => null);
            results.push({ id: m.id, status: 'pending', error: String(e.message || e) });
          }
        }
        res.json({ results });
      } catch (e) {
        res.status(500).json({ error: 'Failed to retry forwarding', details: e.message });
      }
    });
    this.app.get('/sessions/:id/status', this.getSessionStatus.bind(this));
    this.app.post('/sessions/:id/sync', this.syncSession.bind(this));
    this.app.delete('/sessions/:id', this.deleteSession.bind(this));
  }

  // Create and start a session (does not pair automatically)
  async createSession(req, res) {
    try {
      const id = uuidv4();
  // create an empty auth folder for this session
  const folder = path.join(this.authDir, id);
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

      // Save placeholder in DB
      await db.saveSession(id, {});

      // Start the socket and wait for initialization
      try {
        const sock = await this.startSession(id);
        const exists = !!sock;
        res.status(201).json({ id, initialized: exists });
      } catch (err) {
        console.error('Failed to start session:', err);
        res.status(201).json({ id, initialized: false, error: err.message });
      }
    } catch (error) {
      console.error('Error creating session:', error);
      res.status(500).json({ error: 'Failed to create session', details: error.message });
    }
  }

  setupSocketEventHandlers(sessionId, sock, saveCreds) {
    // Persist creds to DB whenever they update
    sock.ev.on('creds.update', async () => {
      try {
        // first let Baileys persist to files
        try { await saveCreds(); } catch (e) { /* continue even if saveCreds fails */ }

        const folder = path.join(this.authDir, sessionId);
        const out = {};
        if (fs.existsSync(folder)) {
          const files = fs.readdirSync(folder);
          for (const f of files) {
            try {
              const content = fs.readFileSync(path.join(folder, f), 'utf8');
              out[f] = JSON.parse(content);
            } catch (e) {
              // skip parse errors for non-json files
            }
          }
        }
        await db.saveSession(sessionId, out);
      } catch (err) {
        console.error('Failed to persist creds to DB for session', sessionId, err);
      }
    });

    sock.ev.on('connection.update', async (update) => {
      await this.handleConnectionUpdate(sessionId, update);
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
      await this.handleIncomingMessages(sessionId, messages);
    });

    sock.ev.on('presence.update', (presenceUpdate) => {
      console.log(`[${sessionId}] Presence update:`, presenceUpdate);
    });
  }

  async handleConnectionUpdate(sessionId, update) {
    const { connection, lastDisconnect, qr } = update;

    console.log(`[${sessionId}] Connection update: ${connection}`);

    const s = this.sockets.get(sessionId);
    if (!s) return;

    if (connection === 'close') {
      s.isConnected = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      console.log(`[${sessionId}] Connection closed due to:`, lastDisconnect?.error?.message || 'Unknown reason');

      if (shouldReconnect) {
        console.log(`[${sessionId}] Attempting to reconnect in 5 seconds...`);
        setTimeout(() => this.startSession(sessionId), 5000);
      } else {
        console.log(`[${sessionId}] ❌ Logged out. Clearing stored auth and DB record.`);
        await db.deleteSession(sessionId).catch(e => console.error('Failed to delete session from DB', e));
        // remove auth folder
        const authFolder = path.join(this.authDir, sessionId);
        if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
        this.sockets.delete(sessionId);
      }
    } else if (connection === 'open') {
      s.isConnected = true;
      console.log(`[${sessionId}] ✅ Connected to WhatsApp successfully`);

      try {
        const me = s.sock.user;
        console.log(`[${sessionId}] 📱 Authenticated as: ${me?.name || me?.id || 'Unknown'}`);
      } catch (error) {
        console.log(`[${sessionId}] Could not get user info:`, error.message);
      }
      // ensure creds are saved to DB now that session is open
      try {
        if (s.saveCreds) await s.saveCreds();
      } catch (e) { /* ignore */ }
      try {
        const folder = path.join(this.authDir, sessionId);
        const out = {};
        if (fs.existsSync(folder)) {
          const files = fs.readdirSync(folder);
          for (const f of files) {
            try { out[f] = JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8')); } catch (e) { }
          }
        }
        await db.saveSession(sessionId, out).catch(e => console.error('Failed to save session on open', sessionId, e));
      } catch (e) { /* ignore */ }
    } else if (connection === 'connecting') {
      s.isConnected = false;
      console.log(`[${sessionId}] 🔄 Connecting to WhatsApp...`);
    } else if (qr) {
      s.isConnected = false;
      console.log(`[${sessionId}] 📱 QR code received - use pairing code instead`);
    }
  }

  async handleIncomingMessages(sessionId, messages) {
    for (const message of messages) {
      if (!message.key.fromMe && message.message) {
        const from = message.key.remoteJid;
        const isGroup = from && from.endsWith('@g.us');
        const timestamp = (message.messageTimestamp || Date.now()) * 1000;
        const text = message.message.conversation || message.message.extendedTextMessage?.text || null;

        console.log(`[${sessionId}] 📨 Message from ${from}: ${text}`);

        // persist in-memory for quick access
        let entry = null;
        try {
          const store = this.receivedMessages.get(sessionId) || [];
          // populate entry (declared outside so webhook code below can access it)
          entry = {
            id: message.key.id || `${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
            from,
            isGroup,
            timestamp,
            text,
            raw: message
          };
          store.unshift(entry); // latest first
          // trim to a reasonable max (keep last 500 messages per session)
          if (store.length > 500) store.length = 500;
          this.receivedMessages.set(sessionId, store);
        } catch (e) {
          console.error('Failed to store incoming message in memory', e);
        }

        // persist to DB and deliver webhook if configured
        try {
          // try to persist the message to DB (best-effort)
          try {
            await db.saveMessage(sessionId, entry).catch(() => null);
          } catch (e) {
            // ignore DB persistence errors
          }

          // read webhooks and post sanitized payload
          const webhooks = await db.loadWebhooks(sessionId).catch(() => null) || {};
          // ensure entry exists (storage may have failed)
          if (entry) {
            const payload = this.buildWebhookPayload(entry);
            const target = entry.isGroup ? webhooks.group : webhooks.incoming;
            if (target) {
              try {
                await this.postToWebhook(target, payload);
                // mark delivered in DB
                await db.updateMessageDelivery(entry.id, { delivered: true, pending_webhook: null, last_delivery_error: null }).catch(() => null);
              } catch (err) {
                console.error('Webhook delivery failed', err);
                // mark pending and save last error
                await db.updateMessageDelivery(entry.id, { delivered: false, pending_webhook: target, last_delivery_error: String(err.message || err) }).catch(() => null);
              }
            }
          }
        } catch (e) {
          console.error('Failed to process webhook for incoming message', e);
        }

        // Example: Echo bot
        if (text && text.toLowerCase() === 'ping') {
          await this.sendMessage(sessionId, from, 'pong').catch(e => console.error(e));
        }
      }
    }
  }


  async handlePairRequest(req, res) {
    try {
      const { number } = req.body;
      const sessionId = req.params.id;

      if (!sessionId) return res.status(400).json({ error: 'Session ID is required in the URL' });
      
      // Validate phone number
      if (!number || typeof number !== 'string') {
        return res.status(400).json({ 
          error: 'Valid phone number is required',
          example: '+1234567890'
        });
      }

      // Basic phone number format validation
      const cleanNumber = number.replace(/\D/g, '');
      if (cleanNumber.length < 10 || cleanNumber.length > 15) {
        return res.status(400).json({ 
          error: 'Phone number must be between 10-15 digits' 
        });
      }

      const session = this.sockets.get(sessionId);
      if (!session || !session.sock) {
        return res.status(503).json({ error: 'Session is not initialized or not running' });
      }

      console.log(`[${sessionId}] Requesting pairing code for: ${number}`);
      const code = await session.sock.requestPairingCode(cleanNumber);
      
      res.json({ 
        success: true,
        pairingCode: code,
        message: 'Enter this code in WhatsApp to pair your device'
      });
      
    } catch (error) {
      console.error('Error requesting pairing code:', error);
      res.status(500).json({ 
        error: 'Failed to request pairing code',
        details: error.message
      });
    }
  }

  async handleSendMessage(req, res) {
    try {
      const { to, message } = req.body;
      const sessionId = req.params.id;
      if (!sessionId) return res.status(400).json({ error: 'Session ID is required in the URL' });
      
      if (!to || !message) {
        return res.status(400).json({ 
          error: 'Both "to" and "message" fields are required' 
        });
      }

      const session = this.sockets.get(sessionId);
      if (!session) return res.status(503).json({ error: 'Session not found' });
      if (!session.isConnected) return res.status(503).json({ error: 'WhatsApp is not connected for this session' });

      const result = await this.sendMessage(sessionId, to, message);
      res.json({ 
        success: true, 
        messageId: result.key.id,
        timestamp: result.messageTimestamp
      });
      
    } catch (error) {
      console.error('Error sending message:', error);
      res.status(500).json({ 
        error: 'Failed to send message',
        details: error.message
      });
    }
  }

  async syncSession(req, res) {
    const sessionId = req.params.id;
    if (!sessionId) return res.status(400).json({ error: 'Session ID required' });
    try {
      const folder = path.join(this.authDir, sessionId);
      if (!fs.existsSync(folder)) return res.status(404).json({ error: 'Session auth folder not found' });
      const out = {};
      const files = fs.readdirSync(folder);
      for (const f of files) {
        try { out[f] = JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8')); } catch (e) { }
      }
      await db.saveSession(sessionId, out);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to sync session', details: err.message });
    }
  }

  async getSessionStatus(req, res) {
    const sessionId = req.params.id;
    if (!sessionId) return res.status(400).json({ error: 'Session ID required' });
    try {
      const s = this.sockets.get(sessionId);
      const folder = path.join(this.authDir, sessionId);
      const hasFiles = fs.existsSync(folder) && fs.readdirSync(folder).length > 0;
      const dbRow = await db.loadSession(sessionId).catch(() => null);
      const hasDbCreds = !!(dbRow && (dbRow['creds.json']?.me || dbRow.creds?.me));
      res.json({
        id: sessionId,
        connected: !!s?.isConnected,
        hasFiles,
        hasDbCreds
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to get status', details: err.message });
    }
  }

  async sendMessage(sessionId, jid, text) {
    const session = this.sockets.get(sessionId);
    if (!session || !session.sock) throw new Error('WhatsApp socket is not initialized for this session');
    if (!session.isConnected) throw new Error('WhatsApp is not connected. Please check connection status.');

    try {
      let formattedJid;
      if (jid.includes('@')) {
        formattedJid = jid;
      } else {
        const cleanNumber = jid.replace(/\D/g, '');
        formattedJid = `${cleanNumber}@s.whatsapp.net`;
      }

      console.log(`[${sessionId}] Attempting to send message to: ${formattedJid}`);

      const [result] = await session.sock.onWhatsApp(formattedJid.replace('@s.whatsapp.net', ''));
      if (!result?.exists) throw new Error('Phone number is not registered on WhatsApp');

      const sentMessage = await session.sock.sendMessage(formattedJid, { text });
      console.log(`[${sessionId}] ✅ Message sent successfully to ${formattedJid}`);
      return sentMessage;
    } catch (error) {
      console.error(`[${sessionId}] ❌ Failed to send message to ${jid}:`, error.message);
      throw error;
    }
  }

  errorHandler(err, req, res, next) {
    console.error('Express error:', err);
    
    if (res.headersSent) {
      return next(err);
    }
    
    res.status(500).json({ 
      error: 'Internal server error',
      timestamp: new Date().toISOString()
    });
  }

  // POST JSON payload to webhook URL with a short timeout
  async postToWebhook(url, payload) {
    if (!url) return;
    try {
      // use global fetch (Node 18+). Set a short timeout via AbortController
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(id);
      if (!res.ok) {
        const txt = await res.text().catch(() => '<no-body>');
        throw new Error(`Webhook POST failed: ${res.status} ${txt}`);
      }
      return true;
    } catch (e) {
      // swallow errors here; caller logs
      throw e;
    }
  }

  // Try to extract an international phone number (+123...) from a jid or raw message
  formatSenderNumber(jid, raw) {
    try {
      // raw may contain participant for group messages
      let candidate = null;
      if (raw && raw.key && raw.key.participant) candidate = raw.key.participant;
      if (!candidate && raw && raw.participant) candidate = raw.participant;
      if (!candidate) candidate = jid;
      if (!candidate) return null;
      // candidate may be like '255683568254@s.whatsapp.net' or '255683568254:12@s.whatsapp.net'
      const m = String(candidate).match(/(\d{6,15})/);
      if (!m) return null;
      return `+${m[1]}`;
    } catch (e) {
      return null;
    }
  }

  // Build a normalized payload for webhooks including both the raw JID and a formatted international number when possible
  buildWebhookPayload(message) {
    // message may be an 'entry' created in memory or a DB row
    const fromJid = message.from || message.from_jid || null;
    const formatted = this.formatSenderNumber(fromJid, message.raw || null) || null;
    return {
      id: message.id,
      fromJid,
      from: formatted,
      isGroup: !!message.isGroup,
      timestamp: message.timestamp || message.timestamp_ms || null,
      text: message.text || null,
      delivered: typeof message.delivered !== 'undefined' ? !!message.delivered : undefined,
      deliveryAttempts: message.deliveryAttempts || message.delivery_attempts || 0,
      lastDeliveryError: message.lastDeliveryError || message.last_delivery_error || null,
      pendingWebhook: message.pendingWebhook || message.pending_webhook || null,
      raw: message.raw || null
    };
  }

  start(port = 3000) {
    this.app.listen(port, () => {
      console.log(`🚀 WhatsApp Bot server running on http://localhost:${port}`);
      console.log(`📊 Health check: http://localhost:${port}/health`);
      console.log(`🔗 Create session: POST http://localhost:${port}/sessions`);
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n📴 Shutting down gracefully...');
      // close all active sockets
      for (const [id, s] of this.sockets.entries()) {
        try {
          if (s.sock) s.sock.end();
        } catch (e) { /* ignore */ }
      }
      process.exit(0);
    });
  }


  // Start a socket for a session (or restart)
  async startSession(sessionId) {
    // load auth from DB if available and write into session folder
    const folder = path.join(this.authDir, sessionId);
    let saved = await db.loadSession(sessionId).catch(() => null);
    if (saved) {
      try {
        if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
        for (const [fname, content] of Object.entries(saved)) {
          try {
            fs.writeFileSync(path.join(folder, fname), JSON.stringify(content, null, 2));
          } catch (e) {
            console.error('Failed to write auth file', fname, e);
          }
        }
      } catch (e) {
        console.error('Failed to restore auth files for session', sessionId, e);
      }
    }

    const { state, saveCreds } = await useMultiFileAuthState(folder);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      keepAliveIntervalMs: 30000,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
    });

    this.sockets.set(sessionId, { sock, isConnected: false, saveCreds });
    this.setupSocketEventHandlers(sessionId, sock, saveCreds);
    
    return sock;
  }

  async listSessions(req, res) {
    try {
      const rows = await db.listSessions();
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: 'Failed to list sessions', details: err.message });
    }
  }

  async deleteSession(req, res) {
    const sessionId = req.params.id;
    if (!sessionId) return res.status(400).json({ error: 'Session ID required' });
    try {
      const s = this.sockets.get(sessionId);
      if (s && s.sock) s.sock.end();
      this.sockets.delete(sessionId);
      await db.deleteSession(sessionId);
      const authFile = path.join(this.authDir, `${sessionId}.json`);
      if (fs.existsSync(authFile)) fs.rmSync(authFile, { force: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete session', details: err.message });
    }
  }

  async getSessionStatus(req, res) {
    const sessionId = req.params.id;
    if (!sessionId) return res.status(400).json({ error: 'Session ID required' });
    try {
      const s = this.sockets.get(sessionId);
      const folder = path.join(this.authDir, sessionId);
      const hasAuth = fs.existsSync(folder) && fs.readdirSync(folder).length > 0;
      res.json({
        id: sessionId,
        connected: !!(s && s.isConnected),
        running: !!s,
        hasAuth
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to get session status', details: err.message });
    }
  }
}

// Start the manager
const manager = new SessionManager();
manager.start();
