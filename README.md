# WhatsApp Bot API

A robust Node.js WhatsApp bot API built with Express.js and Baileys library. Send messages, manage connections, and integrate WhatsApp functionality into your applications.

## Features

- **RESTful API** for WhatsApp messaging
- **Pairing code authentication** (no QR code scanning needed)
- **Auto-reconnection** handling
- **Message validation** and error handling
- **Health monitoring** endpoints
- **Graceful shutdown** support
- **Phone number validation** and formatting

## Prerequisites

- Node.js v16+ 
- npm or yarn
- A phone number with WhatsApp installed

## 🔧 Installation

1. **Clone or create the project:**
   ```bash
   git clone https://github.com/sirtheprogrammer/whatsapp-http-api.git
   cd whatsapp-bot-api
   ```

2. **Initialize npm and install dependencies:**
   ```bash
   npm init -y
   npm install express @whiskeysockets/baileys @hapi/boom
   ```

3. **Create the main file:**
   ```bash
   # Copy the provided code into index.js
   ```

4. **Update package.json to use ES modules:**
   ```json
   {
     "type": "module"
   }
   ```

##  Quick Start

1. **Start the server:**
   ```bash
   node index.js
   ```

2. **Request a pairing code:**
   ```bash
   curl -X POST http://localhost:3000/pair-request \
     -H "Content-Type: application/json" \
     -d '{"number": "+1234567890"}'
   ```

3. **Enter the pairing code in WhatsApp** on your phone

4. **Send a test message:**
   ```bash
   curl -X POST http://localhost:3000/send-message \
     -H "Content-Type: application/json" \
     -d '{"to": "+1234567890", "message": "Hello from bot!"}'
   ```

##  API Endpoints

### Health Check
```http
GET /health
```
Check if the server is running and connection status.

**Response:**
```json
{
  "status": "ok",
  "connected": true,
  "timestamp": "2025-01-01T12:00:00.000Z"
}
```

### Connection Status
```http
GET /status
```
Get detailed connection and authentication status.

**Response:**
```json
{
  "connected": true,
  "hasAuth": true
}
```

### Request Pairing Code
```http
POST /pair-request
```

**Body:**
```json
{
  "number": "+1234567890"
}
```

**Response:**
```json
{
  "success": true,
  "pairingCode": "12345678",
  "message": "Enter this code in WhatsApp to pair your device"
}
```

### Send Message
```http
POST /send-message
```

**Body:**
```json
{
  "to": "+1234567890",
  "message": "Hello, World!"
}
```

**Response:**
```json
{
  "success": true,
  "messageId": "messageId",
  "timestamp": "1640995200"
}
```

## 🔧 Configuration

### Environment Variables
You can customize the bot by setting these environment variables:

```bash
PORT=3000                    # Server port (default: 3000)
AUTH_PATH=./auth_info_baileys # Authentication files path
```

### Bot Settings
Modify the socket configuration in the `initializeBot()` method:

```javascript
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
```

##  Usage Examples

### Basic Message Sending
```bash
# Send a simple text message
curl -X POST http://localhost:3000/send-message \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+1234567890",
    "message": "Hello! This is a test message."
  }'
```

### Phone Number Formats
The API accepts various phone number formats:
- `+1234567890` (recommended)
- `1234567890`
- `+1-234-567-890`

Numbers are automatically cleaned and formatted.

### Error Handling
The API provides detailed error messages:

```json
{
  "error": "Phone number is not registered on WhatsApp"
}
```

##  Monitoring

### Health Checks
Monitor your bot's status with regular health checks:

```bash
# Simple health check
curl http://localhost:3000/health

# Detailed status
curl http://localhost:3000/status
```

### Logs
The bot provides comprehensive logging:
- Connection status updates
- Message sending confirmations
- Error details
- Authentication events

##  Troubleshooting

### Common Issues

**1. "WhatsApp is not connected" Error**
```bash
# Check connection status
curl http://localhost:3000/status

# If not connected, request new pairing code
curl -X POST http://localhost:3000/pair-request \
  -H "Content-Type: application/json" \
  -d '{"number": "+YOUR_NUMBER"}'
```

**2. Authentication Issues**
```bash
# Clear authentication and start fresh
rm -rf ./auth_info_baileys
node index.js
```

**3. "Cannot read properties of undefined" Error**
This usually indicates connection issues. Try:
1. Restart the server
2. Clear auth files
3. Re-pair with WhatsApp

**4. Message Not Delivered**
- Verify recipient has WhatsApp
- Check phone number format
- Ensure bot is connected

### Debug Mode
Enable detailed logging by modifying the console.log statements or add:

```javascript
// Add to socket configuration
logger: console
```

##  Security Considerations

1. **Keep auth files secure** - Never commit `./auth_info_baileys` to version control
2. **Use HTTPS** in production
3. **Implement rate limiting** for production use
4. **Validate all inputs** before processing
5. **Monitor API usage** to prevent abuse



## roduction Deployment

### Using PM2
```bash
# Install PM2
npm install -g pm2

# Start the bot
pm2 start index.js --name "whatsapp-bot"

# Monitor
pm2 logs whatsapp-bot
pm2 status
```

### Docker
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["node", "index.js"]
```

### Environment Variables for Production
```bash
NODE_ENV=production
PORT=3000
AUTH_PATH=/app/auth
```

##  Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

##  License

MIT License - feel free to use this project for personal or commercial purposes.

##  Disclaimer

This bot uses the unofficial WhatsApp Web API. Use responsibly and in accordance with WhatsApp's Terms of Service. The developers are not responsible for any consequences of using this software.

##  Support

For issues and questions:
1. Check the troubleshooting section
2. Review the logs for error details
3. Ensure WhatsApp Web is working normally
4. Verify your phone has internet connectivity

## 🔗 Useful Links

- [Baileys Documentation](https://github.com/WhiskeySockets/Baileys)
- [Express.js Documentation](https://expressjs.com/)
- [WhatsApp Business API](https://developers.facebook.com/docs/whatsapp/)

---

**Happy messaging! **
