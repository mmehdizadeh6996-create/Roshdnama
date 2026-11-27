/* Roshdink unified service: site + Bale bot + Telegram bot in ONE Render service (fits the free 750 h/month instance-hours).
 * One public port; each app runs as its own child process on a private port and is restarted if it crashes.
 *   /webhook/<secret>  -> Bale or Telegram bot (secret is derived from each bot token, or set BALE_WEBHOOK_SECRET / TELEGRAM_WEBHOOK_SECRET)
 *   everything else    -> the website / API (server.js)
 * Env: shared DATABASE_URL, SITE_URL ...; per bot: BALE_BOT_TOKEN, BALE_ADMIN_IDS, TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_IDS (ADMIN_IDS is used if the prefixed one is missing).
 */
const http = require('http'), crypto = require('crypto'), path = require('path'), { spawn } = require('child_process');
const env = process.env;
const PORT = Number(env.PORT || 10000);
const log = (...a) => console.log(new Date().toISOString(), '[unified]', ...a);
const sec = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);

const baleToken = env.BALE_BOT_TOKEN || '', tgToken = env.TELEGRAM_BOT_TOKEN || '';
const APPS = [
  { name: 'site', file: 'server.js', port: 3101, env: {} },
  baleToken && { name: 'bale', file: 'bots/bot.js', port: 3102, secret: env.BALE_WEBHOOK_SECRET || sec('bale:' + baleToken),
    env: { PLATFORM: 'bale', BOT_TOKEN: baleToken, BALE_BOT_TOKEN: baleToken, TELEGRAM_BOT_TOKEN: '', ADMIN_IDS: env.BALE_ADMIN_IDS || env.ADMIN_IDS || '' } },
  tgToken && { name: 'telegram', file: 'bots/bot.js', port: 3103, secret: env.TELEGRAM_WEBHOOK_SECRET || sec('tg:' + tgToken),
    env: { PLATFORM: 'telegram', TELEGRAM_BOT_TOKEN: tgToken, BOT_TOKEN: '', BALE_BOT_TOKEN: '', ADMIN_IDS: env.TELEGRAM_ADMIN_IDS || env.ADMIN_IDS || '' } },
].filter(Boolean);
if (!baleToken) log('BALE_BOT_TOKEN is not set: Bale bot is not started.');
if (!tgToken) log('TELEGRAM_BOT_TOKEN is not set: Telegram bot is not started.');

const procs = new Map(); let stopping = false;
function start(a, attempt = 0) {
  const child = spawn(process.execPath, [path.join(__dirname, a.file)], {
    cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, ...a.env, PORT: String(a.port), ...(a.secret ? { WEBHOOK_SECRET: a.secret } : {}) } });
  const t0 = Date.now(); procs.set(a.name, child);
  const pipe = (s, out) => { let buf = ''; s.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { out.write(`[${a.name}] ${buf.slice(0, i)}\n`); buf = buf.slice(i + 1); } }); };
  pipe(child.stdout, process.stdout); pipe(child.stderr, process.stderr);
  child.on('exit', (code, sig) => {
    procs.delete(a.name); if (stopping) return;
    const ran = Date.now() - t0, n = ran > 60000 ? 0 : attempt + 1, wait = Math.min(30, 2 ** n) * 1000;
    log(`${a.name} exited (${sig || code}) after ${Math.round(ran / 1000)}s; restarting in ${wait / 1000}s`);
    setTimeout(() => start(a, n), wait);
  });
  log(`${a.name} started on private port ${a.port}`);
}
APPS.forEach(a => start(a));

const byName = n => APPS.find(a => a.name === n);
function target(url) {
  const m = /^\/webhook\/([^/?#]+)/.exec(url);
  if (m) return APPS.find(a => a.secret && a.secret === m[1]) || null;
  return byName('site');
}
http.createServer((req, res) => {
  if (req.url === '/__health') return res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
  const a = target(req.url);
  if (!a) return res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  const fwd = (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'] + ', ' : '') + (req.socket.remoteAddress || '');
  const up = http.request({ host: '127.0.0.1', port: a.port, method: req.method, path: req.url, headers: { ...req.headers, 'x-forwarded-for': fwd } }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '5' }); res.end('starting, retry in a few seconds'); });
  req.pipe(up);
}).listen(PORT, () => log(`public port ${PORT}: ${APPS.map(a => a.name).join(', ')}`));

for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { stopping = true; for (const c of procs.values()) c.kill(s); setTimeout(() => process.exit(0), 3000); });
