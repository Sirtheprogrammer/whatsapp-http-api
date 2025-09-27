import express from 'express';
import makeWASocket, { 
  useMultiFileAuthState, 
  DisconnectReason,
  Browsers 
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import path from 'path';

class WhatsAppBot {
  constructor() {
    this.app = express();
    this.sock = null;
    this.isConnected = false;
    this.authPath = './auth_info_baileys';
    
    this.setupExpress();
    this.initializeBot();
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

    // Pairing code endpoint
    this.app.post('/pair-request', this.handlePairRequest.bind(this));
    
    // Connection status endpoint
    this.app.get('/status', (req, res) => {
      res.json({
        connected: this.isConnected,
        hasAuth: fs.existsSync(this.authPath)
      });
    });

    // Send message endpoint (example)
    this.app.post('/send-message', this.handleSendMessage.bind(this));
  }

  async initializeBot() {
    try {
      // Ensure auth directory exists
      if (!fs.existsSync(this.authPath)) {
        fs.mkdirSync(this.authPath, { recursive: true });
      }

      // Initialize authentication state
      const { state, saveCreds } = await useMultiFileAuthState(this.authPath);
      
      // Create socket with enhanced configuration
      this.sock = makeWASocket({
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

      this.setupEventHandlers(saveCreds);
      
    } catch (error) {
      console.error('Failed to initialize WhatsApp bot:', error);
      process.exit(1);
    }
  }

  setupEventHandlers(saveCreds) {
    // Handle credentials update
    this.sock.ev.on('creds.update', saveCreds);

    // Handle connection updates
    this.sock.ev.on('connection.update', async (update) => {
      await this.handleConnectionUpdate(update);
    });

    // Handle incoming messages
    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      await this.handleIncomingMessages(messages);
    });

    // Handle presence updates (optional)
    this.sock.ev.on('presence.update', (presenceUpdate) => {
      console.log('Presence update:', presenceUpdate);
    });
  }

  async handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;
    
    console.log(`Connection update: ${connection}`);
    
    if (connection === 'close') {
      this.isConnected = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      
      console.log('Connection closed due to:', lastDisconnect?.error?.message || 'Unknown reason');
      
      if (shouldReconnect) {
        console.log('Attempting to reconnect in 5 seconds...');
        setTimeout(() => this.initializeBot(), 5000);
      } else {
        console.log('❌ Logged out. Please re-authenticate by requesting a new pairing code.');
        // Clear auth files if logged out
        if (fs.existsSync(this.authPath)) {
          try {
            fs.rmSync(this.authPath, { recursive: true, force: true });
            console.log('🧹 Cleared authentication files');
          } catch (error) {
            console.error('Failed to clear auth files:', error);
          }
        }
      }
    } else if (connection === 'open') {
      this.isConnected = true;
      console.log('✅ Connected to WhatsApp successfully');
      
      // Test connection by getting own number
      try {
        const me = this.sock.user;
        console.log(`📱 Authenticated as: ${me?.name || me?.id || 'Unknown'}`);
      } catch (error) {
        console.log('Could not get user info:', error.message);
      }
    } else if (connection === 'connecting') {
      this.isConnected = false;
      console.log('🔄 Connecting to WhatsApp...');
    } else if (qr) {
      this.isConnected = false;
      console.log('📱 QR code received - use pairing code instead');
    }
  }

  async handleIncomingMessages(messages) {
    for (const message of messages) {
      if (!message.key.fromMe && message.message) {
        const from = message.key.remoteJid;
        const messageText = message.message.conversation || 
                           message.message.extendedTextMessage?.text;
        
        console.log(`📨 Message from ${from}: ${messageText}`);
        
        // Add your message handling logic here
        // Example: Echo bot
        if (messageText && messageText.toLowerCase() === 'ping') {
          await this.sendMessage(from, 'pong');
        }
      }
    }
  }

  async handlePairRequest(req, res) {
    try {
      const { number } = req.body;
      
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

      if (!this.sock) {
        return res.status(503).json({ 
          error: 'WhatsApp service not initialized' 
        });
      }

      console.log(`Requesting pairing code for: ${number}`);
      const code = await this.sock.requestPairingCode(cleanNumber);
      
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
      
      if (!to || !message) {
        return res.status(400).json({ 
          error: 'Both "to" and "message" fields are required' 
        });
      }

      if (!this.isConnected) {
        return res.status(503).json({ 
          error: 'WhatsApp is not connected' 
        });
      }

      const result = await this.sendMessage(to, message);
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

  async sendMessage(jid, text) {
    if (!this.sock) {
      throw new Error('WhatsApp socket is not initialized');
    }
    
    if (!this.isConnected) {
      throw new Error('WhatsApp is not connected. Please check connection status.');
    }
    
    try {
      // Format JID properly - ensure it's a valid WhatsApp ID
      let formattedJid;
      if (jid.includes('@')) {
        formattedJid = jid;
      } else {
        // Remove any non-digit characters and add country code if needed
        const cleanNumber = jid.replace(/\D/g, '');
        formattedJid = `${cleanNumber}@s.whatsapp.net`;
      }
      
      console.log(`Attempting to send message to: ${formattedJid}`);
      
      // Check if the number exists on WhatsApp first
      const [result] = await this.sock.onWhatsApp(formattedJid.replace('@s.whatsapp.net', ''));
      
      if (!result?.exists) {
        throw new Error('Phone number is not registered on WhatsApp');
      }
      
      // Send the message
      const sentMessage = await this.sock.sendMessage(formattedJid, { text });
      console.log(`✅ Message sent successfully to ${formattedJid}`);
      
      return sentMessage;
      
    } catch (error) {
      console.error(`❌ Failed to send message to ${jid}:`, error.message);
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
      console.log(`🔗 Pair device: POST http://localhost:${port}/pair-request`);
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n📴 Shutting down gracefully...');
      if (this.sock) {
        this.sock.end();
      }
      process.exit(0);
    });
  }
}

// Start the bot
const bot = new WhatsAppBot();
bot.start();
