// رشدینک - بک‌اند: تحلیل سایت، پرداخت، داشبورد مشتری، پنل ادمین
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
const SESSION_SECRET = process.env.SESSION_SECRET || 'roshdink-dev-secret-change-me';
const KAVENEGAR_API_KEY = process.env.KAVENEGAR_API_KEY || '';
const KAVENEGAR_TEMPLATE = process.env.KAVENEGAR_TEMPLATE || 'otp';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const PSI_KEY = process.env.PSI_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
async function callClaude(prompt, maxTokens) {
  if (!ANTHROPIC_API_KEY) throw new Error('NO_KEY');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: maxTokens || 1200, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || 'خطای سرویس هوش مصنوعی');
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

const PLANS = [
  { id: 'start', name: 'شروع', price: 9800000 },
  { id: 'growth', name: 'رشد', price: 24500000 },
  { id: 'scale', name: 'تسلط', price: 59000000 },
];

// الگوی آیتم‌های هر پلن: type = one_time | monthly | biweekly ، automation = ai | manual
const PLAN_ITEMS = {
  start: [
    { title: 'ممیزی کامل سئو فنی', type: 'one_time', automation: 'manual' },
    { title: 'تحقیق کلمات کلیدی تا ۳۰ عبارت', type: 'one_time', automation: 'manual' },
    { title: 'بهینه‌سازی on-page تا ۱۰ صفحه', type: 'one_time', automation: 'manual' },
    { title: '۲ محتوای سئوشده این ماه', type: 'monthly', automation: 'ai' },
    { title: 'گزارش عملکرد این ماه', type: 'monthly', automation: 'manual' },
  ],
  growth: [
    { title: 'ممیزی کامل سئو فنی', type: 'one_time', automation: 'manual' },
    { title: 'تحقیق کلمات کلیدی تا ۵۰ عبارت', type: 'one_time', automation: 'manual' },
    { title: 'بهینه‌سازی on-page کل سایت', type: 'one_time', automation: 'manual' },
    { title: 'بهبود سرعت و Core Web Vitals', type: 'one_time', automation: 'manual' },
    { title: 'سئو محلی و ثبت گوگل مپ', type: 'one_time', automation: 'manual' },
    { title: '۸ محتوای تخصصی این ماه', type: 'monthly', automation: 'ai' },
    { title: 'برنامه‌ی لینک‌سازی داخلی سایت این ماه', type: 'monthly', automation: 'ai' },
    { title: 'گزارش عملکرد این ماه', type: 'monthly', automation: 'manual' },
    { title: 'جلسه‌ی استراتژی', type: 'biweekly', automation: 'ai' },
  ],
  scale: [
    { title: 'ممیزی کامل سئو فنی', type: 'one_time', automation: 'manual' },
    { title: 'بهینه‌سازی نرخ تبدیل (CRO)', type: 'one_time', automation: 'manual' },
    { title: '۲۰ محتوا و صفحه‌ی فرود این ماه', type: 'monthly', automation: 'ai' },
    { title: 'برنامه‌ی لینک‌سازی داخلی سایت این ماه', type: 'monthly', automation: 'ai' },
    { title: 'تحلیل رقبا این ماه', type: 'monthly', automation: 'ai' },
    { title: 'گزارش عملکرد این ماه', type: 'monthly', automation: 'manual' },
    { title: 'جلسه‌ی استراتژی', type: 'biweekly', automation: 'ai' },
  ],
};

