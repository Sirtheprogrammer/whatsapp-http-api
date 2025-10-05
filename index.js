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

class SessionManager {
  constructor() {
    this.app = express();
    this.sockets = new Map(); // sessionId -> { sock, isConnected, saveCreds }
    this.authDir = './auth_sessions';

    if (!fs.existsSync(this.authDir)) fs.mkdirSync(this.authDir, { recursive: true });

    this.setupExpress();
    // initialize DB
    db.init().catch(err => {
      console.error('Failed to initialize DB:', err);
      process.exit(1);
    });
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
    
    // Error handling middleware
    this.app.use(this.errorHandler);
  }

  setupRoutes() {
    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'ok', 
        connected: this.isConnected,
        timestamp: new Date().toISOString()
      });
    });

    // Session management
    this.app.post('/sessions', this.createSession.bind(this));
    this.app.get('/sessions', this.listSessions.bind(this));
    this.app.post('/sessions/:id/pair-request', this.handlePairRequest.bind(this));
    this.app.post('/sessions/:id/send-message', this.handleSendMessage.bind(this));
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
      // still call saveCreds to maintain baileys expected behavior
      try { await saveCreds(); } catch (e) { /* no-op */ }
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
        const messageText = message.message.conversation || message.message.extendedTextMessage?.text;

        console.log(`[${sessionId}] 📨 Message from ${from}: ${messageText}`);

        // Example: Echo bot
        if (messageText && messageText.toLowerCase() === 'ping') {
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
}

// Start the manager
const manager = new SessionManager();
manager.start();
