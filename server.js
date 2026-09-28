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
  { id: 'start', name: 'شروع', price: 9800000, contentQuota: 2 },
  { id: 'growth', name: 'رشد', price: 24500000, contentQuota: 8 },
  { id: 'scale', name: 'تسلط', price: 59000000, contentQuota: 20 },
];
function baseUrl(req) {
  return process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
}
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
function requireAdmin(req, res, next) {
  if (!ADMIN_SECRET || req.headers['x-admin-key'] !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'دسترسی مجاز نیست.' });
  }
  next();
}
function requireAuth(req, res, next) {
  const session = getSessionUser(req);
  if (!session) return res.status(401).json({ error: 'وارد نشده‌اید.' });
  req.session = session;
  next();
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
    CREATE TABLE IF NOT EXISTS seo_scans (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      host VARCHAR(255) NOT NULL,
      overall_score INTEGER,
      mobile_scores JSONB,
      desktop_scores JSONB,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS content_requests (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      topic TEXT NOT NULL,
      notes TEXT,
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      subject VARCHAR(200) NOT NULL,
      status VARCHAR(20) DEFAULT 'open',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS ticket_messages (
      id SERIAL PRIMARY KEY,
      ticket_id INTEGER REFERENCES tickets(id),
      sender VARCHAR(10) NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS site_url VARCHAR(255);
    CREATE TABLE IF NOT EXISTS analyses (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), host VARCHAR(255) NOT NULL,
      scores JSONB, vitals JSONB, issues JSONB, created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS content_requests (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), topic VARCHAR(255) NOT NULL,
      keywords VARCHAR(255), status VARCHAR(20) DEFAULT 'queued', result TEXT, created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), subject VARCHAR(120) NOT NULL,
      status VARCHAR(20) DEFAULT 'open', created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS ticket_messages (
      id SERIAL PRIMARY KEY, ticket_id INTEGER REFERENCES tickets(id), sender VARCHAR(10) NOT NULL,
      body TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now()
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
    const url = `https://api.kavenegar.com/v1/${encodeURIComponent(KAVENEGAR_API_KEY)}/verify/lookup.json?receptor=${encodeURIComponent(phone)}&token=${encodeURIComponent(code)}&template=${encodeURIComponent(KAVENEGAR_TEMPLATE)}`;
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

/* ---------- خلاصه‌ی داشبورد و وضعیت مصرف پلن ---------- */
app.get('/api/dashboard/summary', requireAuth, async (req, res) => {
  try {
    const lastPaid = await pool.query(
      "SELECT * FROM orders WHERE user_id=$1 AND status='paid' ORDER BY created_at DESC LIMIT 1",
      [req.session.uid]
    );
    const order = lastPaid.rows[0] || null;
    let activePlan = null;
    if (order) {
      const planDef = PLANS.find(p => p.id === order.plan_id);
      const expires = new Date(order.created_at);
      expires.setMonth(expires.getMonth() + order.cycle);
      activePlan = {
        id: order.plan_id, name: order.plan_name, cycle: order.cycle,
        quota: planDef ? planDef.contentQuota : 0,
        active: expires > new Date(), expiresAt: expires.toISOString(),
      };
    }
    const usedRes = await pool.query(
      "SELECT COUNT(*)::int AS c FROM content_requests WHERE user_id=$1 AND created_at >= date_trunc('month', now())",
      [req.session.uid]
    );
    const openTickets = await pool.query("SELECT COUNT(*)::int AS c FROM tickets WHERE user_id=$1 AND status='open'", [req.session.uid]);
    const lastScan = await pool.query('SELECT * FROM seo_scans WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [req.session.uid]);
    res.json({
      phone: req.session.phone,
      activePlan,
      contentUsed: usedRes.rows[0].c,
      openTickets: openTickets.rows[0].c,
      lastScan: lastScan.rows[0] || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطای سرور.' });
  }
});

/* ---------- تحلیل سئو با ذخیره‌ی تاریخچه ---------- */
app.post('/api/dashboard/scan', requireAuth, async (req, res) => {
  try {
    let raw = String(req.body?.host || '').trim();
    const host = raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[\/?#]/)[0];
    if (!isValidHost(host)) return res.status(400).json({ error: 'آدرس سایت معتبر نیست.' });
    const target = `https://${host}`;
    const [mobile, desktop] = await Promise.all([runPSI(target, 'mobile'), runPSI(target, 'desktop')]);
    const cats = ['performance', 'seo', 'accessibility', 'bestPractices'];
    const overall = Math.round(cats.reduce((s, k) => s + (mobile.scores[k] || 0), 0) / cats.length);
    await pool.query(
      'INSERT INTO seo_scans(user_id, host, overall_score, mobile_scores, desktop_scores) VALUES($1,$2,$3,$4,$5)',
      [req.session.uid, host, overall, mobile.scores, desktop.scores]
    );
    res.json({ host, overall, mobile, desktop });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'بررسی سایت با خطا مواجه شد.' });
  }
});
app.get('/api/dashboard/scans', requireAuth, async (req, res) => {
  const rows = await pool.query('SELECT id, host, overall_score, created_at FROM seo_scans WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30', [req.session.uid]);
  res.json({ scans: rows.rows });
});

/* ---------- درخواست محتوا ---------- */
app.post('/api/dashboard/content', requireAuth, async (req, res) => {
  const topic = String(req.body?.topic || '').trim();
  if (!topic) return res.status(400).json({ error: 'موضوع محتوا را بنویس.' });
  try {
    const summary = await pool.query(
      "SELECT COUNT(*)::int AS c FROM content_requests WHERE user_id=$1 AND created_at >= date_trunc('month', now())",
      [req.session.uid]
    );
    const lastPaid = await pool.query("SELECT * FROM orders WHERE user_id=$1 AND status='paid' ORDER BY created_at DESC LIMIT 1", [req.session.uid]);
    const planDef = lastPaid.rows[0] ? PLANS.find(p => p.id === lastPaid.rows[0].plan_id) : null;
    const quota = planDef ? planDef.contentQuota : 0;
    if (summary.rows[0].c >= quota) return res.status(403).json({ error: 'سهمیه‌ی محتوای این ماه پلن شما تمام شده است.' });
    await pool.query('INSERT INTO content_requests(user_id, topic) VALUES($1,$2)', [req.session.uid, topic]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطای سرور.' });
  }
});
app.get('/api/dashboard/content', requireAuth, async (req, res) => {
  const rows = await pool.query('SELECT id, topic, status, notes, created_at FROM content_requests WHERE user_id=$1 ORDER BY created_at DESC', [req.session.uid]);
  res.json({ requests: rows.rows });
});

/* ---------- تیکت پشتیبانی ---------- */
app.post('/api/dashboard/tickets', requireAuth, async (req, res) => {
  const subject = String(req.body?.subject || '').trim();
  const message = String(req.body?.message || '').trim();
  if (!subject || !message) return res.status(400).json({ error: 'موضوع و متن پیام را بنویس.' });
  try {
    const t = await pool.query('INSERT INTO tickets(user_id, subject) VALUES($1,$2) RETURNING id', [req.session.uid, subject]);
    await pool.query("INSERT INTO ticket_messages(ticket_id, sender, message) VALUES($1,'user',$2)", [t.rows[0].id, message]);
    res.json({ ok: true, id: t.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطای سرور.' });
  }
});
app.get('/api/dashboard/tickets', requireAuth, async (req, res) => {
  const rows = await pool.query('SELECT id, subject, status, created_at FROM tickets WHERE user_id=$1 ORDER BY created_at DESC', [req.session.uid]);
  res.json({ tickets: rows.rows });
});
app.get('/api/dashboard/tickets/:id/messages', requireAuth, async (req, res) => {
  const own = await pool.query('SELECT id FROM tickets WHERE id=$1 AND user_id=$2', [req.params.id, req.session.uid]);
  if (!own.rows[0]) return res.status(404).json({ error: 'یافت نشد.' });
  const rows = await pool.query('SELECT sender, message, created_at FROM ticket_messages WHERE ticket_id=$1 ORDER BY created_at ASC', [req.params.id]);
  res.json({ messages: rows.rows });
});
app.post('/api/dashboard/tickets/:id/messages', requireAuth, async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'متن پیام خالی است.' });
  const own = await pool.query('SELECT id FROM tickets WHERE id=$1 AND user_id=$2', [req.params.id, req.session.uid]);
  if (!own.rows[0]) return res.status(404).json({ error: 'یافت نشد.' });
  await pool.query("INSERT INTO ticket_messages(ticket_id, sender, message) VALUES($1,'user',$2)", [req.params.id, message]);
  await pool.query("UPDATE tickets SET status='open' WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

/* ---------- پنل ادمین (پاسخ به تیکت‌ها، مدیریت درخواست‌های محتوا) ---------- */
app.get('/api/admin/tickets', requireAdmin, async (req, res) => {
  const rows = await pool.query(`
    SELECT t.id, t.subject, t.status, t.created_at, u.phone
    FROM tickets t JOIN users u ON u.id=t.user_id ORDER BY t.created_at DESC`);
  res.json({ tickets: rows.rows });
});
app.get('/api/admin/tickets/:id/messages', requireAdmin, async (req, res) => {
  const rows = await pool.query('SELECT sender, message, created_at FROM ticket_messages WHERE ticket_id=$1 ORDER BY created_at ASC', [req.params.id]);
  res.json({ messages: rows.rows });
});
app.post('/api/admin/tickets/:id/reply', requireAdmin, async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'متن پیام خالی است.' });
  await pool.query("INSERT INTO ticket_messages(ticket_id, sender, message) VALUES($1,'support',$2)", [req.params.id, message]);
  await pool.query("UPDATE tickets SET status=$1 WHERE id=$2", [req.body.close ? 'closed' : 'open', req.params.id]);
  res.json({ ok: true });
});
app.get('/api/admin/content', requireAdmin, async (req, res) => {
  const rows = await pool.query(`
    SELECT c.id, c.topic, c.status, c.notes, c.created_at, u.phone
    FROM content_requests c JOIN users u ON u.id=c.user_id ORDER BY c.created_at DESC`);
  res.json({ requests: rows.rows });
});
app.post('/api/admin/content/:id', requireAdmin, async (req, res) => {
  const status = String(req.body?.status || 'pending');
  const notes = String(req.body?.notes || '');
  await pool.query('UPDATE content_requests SET status=$1, notes=$2 WHERE id=$3', [status, notes, req.params.id]);
  res.json({ ok: true });
});

/* ---------- داشبورد مشتری ---------- */
const PLAN_LIMITS = { start: { content: 2, analyses: 10 }, growth: { content: 8, analyses: 30 }, scale: { content: 20, analyses: 100 } };
function requireAuth(req, res, next) {
  const s = getSessionUser(req);
  if (!s) return res.status(401).json({ error: 'وارد نشده‌اید.' });
  req.session = s; next();
}
async function getActivePlan(uid) {
  const r = await pool.query(`SELECT plan_id, plan_name, cycle, created_at, created_at + make_interval(months => cycle) AS expires_at
    FROM orders WHERE user_id=$1 AND status='paid' AND created_at + make_interval(months => cycle) > now()
    ORDER BY created_at DESC LIMIT 1`, [uid]);
  return r.rows[0] || null;
}
async function monthlyUsage(uid) {
  const q = t => pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE user_id=$1 AND created_at >= date_trunc('month', now())`, [uid]);
  const [c, a] = await Promise.all([q('content_requests'), q('analyses')]);
  return { content: c.rows[0].n, analyses: a.rows[0].n };
}
const cleanHost = raw => String(raw || '').trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[\/?#]/)[0].toLowerCase();
const fail = (res, err) => { console.error(err); res.status(500).json({ error: 'خطای سرور.' }); };

app.get('/api/dashboard/summary', requireAuth, async (req, res) => {
  try {
    const uid = req.session.uid;
    const u = (await pool.query('SELECT phone, site_url, created_at FROM users WHERE id=$1', [uid])).rows[0];
    const plan = await getActivePlan(uid);
    const orders = (await pool.query('SELECT id, plan_name, cycle, amount_toman, status, ref_number, created_at FROM orders WHERE user_id=$1 ORDER BY created_at DESC', [uid])).rows;
    res.json({ phone: u.phone, site_url: u.site_url, member_since: u.created_at, plan, limits: plan ? PLAN_LIMITS[plan.plan_id] : null, usage: await monthlyUsage(uid), orders });
  } catch (e) { fail(res, e); }
});

app.post('/api/dashboard/profile', requireAuth, async (req, res) => {
  const host = cleanHost(req.body?.site_url);
  if (host && !isValidHost(host)) return res.status(400).json({ error: 'آدرس سایت معتبر نیست.' });
  try { await pool.query('UPDATE users SET site_url=$1 WHERE id=$2', [host || null, req.session.uid]); res.json({ ok: true, site_url: host }); } catch (e) { fail(res, e); }
});

async function guardPlan(req, res, kind) {
  const plan = await getActivePlan(req.session.uid);
  if (!plan) { res.status(403).json({ error: 'برای استفاده از این بخش باید پلن فعال داشته باشی.' }); return null; }
  const usage = await monthlyUsage(req.session.uid);
  if (usage[kind] >= PLAN_LIMITS[plan.plan_id][kind]) { res.status(429).json({ error: 'سهمیه‌ی این ماه پلنت تمام شده است.' }); return null; }
  return plan;
}

app.get('/api/dashboard/analyses', requireAuth, async (req, res) => {
  try { res.json((await pool.query('SELECT id, host, scores, vitals, issues, created_at FROM analyses WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30', [req.session.uid])).rows); } catch (e) { fail(res, e); }
});
app.post('/api/dashboard/analyses', requireAuth, async (req, res) => {
  try {
    if (!(await guardPlan(req, res, 'analyses'))) return;
    let host = cleanHost(req.body?.domain);
    if (!host) host = (await pool.query('SELECT site_url FROM users WHERE id=$1', [req.session.uid])).rows[0].site_url || '';
    if (!host || !isValidHost(host)) return res.status(400).json({ error: 'اول آدرس سایتت را در بخش پروفایل ثبت کن.' });
    const r = await runPSI(`https://${host}`, 'mobile');
    const ins = await pool.query('INSERT INTO analyses(user_id, host, scores, vitals, issues) VALUES($1,$2,$3,$4,$5) RETURNING id, host, scores, vitals, issues, created_at',
      [req.session.uid, host, JSON.stringify(r.scores), JSON.stringify(r.vitals), JSON.stringify(r.topIssues)]);
    res.json(ins.rows[0]);
  } catch (e) { console.error(e); res.status(502).json({ error: 'بررسی سایت ناموفق بود. کمی بعد دوباره امتحان کن.' }); }
});

app.get('/api/dashboard/content', requireAuth, async (req, res) => {
  try { res.json((await pool.query('SELECT id, topic, keywords, status, result, created_at FROM content_requests WHERE user_id=$1 ORDER BY created_at DESC', [req.session.uid])).rows); } catch (e) { fail(res, e); }
});
app.post('/api/dashboard/content', requireAuth, async (req, res) => {
  try {
    const topic = String(req.body?.topic || '').trim(), keywords = String(req.body?.keywords || '').trim().slice(0, 255);
    if (topic.length < 3 || topic.length > 255) return res.status(400).json({ error: 'موضوع باید بین ۳ تا ۲۵۵ کاراکتر باشد.' });
    if (!(await guardPlan(req, res, 'content'))) return;
    res.json((await pool.query('INSERT INTO content_requests(user_id, topic, keywords) VALUES($1,$2,$3) RETURNING id, topic, keywords, status, result, created_at', [req.session.uid, topic, keywords])).rows[0]);
  } catch (e) { fail(res, e); }
});

app.get('/api/dashboard/tickets', requireAuth, async (req, res) => {
  try {
    const t = (await pool.query('SELECT id, subject, status, created_at FROM tickets WHERE user_id=$1 ORDER BY created_at DESC', [req.session.uid])).rows;
    const m = t.length ? (await pool.query('SELECT ticket_id, sender, body, created_at FROM ticket_messages WHERE ticket_id = ANY($1::int[]) ORDER BY created_at ASC', [t.map(x => x.id)])).rows : [];
    res.json(t.map(x => ({ ...x, messages: m.filter(y => y.ticket_id === x.id) })));
  } catch (e) { fail(res, e); }
});
app.post('/api/dashboard/tickets', requireAuth, async (req, res) => {
  try {
    const subject = String(req.body?.subject || '').trim(), body = String(req.body?.body || '').trim();
    if (subject.length < 3 || subject.length > 120 || body.length < 3 || body.length > 2000) return res.status(400).json({ error: 'موضوع و متن پیام را کامل بنویس.' });
    const t = (await pool.query('INSERT INTO tickets(user_id, subject) VALUES($1,$2) RETURNING id', [req.session.uid, subject])).rows[0];
    await pool.query('INSERT INTO ticket_messages(ticket_id, sender, body) VALUES($1,$2,$3)', [t.id, 'user', body]);
    res.json({ ok: true, id: t.id });
  } catch (e) { fail(res, e); }
});
app.post('/api/dashboard/tickets/:id/messages', requireAuth, async (req, res) => {
  try {
    const body = String(req.body?.body || '').trim();
    if (body.length < 1 || body.length > 2000) return res.status(400).json({ error: 'متن پیام معتبر نیست.' });
    const own = await pool.query('SELECT id FROM tickets WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.session.uid]);
    if (!own.rows[0]) return res.status(404).json({ error: 'تیکت پیدا نشد.' });
    await pool.query('INSERT INTO ticket_messages(ticket_id, sender, body) VALUES($1,$2,$3)', [own.rows[0].id, 'user', body]);
    await pool.query("UPDATE tickets SET status='open' WHERE id=$1", [own.rows[0].id]);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
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