function baseUrl(req) { return process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`; }
function isValidPhone(p) { return /^09\d{9}$/.test(String(p || '').trim()); }
function isValidHost(h) { return /^([a-z0-9\u0600-\u06ff]([a-z0-9\u0600-\u06ff-]*[a-z0-9\u0600-\u06ff])?\.)+[a-z\u0600-\u06ff]{2,}$/i.test(h); }
const cleanHost = raw => String(raw || '').trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[\/?#]/)[0].toLowerCase();
const fail = (res, err) => { console.error(err); res.status(500).json({ error: 'خطای سرور.' }); };

/* ---------- دیتابیس ---------- */
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function initDb() {
  if (!process.env.DATABASE_URL) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, phone VARCHAR(15) UNIQUE NOT NULL, site_url VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), plan_id VARCHAR(20) NOT NULL,
      plan_name VARCHAR(50) NOT NULL, cycle INTEGER NOT NULL, amount_toman BIGINT NOT NULL,
      status VARCHAR(20) DEFAULT 'pending', track_id VARCHAR(50), ref_number VARCHAR(50),
      created_at TIMESTAMPTZ DEFAULT now()
    );
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
    CREATE TABLE IF NOT EXISTS deliverables (
      id SERIAL PRIMARY KEY, order_id INTEGER REFERENCES orders(id), user_id INTEGER REFERENCES users(id),
      title VARCHAR(255) NOT NULL, item_type VARCHAR(20) NOT NULL, automation VARCHAR(10) NOT NULL,
      period_index INTEGER NOT NULL, status VARCHAR(20) DEFAULT 'pending', result TEXT,
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
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
function setSessionCookie(res, user) {
  const token = jwt.sign({ uid: user.id, phone: user.phone }, SESSION_SECRET, { expiresIn: '30d' });
  res.cookie('session', token, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
}
function getSessionUser(req) {
  try { return jwt.verify(req.cookies?.session, SESSION_SECRET); } catch (e) { return null; }
}
function requireAuth(req, res, next) {
  const s = getSessionUser(req);
  if (!s) return res.status(401).json({ error: 'وارد نشده‌اید.' });
  req.session = s; next();
}
function setAdminCookie(res) {
  const token = jwt.sign({ admin: true }, SESSION_SECRET, { expiresIn: '7d' });
  res.cookie('admin_session', token, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
}
function requireAdmin(req, res, next) {
  try {
    const t = jwt.verify(req.cookies?.admin_session, SESSION_SECRET);
    if (!t.admin) throw new Error('not admin');
    next();
  } catch (e) { res.status(401).json({ error: 'وارد نشده‌اید.' }); }
}

/* ---------- ورود با کد پیامکی (مشتری) ---------- */
const otpStore = new Map();
app.post('/api/auth/otp/request', async (req, res) => {
  const phone = String(req.body?.phone || '').trim();
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'شماره موبایل معتبر نیست.' });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  otpStore.set(phone, { code, expires: Date.now() + 2 * 60 * 1000 });
  if (!KAVENEGAR_API_KEY) return res.json({ ok: true, dev: true, devCode: code });
  try {
    const url = `https://api.kavenegar.com/v1/${encodeURIComponent(KAVENEGAR_API_KEY)}/verify/lookup.json?receptor=${encodeURIComponent(phone)}&token=${encodeURIComponent(code)}&template=${encodeURIComponent(KAVENEGAR_TEMPLATE)}`;
    const kRes = await fetch(url);
    const kData = await kRes.json();
    if (kData.return && kData.return.status !== 200) {
      console.error('Kavenegar error:', JSON.stringify(kData));
      return res.status(502).json({ error: 'ارسال پیامک ناموفق بود.' });
    }
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'خطا در ارسال کد.' }); }
});
app.post('/api/auth/otp/verify', async (req, res) => {
  const phone = String(req.body?.phone || '').trim();
  const code = String(req.body?.code || '').trim();
  const entry = otpStore.get(phone);
  if (!entry || entry.expires < Date.now()) return res.status(400).json({ error: 'کد منقضی شده. دوباره درخواست بده.' });
  if (entry.code !== code) return res.status(400).json({ error: 'کد وارد شده اشتباه است.' });
  otpStore.delete(phone);
  try { const user = await findOrCreateUser(phone); setSessionCookie(res, user); res.json({ ok: true, phone: user.phone }); }
  catch (err) { fail(res, err); }
});
app.post('/api/auth/logout', (req, res) => { res.clearCookie('session'); res.json({ ok: true }); });

