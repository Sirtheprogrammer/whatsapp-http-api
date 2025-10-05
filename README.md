# WhatsApp HTTP API

A Node.js REST API for managing WhatsApp sessions and sending messages using Baileys.

This project supports multiple concurrent sessions, persistent auth stored in PostgreSQL, and folder-based auth state compatible with Baileys' `useMultiFileAuthState()`.

## Key features

- Multi-session support (one session per user/account)
- Persistent auth state stored in PostgreSQL (JSONB)
- Endpoints to create/list/delete sessions, request pairing codes, and send messages
- Auto-reconnect and graceful shutdown
- Health and basic status endpoints

## Quick start

1. Install dependencies

```bash
npm install
```

2. (Optional) Set your Postgres DATABASE_URL. By default the app uses:

```
postgresql://sirtheprogrammer.....................................................................

To use your own database, export the URL before starting the server:

```bash
export DATABASE_URL="postgresql://user:pass@host:5432/dbname"
```

3. Start the server

```bash
node index.js
```

By default the server listens on port 3000.

## Endpoints

All endpoints are JSON and use HTTP status codes.

### Create a session

Create a new session ID and start the socket in the background.

POST /sessions

Response (201):

```json
{ "id": "<session-id>" }
```

Example:

```bash
curl -X POST http://localhost:3000/sessions -H "Content-Type: application/json"
```

### List sessions

GET /sessions

Response: array of sessions from the DB:

```json
[ { "id": "...", "created_at": "...", "updated_at": "..." }, ... ]
```

### Request pairing code for a session

POST /sessions/:id/pair-request

Body:

```json
{ "number": "+1234567890" }
```

This will ask Baileys to request a pairing code for the given phone number. You should enter the returned pairing code on the user's WhatsApp (Linked devices / Companion setup).

Response:

```json
{ "success": true, "pairingCode": "123456", "message": "Enter this code in WhatsApp to pair your device" }
```

Example:

```bash
curl -X POST http://localhost:3000/sessions/<id>/pair-request \
  -H "Content-Type: application/json" \
  -d '{"number":"+1234567890"}'
```

### Send message via session

POST /sessions/:id/send-message

Body:

```json
{ "to": "+1234567890", "message": "Hello from API" }
```

Response:

```json
{ "success": true, "messageId": "...", "timestamp": 169... }
```

Example:

```bash
curl -X POST http://localhost:3000/sessions/<id>/send-message \
  -H "Content-Type: application/json" \
  -d '{"to":"+1234567890","message":"Hello"}'
```

### Delete / stop session

DELETE /sessions/:id

This stops the socket, removes the auth folder (`./auth_sessions/:id`) and deletes the DB row.

Example:

```bash
curl -X DELETE http://localhost:3000/sessions/<id>
```

### Health

GET /health

Returns server health and a timestamp.

