// رشدنما - بک‌اند تحلیل واقعی سایت با Google PageSpeed Insights API
const express = require('express');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(cookieParser());
const ZIBAL_MERCHANT = process.env.ZIBAL_MERCHANT || '';
const PLANS = [
  { id: 'start', name: 'شروع', price: 9800000 },
  { id: 'growth', name: 'رشد', price: 24500000 },
  { id: 'scale', name: 'تسلط', price: 59000000 },
];
function baseUrl(req) {
  return process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

/* ---------- دیتابیس ---------- */
const SESSION_SECRET = process.env.SESSION_SECRET || 'roshdink-dev-secret-change-me';
const KAVENEGAR_API_KEY = process.env.KAVENEGAR_API_KEY || '';
const KAVENEGAR_TEMPLATE = process.env.KAVENEGAR_TEMPLATE || 'otp';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function initDb() {
  if (!process.env.DATABASE_URL) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      phone VARCHAR(15) UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      plan_id VARCHAR(20) NOT NULL,
      plan_name VARCHAR(50) NOT NULL,
      cycle INTEGER NOT NULL,
      amount_toman BIGINT NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      track_id VARCHAR(50),
      ref_number VARCHAR(50),
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}
initDb().catch(err => console.error('DB init error:', err));

async function findOrCreateUser(phone) {
  const found = await pool.query('SELECT * FROM users WHERE phone=$1', [phone]);
  if (found.rows[0]) return found.rows[0];
  const created = await pool.query('INSERT INTO users(phone) VALUES($1) RETURNING *', [phone]);
  return created.rows[0];
}
function isValidPhone(p) { return /^09\d{9}$/.test(String(p || '').trim()); }
function setSessionCookie(res, user) {
  const token = jwt.sign({ uid: user.id, phone: user.phone }, SESSION_SECRET, { expiresIn: '30d' });
  res.cookie('session', token, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
}
function getSessionUser(req) {
  try {
    const token = req.cookies && req.cookies.session;
    if (!token) return null;
    return jwt.verify(token, SESSION_SECRET);
  } catch (e) { return null; }
}

/* ---------- ورود با کد پیامکی ---------- */
const otpStore = new Map(); // phone -> {code, expires}

app.post('/api/auth/otp/request', async (req, res) => {
  const phone = String(req.body?.phone || '').trim();
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'شماره موبایل معتبر نیست.' });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  otpStore.set(phone, { code, expires: Date.now() + 2 * 60 * 1000 });

  if (!KAVENEGAR_API_KEY) {
    return res.json({ ok: true, dev: true, devCode: code }); // حالت آزمایشی بدون سرویس پیامک
  }
  try {
    const url = `https://api.kavenegar.com/v1/${KAVENEGAR_API_KEY}/verify/lookup.json?receptor=${encodeURIComponent(phone)}&token=${encodeURIComponent(code)}&template=${encodeURIComponent(KAVENEGAR_TEMPLATE)}`;
    const kRes = await fetch(url);
    const kData = await kRes.json();
    if (kData.return && kData.return.status !== 200) {
      console.error('Kavenegar error:', JSON.stringify(kData));
      return res.status(502).json({ error: 'ارسال پیامک ناموفق بود.' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطا در ارسال کد.' });
  }
});

app.post('/api/auth/otp/verify', async (req, res) => {
  const phone = String(req.body?.phone || '').trim();
  const code = String(req.body?.code || '').trim();
  const entry = otpStore.get(phone);
  if (!entry || entry.expires < Date.now()) return res.status(400).json({ error: 'کد منقضی شده. دوباره درخواست بده.' });
  if (entry.code !== code) return res.status(400).json({ error: 'کد وارد شده اشتباه است.' });
  otpStore.delete(phone);
  try {
    const user = await findOrCreateUser(phone);
    setSessionCookie(res, user);
    res.json({ ok: true, phone: user.phone });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطای سرور در ورود.' });
  }
});

app.post('/api/auth/logout', (req, res) => { res.clearCookie('session'); res.json({ ok: true }); });

app.get('/api/me', async (req, res) => {
  const session = getSessionUser(req);
  if (!session) return res.status(401).json({ error: 'وارد نشده‌اید.' });
  try {
    const orders = await pool.query('SELECT id, plan_id, plan_name, cycle, amount_toman, status, ref_number, created_at FROM orders WHERE user_id=$1 ORDER BY created_at DESC', [session.uid]);
    res.json({ phone: session.phone, orders: orders.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطای سرور.' });
  }
});

app.post('/api/payment/request', async (req, res) => {
  try {
    if (!ZIBAL_MERCHANT) return res.status(500).json({ error: 'درگاه پرداخت هنوز تنظیم نشده است.' });
    const { planId, billing, phone } = req.body || {};
    if (!isValidPhone(phone)) return res.status(400).json({ error: 'شماره موبایل معتبر نیست.' });
    const plan = PLANS.find(p => p.id === planId);
    if (!plan) return res.status(400).json({ error: 'پلن نامعتبر است.' });
    const cycle = Number(billing) === 3 ? 3 : 1;
    const monthly = cycle === 3 ? Math.round((plan.price * 0.85) / 1000) * 1000 : plan.price;
    const amountToman = monthly * cycle;
    const amountRial = amountToman * 10; // تومان به ریال

    const user = await findOrCreateUser(String(phone).trim());
    const orderRow = await pool.query(
      'INSERT INTO orders(user_id, plan_id, plan_name, cycle, amount_toman, status) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [user.id, plan.id, plan.name, cycle, amountToman, 'pending']
    );
    const orderId = String(orderRow.rows[0].id);
    const callbackUrl = `${baseUrl(req)}/api/payment/callback`;

    const zRes = await fetch('https://gateway.zibal.ir/v1/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchant: ZIBAL_MERCHANT,
        amount: amountRial,
        callbackUrl,
        orderId,
        description: `اشتراک پلن ${plan.name} - ${cycle} ماهه`,
      }),
    });
    const zData = await zRes.json();
    if (zData.result !== 100) {
      console.error('Zibal request rejected:', JSON.stringify(zData));
      return res.status(502).json({ error: 'اتصال به درگاه پرداخت ناموفق بود.', detail: zData.message || zData.result });
    }
    await pool.query('UPDATE orders SET track_id=$1 WHERE id=$2', [zData.trackId, orderId]);
    res.json({ paymentUrl: `https://gateway.zibal.ir/start/${zData.trackId}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطای سرور در ایجاد پرداخت.' });
  }
});

app.get('/api/payment/callback', async (req, res) => {
  const { trackId, success, orderId } = req.query;
  try {
    const orderRes = await pool.query('SELECT * FROM orders WHERE id=$1', [orderId]);
    const order = orderRes.rows[0];
    if (String(success) !== '1' || !order) {
      if (order) await pool.query("UPDATE orders SET status='failed' WHERE id=$1", [orderId]);
      return res.redirect(`/dashboard.html?payment=failed`);
    }
    const vRes = await fetch('https://gateway.zibal.ir/v1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merchant: ZIBAL_MERCHANT, trackId }),
    });
    const vData = await vRes.json();
    if (vData.result === 100 || vData.result === 201) {
      await pool.query("UPDATE orders SET status='paid', ref_number=$1 WHERE id=$2", [vData.refNumber || trackId, orderId]);
      const userRes = await pool.query('SELECT * FROM users WHERE id=$1', [order.user_id]);
      if (userRes.rows[0]) setSessionCookie(res, userRes.rows[0]); // ورود خودکار به داشبورد
      return res.redirect(`/dashboard.html?payment=success&ref=${encodeURIComponent(vData.refNumber || trackId)}`);
    }
    await pool.query("UPDATE orders SET status='failed' WHERE id=$1", [orderId]);
    return res.redirect(`/dashboard.html?payment=failed`);
  } catch (err) {
    console.error(err);
    return res.redirect(`/dashboard.html?payment=failed`);
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'roshdnama.html')));
app.use(express.static(__dirname, { index: false })); // سرو کردن فایل‌های استاتیک از ریشه‌ی پروژه

const PSI_KEY = process.env.PSI_API_KEY || ''; // اختیاری؛ بدون کلید هم کار می‌کند ولی با محدودیت بیشتر

function isValidHost(h) {
  return /^([a-z0-9\u0600-\u06ff]([a-z0-9\u0600-\u06ff-]*[a-z0-9\u0600-\u06ff])?\.)+[a-z\u0600-\u06ff]{2,}$/i.test(h);
}

async function runPSI(url, strategy) {
  const endpoint = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  endpoint.searchParams.set('url', url);
  endpoint.searchParams.set('strategy', strategy);
  ['performance', 'accessibility', 'best-practices', 'seo'].forEach(c =>
    endpoint.searchParams.append('category', c)
  );
  if (PSI_KEY) endpoint.searchParams.set('key', PSI_KEY);

  const res = await fetch(endpoint.toString());
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`PageSpeed API error (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const cats = data.lighthouseResult?.categories || {};
  const audits = data.lighthouseResult?.audits || {};
  const pct = v => (v == null ? null : Math.round(v * 100));

  return {
    strategy,
    scores: {
      performance: pct(cats.performance?.score),
      accessibility: pct(cats.accessibility?.score),
      bestPractices: pct(cats['best-practices']?.score),
      seo: pct(cats.seo?.score),
    },
    vitals: {
      lcp: audits['largest-contentful-paint']?.displayValue || null,
      cls: audits['cumulative-layout-shift']?.displayValue || null,
      tbt: audits['total-blocking-time']?.displayValue || null,
      fcp: audits['first-contentful-paint']?.displayValue || null,
    },
    topIssues: Object.values(audits)
      .filter(a => a.score !== null && a.score < 0.9 && a.details?.type === 'opportunity')
      .sort((a, b) => (b.details?.overallSavingsMs || 0) - (a.details?.overallSavingsMs || 0))
      .slice(0, 5)
      .map(a => ({ title: a.title, description: a.description })),
  };
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/analyze', async (req, res) => {
  try {
    let raw = String(req.body?.domain || '').trim();
    if (!raw) return res.status(400).json({ error: 'آدرس سایت ارسال نشده است.' });

    const hasProtocol = /^https?:\/\//i.test(raw);
    const host = raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[\/?#]/)[0];
    if (!isValidHost(host)) {
      return res.status(400).json({ error: 'آدرس سایت معتبر نیست.' });
    }
    const target = hasProtocol ? raw : `https://${host}`;

    const [mobile, desktop] = await Promise.all([
      runPSI(target, 'mobile'),
      runPSI(target, 'desktop'),
    ]);

    res.json({ host, target, mobile, desktop, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'بررسی سایت با خطا مواجه شد. ممکن است سایت در دسترس نباشد یا سرویس گوگل موقتاً پاسخ ندهد.', detail: String(err.message || err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API روی پورت ${PORT} اجرا شد`));
