/**
 * Tests.
 *   - runPasswordTests() is used by GET /api/mpesa/test-password
 *   - `npm test` (node test.js) runs the full suite, with Daraja mocked
 *     so no credentials or network access are needed.
 */
const assert = require('assert');
const mpesa = require('./mpesa');

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function runPasswordTests() {
  const results = [];
  const check = (name, fn) => {
    try {
      fn();
      results.push({ name, passed: true });
    } catch (err) {
      results.push({ name, passed: false, error: err.message });
    }
  };

  check('getTimestamp() returns exactly 14 digits', () => {
    assert.match(mpesa.getTimestamp(), /^\d{14}$/);
  });

  check('getTimestamp() starts with the current year', () => {
    assert.ok(mpesa.getTimestamp().startsWith(String(new Date().getFullYear())));
  });

  check('generatePassword() is consistent for the same timestamp', () => {
    const a = mpesa.generatePassword('20260503143045');
    const b = mpesa.generatePassword('20260503143045');
    assert.strictEqual(a, b);
  });

  check('generatePassword() output is valid Base64', () => {
    assert.match(mpesa.generatePassword('20260503143045'), BASE64_RE);
  });

  check('generatePassword() decodes to shortcode + passkey + timestamp', () => {
    const { shortcode, passkey } = mpesa.validateConfig();
    const decoded = Buffer.from(mpesa.generatePassword('20260503143045'), 'base64').toString();
    assert.strictEqual(decoded, `${shortcode}${passkey}20260503143045`);
  });

  check('generatePassword() rejects a malformed timestamp', () => {
    assert.throws(() => mpesa.generatePassword('2026-05-03'));
  });

  return { passed: results.every((r) => r.passed), results };
}

module.exports = { runPasswordTests };

