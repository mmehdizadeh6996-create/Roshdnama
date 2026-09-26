// رشدنما - بک‌اند تحلیل واقعی سایت با Google PageSpeed Insights API
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors()); // اجازه فراخوانی از دامنه‌های دیگر (اگر لازم شد)
app.use(express.json());
const ZIBAL_MERCHANT = process.env.ZIBAL_MERCHANT || '';
const PLANS = [
  { id: 'start', name: 'شروع', price: 9800000 },
  { id: 'growth', name: 'رشد', price: 24500000 },
  { id: 'scale', name: 'تسلط', price: 59000000 },
];
function baseUrl(req) {
  return process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

app.post('/api/payment/request', async (req, res) => {
  try {
    if (!ZIBAL_MERCHANT) return res.status(500).json({ error: 'درگاه پرداخت هنوز تنظیم نشده است.' });
    const { planId, billing } = req.body || {};
    const plan = PLANS.find(p => p.id === planId);
    if (!plan) return res.status(400).json({ error: 'پلن نامعتبر است.' });
    const cycle = Number(billing) === 3 ? 3 : 1;
    const monthly = cycle === 3 ? Math.round((plan.price * 0.85) / 1000) * 1000 : plan.price;
    const amountRial = monthly * cycle * 10; // تومان به ریال
    const orderId = `${plan.id}-${cycle}-${Date.now()}`;
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
    res.json({ paymentUrl: `https://gateway.zibal.ir/start/${zData.trackId}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطای سرور در ایجاد پرداخت.' });
  }
});

app.get('/api/payment/callback', async (req, res) => {
  const { trackId, success, orderId } = req.query;
  const planId = String(orderId || '').split('-')[0] || '';
  try {
    if (String(success) !== '1') {
      return res.redirect(`/?payment=failed&plan=${encodeURIComponent(planId)}`);
    }
    const vRes = await fetch('https://gateway.zibal.ir/v1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merchant: ZIBAL_MERCHANT, trackId }),
    });
    const vData = await vRes.json();
    if (vData.result === 100 || vData.result === 201) {
      return res.redirect(`/?payment=success&plan=${encodeURIComponent(planId)}&ref=${encodeURIComponent(vData.refNumber || trackId)}`);
    }
    return res.redirect(`/?payment=failed&plan=${encodeURIComponent(planId)}`);
  } catch (err) {
    console.error(err);
    return res.redirect(`/?payment=failed&plan=${encodeURIComponent(planId)}`);
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
