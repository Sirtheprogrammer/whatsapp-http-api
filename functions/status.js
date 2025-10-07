import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import db from '../db.js';

const upload = multer({ dest: path.join(process.cwd(), 'uploads') });

// Registers status/broadcast routes on an express Router and returns it
export default function registerStatusRoutes(manager) {
  const router = express.Router();

  // Send a status/broadcast message via a session
  // POST /sessions/:id/status/send
  // body: { url, caption, backgroundColor, font, statusJidList: [], broadcast }
  // Support multipart uploads (field name: media) or JSON body with { type, url, caption }
  router.post('/sessions/:id/status/send', upload.single('media'), async (req, res) => {
    const sessionId = req.params.id;
    const { type = 'image', url, caption, backgroundColor, font, statusJidList, broadcast } = req.body;

    if (!sessionId) return res.status(400).json({ error: 'Session ID required' });
    const s = manager.sockets.get(sessionId);
    if (!s || !s.sock) return res.status(404).json({ error: 'Session not found or not initialized' });
    if (!s.isConnected) return res.status(503).json({ error: 'Session is not connected' });

    try {
      const jid = 'status@broadcast';
      const parsedStatusJidList = (() => {
        if (!statusJidList) return [];
        if (Array.isArray(statusJidList)) return statusJidList;
        try { return JSON.parse(statusJidList); } catch (e) { return [statusJidList]; }
      })();

      const sendOpts = {
        backgroundColor,
        font,
        statusJidList: parsedStatusJidList,
        broadcast: !!broadcast
      };

      // Ensure broadcast is true when sending to status@broadcast
      if (jid === 'status@broadcast') sendOpts.broadcast = true;

      // Helper to clean up uploaded file
      const cleanupUpload = async (file) => {
        if (!file) return;
        try { await fs.promises.unlink(file.path); } catch (e) { /* ignore */ }
      };

      let messageOptions = {};

      if (type === 'text') {
        if (!caption && !req.body.text) return res.status(400).json({ error: 'Text content required for text status' });
        messageOptions = { text: caption || req.body.text };
      } else if (type === 'image' || type === 'video') {
          // Prefer uploaded file if present
          if (req.file) {
            const buffer = fs.readFileSync(req.file.path);
            if (type === 'image') messageOptions = { image: buffer, caption: caption || '' };
            else messageOptions = { video: buffer, caption: caption || '' };
            // send and cleanup afterwards
            const result = await s.sock.sendMessage(jid, messageOptions, sendOpts);
            await cleanupUpload(req.file);
            return res.json({ success: true, result });
          }

          // Server-local path (for environments where media is already on disk)
          if (req.body.path) {
            const localPath = path.isAbsolute(req.body.path) ? req.body.path : path.join(process.cwd(), req.body.path);
            if (fs.existsSync(localPath)) {
              const buffer = fs.readFileSync(localPath);
              if (type === 'image') messageOptions = { image: buffer, caption: caption || '' };
              else messageOptions = { video: buffer, caption: caption || '' };
            } else {
              return res.status(400).json({ error: 'Local file path not found' });
            }
          }

          // Base64 inline data
          if (!messageOptions || Object.keys(messageOptions).length === 0) {
            if (req.body.base64) {
              // data URI allowed or raw base64
              const b = req.body.base64;
              const m = b.match(/^data:(.+);base64,(.+)$/);
              const raw = m ? m[2] : b;
              const buffer = Buffer.from(raw, 'base64');
              if (type === 'image') messageOptions = { image: buffer, caption: caption || '' };
              else messageOptions = { video: buffer, caption: caption || '' };
            }
          }

          // Otherwise allow remote URL provided in body
          if ((!messageOptions || Object.keys(messageOptions).length === 0) && url) {
            if (type === 'image') messageOptions = { image: { url }, caption: caption || '' };
            else messageOptions = { video: { url }, caption: caption || '' };
          }

          if (!messageOptions || Object.keys(messageOptions).length === 0) {
            return res.status(400).json({ error: 'Provide media via upload (form field "media"), server path, base64, or remote "url"' });
          }
      } else {
        return res.status(400).json({ error: 'Invalid type. Supported: text, image, video' });
      }

      const result = await s.sock.sendMessage(jid, messageOptions, sendOpts);
      // cache last status sent on the session object for diagnostics
      try {
        const sess = manager.sockets.get(sessionId);
        if (sess) sess.lastStatus = result;
        // Persist last status in DB as well
        await db.saveLastStatus(sessionId, result);
        // deliver status webhook if configured
        try {
          const webhooks = await db.loadWebhooks(sessionId).catch(() => null) || {};
          if (webhooks && webhooks.status) {
            // keep the payload small and useful
            const payload = { sessionId, result: { id: result.key?.id, remoteJid: result.key?.remoteJid, timestamp: Date.now() } };
            // best-effort POST
            try { await fetch(webhooks.status, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), timeout: 5000 }); } catch (e) { /* ignore webhook errors */ }
          }
        } catch (e) { /* ignore */ }
      } catch (e) { /* ignore caching/persist errors */ }
      res.json({ success: true, result });
    } catch (err) {
      console.error('Failed to send status:', err);
      res.status(500).json({ error: 'Failed to send status', details: err.message });
    }
  });

  // Query broadcast list info
  // GET /sessions/:id/broadcast/:jid
  router.get('/sessions/:id/broadcast/:jid', async (req, res) => {
    const sessionId = req.params.id;
    const bcastJid = req.params.jid;
    if (!sessionId) return res.status(400).json({ error: 'Session ID required' });
    if (!bcastJid) return res.status(400).json({ error: 'Broadcast JID required' });

    const s = manager.sockets.get(sessionId);
    if (!s || !s.sock) return res.status(404).json({ error: 'Session not found or not initialized' });

    try {
      const info = await s.sock.getBroadcastListInfo(bcastJid);
      res.json({ success: true, info });
    } catch (err) {
      console.error('Failed to query broadcast list:', err);
      res.status(500).json({ error: 'Failed to query broadcast list', details: err.message });
    }
  });

  return router;
}
