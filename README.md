# Stripe Identity Verification Backend

Production-ready backend for Stripe Identity verification POC.

## Features

- ✅ Secure webhook signature verification
- ✅ Idempotent event processing
- ✅ No PII storage (GDPR compliant)
- ✅ Audit logging
- ✅ Clean logging system with debug mode
- ✅ Health check endpoint
- ✅ Error handling and monitoring

## Environment Variables

Create a `.env` file with the following variables:

```env
# Stripe Configuration
STRIPE_SECRET_KEY=sk_test_xxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxx
FRONTEND_URL=http://localhost:5173

# Server Configuration
PORT=5000
DEBUG_MODE=false
```

### Getting Webhook Secret

1. **Using ngrok:**
   - Start ngrok: `ngrok http 5000`
   - Go to [Stripe Webhooks Dashboard](https://dashboard.stripe.com/test/webhooks)
   - Click "Add endpoint"
   - Enter: `https://your-ngrok-url.ngrok-free.app/webhook`
   - Select events:
     - `identity.verification_session.verified`
     - `identity.verification_session.requires_input`
     - `identity.verification_session.processing`
     - `identity.verification_session.canceled`
   - Click "Add endpoint"
   - Copy the signing secret and add to `.env`

2. **Using Stripe CLI (Development):**
   ```bash
   stripe login
   stripe listen --forward-to localhost:5000/webhook
   # Copy the webhook signing secret displayed
   ```

## Installation

```bash
npm install
```

## Running the Server

### Development Mode (with debug logs)
```bash
DEBUG_MODE=true npm start
```

### Production Mode
```bash
npm start
```

## API Endpoints

### POST `/create-session`
Create a new verification session.

**Request:**
```json
{
  "userReference": "user_123"  // Optional
}
```

**Response:**
```json
{
  "url": "https://verify.stripe.com/...",
  "session_id": "vs_xxx"
}
```

### GET `/verification-status/:sessionId`
Get verification status for a session.

**Response:**
```json
{
  "session_id": "vs_xxx",
  "status": "verified",
  "created_at": "2024-01-01T00:00:00.000Z",
  "verified_at": "2024-01-01T00:05:00.000Z"
}
```

### GET `/stats`
Get verification statistics (POC evaluation).

**Response:**
```json
{
  "total_sessions": 10,
  "verified": 7,
  "pending": 2,
  "failed": 1,
  "audit_events": 45
}
```

### DELETE `/user-data/:userReference`
Delete user data (GDPR Right to Erasure).

**Response:**
```json
{
  "message": "User data deleted successfully"
}
```

### POST `/webhook`
Stripe webhook endpoint (signature verified).

**Note:** This endpoint is called by Stripe automatically. Do not call manually.

### GET `/health`
Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Logging

The server uses a tiered logging system:

- **`log.info`**: Important information (session created, verified, etc.)
- **`log.success`**: Successful operations (server started)
- **`log.warn`**: Warnings (verification requires input, canceled)
- **`log.error`**: Errors (webhook failures, API errors)
- **`log.debug`**: Verbose debugging (only when DEBUG_MODE=true)

### Enable Debug Mode

Set `DEBUG_MODE=true` in `.env` to see detailed logs including:
- Webhook signature verification details
- Request/response details
- Database sync operations

## Security Considerations

### ✅ What This Backend Does Right

1. **Webhook Signature Verification**: All webhooks are verified using Stripe's signature
2. **Raw Body Parsing**: Uses `express.raw()` to preserve body for signature verification
3. **No PII Storage**: Only stores session IDs and status, not document data
4. **Audit Trail**: All operations are logged for compliance
5. **Idempotency**: Prevents duplicate event processing

### ⚠️ Production Recommendations

1. **Authentication**: Add JWT/OAuth authentication to endpoints
2. **Rate Limiting**: Implement rate limiting on public endpoints
3. **HTTPS Only**: Use HTTPS in production (nginx/CloudFlare)
4. **Environment Variables**: Use secure secret management (AWS Secrets Manager, Vault)
5. **Database**: Consider PostgreSQL instead of SQLite for production
6. **Monitoring**: Add application monitoring (Sentry, DataDog)
7. **CORS**: Restrict CORS to specific domains
8. **User Reference**: Hash/pseudonymize user identifiers

## Testing Webhooks

### 1. Test in Stripe Dashboard
- Go to your webhook endpoint
- Click "Send test webhook"
- Select event type
- Check server logs

### 2. Test with Stripe CLI
```bash
stripe trigger identity.verification_session.verified
```

### 3. Monitor Webhook Delivery
Check Stripe Dashboard > Webhooks for delivery status and errors.

## Troubleshooting

### Webhook Signature Verification Failed

**Symptoms:**
- Webhook returns 400 error
- Logs show "Signature verification failed"

**Solutions:**
1. Verify webhook secret matches the endpoint in Stripe Dashboard
2. Check that ngrok URL matches the endpoint URL
3. Ensure `express.raw()` is used for webhook route
4. Confirm webhook route is before `express.json()`

### No Webhook Events Received

**Solutions:**
1. Check ngrok is running and URL is correct
2. Verify endpoint is configured in Stripe Dashboard
3. Check firewall/network settings
4. Test with "Send test webhook" in Dashboard

## Database

The backend uses SQLite with the following schema:

- **verification_sessions**: Session metadata (no PII)
- **audit_log**: Audit trail for compliance

### Data Retention

Implement a data retention policy:
- Delete old sessions after 90 days
- Maintain audit logs per legal requirements
- Honor GDPR deletion requests

## Compliance Notes

### GDPR Compliance
- ✅ No PII stored locally
- ✅ Right to Erasure endpoint
- ✅ Audit logging (Article 30)
- ⚠️ Implement data retention policy
- ⚠️ Add privacy notice to users

### PCI Compliance
- ✅ No payment card data stored
- ✅ Stripe handles all sensitive data
- ✅ Webhook signature verification

## License

MIT
