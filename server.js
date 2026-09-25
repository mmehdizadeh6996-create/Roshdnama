// رشدنما - بک‌اند تحلیل واقعی سایت با Google PageSpeed Insights API
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors()); // اجازه فراخوانی از دامنه‌های دیگر (اگر لازم شد)
app.use(express.json());
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
