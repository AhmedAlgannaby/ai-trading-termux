/**
 * وسيط Binance من الخادم (بديل binance_proxy في Base44).
 * - البيانات العامة (الأسعار) لا تحتاج مفاتيح.
 * - العمليات الخاصة تستخدم مفاتيح المستخدم المحفوظة في الإعدادات.
 * العمل من الخادم يتجاوز مشكلة CORS نهائياً.
 */
import crypto from 'node:crypto';

const BINANCE_BASE = process.env.BINANCE_BASE_URL || 'https://api.binance.com';
// نطاق بديل لبيانات السوق العامة (يُستخدم تلقائياً عند حجب/تعطل النطاق الأساسي)
const BINANCE_PUBLIC_BASE = process.env.BINANCE_PUBLIC_BASE_URL || 'https://data-api.binance.vision';
const BINANCE_TESTNET_BASE = process.env.BINANCE_TESTNET_BASE_URL || 'https://testnet.binance.vision';
const RECV_WINDOW = 5000;

// بعد 429/418 نوقف الطلبات العامة مؤقتاً بدل تكرارها (التكرار يطيل الحظر).
let cooldownUntil = 0;

function cooldownError() {
  const waitSec = Math.max(1, Math.ceil((cooldownUntil - Date.now()) / 1000));
  const err = new Error(`حد طلبات Binance — أعد المحاولة بعد ${waitSec} ثانية`);
  err.status = 429;
  err.retryAfterMs = waitSec * 1000;
  return err;
}

/** Public data always uses mainnet (deep liquidity). Private calls use the user's selected network. */
function isTestnet(user) {
  return user?.binance_network === 'testnet';
}
function privateBase(user) {
  return isTestnet(user) ? BINANCE_TESTNET_BASE : BINANCE_BASE;
}

function sign(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function binanceFetch(path, apiKey, base = BINANCE_BASE) {
  let res;
  try {
    res = await fetchWithTimeout(`${base}${path}`, {
      headers: apiKey ? { 'X-MBX-APIKEY': apiKey } : {},
    });
  } catch (e) {
    const err = new Error(e?.name === 'AbortError' ? 'Binance timeout' : 'Binance network error');
    err.status = 502;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 429 = تجاوز الحد، 418 = حظر IP مؤقت. نحترم Retry-After ونتوقف.
    if (res.status === 418 || res.status === 429) {
      const retryAfterSec = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? retryAfterSec * 1000
        : (res.status === 418 ? 120_000 : 60_000);
      cooldownUntil = Math.max(cooldownUntil, Date.now() + waitMs);
      const err = new Error(`حد طلبات Binance — أعد المحاولة بعد ${Math.ceil(waitMs / 1000)} ثانية`);
      err.status = 429;
      err.retryAfterMs = waitMs;
      err.details = data?.msg || 'Too many requests';
      throw err;
    }
    const err = new Error('Binance request failed');
    err.status = res.status >= 500 ? 502 : (res.status === 403 || res.status === 451 ? res.status : 400);
    err.details = data?.msg || data;
    throw err;
  }
  return data;
}

// ── ذاكرة وسيطة قصيرة + دمج الطلبات المتطابقة ──
// الواجهة فيها عدة مكونات تستعلم نفس الأسعار؛ بدون هذا كل مكوّن يستهلك وزن Binance.
const _cache = new Map();
const _inflight = new Map();
const MAX_CACHE_ENTRIES = 500;

function cachedPublic(key, ttlMs, fn) {
  const now = Date.now();
  const hit = _cache.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value;
  if (_inflight.has(key)) return _inflight.get(key);
  const p = fn()
    .then((value) => {
      _cache.set(key, { at: Date.now(), value });
      if (_cache.size > MAX_CACHE_ENTRIES) {
        const oldest = [..._cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 50);
        for (const [k] of oldest) _cache.delete(k);
      }
      return value;
    })
    .catch((e) => {
      // بيانات قديمة أفضل من تعطيل الواجهة عند بلوك مؤقت
      if (hit) return hit.value;
      throw e;
    })
    .finally(() => { _inflight.delete(key); });
  _inflight.set(key, p);
  return p;
}

// نتذكر النطاق العام الذي نجح آخر مرة كي لا نكرر مهلة الفشل في كل طلب.
let preferredPublicBase = BINANCE_BASE;
const PUBLIC_HOSTS = [...new Set([BINANCE_BASE, BINANCE_PUBLIC_BASE].filter(Boolean))];

async function publicFetch(path) {
  if (Date.now() < cooldownUntil) throw cooldownError();
  const order = [preferredPublicBase, ...PUBLIC_HOSTS.filter((b) => b !== preferredPublicBase)];
  let lastErr;
  for (const base of order) {
    try {
      const data = await binanceFetch(path, undefined, base);
      preferredPublicBase = base;
      return data;
    } catch (e) {
      lastErr = e;
      // حظر IP يطال كل النطاقات — لا فائدة من المحاولة على نطاق آخر
      if (e.status === 429) throw e;
      // جرّب النطاق البديل عند حجب/عطل الشبكة فقط
      if (e.status === 502 || e.status === 403 || e.status === 451) continue;
      throw e;
    }
  }
  throw lastErr;
}

function assertSymbol(s) {
  if (typeof s !== 'string' || !/^[A-Z0-9]{4,20}$/.test(s)) {
    const err = new Error('Invalid symbol');
    err.status = 400;
    throw err;
  }
}

const VALID_INTERVALS = new Set(['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M']);

export async function ticker(symbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'ADAUSDT', 'XRPUSDT']) {
  if (!Array.isArray(symbols) || symbols.length === 0 || symbols.length > 50) {
    symbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'ADAUSDT', 'XRPUSDT'];
  }
  symbols.forEach(assertSymbol);
  const param = encodeURIComponent(JSON.stringify(symbols));
  // مفتاح واحد بغض النظر عن ترتيب الرموز + كاش 10 ثوانٍ
  const key = `ticker:${[...symbols].sort().join(',')}`;
  return cachedPublic(key, 10_000, () => publicFetch(`/api/v3/ticker/24hr?symbols=${param}`));
}