/* ---------- ورود ادمین ---------- */
app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD || req.body?.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'رمز اشتباه است.' });
  setAdminCookie(res); res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => { res.clearCookie('admin_session'); res.json({ ok: true }); });
app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ ok: true }));

/* ---------- تولید خودکار برنامه‌ی تحویل بعد از پرداخت موفق ---------- */
async function generateDeliverables(orderId, userId, planId, cycle) {
  const items = PLAN_ITEMS[planId] || [];
  const rows = [];
  for (const it of items) {
    let count = 1;
    if (it.type === 'monthly') count = cycle;
    if (it.type === 'biweekly') count = cycle * 2;
    for (let i = 1; i <= count; i++) rows.push([orderId, userId, it.title, it.type, it.automation, i]);
  }
  if (!rows.length) return;
  const values = [], params = [];
  rows.forEach((r, i) => { const b = i * 6; values.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6})`); params.push(...r); });
  await pool.query(`INSERT INTO deliverables(order_id, user_id, title, item_type, automation, period_index) VALUES ${values.join(',')}`, params);
}

/* ---------- خلاصه و بخش‌های داشبورد مشتری ---------- */
const PLAN_LIMITS = { start: { content: 2, analyses: 10 }, growth: { content: 8, analyses: 30 }, scale: { content: 20, analyses: 100 } };
async function getActivePlan(uid) {
  const r = await pool.query(`SELECT id, plan_id, plan_name, cycle, created_at, created_at + make_interval(months => cycle) AS expires_at
    FROM orders WHERE user_id=$1 AND status='paid' AND created_at + make_interval(months => cycle) > now()
    ORDER BY created_at DESC LIMIT 1`, [uid]);
  return r.rows[0] || null;
}
async function monthlyUsage(uid) {
  const q = t => pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE user_id=$1 AND created_at >= date_trunc('month', now())`, [uid]);
  const [c, a] = await Promise.all([q('content_requests'), q('analyses')]);
  return { content: c.rows[0].n, analyses: a.rows[0].n };
}

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
    if (!host || !isValidHost(host)) return res.status(400).json({ error: 'اول آدرس سایتت را در بخش حساب ثبت کن.' });
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
    const row = (await pool.query('INSERT INTO content_requests(user_id, topic, keywords) VALUES($1,$2,$3) RETURNING *', [req.session.uid, topic, keywords])).rows[0];
    if (ANTHROPIC_API_KEY) {
      try {
        const text = await callClaude(`یک مقاله‌ی سئوشده و کامل به زبان فارسی درباره‌ی موضوع «${topic}» بنویس. کلمات کلیدی هدف: ${keywords || '—'}. مقاله باید حداقل ۵۰۰ کلمه، ساختارمند با زیرتیتر، طبیعی و آماده‌ی انتشار در وبلاگ باشد. فقط متن نهایی مقاله را بنویس، بدون توضیح اضافه.`, 2200);
        const upd = await pool.query('UPDATE content_requests SET status=$1, result=$2 WHERE id=$3 RETURNING *', ['done', text, row.id]);
        return res.json(upd.rows[0]);
      } catch (e) { console.error('AI content error:', e.message); }
    }
    res.json(row);
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

/* ---------- برنامه‌ی اجرا (تحویل‌ها) — مشتری ---------- */
app.get('/api/dashboard/plan', requireAuth, async (req, res) => {
  try {
    const rows = (await pool.query('SELECT id, title, item_type, automation, period_index, status, result, created_at, updated_at FROM deliverables WHERE user_id=$1 ORDER BY period_index ASC, id ASC', [req.session.uid])).rows;
    res.json(rows);
  } catch (e) { fail(res, e); }
});

