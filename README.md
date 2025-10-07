# WhatsApp HTTP API

![Node.js](https://img.shields.io/badge/Node.js-18+-green?logo=node.js\&logoColor=white)
![Express](https://img.shields.io/badge/Express.js-Backend-lightgrey?logo=express)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Database-blue?logo=postgresql)
![License](https://img.shields.io/badge/License-MIT-yellow)
![Status](https://img.shields.io/badge/Status-Stable-success)

A high-performance **Node.js REST API** for managing WhatsApp sessions and sending messages using **Baileys**.
Supports multiple concurrent sessions, persistent authentication in PostgreSQL, and folder-based auth compatible with Baileys’ `useMultiFileAuthState()`.

---

## Tech Stack

<p align="left">
  <img src="https://skillicons.dev/icons?i=nodejs,express,postgres,js,bash,linux,git" />
  <img src="https://baileys.wiki/img/WhiskeySockets-colorful.png" alt="Baileys" height="50" width="50"/>
</p>

---

## Key Features

* Multi-session support (one session per user/account)
* Persistent auth state stored in PostgreSQL (JSONB)
# WhatsApp HTTP API

![Node.js](https://img.shields.io/badge/Node.js-18+-green?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express.js-Backend-lightgrey?logo=express)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Database-blue?logo=postgresql)
![License](https://img.shields.io/badge/License-MIT-yellow)

A small but powerful Node.js REST API that wraps the Baileys WhatsApp client and exposes simple HTTP endpoints to manage multiple sessions, send messages and statuses, capture incoming messages, and forward events to webhooks.

---

## What's new in this build

- Multi-session support with persistent auth state (Postgres + per-session auth folders)
- Root page at `/` showing API uptime and author
- GET `/sessions/:id/messages` to retrieve received messages (group/individual filters)
- Per-session webhooks for incoming messages, group messages, and status updates
- POST `/sessions/:id/status/send` for sending statuses (stories/broadcasts)
- In-memory message capture (default) with optional persistence suggested

---

## Quick start

1. Install dependencies:

```bash
npm install
```

2. Configure database (optional):

```bash
export DATABASE_URL="postgresql://user:pass@host:5432/dbname"
```

3. Start server:

```bash
node index.js
```

Server runs at http://localhost:3000 by default.

---

## Root page

GET `/`

A lightweight HTML page named `whatsapp-hhtp-api` that displays the API uptime and a small footer "© made by codeskytz".

---

## Session management

Create, list, pair, and delete sessions.

- POST `/sessions` — create & start a new session (returns `id`)
- GET `/sessions` — list existing sessions
- POST `/sessions/:id/pair-request` — request pairing code for a phone number
- DELETE `/sessions/:id` — stop a session and delete auth data

Examples:

```bash
# create
curl -X POST http://localhost:3000/sessions

# pair
curl -X POST http://localhost:3000/sessions/<id>/pair-request \
  -H "Content-Type: application/json" \
  -d '{"number":"+1234567890"}'

# delete
curl -X DELETE http://localhost:3000/sessions/<id>
```

---

## Send messages

POST `/sessions/:id/send-message`

Body JSON:

```json
{ "to": "+1234567890", "message": "Hello from API" }
```

Returns message id and timestamp on success.

---

## Incoming messages (read-only)

The server captures incoming messages per-session in-memory and exposes them via an endpoint.

GET `/sessions/:id/messages`

Query parameters:

- `type=group|individual` — optional filter
- `limit` — number of messages to return (default 50, max 500)
- `since` — unix ms timestamp to filter newer messages

Response example:

```json
{ "count": 1, "messages": [ { "id": "ABCD", "from": "255123456789@s.whatsapp.net", "isGroup": false, "timestamp": 169..., "text": "hello" } ] }
```

Notes:

- Messages are stored in-memory by default (non-persistent). If you need durable storage, add DB persistence (Postgres) or file-based storage.
- `isGroup` is true for group JIDs (ending with `@g.us`).

---

## Webhooks

Per-session webhooks allow you to receive incoming events via HTTP POST from this server.

- GET `/sessions/:id/webhooks` — get configured webhooks
- POST `/sessions/:id/webhooks` — set webhooks

Webhook payload for messages:

```json
{ "id": "<message-id>", "from": "255123456789@s.whatsapp.net", "isGroup": false, "timestamp": 169..., "text": "Hello" }
```

Webhook fields supported (in POST body to set):

```json
{ "incoming": "https://example.com/incoming", "group": "https://example.com/group", "status": "https://example.com/status" }
```

Behavior:

- Individual chat messages are POSTed to `incoming` webhook.
- Group messages are POSTed to `group` webhook.
- When a status (story) is successfully sent, a payload is POSTed to the `status` webhook (if configured).

Delivery notes:

- Webhook POSTs use a short timeout and log failures. The server does not retry failed deliveries by default.

---

## Status / Broadcast (Stories)

POST `/sessions/:id/status/send`

Supports sending text, images, and videos as status updates. The `functions/status.js` handler accepts multiple input methods (JSON text, URL, multipart upload, base64, or server-local path). After a successful send the server saves `last_status` into the sessions DB row for diagnostics.

Example (text):

```bash
curl -X POST http://localhost:3000/sessions/<id>/status/send \
  -H "Content-Type: application/json" \
  -d '{ "type":"text", "text":"Hello from API" }'
```

---

## Health & diagnostics

- GET `/health` — server health and timestamp
- GET `/sessions/:id/status/last` — returns the last status payload saved for a session (if any)

---

## Security & privacy notes

- This project intentionally stores WhatsApp auth state on disk and optionally in Postgres; keep your DB and `./auth_sessions` folder secure.
- Webhooks may deliver user message content to third-party URLs — only configure webhooks you trust.

---

## Contributing & roadmap

Planned enhancements:

- Persist incoming messages to the DB (optional)
- Retry/backoff for webhook delivery
- Web dashboard to manage sessions and webhooks
- Authentication / API keys for endpoints

Contributions welcome via pull requests.

---

## License

MIT © 2025 — SirTheProgrammer