export async function klines(symbol = 'BTCUSDT', interval = '4h', limit = 100, opts = {}) {
  assertSymbol(symbol);
  if (!VALID_INTERVALS.has(interval)) {
    const err = new Error('Invalid interval');
    err.status = 400;
    throw err;
  }
  const n = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const startTime = Number.isFinite(Number(opts.startTime)) ? Number(opts.startTime) : null;
  const endTime = Number.isFinite(Number(opts.endTime)) ? Number(opts.endTime) : null;
  let q = `symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${n}`;
  // حدود زمنية اختيارية (للمراجعة اللاحقة: إعادة بناء الماضي كما كان وقت الدخول)
  if (startTime !== null) q += `&startTime=${startTime}`;
  if (endTime !== null) q += `&endTime=${endTime}`;
  const key = `klines:${symbol}:${interval}:${n}:${startTime ?? ''}:${endTime ?? ''}`;
  // الشموع التاريخية لا تتغير → كاش أطول؛ الشمعة الحالية تتغير → كاش قصير
  const historical = endTime !== null && endTime < Date.now() - 60_000;
  return cachedPublic(key, historical ? 5 * 60_000 : 20_000, () => publicFetch(`/api/v3/klines?${q}`));
}

function requireKeys(user) {
  const testnet = isTestnet(user);
  const apiKey = testnet ? (user?.binance_testnet_api_key || '') : (user?.binance_api_key || '');
  const secretKey = testnet ? (user?.binance_testnet_secret_key || '') : (user?.binance_secret_key || '');
  if (!apiKey || !secretKey) {
    const err = new Error(testnet
      ? 'مفاتيح Binance Testnet غير مضبوطة — أدخلها من صفحة الإعدادات.'
      : 'مفاتيح Binance غير مضبوطة — أدخلها من صفحة الإعدادات.');
    err.status = 400;
    throw err;
  }
  return { apiKey, secretKey, base: privateBase(user), testnet };
}

export async function account(user) {
  const { apiKey, secretKey, base } = requireKeys(user);
  const qs = `recvWindow=${RECV_WINDOW}&timestamp=${Date.now()}`;
  return binanceFetch(`/api/v3/account?${qs}&signature=${sign(qs, secretKey)}`, apiKey, base);
}

export async function openOrders(user) {
  const { apiKey, secretKey, base } = requireKeys(user);
  const qs = `recvWindow=${RECV_WINDOW}&timestamp=${Date.now()}`;
  return binanceFetch(`/api/v3/openOrders?${qs}&signature=${sign(qs, secretKey)}`, apiKey, base);
}

export async function placeOrder(user, { symbol, side, type, quantity, price }) {
  const { apiKey, secretKey, base } = requireKeys(user);
  assertSymbol(symbol);
  if (side !== 'BUY' && side !== 'SELL') {
    const err = new Error('Invalid side (BUY/SELL only)');
    err.status = 400;
    throw err;
  }
  if (type !== 'MARKET' && type !== 'LIMIT') {
    const err = new Error('Invalid type (MARKET/LIMIT only)');
    err.status = 400;
    throw err;
  }
  const qty = Number(quantity);
  if (!isFinite(qty) || qty <= 0) {
    const err = new Error('Invalid quantity');
    err.status = 400;
    throw err;
  }
  let params = `symbol=${encodeURIComponent(symbol)}&side=${side}&type=${type}&quantity=${encodeURIComponent(String(qty))}&recvWindow=${RECV_WINDOW}&timestamp=${Date.now()}`;
  if (type === 'LIMIT') {
    const p = Number(price);
    if (!isFinite(p) || p <= 0) {
      const err = new Error('Invalid price for LIMIT order');
      err.status = 400;
      throw err;
    }
    params += `&price=${encodeURIComponent(String(p))}&timeInForce=GTC`;
  }
  let res;
  try {
    res = await fetchWithTimeout(`${base}/api/v3/order?${params}&signature=${sign(params, secretKey)}`, {
      method: 'POST',
      headers: { 'X-MBX-APIKEY': apiKey },
    });
  } catch (e) {
    const err = new Error(e?.name === 'AbortError' ? 'Binance timeout' : 'Binance network error');
    err.status = 502;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error('Order failed');
    err.status = res.status >= 500 ? 502 : 400;
    err.details = data?.msg || data;
    throw err;
  }
  return data;
}
