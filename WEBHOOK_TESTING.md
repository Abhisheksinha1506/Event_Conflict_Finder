# Webhook Testing Guide

This guide shows you how to test Polar webhooks locally without needing a public URL.

## Method 1: Using the Test Script (Recommended)

### Prerequisites
1. Make sure your server is running:
   ```bash
   npm run dev
   ```

2. The script will use `POLAR_WEBHOOK_SECRET` from your `.env` file if available (optional for testing).

### Usage

#### Test customer.updated event:
```bash
node test-webhook.js customer.updated test@example.com
```

#### Test checkout.succeeded event:
```bash
node test-webhook.js checkout.succeeded test@example.com checkout-id-123
```

#### Test checkout.updated event:
```bash
node test-webhook.js checkout.updated test@example.com checkout-id-123
```

#### Test benefit_grant.created event:
```bash
node test-webhook.js benefit_grant.created test@example.com checkout-id-123
```

### Available Event Types
- `customer.updated` - Customer information updated
- `checkout.succeeded` - Payment succeeded
- `checkout.updated` - Checkout status updated
- `benefit_grant.created` - Benefit granted (payment succeeded)

---

## Method 2: Using curl (Manual)

### Test customer.updated event:

```bash
curl -X POST http://localhost:3000/api/paywall/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "type": "customer.updated",
    "timestamp": "2025-11-17T19:48:57.711034Z",
    "data": {
      "id": "f6778417-e5d0-47ec-9841-eea089840d25",
      "email": "test@example.com",
      "name": "Test User",
      "email_verified": false
    }
  }'
```

### Test checkout.succeeded event:

```bash
curl -X POST http://localhost:3000/api/paywall/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "type": "checkout.succeeded",
    "timestamp": "2025-11-17T19:48:57.711034Z",
    "data": {
      "id": "checkout-123",
      "status": "succeeded",
      "customer_email": "test@example.com"
    }
  }'
```

### Test with signature (if you have POLAR_WEBHOOK_SECRET):

```bash
# First, create the signature manually or use the test script
# The signature format is: t=timestamp,v1=hash

curl -X POST http://localhost:3000/api/paywall/webhook \
  -H "Content-Type: application/json" \
  -H "polar-signature: t=1234567890,v1=your-signature-here" \
  -d '{
    "type": "customer.updated",
    "data": {
      "email": "test@example.com"
    }
  }'
```

---

## Method 3: Using Postman or Insomnia

1. **Method**: POST
2. **URL**: `http://localhost:3000/api/paywall/webhook`
3. **Headers**:
   - `Content-Type: application/json`
   - `polar-signature: t=timestamp,v1=signature` (optional)

4. **Body** (JSON):
```json
{
  "type": "customer.updated",
  "timestamp": "2025-11-17T19:48:57.711034Z",
  "data": {
    "id": "f6778417-e5d0-47ec-9841-eea089840d25",
    "email": "test@example.com",
    "name": "Test User",
    "email_verified": false
  }
}
```

---

## Expected Responses

### Success Response:
```json
{
  "received": true,
  "event": "customer.updated",
  "processed": true
}
```

### For payment events:
```json
{
  "received": true
}
```

---

## Troubleshooting

### Server not running
```bash
# Start the server first
npm run dev
```

### Connection refused
- Make sure the server is running on port 3000
- Check if another process is using port 3000
- Try changing PORT in .env file

### Signature verification fails
- This is OK for local testing - the webhook will still process
- Check server logs for details
- Make sure `POLAR_WEBHOOK_SECRET` is set if you want to test signatures

### Check server logs
The server will log:
- `📥 Polar webhook received`
- `📋 Headers:` (all headers)
- `📦 Webhook payload type:`
- `🔔 Event type:`
- `👤 Customer updated:` (for customer.updated events)
- `✅ Plan activated for:` (for payment events)

---

## Testing Different Scenarios

### Test customer with existing plan:
```bash
node test-webhook.js customer.updated existing-user@example.com
```

### Test new customer signup:
```bash
node test-webhook.js checkout.succeeded new-user@example.com new-checkout-123
```

### Test payment failure:
Modify the script or use curl to send a `checkout.payment_failed` event.

---

## Notes

- The webhook endpoint always returns 200 OK to prevent Polar from disabling it
- Signature verification is optional for local testing
- All events are logged to the console for debugging
- The webhook processes events even if signature verification fails (with warnings)

