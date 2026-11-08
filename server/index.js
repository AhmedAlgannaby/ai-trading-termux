/**
 * السيرفر المحلي — بديل Base44 الكامل:
 *   - Entities API (تخزين JSON محلي)
 *   - Auth محلي (مستخدم واحد على الجهاز/الاستضافة)
 *   - LLM API بأي مزود متوافق مع OpenAI
 *   - دوال ai_signal_generator / signal_executor + وسيط Binance
 *   - في الإنتاج يقدّم ملفات dist الجاهزة (تطبيق + API على نفس المنفذ)
 *
 * التشغيل:
 *   npm run dev:server   (تطوير — المنفذ 3001)
 *   npm start            (إنتاج — يقدّم dist/)
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { db, getUser, updateUser, isBlockedEntity } from './db.js';
import { callLLM } from './llm.js';
import * as binance from './binance.js';
import { executeSignal, generateSignals } from './functions.js';
import { sanitizeEntityInput, sanitizeEntityPatch } from './entityGuards.js';
import { startWorker, workerStatus } from './worker/index.js';

const PORT = Number(process.env.PORT || 3001);
const app = express();
app.disable('x-powered-by');

// ── CORS locked down (was app.use(cors()) — any origin could drive trading/LLM) ──
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / curl / server-to-server
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('CORS blocked'), false);
  },
}));

// Minimal security headers (helmet-lite to avoid new deps)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.json({ limit: '2mb' }));

// ── Simple in-memory rate limiter (avoids new deps) ──
const _hits = new Map();
function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const arr = (_hits.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    _hits.set(key, arr);
    if (arr.length > max) {
      res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({
        error: 'تم الوصول إلى حد الطلبات — أعد المحاولة بعد قليل',
        retry_after_ms: windowMs,
      });
    }
    next();
  };
}
const generalLimiter = rateLimit({ windowMs: 60_000, max: 600 });
// العقل المحلي (بدون LLM_API_KEY) لا يستهلك مزوداً خارجياً — يجب أن تكفي دورة
// كاملة لكل الأزواج (28+). مع مزود خارجي نبقى على حد أقل للحماية من التكلفة.
const LLM_RATE_MAX = Number(process.env.LLM_RATE_LIMIT) > 0
  ? Number(process.env.LLM_RATE_LIMIT)
  : (process.env.LLM_API_KEY ? 60 : 240);
const llmLimiter = rateLimit({ windowMs: 60_000, max: LLM_RATE_MAX });
const orderLimiter = rateLimit({ windowMs: 60_000, max: 10 }); // B: الأوامر الحية 10/دقيقة
app.use('/api/', generalLimiter);
// H: تنظيف دوري لخريطة المعدل (كانت تنمو بلا حد مع كل IP جديد)
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of _hits) {
    const fresh = arr.filter((t) => now - t < 3600000);
    if (fresh.length) _hits.set(k, fresh);
    else _hits.delete(k);
  }
  if (_hits.size > 5000) _hits.clear(); // صمام أمان أخير
}, 15 * 60 * 1000).unref?.();

// ── API token: إلزامي، أو loopback فقط عند غيابه (A) ──
// بلا توكن: التشغيل المحلي يعمل، وأي وصول شبكي خارجي يُرفض 403.
// مقارنة ثابتة الزمن ضد التخمين.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function requireToken(req, res, next) {
  const expected = process.env.LOCAL_API_TOKEN;
  if (req.path === '/api/health') return next();
  if (expected) {
    const got = req.headers['x-api-token']
      || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(String(got)), b = Buffer.from(String(expected));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return next();
  }
  if (!LOOPBACK.has(req.ip)) {
    return res.status(403).json({ error: 'API exposed without LOCAL_API_TOKEN — set it or use localhost' });
  }
  next();
}
app.use(requireToken);

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── الصحة (يكشف حالة العامل لتنحي محركات المتصفح) ──
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString(), worker: workerStatus() }));

// ── المستخدم المحلي (secrets are masked on read; empty = keep existing on write) ──
app.get('/api/auth/me', asyncHandler(async (req, res) => {
  res.json(await getUser({ includeSecrets: false }));
}));
app.patch('/api/auth/me', asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (body && typeof body !== 'object') return res.status(400).json({ error: 'Invalid body' });
  const updated = await updateUser(body);
  // Never echo secrets back
  updated.binance_api_key = '';
  updated.binance_secret_key = '';
  updated.binance_testnet_api_key = '';
  updated.binance_testnet_secret_key = '';
  updated.telegram_bot_token = '';
  res.json(updated);
}));

// ── Entities (متوافقة مع واجهة SDK: list/filter/create/update/delete/bulkCreate) ──
function assertEntity(req, res) {
  if (isBlockedEntity(req.params.name)) {
    res.status(404).json({ error: 'Not found' });
    return false;
  }
  return true;
}

app.get('/api/entities/:name', asyncHandler(async (req, res) => {
  if (!assertEntity(req, res)) return;
  const { sort, limit, filter } = req.query;
  let parsedFilter = {};
  if (filter) {
    if (String(filter).length > 4000) return res.status(400).json({ error: 'Filter too large' });
    try {
      parsedFilter = JSON.parse(filter);
    } catch {
      return res.status(400).json({ error: 'Invalid filter JSON' });
    }
    if (parsedFilter && typeof parsedFilter !== 'object') {
      return res.status(400).json({ error: 'Invalid filter' });
    }
  }
  if (typeof sort === 'string' && sort.length > 60) return res.status(400).json({ error: 'Invalid sort' });
  const user = await getUser();
  res.json(await db.list(req.params.name, { sort, limit, filter: parsedFilter, _by: user.email }));
}));

app.post('/api/entities/:name', asyncHandler(async (req, res) => {
  if (!assertEntity(req, res)) return;
  const user = await getUser();
  // C2: تعقيم الكتابة العامة (فرض paper للصفقات + تحقق الإشارات/الإعدادات)
  const guard = sanitizeEntityInput(req.params.name, req.body || {});
  if (!guard.ok) return res.status(400).json({ error: guard.error });
  const record = await db.create(req.params.name, guard.body, user.email);
  // خطاف signal_executor الأصلي: معالجة إشارات Signal الجديدة فوراً.
  // auto_execute===false يعني أن منشئ الإشارة (روبوت المتصفح) أوقف التنفيذ
  // التلقائي صراحةً — نحترم ذلك ولا ننفذ.
  if (req.params.name === 'Signal' && record?.id && record.auto_execute !== false) {
    executeSignal(record.id).catch((e) => console.error('signal hook:', e.message));
  }
  res.status(201).json(record);
}));

app.post('/api/entities/:name/bulk', asyncHandler(async (req, res) => {
  if (!assertEntity(req, res)) return;
  const user = await getUser();
  const items = Array.isArray(req.body) ? req.body : req.body?.items || [];
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Invalid items' });
  if (items.length > 100) return res.status(400).json({ error: 'Too many items (max 100)' });
  const clean = [];
  for (const it of items) {
    const g = sanitizeEntityInput(req.params.name, it || {});
    if (!g.ok) return res.status(400).json({ error: g.error });
    clean.push(g.body);
  }
  res.status(201).json(await db.bulkCreate(req.params.name, clean, user.email));
}));

app.get('/api/entities/:name/:id', asyncHandler(async (req, res) => {
  if (!assertEntity(req, res)) return;
  const record = await db.get(req.params.name, req.params.id);
  if (!record) return res.status(404).json({ error: 'Not found' });
  res.json(record);
}));

app.patch('/api/entities/:name/:id', asyncHandler(async (req, res) => {
  if (!assertEntity(req, res)) return;
  const guard = sanitizeEntityPatch(req.params.name, req.body || {});
  if (!guard.ok) return res.status(400).json({ error: guard.error });
  const record = await db.update(req.params.name, req.params.id, guard.body);
  if (!record) return res.status(404).json({ error: 'Not found' });
  res.json(record);
}));

app.delete('/api/entities/:name/:id', asyncHandler(async (req, res) => {
  if (!assertEntity(req, res)) return;
  const ok = await db.remove(req.params.name, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
}));

// ── LLM (بديل InvokeLLM — يقبل نفس الحقول prompt/response_json_schema) ──
// NOTE: client `system`/`model` are ignored unless explicitly allowed, to
// prevent prompt-injection / model-override abuse.
app.post('/api/llm', llmLimiter, asyncHandler(async (req, res) => {
  const { prompt, response_json_schema, schema } = req.body || {};
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt is required' });
  if (prompt.length > 20000) return res.status(400).json({ error: 'prompt too large' });
  res.json(await callLLM({ prompt, schema: response_json_schema || schema }));
}));

// ── الدوال (بديل backend functions) ──
app.post('/api/functions/ai_signal_generator', llmLimiter, asyncHandler(async (req, res) => {
  const { pairs } = req.body || {};
  if (pairs !== undefined) {
    if (!Array.isArray(pairs) || pairs.length > 40) {
      return res.status(400).json({ error: 'pairs must be an array (max 40)' });
    }
  }
  res.json(await generateSignals(pairs));
}));

app.post('/api/functions/signal_executor', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const signal = body?.record || body?.data || body;
  if (!signal?.id || typeof signal.id !== 'string') {
    return res.status(400).json({ error: 'signal id is required' });
  }
  res.json(await executeSignal(signal.id));
}));

// ── إغلاق موحد (البيع = تحويل الأصل إلى USDT) — نصيحة أولاً ثم تنفيذ مؤكد ──
app.post('/api/functions/close_trade', asyncHandler(async (req, res) => {
  const { closeTradeById } = await import('./functions.js');
  const body = req.body || {};
  const t = body?.record || body?.data || body;
  if (!t?.id || typeof t.id !== 'string') {
    return res.status(400).json({ error: 'trade id is required' });
  }
  if (t.confirmed === true) {
    let allowed = false;
    orderLimiter(req, res, () => { allowed = true; });
    if (!allowed) return; // رُدّ 429 داخل المحدد
  }
  const out = await closeTradeById(t.id, { confirmed: t.confirmed === true });
  if (!out.ok) return res.status(out.status || 400).json({ error: out.error });
  res.json(out);
}));

// ── Binance عبر الخادم (بدون CORS وبدون كشف المفاتيح للمتصفح) ──
const VALID_INTERVALS = new Set(['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M']);
function isValidSymbol(s) {
  return typeof s === 'string' && /^[A-Z0-9]{4,20}$/.test(s);
}
app.post('/api/binance', asyncHandler(async (req, res) => {
  const { action, ...rest } = req.body || {};
  const user = await getUser();
  if (action === 'ticker') {
    const symbols = rest.symbols ?? undefined;
    if (symbols !== undefined) {
      if (!Array.isArray(symbols) || symbols.length > 50 || !symbols.every(isValidSymbol)) {
        return res.status(400).json({ error: 'Invalid symbols' });
      }
    }
    return res.json(await binance.ticker(symbols));
  }
  if (action === 'klines') {
    if (!isValidSymbol(rest.symbol)) return res.status(400).json({ error: 'Invalid symbol' });
    if (!VALID_INTERVALS.has(rest.interval)) return res.status(400).json({ error: 'Invalid interval' });
    const limit = Math.min(Math.max(Number(rest.limit) || 100, 1), 1000);
    const opts = {};
    if (Number.isFinite(Number(rest.startTime))) opts.startTime = Number(rest.startTime);
    if (Number.isFinite(Number(rest.endTime))) opts.endTime = Number(rest.endTime);
    return res.json(await binance.klines(rest.symbol, rest.interval, limit, opts));
  }
  if (action === 'account') return res.json(await binance.account(user));
  if (action === 'openOrders') return res.json(await binance.openOrders(user));
  if (action === 'order') {
    // B: حد صارم على الأوامر الحية (10/دقيقة لكل IP) قبل أي تحقق
    let allowed = false;
    orderLimiter(req, res, () => { allowed = true; });
    if (!allowed) return; // رُدّ 429 داخل المحدد
    return res.json(await binance.placeOrder(user, rest));
  }
  return res.status(400).json({ error: 'Unknown action' });
}));

// ── العقل المحلي المباشر (تحليل كمي بلا LLM) ──
function sanitizePair(p, fallback = 'BTC/USDT') {
  if (typeof p !== 'string' || !/^[A-Z]{2,12}\/[A-Z]{2,12}$/.test(p.toUpperCase())) return fallback;
  return p.toUpperCase();
}
app.post('/api/brain/analyze', asyncHandler(async (req, res) => {
  const { analyze } = await import('./brain/signals.js');
  const { getCandles } = await import('./brain/market.js');
  const pair = sanitizePair(req.body?.pair);
  const interval = VALID_INTERVALS.has(req.body?.interval) ? req.body.interval : '4h';
  const candles = await getCandles(pair, interval, 300);
  const knowledge = await db.list('BacktestResult', { sort: '-score', limit: 5 });
  res.json(await analyze(pair, candles, knowledge));
}));

// ── تحليل متعدد الفريمات بمواصفة استراتيجية (Phase 2) ──
// body: { pair, spec?: id|object, tf1h?: bool, tf1d?: bool }
app.post('/api/brain/ensemble', asyncHandler(async (req, res) => {
  const { analyzeMultiTF, getSpec } = await import('./brain/strategies.js');
  const { getCandles } = await import('./brain/market.js');
  const { summarize } = await import('./brain/indicators.js');
  const pair = sanitizePair(req.body?.pair);
  // G: المواصفة بمعرف من القائمة البيضاء فقط (لا كائنات من العميل)
  const specId = typeof req.body?.spec === 'string' ? req.body.spec.slice(0, 60) : 'quant_hybrid';
  const spec = getSpec(specId);
  const use1h = req.body?.tf1h !== false;
  const use1d = req.body?.tf1d !== false;
  const [h4, d1, h1] = await Promise.all([
    getCandles(pair, '4h', 300),
    use1d ? getCandles(pair, '1d', 120).catch(() => []) : Promise.resolve([]),
    use1h ? getCandles(pair, '1h', 120).catch(() => []) : Promise.resolve([]),
  ]);
  const knowledge = await db.list('BacktestResult', { sort: '-score', limit: 5 });
  res.json(analyzeMultiTF(pair, { h4, d1, h1 }, { spec, knowledge, summarize4h: summarize(h4) }));
}));

app.post('/api/brain/backtest', asyncHandler(async (req, res) => {
  const { runBacktest, deriveLessons, walkForward } = await import('./brain/backtest.js');
  const { getCandles } = await import('./brain/market.js');
  const { getSpec } = await import('./brain/strategies.js');
  const {
    pair: rawPair = 'BTC/USDT', interval: rawInterval = '1h', limit: rawLimit = 720,
    initialBalance = 10000, riskPerTrade = 2,
    stopLossPercent = 2, takeProfitPercent = 4, save = false, strategy = 'عقل كمي',
    strategyId = null, walkforward = false,
  } = req.body || {};
  const pair = sanitizePair(rawPair);
  const interval = VALID_INTERVALS.has(rawInterval) ? rawInterval : '1h';
  const limit = Math.min(Math.max(Number(rawLimit) || 720, 80), 1000);
  const spec = strategyId ? getSpec(String(strategyId).slice(0, 60)) : null;
  const candles = await getCandles(pair, interval, limit);
  // G: تثبيت أرقام الباكتست (سالب/صفر/ضخم = نتائج مضللة أو حلقات ثقيلة)
  const clampN = (v, d, a, b) => {
    const n = Number(v);
    return isFinite(n) ? Math.min(Math.max(n, a), b) : d;
  };
  const riskCfg = {
    initialBalance: clampN(initialBalance, 10000, 100, 10_000_000),
    riskPerTrade: clampN(riskPerTrade, 2, 0.1, 20),
    stopLossPercent: clampN(stopLossPercent, 2, 0.1, 50),
    takeProfitPercent: clampN(takeProfitPercent, 4, 0.1, 500),
  };
  const stats = runBacktest({ candles, ...riskCfg, strategySpec: spec });
  const lessons = deriveLessons(stats, { riskPerTrade: riskCfg.riskPerTrade, stopLossPercent: riskCfg.stopLossPercent });
  const out = {
    pair, strategy: String(stats.strategy_name || strategy || 'عقل كمي').slice(0, 100),
    strategy_id: stats.strategy_id || null, source: 'engine', ...stats, ...lessons,
  };
  if (walkforward) {
    out.walkforward = walkForward({ candles, spec: spec || 'quant_hybrid', ...riskCfg });
  }
  if (save) {
    const user = await getUser();
    const { saved: _ignored, trades: _t, ...toSave } = out;
    out.saved = await db.create('BacktestResult', { ...toSave }, user.email);
  }
  res.json(out);
}));

// ── تقديم الواجهة في الإنتاج + معالج أخطاء ──
const distDir = path.resolve('dist');
app.use(express.static(distDir));
app.get(/^(?!\/api\/).*/, async (req, res, next) => {
  try {
    await fs.access(path.join(distDir, 'index.html'));
    res.sendFile(path.join(distDir, 'index.html'));
  } catch {
    next();
  }
});

 
app.use((err, req, res, next) => {
  console.error('API error:', err.message);
  const status = err.status || 500;
  if (status === 429 && err.retryAfterMs) {
    res.setHeader('Retry-After', String(Math.ceil(err.retryAfterMs / 1000)));
  }
  // Don't leak upstream (Binance/LLM) details to clients on 5xx
  if (status >= 500) return res.status(status).json({ error: 'Internal error' });
  res.status(status).json({ error: err.message || 'Request failed' });
});

app.listen(PORT, () => {
  console.log(`✅ Local API running on http://localhost:${PORT}`);
  // عامل السيرفر (مراقب الإغلاق + مولد الإشارات + متعلم الدروس) — يعمل بلا متصفح.
  // محركات المتصفح (PaperTradingEngine/AutoPaperTrader) تتنحى تلقائياً عند رؤيته نشطاً.
  startWorker();
});