/* ---------- پنل ادمین ---------- */
app.get('/api/admin/overview', requireAdmin, async (req, res) => {
  try {
    const orders = (await pool.query(`SELECT o.id, o.plan_name, o.cycle, o.status, o.amount_toman, o.created_at, u.phone, u.id AS user_id
      FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT 100`)).rows;
    const pendingDeliverables = (await pool.query(`SELECT count(*)::int AS n FROM deliverables WHERE status != 'done'`)).rows[0].n;
    const openTickets = (await pool.query(`SELECT count(*)::int AS n FROM tickets WHERE status='open'`)).rows[0].n;
    res.json({ orders, pendingDeliverables, openTickets });
  } catch (e) { fail(res, e); }
});
app.get('/api/admin/deliverables', requireAdmin, async (req, res) => {
  try {
    const status = req.query.status;
    const rows = (await pool.query(`SELECT d.id, d.title, d.item_type, d.automation, d.period_index, d.status, d.result, d.created_at, u.phone, d.order_id
      FROM deliverables d JOIN users u ON u.id=d.user_id ${status ? 'WHERE d.status=$1' : ''} ORDER BY d.created_at ASC LIMIT 300`, status ? [status] : [])).rows;
    res.json(rows);
  } catch (e) { fail(res, e); }
});
app.post('/api/admin/deliverables/:id', requireAdmin, async (req, res) => {
  try {
    const status = String(req.body?.status || '');
    if (!['pending', 'in_progress', 'done'].includes(status)) return res.status(400).json({ error: 'وضعیت نامعتبر است.' });
    const result = req.body?.result != null ? String(req.body.result).slice(0, 5000) : null;
    await pool.query('UPDATE deliverables SET status=$1, result=COALESCE($2, result), updated_at=now() WHERE id=$3', [status, result, req.params.id]);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
app.post('/api/admin/deliverables/:id/generate', requireAdmin, async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'کلید هوش مصنوعی هنوز تنظیم نشده است.' });
    const d = (await pool.query('SELECT d.*, u.site_url FROM deliverables d JOIN users u ON u.id=d.user_id WHERE d.id=$1', [req.params.id])).rows[0];
    if (!d) return res.status(404).json({ error: 'آیتم پیدا نشد.' });
    if (d.automation !== 'ai') return res.status(400).json({ error: 'این آیتم خودکار نیست.' });
    const site = d.site_url || 'سایت مشتری';
    let prompt;
    if (d.title.includes('محتوا')) {
      const n = (d.title.match(/\d+/) || [])[0] || '5';
      prompt = `برای سایت ${site}، ${n} موضوع مقاله‌ی سئوشده‌ی جذاب و متفاوت به فارسی پیشنهاد بده. برای هر موضوع یک عنوان و یک خط توضیح کوتاه بنویس. فقط لیست شماره‌گذاری‌شده را برگردان.`;
    } else if (d.title.includes('لینک‌سازی داخلی')) {
      prompt = `برای سایت ${site} یک برنامه‌ی لینک‌سازی داخلی این ماه به فارسی بنویس: چند پیشنهاد مشخص که کدام نوع صفحات باید به کدام صفحات لینک داخلی بدهند و چرا. مختصر و عملی، به‌صورت لیست.`;
    } else if (d.title.includes('تحلیل رقبا')) {
      prompt = `یک چارچوب تحلیل رقبا برای کسب‌وکاری با سایت ${site} به فارسی بنویس: چه معیارهایی (کلمات کلیدی، محتوا، بک‌لینک، سرعت) باید بررسی شود و چطور از روی آن‌ها نتیجه گرفت. چون به داده‌ی زنده‌ی رقبا دسترسی مستقیم نداری، این را به‌عنوان چارچوب و روش تحلیل ارائه بده، نه با اعداد ساختگی.`;
    } else if (d.title.includes('استراتژی')) {
      prompt = `یک گزارش استراتژی سئوی دو هفته‌ای برای سایت ${site} به فارسی بنویس: ۳ تا ۵ اقدام اولویت‌دار برای دو هفته‌ی آینده، با یک دلیل کوتاه برای هرکدام.`;
    } else {
      prompt = `یک گزارش کوتاه و عملی درباره‌ی «${d.title}» برای سایت ${site} به فارسی بنویس.`;
    }
    const text = await callClaude(prompt, 1500);
    const upd = await pool.query('UPDATE deliverables SET status=$1, result=$2, updated_at=now() WHERE id=$3 RETURNING id, title, item_type, automation, period_index, status, result', ['done', text, d.id]);
    res.json(upd.rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'تولید با هوش مصنوعی ناموفق بود.', detail: e.message }); }
});
app.get('/api/admin/tickets', requireAdmin, async (req, res) => {
  try {
    const t = (await pool.query(`SELECT t.id, t.subject, t.status, t.created_at, u.phone FROM tickets t JOIN users u ON u.id=t.user_id ORDER BY t.created_at DESC LIMIT 200`)).rows;
    const m = t.length ? (await pool.query('SELECT ticket_id, sender, body, created_at FROM ticket_messages WHERE ticket_id = ANY($1::int[]) ORDER BY created_at ASC', [t.map(x => x.id)])).rows : [];
    res.json(t.map(x => ({ ...x, messages: m.filter(y => y.ticket_id === x.id) })));
  } catch (e) { fail(res, e); }
});
app.post('/api/admin/tickets/:id/reply', requireAdmin, async (req, res) => {
  try {
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'متن پاسخ خالی است.' });
    await pool.query('INSERT INTO ticket_messages(ticket_id, sender, body) VALUES($1,$2,$3)', [req.params.id, 'support', body]);
    const close = req.body?.close ? "'closed'" : "'open'";
    await pool.query(`UPDATE tickets SET status=${close} WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
app.get('/api/admin/content', requireAdmin, async (req, res) => {
  try {
    const rows = (await pool.query(`SELECT c.id, c.topic, c.keywords, c.status, c.result, c.created_at, u.phone
      FROM content_requests c JOIN users u ON u.id=c.user_id ORDER BY c.created_at ASC LIMIT 300`)).rows;
    res.json(rows);
  } catch (e) { fail(res, e); }
});
app.post('/api/admin/content/:id', requireAdmin, async (req, res) => {
  try {
    const status = String(req.body?.status || 'done');
    const result = req.body?.result != null ? String(req.body.result).slice(0, 20000) : null;
    await pool.query('UPDATE content_requests SET status=$1, result=COALESCE($2, result) WHERE id=$3', [status, result, req.params.id]);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

/* ---------- پرداخت (زیبال) ---------- */
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
    const amountRial = amountToman * 10;

    const user = await findOrCreateUser(String(phone).trim());
    const orderRow = await pool.query(
      'INSERT INTO orders(user_id, plan_id, plan_name, cycle, amount_toman, status) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [user.id, plan.id, plan.name, cycle, amountToman, 'pending']
    );
    const orderId = String(orderRow.rows[0].id);
    const callbackUrl = `${baseUrl(req)}/api/payment/callback`;

    const zRes = await fetch('https://gateway.zibal.ir/v1/request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merchant: ZIBAL_MERCHANT, amount: amountRial, callbackUrl, orderId, description: `اشتراک پلن ${plan.name} - ${cycle} ماهه` }),
    });
    const zData = await zRes.json();
    if (zData.result !== 100) {
      console.error('Zibal request rejected:', JSON.stringify(zData));
      return res.status(502).json({ error: 'اتصال به درگاه پرداخت ناموفق بود.', detail: zData.message || zData.result });
    }
    await pool.query('UPDATE orders SET track_id=$1 WHERE id=$2', [zData.trackId, orderId]);
    res.json({ paymentUrl: `https://gateway.zibal.ir/start/${zData.trackId}` });
  } catch (err) { console.error(err); res.status(500).json({ error: 'خطای سرور در ایجاد پرداخت.' }); }
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
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merchant: ZIBAL_MERCHANT, trackId }),
    });
    const vData = await vRes.json();
    if (vData.result === 100 || vData.result === 201) {
      await pool.query("UPDATE orders SET status='paid', ref_number=$1 WHERE id=$2", [vData.refNumber || trackId, orderId]);
      await generateDeliverables(order.id, order.user_id, order.plan_id, order.cycle);
      const userRes = await pool.query('SELECT * FROM users WHERE id=$1', [order.user_id]);
      if (userRes.rows[0]) setSessionCookie(res, userRes.rows[0]);
      return res.redirect(`/dashboard.html?payment=success&ref=${encodeURIComponent(vData.refNumber || trackId)}`);
    }
    await pool.query("UPDATE orders SET status='failed' WHERE id=$1", [orderId]);
    return res.redirect(`/dashboard.html?payment=failed`);
  } catch (err) { console.error(err); return res.redirect(`/dashboard.html?payment=failed`); }
});

