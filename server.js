require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');
const mpesa = require('./mpesa');
const { formatPhoneNumber, maskPhone } = require('./phone');
const { runPasswordTests } = require('./test');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Task 2: health check
app.get('/api/health', (req, res) => {
  try {
    const config = mpesa.validateConfig();
    res.json({
      status: 'ok',
      mpesa_configured: true,
      environment: config.env,
      shortcode: config.shortcode,
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      mpesa_configured: false,
      error: err.message,
    });
  }
});

// Task 1: token + cache demo
app.get('/api/mpesa/token', async (req, res) => {
  const start = process.hrtime.bigint();
  try {
    const token = await mpesa.getAccessToken();
    const elapsedMs = Number((process.hrtime.bigint() - start) / 1000n);
    const fromCache = mpesa.getLastTokenSource() === 'cache';
    res.json({
      success: true,
      token_preview: `${token.substring(0, 20)}...`,
      fetch_time_ms: Math.round(elapsedMs) / 1000,
      message: fromCache
        ? 'Token returned from cache (fast)'
        : 'Token fetched from Daraja (network request)',
    });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// Task 3: timestamp/password test
app.get('/api/mpesa/test-password', (req, res) => {
  try {
    const timestamp = mpesa.getTimestamp();
    const password = mpesa.generatePassword(timestamp);
    const tests = runPasswordTests();
    res.json({
      timestamp,
      password_preview: `${password.substring(0, 20)}...`,
      password_length: password.length,
      tests_passed: tests.passed,
      tests: tests.results,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Bonus: Daraja connectivity health
app.get('/api/mpesa/health', async (req, res) => {
  const result = await mpesa.checkDarajaHealth();
  res.status(result.reachable ? 200 : 503).json(result);
});

// ---------------------------------------------------------------------------
// Day 2: STK Push endpoint, in-memory transactions, masked logging
// ---------------------------------------------------------------------------

// In-memory stores (reset on restart). Exposed via app.locals so tests can inspect them.
app.locals.transactions = [];
app.locals.logs = [];
const MAX_LOG_ENTRIES = 1000;
const LOGS_RETURNED = 20;

const pad2 = (n) => String(n).padStart(2, '0');
function formatLocalTime(d) {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/** Logs one STK Push attempt to the console and the in-memory log. Phone numbers are masked. */
function logSTKPush({ phone, amount, status, checkoutRequestId, error }) {
  const now = new Date();
  // Only echo amounts that are really numbers, so user input can't forge log lines.
  const isNumeric =
    (typeof amount === 'number' || (typeof amount === 'string' && amount.trim() !== '')) &&
    Number.isFinite(Number(amount));
  const loggedAmount = isNumeric ? Number(amount) : null;
  const masked = maskPhone(phone);

  const entry = {
    timestamp: now.toISOString(),
    phone: masked,
    amount: loggedAmount,
    status,
    ...(checkoutRequestId ? { checkoutRequestId } : {}),
    ...(error ? { error } : {}),
  };
  app.locals.logs.push(entry);
  if (app.locals.logs.length > MAX_LOG_ENTRIES) {
    app.locals.logs.splice(0, app.locals.logs.length - MAX_LOG_ENTRIES);
  }

  const detail = status === 'SUCCESS' ? checkoutRequestId : error;
  console.log(
    `[${formatLocalTime(now)}] STK Push | ${masked} | KES ${loggedAmount === null ? 'N/A' : loggedAmount} | ${status} | ${detail}`
  );
}

app.post('/api/mpesa/stkpush', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { phoneNumber, amount, accountReference = 'Payment', transactionDesc = 'Payment' } = body;

  let phoneForLog = phoneNumber;
  try {
    const phone = formatPhoneNumber(phoneNumber);
    if (!phone.success) throw new mpesa.MpesaError(phone.error, 400);
    phoneForLog = phone.formatted;

    const validAmount = mpesa.validateAmount(amount);

    const result = await mpesa.initiateSTKPush(
      phone.formatted,
      validAmount,
      accountReference,
      transactionDesc
    );

    const { transactions } = app.locals;
    const paymentId = `txn_${String(transactions.length + 1).padStart(3, '0')}`;
    transactions.push({
      paymentId,
      checkoutRequestId: result.CheckoutRequestID,
      merchantRequestId: result.MerchantRequestID,
      phoneNumber: phone.formatted,
      amount: validAmount,
      accountReference,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });

    logSTKPush({
      phone: phone.formatted,
      amount: validAmount,
      status: 'SUCCESS',
      checkoutRequestId: result.CheckoutRequestID,
    });

    res.json({
      success: true,
      message: 'STK Push sent. Check your phone for the M-Pesa prompt.',
      data: { paymentId, checkoutRequestId: result.CheckoutRequestID },
    });
  } catch (err) {
    const known = err instanceof mpesa.MpesaError;
    const status = known ? err.status : 500;
    const message = known ? err.message : 'Internal server error';
    if (!known) console.error(err);

    logSTKPush({ phone: phoneForLog, amount, status: 'FAILED', error: message });
    res.status(status).json({ success: false, error: message });
  }
});

// Bonus: last 20 log entries (oldest first)
app.get('/api/mpesa/logs', (req, res) => {
  const logs = app.locals.logs.slice(-LOGS_RETURNED);
  res.json({ success: true, count: logs.length, logs });
});

// Malformed JSON bodies and anything unexpected
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    // The body never reached the route handler, so log the failed STK attempt here.
    if (req.path === '/api/mpesa/stkpush') {
      logSTKPush({ status: 'FAILED', error: 'Invalid JSON in request body.' });
    }
    return res.status(400).json({ success: false, error: 'Invalid JSON in request body.' });
  }
  console.error(err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

if (require.main === module) {
  try {
    mpesa.validateConfig();
  } catch (err) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}

module.exports = app;
