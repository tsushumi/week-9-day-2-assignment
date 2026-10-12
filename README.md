# Week 9 Day 2: STK Push Implementation

Continues the Day 1 Daraja project (OAuth, token cache, config validation, timestamp/password) and adds M-Pesa STK Push, a Kenyan phone number formatter, a `POST /api/mpesa/stkpush` endpoint, and masked transaction logging.

## Setup

```bash
npm install
cp .env.example .env     # add your Daraja sandbox key/secret and your ngrok callback URL
npm run dev              # or: npm start
npm test                 # 37 tests, Daraja is mocked so no credentials or network are needed
```

Start a tunnel with `ngrok http 3000` and paste the `https://` URL (plus `/api/mpesa/callback`) into `MPESA_CALLBACK_URL`. The server returns a clear error if it is missing, not `https://`, or still the placeholder.

## Project structure

| File | Purpose |
| --- | --- |
| `phone.js` | `formatPhoneNumber`, `isValidKenyanPhone`, `maskPhone` |
| `mpesa.js` | Day 1 functions plus `initiateSTKPush`, `validateAmount`, `getCallbackUrl` |
| `server.js` | Express routes, in-memory transactions and logs |
| `test.js` | `npm test` suite (phone formats, STK payload, error handling, endpoint over real HTTP, logging) |

## Endpoints, curl commands and sample responses

### Task 3: `POST /api/mpesa/stkpush`

Body: `{ phoneNumber, amount, accountReference, transactionDesc }`. `accountReference` and `transactionDesc` default to `"Payment"` when omitted.

```bash
curl -X POST http://localhost:3000/api/mpesa/stkpush \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "0712345678", "amount": 100, "accountReference": "PayLink", "transactionDesc": "Test payment"}'
```

`200`:

```json
{
  "success": true,
  "message": "STK Push sent. Check your phone for the M-Pesa prompt.",
  "data": { "paymentId": "txn_001", "checkoutRequestId": "ws_CO_DMZ_123456789_20261011154530" }
}
```

Missing phone (`400`):

```bash
curl -X POST http://localhost:3000/api/mpesa/stkpush -H "Content-Type: application/json" -d '{"amount": 100}'
```

```json
{ "success": false, "error": "Phone number is required." }
```

Invalid amount (`400`):

```bash
curl -X POST http://localhost:3000/api/mpesa/stkpush -H "Content-Type: application/json" \
  -d '{"phoneNumber": "0712345678", "amount": 0}'
```

```json
{ "success": false, "error": "Amount must be between 1 and 150,000 KES" }
```

Invalid phone (`400`):

```bash
curl -X POST http://localhost:3000/api/mpesa/stkpush -H "Content-Type: application/json" \
  -d '{"phoneNumber": "0612345678", "amount": 100}'
```

```json
{ "success": false, "error": "Invalid Kenyan phone number. Must start with 07, 01, or 254." }
```

Status codes: `400` for validation errors (including malformed JSON), `502` when Daraja rejects the request or is unreachable, `500` for server configuration problems.

Pending transactions are stored in memory with `paymentId`, `checkoutRequestId`, `merchantRequestId`, `phoneNumber`, `amount`, `status: "pending"` and `createdAt`. They are lost on restart.

### Bonus: `GET /api/mpesa/logs`

Returns the last 20 STK Push attempts (oldest first). Every attempt, successful or failed, is logged, with the phone number masked.

```bash
curl http://localhost:3000/api/mpesa/logs
```

```json
{
  "success": true,
  "count": 2,
  "logs": [
    { "timestamp": "2026-10-11T12:47:34.645Z", "phone": "2547****5678", "amount": 100, "status": "SUCCESS", "checkoutRequestId": "ws_CO_DMZ_123456789_20261011154530" },
    { "timestamp": "2026-10-11T12:47:34.664Z", "phone": "2547****5678", "amount": 0, "status": "FAILED", "error": "Amount must be between 1 and 150,000 KES" }
  ]
}
```

Console output:

```text
[2026-10-11 15:47:34] STK Push | 2547****5678 | KES 100 | SUCCESS | ws_CO_DMZ_123456789_20261011154530
[2026-10-11 15:47:34] STK Push | 2547****5678 | KES 0 | FAILED | Amount must be between 1 and 150,000 KES
```

### Carried over from Day 1

`GET /api/health`, `GET /api/mpesa/token`, `GET /api/mpesa/test-password`, `GET /api/mpesa/health`.

## Phone formatting (`phone.js`)

| Input | Result |
| --- | --- |
| `0712345678`, `0712 345 678` | `254712345678` |
| `+254712345678`, `+254-712-345-678`, `254712345678` | `254712345678` |
| `0112345678`, `+254112345678` | `254112345678` |
| `12345` | `Phone number too short. Must be 10 digits (07XX) or 12 digits (254XX).` |
| `0612345678` | `Invalid Kenyan phone number. Must start with 07, 01, or 254.` |
| `""` | `Phone number is required.` |
| `abc` | `Phone number must contain only digits, spaces, dashes, or a leading +.` |

