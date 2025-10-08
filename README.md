# WhatsApp HTTP API

![Node.js](https://img.shields.io/badge/Node.js-18+-green?logo=node.js\&logoColor=white)
# WhatsApp HTTP API

![Node.js](https://img.shields.io/badge/Node.js-18+-green?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express.js-Backend-lightgrey?logo=express)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Database-blue?logo=postgresql)
![License](https://img.shields.io/badge/License-MIT-yellow)

A small but powerful Node.js REST API that wraps the Baileys WhatsApp client and exposes simple HTTP endpoints to manage multiple sessions, send messages and statuses, capture incoming messages, and forward events to webhooks.

---

## Quick highlights

- Multi-session support (one session per WhatsApp account)
- Persistent auth state (stored in PostgreSQL and mirrored to per-session auth folders)
- Incoming message capture (in-memory) with filtering by group vs individual
- Per-session webhooks for incoming messages, group messages and status/send events
- Status (story) sending support (text, image, video) via `/sessions/:id/status/send`
- Small root page at `/` showing uptime and author credit

---

## Getting started

1. Install dependencies:

```bash
npm install
```

2. Configure database (optional, defaults are handled):

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

A lightweight HTML page titled `whatsapp-hhtp-api` that displays the API uptime and a footer "© made by codeskytz".

---

## Session management

Create, list, pair, and delete sessions.

- POST `/sessions` — create & start a new session (returns `id`)
- GET `/sessions` — list existing sessions (id, created_at, updated_at)
- POST `/sessions/:id/pair-request` — request a pairing code for a phone number (body: `{ "number": "+123..." }`)
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

## Status / Broadcast (Stories)

POST `/sessions/:id/status/send`

Supports sending text, images, and videos as status updates. The handler accepts multiple input methods (JSON text, URL, multipart upload, base64 or server-local path). After a successful send the server saves `last_status` into the sessions DB row for diagnostics.

Example (text):

```bash
curl -X POST http://localhost:3000/sessions/<id>/status/send \
  -H "Content-Type: application/json" \
  -d '{ "type":"text", "text":"Hello from API" }'
```

Diagnostics:

- GET `/sessions/:id/status/last` — returns the last status payload saved for a session (if any)

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

- `isGroup` is true for group JIDs (ending with `@g.us`).
- Messages are stored in-memory by default (non-persistent). If you need durable storage, persist them to the DB or files.

Note: In this build incoming messages are persisted to Postgres in the `messages` table (see DB schema below). The endpoint will read from the DB by default and fall back to in-memory cache if the DB is unavailable.

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

Extended webhook behavior (forwarding and retry):

- The server records delivery metadata for each persisted message (delivered, delivery_attempts, last_delivery_error, pending_webhook).
- If a webhook delivery fails for a message the server will mark it as pending (store pending_webhook and error). Pending messages can be reviewed and retried via the forwarding endpoints below.

## Forwarding / Undelivered messages

You can forward persisted messages to an arbitrary webhook and inspect pending/failed deliveries.

- POST `/sessions/:id/forward` — forward messages immediately to a given webhook. Body JSON: `{ "webhook": "https://example.com/endpoint", "ids": ["msgId1","msgId2"] }`. If `ids` omitted the API forwards the latest 50 messages for the session.
- GET `/sessions/:id/undelivered` — list messages that are undelivered or marked pending (shows deliveryAttempts, lastDeliveryError, pendingWebhook)
- POST `/sessions/:id/forward/retry` — retry forwarding messages. Body JSON: `{ "ids": [...], "webhook": "https://..." }`. If `ids` omitted, retries all pending messages (optionally filtered to a specific webhook when `webhook` provided).

Behavior notes:

- Forwarding endpoints synchronously attempt delivery and update message delivery metadata. Failed deliveries are recorded as pending with the target webhook.
- The system supports manual retries via `/forward/retry`. If you want automatic background retries or backoff, I can add a worker to scan pending messages and retry them with exponential backoff.

---

## DB schema (messages table)

The `messages` table includes the following columns relevant to forwarding:

- `id` — message id (primary key)
- `session_id` — session associated with the message
- `from_jid` — sender JID
- `is_group` — boolean
- `timestamp_ms` — original message unix ms timestamp
- `text` — text content
- `raw` — raw JSON blob of the message
- `delivered` — boolean (true if forwarded successfully)
- `delivered_at` — timestamp the message was forwarded successfully
- `delivery_attempts` — number of delivery attempts
- `last_delivery_error` — last error message from webhook delivery
- `pending_webhook` — target webhook URL when last attempt failed and the message is pending

---

## Health & diagnostics

- GET `/health` — server health and timestamp
- GET `/sessions/:id/status/last` — returns the last status payload saved for a session (if any)

---

## Security & privacy notes

- This project stores WhatsApp auth state on disk and optionally in Postgres; keep your DB and `./auth_sessions` folder secure.
- Webhooks may deliver user message content to third-party URLs — only configure webhooks you trust.

---

## Roadmap / Contributing

Planned enhancements:

- Persist incoming messages to the DB (optional)
- Retry/backoff for webhook delivery
- Web dashboard to manage sessions and webhooks
- Authentication / API keys for endpoints

Contributions welcome via pull requests.

---

## License

MIT © 2025 — SirTheProgrammer

