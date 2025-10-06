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
  <img src="https://raw.githubusercontent.com/WhiskeySockets/Baileys/refs/heads/master/Media/logo.png" alt="Baileys" width="48" height="100" />
</p>

---

## Key Features

* Multi-session support (one session per user/account)
* Persistent auth state stored in PostgreSQL (JSONB)
* REST endpoints for session management, pairing, and messaging
* Auto-reconnect and graceful shutdown
* Health and status endpoints

---

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure PostgreSQL (optional)

Set your database connection URL:

```bash
export DATABASE_URL="postgresql://user:pass@host:5432/dbname"
```

> Default configuration uses:
>
> ```
> postgresql://sirtheprogrammer............................................
> ```

### 3. Run the Server

```bash
node index.js
```

By default, the server runs at `http://localhost:3000`.

---

## API Endpoints

All endpoints accept and return JSON, and use standard HTTP status codes.

---

### Create a Session

**POST** `/sessions`

Creates a new session ID and starts the socket in the background.

**Example:**

```bash
curl -X POST http://localhost:3000/sessions \
     -H "Content-Type: application/json"
```

**Response:**

```json
{ "id": "<session-id>" }
```

---

### List Sessions

**GET** `/sessions`

**Response:**

```json
[
  { "id": "...", "created_at": "...", "updated_at": "..." }
]
```

---

### Request Pairing Code

**POST** `/sessions/:id/pair-request`

**Body:**

```json
{ "number": "+1234567890" }
```

**Response:**

```json
{
  "success": true,
  "pairingCode": "123456",
  "message": "Enter this code in WhatsApp to pair your device"
}
```

**Example:**

```bash
curl -X POST http://localhost:3000/sessions/<id>/pair-request \
  -H "Content-Type: application/json" \
  -d '{"number":"+1234567890"}'
```

---

### Send Message

**POST** `/sessions/:id/send-message`

**Body:**

```json
{ "to": "+1234567890", "message": "Hello from API" }
```

**Response:**

```json
{ "success": true, "messageId": "...", "timestamp": 169... }
```

**Example:**

```bash
curl -X POST http://localhost:3000/sessions/<id>/send-message \
  -H "Content-Type: application/json" \
  -d '{"to":"+1234567890","message":"Hello"}'
```

---

### Delete / Stop Session

**DELETE** `/sessions/:id`

Stops the socket, deletes the auth folder (`./auth_sessions/:id`), and removes the entry from the database.

**Example:**

```bash
curl -X DELETE http://localhost:3000/sessions/<id>
```

---

### Health Check

**GET** `/health`

Returns server health and a timestamp.

---

## Author

**SirTheProgrammer**
[GitHub](https://github.com/sirtheprogrammer)

> Built for automation, scalability, and seamless WhatsApp integration.

---

## Future Enhancements

* WebSocket live message tracking
* Web dashboard for session management
* OAuth2 / JWT-based API authentication
* Prometheus metrics endpoint

---

## License

MIT © 2025 — *SirTheProgrammer*

---