/* ---------- تحلیل عمومی سایت (صفحه‌ی اصلی) ---------- */
async function runPSI(url, strategy) {
  const endpoint = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  endpoint.searchParams.set('url', url);
  endpoint.searchParams.set('strategy', strategy);
  ['performance', 'accessibility', 'best-practices', 'seo'].forEach(c => endpoint.searchParams.append('category', c));
  if (PSI_KEY) endpoint.searchParams.set('key', PSI_KEY);
  const res = await fetch(endpoint.toString());
  if (!res.ok) { const body = await res.text().catch(() => ''); throw new Error(`PageSpeed API error (${res.status}): ${body.slice(0, 300)}`); }
  const data = await res.json();
  const cats = data.lighthouseResult?.categories || {};
  const audits = data.lighthouseResult?.audits || {};
  const pct = v => (v == null ? null : Math.round(v * 100));
  return {
    strategy,
    scores: { performance: pct(cats.performance?.score), accessibility: pct(cats.accessibility?.score), bestPractices: pct(cats['best-practices']?.score), seo: pct(cats.seo?.score) },
    vitals: { lcp: audits['largest-contentful-paint']?.displayValue || null, cls: audits['cumulative-layout-shift']?.displayValue || null, tbt: audits['total-blocking-time']?.displayValue || null, fcp: audits['first-contentful-paint']?.displayValue || null },
    topIssues: Object.values(audits).filter(a => a.score !== null && a.score < 0.9 && a.details?.type === 'opportunity')
      .sort((a, b) => (b.details?.overallSavingsMs || 0) - (a.details?.overallSavingsMs || 0)).slice(0, 5).map(a => ({ title: a.title, description: a.description })),
  };
}
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.post('/api/analyze', async (req, res) => {
  try {
    let raw = String(req.body?.domain || '').trim();
    if (!raw) return res.status(400).json({ error: 'آدرس سایت ارسال نشده است.' });
    const hasProtocol = /^https?:\/\//i.test(raw);
    const host = raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[\/?#]/)[0];
    if (!isValidHost(host)) return res.status(400).json({ error: 'آدرس سایت معتبر نیست.' });
    const target = hasProtocol ? raw : `https://${host}`;
    const [mobile, desktop] = await Promise.all([runPSI(target, 'mobile'), runPSI(target, 'desktop')]);
    res.json({ host, target, mobile, desktop, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'بررسی سایت با خطا مواجه شد. ممکن است سایت در دسترس نباشد یا سرویس گوگل موقتاً پاسخ ندهد.', detail: String(err.message || err) });
  }
});

/* ---------- سرو کردن فایل‌های استاتیک سایت ---------- */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'roshdnama.html')));
app.use(express.static(__dirname, { index: false }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API روی پورت ${PORT} اجرا شد`));