// ---------------------------------------------------------------------------
// Full suite (only when run directly)
// ---------------------------------------------------------------------------
if (require.main === module) {
  const axios = require('axios');
  const realGet = axios.get;
  const realPost = axios.post;
  let failures = 0;
  const queue = [];

  const test = (name, fn) => queue.push({ name, fn });

  const withEnv = async (overrides, fn) => {
    const saved = {};
    for (const k of Object.keys(overrides)) {
      saved[k] = process.env[k];
      if (overrides[k] === undefined) delete process.env[k];
      else process.env[k] = overrides[k];
    }
    try {
      return await fn();
    } finally {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };

  const baseEnv = {
    MPESA_CONSUMER_KEY: 'test_key',
    MPESA_CONSUMER_SECRET: 'test_secret',
    MPESA_SHORTCODE: '174379',
    MPESA_PASSKEY: 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919',
    MPESA_ENV: 'sandbox',
    MPESA_CALLBACK_URL: 'https://example.ngrok-free.app/api/mpesa/callback',
  };

  // ---- Day 2 helpers ----
  const { formatPhoneNumber, isValidKenyanPhone, maskPhone, ERRORS } = require('./phone');

  const DARAJA_OK = {
    MerchantRequestID: '29115-34620561-1',
    CheckoutRequestID: 'ws_CO_DMZ_123456789_20260504143045',
    ResponseCode: '0',
    ResponseDescription: 'Success. Request accepted for processing',
    CustomerMessage: 'Success. Request accepted for processing',
  };

  /** Mocks Daraja's token + STK endpoints and records every call. */
  const mockDaraja = (opts = {}) => {
    const calls = { get: 0, post: [] };
    axios.get = async () => {
      calls.get++;
      return { data: { access_token: 'tok', expires_in: '3599' } };
    };
    axios.post = async (url, payload, cfg) => {
      calls.post.push({ url, payload, cfg });
      if (opts.postError) throw opts.postError;
      return { data: opts.postData || DARAJA_OK };
    };
    return calls;
  };

  const httpError = (status, data) => {
    const e = new Error('Request failed');
    e.response = { status, data };
    return e;
  };

  /** Runs fn with console.log captured; returns the captured lines via the callback arg. */
  const withCapturedLogs = async (fn) => {
    const realLog = console.log;
    const lines = [];
    console.log = (...a) => lines.push(a.join(' '));
    try {
      return await fn(lines);
    } finally {
      console.log = realLog;
    }
  };

  const startServer = () =>
    new Promise((resolve) => {
      const app = require('./server');
      app.locals.transactions.length = 0;
      app.locals.logs.length = 0;
      const srv = app.listen(0, () =>
        resolve({ app, srv, base: `http://127.0.0.1:${srv.address().port}` })
      );
    });

  const postStk = async (base, body, raw) => {
    const r = await fetch(`${base}/api/mpesa/stkpush`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw !== undefined ? raw : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };

  const validBody = {
    phoneNumber: '0712345678',
    amount: 100,
    accountReference: 'PayLink',
    transactionDesc: 'Test payment',
  };

  // ---- Day 2 / Task 2: phone formatting ----
  test('Day 2 Task 2: all valid formats normalise to 254XXXXXXXXX', () => {
    const cases = [
      ['0712345678', '254712345678'],
      ['+254712345678', '254712345678'],
      ['254712345678', '254712345678'],
      ['0112345678', '254112345678'],
      ['+254112345678', '254112345678'],
      ['0712 345 678', '254712345678'],
      ['+254-712-345-678', '254712345678'],
      ['  0712345678  ', '254712345678'],
      [254712345678, '254712345678'],
    ];
    for (const [input, expected] of cases) {
      assert.deepStrictEqual(
        formatPhoneNumber(input),
        { success: true, formatted: expected },
        `input: ${JSON.stringify(input)}`
      );
    }
  });

  test('Day 2 Task 2: invalid inputs give the specified errors', () => {
    const cases = [
      ['12345', 'Phone number too short. Must be 10 digits (07XX) or 12 digits (254XX).'],
      ['0612345678', 'Invalid Kenyan phone number. Must start with 07, 01, or 254.'],
      ['', 'Phone number is required.'],
      ['abc', 'Phone number must contain only digits, spaces, dashes, or a leading +.'],
      [undefined, ERRORS.REQUIRED],
      [null, ERRORS.REQUIRED],
      ['   ', ERRORS.REQUIRED],
      ['254612345678', ERRORS.INVALID],
      ['++254712345678', ERRORS.CHARACTERS],
      ['0712-345+678', ERRORS.CHARACTERS],
      ['07123456789', ERRORS.LENGTH],
      ['25471234567', ERRORS.LENGTH],
      [{ a: 1 }, ERRORS.CHARACTERS],
    ];
    for (const [input, error] of cases) {
      assert.deepStrictEqual(
        formatPhoneNumber(input),
        { success: false, error },
        `input: ${JSON.stringify(input)}`
      );
    }
  });

  test('Day 2 Task 2: isValidKenyanPhone', () => {
    assert.strictEqual(isValidKenyanPhone('0712345678'), true);
    assert.strictEqual(isValidKenyanPhone('+254-112-345-678'), true);
    assert.strictEqual(isValidKenyanPhone('0612345678'), false);
    assert.strictEqual(isValidKenyanPhone(''), false);
    assert.strictEqual(isValidKenyanPhone(undefined), false);
  });

  test('Day 2 Bonus: maskPhone', () => {
    assert.strictEqual(maskPhone('254712345678'), '2547****5678');
    assert.strictEqual(maskPhone('0712345678'), '0712****5678');
    assert.strictEqual(maskPhone('abc'), '****');
    assert.strictEqual(maskPhone(undefined), '****');
  });

  // ---- Day 2 / Task 1: initiateSTKPush ----
  test('Day 2 Task 1: sends a correct STK payload and returns Daraja data', () =>
    withEnv(baseEnv, async () => {
      mpesa.clearTokenCache();
      const calls = mockDaraja();
      const result = await mpesa.initiateSTKPush('254712345678', 100, 'PayLink', 'Test');
      assert.deepStrictEqual(result, DARAJA_OK);

      assert.strictEqual(calls.post.length, 1);
      const { url, payload, cfg } = calls.post[0];
      assert.strictEqual(url, 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest');
      assert.strictEqual(cfg.headers.Authorization, 'Bearer tok');
      assert.strictEqual(payload.BusinessShortCode, '174379');
      assert.strictEqual(payload.TransactionType, 'CustomerPayBillOnline');
      assert.strictEqual(payload.Amount, 100);
      assert.strictEqual(payload.PartyA, '254712345678');
      assert.strictEqual(payload.PhoneNumber, '254712345678');
      assert.strictEqual(payload.PartyB, '174379');
      assert.strictEqual(payload.CallBackURL, baseEnv.MPESA_CALLBACK_URL);
      assert.strictEqual(payload.AccountReference, 'PayLink');
      assert.strictEqual(payload.TransactionDesc, 'Test');
      assert.match(payload.Timestamp, /^\d{14}$/);
      // The password must be built from the SAME timestamp that is in the payload.
      assert.strictEqual(
        Buffer.from(payload.Password, 'base64').toString(),
        `174379${baseEnv.MPESA_PASSKEY}${payload.Timestamp}`
      );
    }));

  test('Day 2 Task 1: formats 07XX, +254 and 01XX phone numbers itself', () =>
    withEnv(baseEnv, async () => {
      mpesa.clearTokenCache();
      const calls = mockDaraja();
      await mpesa.initiateSTKPush('0712345678', 5, 'Ref', 'Desc');
      await mpesa.initiateSTKPush('+254712345678', 5, 'Ref', 'Desc');
      await mpesa.initiateSTKPush('0112345678', 5, 'Ref', 'Desc');
      assert.deepStrictEqual(
        calls.post.map((c) => c.payload.PhoneNumber),
        ['254712345678', '254712345678', '254112345678']
      );
    }));

  test('Day 2 Task 1: reuses the cached token across pushes', () =>
    withEnv(baseEnv, async () => {
      mpesa.clearTokenCache();
      const calls = mockDaraja();
      await mpesa.initiateSTKPush('254712345678', 10, 'Ref', 'Desc');
      await mpesa.initiateSTKPush('254712345678', 10, 'Ref', 'Desc');
      assert.strictEqual(calls.get, 1);
      assert.strictEqual(calls.post.length, 2);
    }));

  test('Day 2 Task 1: amount boundaries and bad amounts', () =>
    withEnv(baseEnv, async () => {
      mpesa.clearTokenCache();
      const calls = mockDaraja();
      await mpesa.initiateSTKPush('254712345678', 1, 'Ref', 'Desc');
      await mpesa.initiateSTKPush('254712345678', 150000, 'Ref', 'Desc');
      await mpesa.initiateSTKPush('254712345678', '250', 'Ref', 'Desc');
      assert.deepStrictEqual(calls.post.map((c) => c.payload.Amount), [1, 150000, 250]);

      const before = { get: calls.get, post: calls.post.length };
      const range = 'Amount must be between 1 and 150,000 KES';
      for (const bad of [0, 200000, 150001, -5]) {
        await assert.rejects(
          mpesa.initiateSTKPush('254712345678', bad, 'Ref', 'Desc'),
          { message: range, status: 400 },
          `amount ${bad}`
        );
      }
      await assert.rejects(mpesa.initiateSTKPush('254712345678', 10.5, 'Ref', 'Desc'), /whole number/);
      await assert.rejects(mpesa.initiateSTKPush('254712345678', 'abc', 'Ref', 'Desc'), /must be a number/);
      await assert.rejects(mpesa.initiateSTKPush('254712345678', undefined, 'Ref', 'Desc'), /Amount is required/);
      await assert.rejects(mpesa.initiateSTKPush('254712345678', NaN, 'Ref', 'Desc'), /must be a number/);
      // Validation failures must not touch the network
      assert.strictEqual(calls.get, before.get);
      assert.strictEqual(calls.post.length, before.post);
    }));

  test('Day 2 Task 1: invalid phone and bad text fields are rejected with 400', () =>
    withEnv(baseEnv, async () => {
      mpesa.clearTokenCache();
      mockDaraja();
      await assert.rejects(mpesa.initiateSTKPush('0612345678', 100, 'Ref', 'Desc'), {
        message: ERRORS.INVALID,
        status: 400,
      });
      await assert.rejects(mpesa.initiateSTKPush('254712345678', 100, '', 'Desc'), /Account reference is required/);
      await assert.rejects(
        mpesa.initiateSTKPush('254712345678', 100, 'ThisIsWayTooLong', 'Desc'),
        /at most 12 characters/
      );
      await assert.rejects(
        mpesa.initiateSTKPush('254712345678', 100, 'Ref', 'This description is too long'),
        /at most 13 characters/
      );
    }));

  test('Day 2 Task 1: callback URL must be configured, https, and not the placeholder', async () => {
    const run = (url) => withEnv({ ...baseEnv, MPESA_CALLBACK_URL: url }, () => mpesa.getCallbackUrl());
    await assert.rejects(run(undefined), /MPESA_CALLBACK_URL/);
    await assert.rejects(run('http://insecure.example.com/cb'), /https/);
    await assert.rejects(run('https://your-ngrok-url.ngrok-free.app/api/mpesa/callback'), /placeholder/);
    assert.strictEqual(await run('https://abc.ngrok-free.app/cb'), 'https://abc.ngrok-free.app/cb');
  });

  test('Day 2 Task 1: Daraja HTTP error is descriptive (502)', () =>
    withEnv(baseEnv, async () => {
      mpesa.clearTokenCache();
      mockDaraja({ postError: httpError(400, { errorMessage: 'Bad Request - Invalid PhoneNumber' }) });
      await assert.rejects(mpesa.initiateSTKPush('254712345678', 100, 'Ref', 'Desc'), {
        message: 'STK Push failed (HTTP 400): Bad Request - Invalid PhoneNumber',
        status: 502,
      });
    }));

  test('Day 2 Task 1: a 401 from the STK endpoint clears the token cache', () =>
    withEnv(baseEnv, async () => {
      mpesa.clearTokenCache();
      const calls = mockDaraja({ postError: httpError(401, { errorMessage: 'Invalid Access Token' }) });
      await assert.rejects(mpesa.initiateSTKPush('254712345678', 100, 'Ref', 'Desc'), /HTTP 401/);
      assert.strictEqual(calls.get, 1);
      await assert.rejects(mpesa.initiateSTKPush('254712345678', 100, 'Ref', 'Desc'), /HTTP 401/);
      assert.strictEqual(calls.get, 2); // refetched, not served from cache
    }));

  test('Day 2 Task 1: non-zero ResponseCode and network errors are reported', () =>
    withEnv(baseEnv, async () => {
      mpesa.clearTokenCache();
      mockDaraja({ postData: { ResponseCode: '1', ResponseDescription: 'Insufficient balance' } });
      await assert.rejects(mpesa.initiateSTKPush('254712345678', 100, 'Ref', 'Desc'), {
        message: 'STK Push rejected by Daraja: Insufficient balance',
        status: 502,
      });

      const timeout = Object.assign(new Error('timeout'), { code: 'ECONNABORTED', request: {} });
      mockDaraja({ postError: timeout });
      await assert.rejects(mpesa.initiateSTKPush('254712345678', 100, 'Ref', 'Desc'), /timed out/);

      const dns = Object.assign(new Error('dns'), { code: 'ENOTFOUND', request: {} });
      mockDaraja({ postError: dns });
      await assert.rejects(mpesa.initiateSTKPush('254712345678', 100, 'Ref', 'Desc'), /unable to reach Daraja/);
    }));

  // ---- Day 2 / Task 3 + Bonus: endpoint over real HTTP ----
  test('Day 2 Task 3: valid request returns paymentId + checkoutRequestId and stores the transaction', () =>
    withEnv(baseEnv, async () => {
      mpesa.clearTokenCache();
      const calls = mockDaraja();
      const { app, srv, base } = await startServer();
      try {
        await withCapturedLogs(async () => {
          const r1 = await postStk(base, validBody);
          assert.strictEqual(r1.status, 200);
          assert.deepStrictEqual(r1.body, {
            success: true,
            message: 'STK Push sent. Check your phone for the M-Pesa prompt.',
            data: { paymentId: 'txn_001', checkoutRequestId: 'ws_CO_DMZ_123456789_20260504143045' },
          });
          const r2 = await postStk(base, { ...validBody, phoneNumber: '+254 712 345 678' });
          assert.strictEqual(r2.body.data.paymentId, 'txn_002');

          assert.strictEqual(app.locals.transactions.length, 2);
          const t = app.locals.transactions[0];
          assert.strictEqual(t.checkoutRequestId, DARAJA_OK.CheckoutRequestID);
          assert.strictEqual(t.merchantRequestId, DARAJA_OK.MerchantRequestID);
          assert.strictEqual(t.phoneNumber, '254712345678');
          assert.strictEqual(t.amount, 100);
          assert.strictEqual(t.status, 'pending');
          assert.ok(!Number.isNaN(Date.parse(t.createdAt)));
          assert.strictEqual(calls.post[0].payload.PhoneNumber, '254712345678');
        });
      } finally {
        srv.close();
      }
    }));

  test('Day 2 Task 3: validation failures return 400 and never call Daraja', () =>
    withEnv(baseEnv, async () => {
      mpesa.clearTokenCache();
      const calls = mockDaraja();
      const { app, srv, base } = await startServer();
      try {
        await withCapturedLogs(async () => {
          let r = await postStk(base, { ...validBody, phoneNumber: undefined });
          assert.deepStrictEqual([r.status, r.body], [400, { success: false, error: 'Phone number is required.' }]);

          r = await postStk(base, { ...validBody, amount: 0 });
          assert.deepStrictEqual(
            [r.status, r.body],
            [400, { success: false, error: 'Amount must be between 1 and 150,000 KES' }]
          );

          r = await postStk(base, { ...validBody, amount: 200000 });
          assert.strictEqual(r.status, 400);

          r = await postStk(base, { ...validBody, amount: undefined });
          assert.deepStrictEqual([r.status, r.body.error], [400, 'Amount is required.']);

          r = await postStk(base, { ...validBody, phoneNumber: '0612345678' });
          assert.deepStrictEqual(
            [r.status, r.body],
            [400, { success: false, error: 'Invalid Kenyan phone number. Must start with 07, 01, or 254.' }]
          );

          r = await postStk(base, null, '{"phoneNumber": "0712345678", ');
          assert.deepStrictEqual(
            [r.status, r.body],
            [400, { success: false, error: 'Invalid JSON in request body.' }]
          );

          r = await postStk(base, {});
          assert.strictEqual(r.status, 400);

          assert.strictEqual(calls.post.length, 0);
          assert.strictEqual(calls.get, 0);
          assert.strictEqual(app.locals.transactions.length, 0);
          // Every attempt is logged, including the malformed-JSON one
          assert.strictEqual(app.locals.logs.length, 7);
          assert.ok(app.locals.logs.some((l) => l.error === 'Invalid JSON in request body.'));
          assert.ok(app.locals.logs.every((l) => l.status === 'FAILED'));
        });
      } finally {
        srv.close();
      }
    }));

  test('Day 2 Task 3: omitted reference/description get defaults; Daraja failures return 502', () =>
    withEnv(baseEnv, async () => {
      mpesa.clearTokenCache();
      let calls = mockDaraja();
      const { app, srv, base } = await startServer();
      try {
        await withCapturedLogs(async () => {
          const r = await postStk(base, { phoneNumber: '0712345678', amount: 50 });
          assert.strictEqual(r.status, 200);
          assert.strictEqual(calls.post[0].payload.AccountReference, 'Payment');
          assert.strictEqual(calls.post[0].payload.TransactionDesc, 'Payment');

          mockDaraja({ postError: httpError(500, { errorMessage: 'Server busy' }) });
          const bad = await postStk(base, validBody);
          assert.strictEqual(bad.status, 502);
          assert.strictEqual(bad.body.success, false);
          assert.match(bad.body.error, /STK Push failed \(HTTP 500\): Server busy/);
          assert.strictEqual(app.locals.transactions.length, 1); // failed push is not stored as pending
        });
      } finally {
        srv.close();
      }
    }));

  test('Day 2 Task 3: missing callback URL is a 500 with a clear message', () =>
    withEnv({ ...baseEnv, MPESA_CALLBACK_URL: undefined }, async () => {
      mpesa.clearTokenCache();
      mockDaraja();
      const { srv, base } = await startServer();
      try {
        await withCapturedLogs(async () => {
          const r = await postStk(base, validBody);
          assert.strictEqual(r.status, 500);
          assert.match(r.body.error, /MPESA_CALLBACK_URL/);
        });
      } finally {
        srv.close();
      }
    }));

  test('Day 2 Bonus: logs are masked, formatted, and served by GET /api/mpesa/logs', () =>
    withEnv(baseEnv, async () => {
      mpesa.clearTokenCache();
      mockDaraja();
      const { srv, base } = await startServer();
      try {
        await withCapturedLogs(async (lines) => {
          await postStk(base, validBody); // success
          await postStk(base, { ...validBody, phoneNumber: '254712345678', amount: 0 }); // failure
          await postStk(base, { ...validBody, phoneNumber: 'abc' }); // invalid phone
          await postStk(base, { ...validBody, amount: '1\n[2026-01-01 00:00:00] STK Push | FORGED' });

          assert.match(
            lines[0],
            /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] STK Push \| 2547\*\*\*\*5678 \| KES 100 \| SUCCESS \| ws_CO_DMZ_123456789_20260504143045$/
          );
          assert.match(
            lines[1],
            /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] STK Push \| 2547\*\*\*\*5678 \| KES 0 \| FAILED \| Amount must be between 1 and 150,000 KES$/
          );
          assert.match(lines[2], /\| \*\*\*\* \| KES 100 \| FAILED \| Phone number must contain only digits/);
          assert.strictEqual(lines.length, 4);
          assert.ok(lines.every((l) => !l.includes('254712345678') && !l.includes('0712345678')));
          assert.ok(!lines.some((l) => l.includes('FORGED')), 'user input must not be echoed into logs');

          const res = await fetch(`${base}/api/mpesa/logs`);
          const json = await res.json();
          assert.strictEqual(res.status, 200);
          assert.strictEqual(json.success, true);
          assert.strictEqual(json.count, 4);
          const [ok, failed, badPhone, forged] = json.logs;
          assert.strictEqual(ok.phone, '2547****5678');
          assert.strictEqual(ok.amount, 100);
          assert.strictEqual(ok.status, 'SUCCESS');
          assert.strictEqual(ok.checkoutRequestId, 'ws_CO_DMZ_123456789_20260504143045');
          assert.ok(!('error' in ok));
          assert.strictEqual(failed.status, 'FAILED');
          assert.strictEqual(failed.error, 'Amount must be between 1 and 150,000 KES');
          assert.ok(!('checkoutRequestId' in failed));
          assert.strictEqual(badPhone.phone, '****');
          assert.strictEqual(forged.amount, null);
          assert.ok(!Number.isNaN(Date.parse(ok.timestamp)));
          const raw = JSON.stringify(json);
          assert.ok(!raw.includes('254712345678'), 'full phone number must never appear in logs');
        });
      } finally {
        srv.close();
      }
    }));

  test('Day 2 Bonus: GET /api/mpesa/logs returns only the last 20 entries', () =>
    withEnv(baseEnv, async () => {
      mpesa.clearTokenCache();
      mockDaraja();
      const { srv, base } = await startServer();
      try {
        await withCapturedLogs(async () => {
          for (let i = 1; i <= 25; i++) await postStk(base, { ...validBody, amount: i });
          const json = await (await fetch(`${base}/api/mpesa/logs`)).json();
          assert.strictEqual(json.count, 20);
          assert.strictEqual(json.logs[0].amount, 6);
          assert.strictEqual(json.logs[19].amount, 25);
        });
      } finally {
        srv.close();
      }
    }));

  // ---- Task 3 ----
  test('Task 3: password unit tests', () =>
    withEnv(baseEnv, () => {
      const r = runPasswordTests();
      assert.ok(r.passed, JSON.stringify(r.results.filter((x) => !x.passed)));
    }));

  test('Task 3: known password value', () =>
    withEnv(baseEnv, () => {
      const expected = Buffer.from(`${baseEnv.MPESA_SHORTCODE}${baseEnv.MPESA_PASSKEY}20260503143045`).toString('base64');
      assert.strictEqual(mpesa.generatePassword('20260503143045'), expected);
    }));

  test('Task 3: timestamp zero-pads single digits', () => {
    const RealDate = Date;
    global.Date = class extends RealDate {
      constructor() { super(2026, 0, 5, 3, 4, 9); } // 5 Jan 2026 03:04:09
    };
    try {
      assert.strictEqual(mpesa.getTimestamp(), '20260105030409');
    } finally {
      global.Date = RealDate;
    }
  });

  // ---- Task 2 ----
  test('Task 2: validateConfig lists a single missing variable', () =>
    withEnv({ ...baseEnv, MPESA_CONSUMER_KEY: undefined }, () => {
      assert.throws(() => mpesa.validateConfig(), {
        message: 'Missing required environment variables: MPESA_CONSUMER_KEY',
      });
    }));

  test('Task 2: validateConfig lists several, treats empty as missing', () =>
    withEnv({ ...baseEnv, MPESA_CONSUMER_KEY: undefined, MPESA_PASSKEY: '   ' }, () => {
      assert.throws(() => mpesa.validateConfig(), {
        message: 'Missing required environment variables: MPESA_CONSUMER_KEY, MPESA_PASSKEY',
      });
    }));

  test('Task 2: getBaseUrl sandbox vs production', () => {
    withEnv({ MPESA_ENV: 'production' }, () =>
      assert.strictEqual(mpesa.getBaseUrl(), 'https://api.safaricom.co.ke'));
    withEnv({ MPESA_ENV: 'sandbox' }, () =>
      assert.strictEqual(mpesa.getBaseUrl(), 'https://sandbox.safaricom.co.ke'));
    withEnv({ MPESA_ENV: 'anything-else' }, () =>
      assert.strictEqual(mpesa.getBaseUrl(), 'https://sandbox.safaricom.co.ke'));
  });

  test('Task 2: getBase64Credentials', () =>
    withEnv(baseEnv, () => {
      assert.strictEqual(
        mpesa.getBase64Credentials(),
        Buffer.from('test_key:test_secret').toString('base64')
      );
    }));

  test('Task 2: production mode logs a warning', () => {
    const warn = console.warn;
    const calls = [];
    console.warn = (m) => calls.push(m);
    try {
      withEnv({ ...baseEnv, MPESA_ENV: 'production' }, () => mpesa.validateConfig());
    } finally {
      console.warn = warn;
    }
    assert.ok(calls.some((m) => /PRODUCTION/.test(m)));
  });

  // ---- Task 1 ----
  test('Task 1: token fetched, then served from cache', () =>
    withEnv(baseEnv, async () => {
      mpesa.clearTokenCache();
      let calls = 0;
      let seen;
      axios.get = async (url, opts) => {
        calls++;
        seen = { url, opts };
        return { data: { access_token: 'tok123', expires_in: '3599' } };
      };
      const t1 = await mpesa.getAccessToken();
      assert.strictEqual(mpesa.getLastTokenSource(), 'network');
      const t2 = await mpesa.getAccessToken();
      assert.strictEqual(mpesa.getLastTokenSource(), 'cache');
      assert.strictEqual(t1, 'tok123');
      assert.strictEqual(t2, 'tok123');
      assert.strictEqual(calls, 1);
      assert.strictEqual(
        seen.url,
        'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
      );
      assert.strictEqual(
        seen.opts.headers.Authorization,
        `Basic ${Buffer.from('test_key:test_secret').toString('base64')}`
      );
    }));

  test('Task 1: expired token (within 60s buffer) is refetched', () =>
    withEnv(baseEnv, async () => {
      mpesa.clearTokenCache();
      let calls = 0;
      axios.get = async () => {
        calls++;
        // expires_in 30s is inside the 60s buffer, so it is already "expired"
        return { data: { access_token: `tok${calls}`, expires_in: '30' } };
      };
      const a = await mpesa.getAccessToken();
      const b = await mpesa.getAccessToken();
      assert.strictEqual(calls, 2);
      assert.notStrictEqual(a, b);
    }));

  test('Task 1: HTTP error is descriptive and clears the cache', () =>
    withEnv(baseEnv, async () => {
      mpesa.clearTokenCache();
      axios.get = async () => ({ data: { access_token: 'good', expires_in: '3599' } });
      await mpesa.getAccessToken(); // populate cache
      mpesa.clearTokenCache();
      axios.get = async () => {
        const e = new Error('Request failed');
        e.response = { status: 400, data: { errorMessage: 'Bad Request - Invalid Credentials' } };
        throw e;
      };
      await assert.rejects(mpesa.getAccessToken(), /HTTP 400.*Invalid Credentials/);
      let calls = 0;
      axios.get = async () => {
        calls++;
        return { data: { access_token: 'fresh', expires_in: '3599' } };
      };
      assert.strictEqual(await mpesa.getAccessToken(), 'fresh');
      assert.strictEqual(calls, 1);
    }));

  test('Task 1: network failure is descriptive', () =>
    withEnv(baseEnv, async () => {
      mpesa.clearTokenCache();
      axios.get = async () => {
        const e = new Error('getaddrinfo ENOTFOUND');
        e.code = 'ENOTFOUND';
        e.request = {};
        throw e;
      };
      await assert.rejects(mpesa.getAccessToken(), /Network error: unable to reach Daraja/);
    }));

  test('Task 1: timeout is descriptive', () =>
    withEnv(baseEnv, async () => {
      mpesa.clearTokenCache();
      axios.get = async () => {
        const e = new Error('timeout');
        e.code = 'ECONNABORTED';
        e.request = {};
        throw e;
      };
      await assert.rejects(mpesa.getAccessToken(), /timed out/);
    }));

  test('Task 1: missing credentials throw before any request', () =>
    withEnv({ ...baseEnv, MPESA_CONSUMER_SECRET: undefined }, async () => {
      mpesa.clearTokenCache();
      let calls = 0;
      axios.get = async () => { calls++; return { data: {} }; };
      await assert.rejects(mpesa.getAccessToken(), /MPESA_CONSUMER_SECRET/);
      assert.strictEqual(calls, 0);
    }));

  // ---- Bonus ----
  test('Bonus: health check bypasses cache but does not break it', () =>
    withEnv(baseEnv, async () => {
      mpesa.clearTokenCache();
      let calls = 0;
      axios.get = async () => {
        calls++;
        return { data: { access_token: `t${calls}`, expires_in: '3599' } };
      };
      await mpesa.getAccessToken(); // 1 network call, caches
      await mpesa.checkDarajaHealth(); // must hit network again (call 2)
      assert.strictEqual(calls, 2);
      await mpesa.getAccessToken(); // served from refreshed cache
      assert.strictEqual(calls, 2);
      assert.strictEqual(mpesa.getLastTokenSource(), 'cache');
    }));

  test('Bonus: healthy API', () =>
    withEnv(baseEnv, async () => {
      axios.get = async () => ({ data: { access_token: 'x', expires_in: '3599' } });
      const r = await mpesa.checkDarajaHealth();
      assert.strictEqual(r.reachable, true);
      assert.strictEqual(r.token_valid, true);
      assert.strictEqual(typeof r.response_time_ms, 'number');
    }));

  test('Bonus: unreachable API (timeout)', () =>
    withEnv(baseEnv, async () => {
      axios.get = async () => {
        const e = new Error('timeout');
        e.code = 'ECONNABORTED';
        e.request = {};
        throw e;
      };
      const r = await mpesa.checkDarajaHealth();
      assert.deepStrictEqual(r, {
        reachable: false,
        response_time_ms: null,
        error: 'Connection timed out',
      });
    }));

  test('Bonus: reachable but bad credentials', () =>
    withEnv(baseEnv, async () => {
      axios.get = async () => {
        const e = new Error('x');
        e.response = { status: 400, data: { errorMessage: 'Invalid Credentials' } };
        throw e;
      };
      const r = await mpesa.checkDarajaHealth();
      assert.strictEqual(r.reachable, true);
      assert.strictEqual(r.token_valid, false);
    }));

  (async () => {
    for (const { name, fn } of queue) {
      try {
        await fn();
        console.log(`  PASS  ${name}`);
      } catch (err) {
        failures++;
        console.log(`  FAIL  ${name}\n        ${err.message}`);
      }
    }
    axios.get = realGet;
    axios.post = realPost;
    console.log(`\n${queue.length - failures}/${queue.length} tests passed`);
    process.exit(failures ? 1 : 0);
  })();
}
