/**
 * حراس مدخلات Entities API (C2) — دوال خالصة قابلة للاختبار:
 *   node server/entityGuards.test.js
 *
 * القاعدة: أي سجل يدخل عبر /api/entities العام يُعقَّم هنا قبل db.create/update:
 * - Trade: الوضع paper حصراً (صفقات live تُنشأ server-side فقط عبر executeSignal)،
 *   حقول رقمية صالحة، نوع/حالة من قوائم بيضاء.
 * - Signal: زوج واتجاه وثقة ومستويات صالحة (إشارة مسمومة = أمر حي محتمل).
 * - RiskSettings: تثبيت النطاقات (clamp) بدل الرفض حتى لا تنكسر صفحة الإعدادات.
 */
const PAIR_RE = /^[A-Z]{2,12}\/[A-Z]{2,12}$/;
const TRADE_TYPES = new Set(['long', 'short']);
const TRADE_STATUS = new Set(['open', 'closed']);
const SIGNAL_DIRS = new Set(['buy', 'sell', 'hold']);
const SIGNAL_STATUS = new Set(['pending', 'executed', 'expired', 'notified']);

function num(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return isFinite(n) ? n : NaN;
}

function reqFinite(value, field) {
  const n = num(value);
  if (value !== undefined && (n === undefined || Number.isNaN(n))) {
    return { error: `Invalid ${field}` };
  }
  return { value: n };
}

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

function guardTrade(body, isUpdate) {
  const out = { ...body };
  // صفقات live عبر الـ API العامة ممنوعة نهائياً
  out.mode = 'paper';
  // منطق السوق: السبوت شراء فقط (لا تملك الأصل لتبيعه) — الشورت للفيوتشر
  const market = body.market_type === 'futures' ? 'futures' : 'spot';
  out.market_type = market;
  if (body.market_type !== undefined && body.market_type !== 'spot' && body.market_type !== 'futures') {
    return { ok: false, error: 'Invalid market_type (spot/futures only)' };
  }
  if (body.type !== undefined && !TRADE_TYPES.has(body.type)) {
    return { ok: false, error: 'Invalid trade type (long/short only)' };
  }
  if (!isUpdate && body.type === undefined) {
    return { ok: false, error: 'Trade type is required' };
  }
  const effType = body.type !== undefined ? body.type : undefined;
  if (effType === 'short' && market === 'spot') {
    return { ok: false, error: 'Spot cannot short — you cannot sell what you do not own (use futures market)' };
  }
  if (body.status !== undefined && !TRADE_STATUS.has(body.status)) {
    return { ok: false, error: 'Invalid trade status' };
  }
  for (const f of ['entry_price', 'current_price', 'position_size', 'stop_loss',
    'take_profit_1', 'take_profit_2', 'take_profit_3', 'confidence', 'pnl', 'pnl_percent']) {
    const r = reqFinite(body[f], f);
    if (r.error) return { ok: false, error: r.error };
    if (r.value !== undefined) out[f] = r.value;
  }
  if (out.position_size !== undefined && out.position_size <= 0) {
    return { ok: false, error: 'position_size must be positive' };
  }
  if (out.entry_price !== undefined && out.entry_price <= 0) {
    return { ok: false, error: 'entry_price must be positive' };
  }
  if (body.leverage !== undefined) {
    const l = num(body.leverage);
    if (Number.isNaN(l)) return { ok: false, error: 'Invalid leverage' };
    out.leverage = clamp(Math.trunc(l), 1, 125);
  }
  return { ok: true, body: out };
}

function guardSignal(body) {
  const out = { ...body };
  if (body.pair !== undefined) {
    const p = String(body.pair).toUpperCase();
    if (!PAIR_RE.test(p)) return { ok: false, error: 'Invalid pair' };
    out.pair = p;
  }
  if (body.direction !== undefined && !SIGNAL_DIRS.has(body.direction)) {
    return { ok: false, error: 'Invalid direction (buy/sell/hold only)' };
  }
  if (body.confidence !== undefined) {
    const c = num(body.confidence);
    if (Number.isNaN(c) || c < 0 || c > 100) return { ok: false, error: 'confidence must be 0..100' };
    out.confidence = c;
  }
  for (const f of ['entry_price', 'stop_loss', 'take_profit_1', 'take_profit_2', 'take_profit_3']) {
    const r = reqFinite(body[f], f);
    if (r.error) return { ok: false, error: r.error };
    if (r.value !== undefined) {
      if (r.value <= 0) return { ok: false, error: `${f} must be positive` };
      out[f] = r.value;
    }
  }
  if (body.status !== undefined && !SIGNAL_STATUS.has(body.status)) {
    return { ok: false, error: 'Invalid signal status' };
  }
  return { ok: true, body: out };
}

function guardRisk(body) {
  const out = { ...body };
  const clamps = {
    paper_balance: [5, 100_000_000],
    max_risk_per_trade: [0.1, 10],
    max_open_positions: [1, 20],
    circuit_breaker_losses: [1, 10],
    default_leverage: [1, 125],
    max_leverage: [1, 125],
    default_stop_loss_percent: [0.1, 50],
    default_take_profit_percent: [0.1, 200],
    min_confidence: [0, 100],
    confidence_to_enter: [0, 100],
  };
  for (const [f, [a, b]] of Object.entries(clamps)) {
    if (body[f] === undefined) continue;
    const n = num(body[f]);
    if (Number.isNaN(n)) return { ok: false, error: `Invalid ${f}` };
    out[f] = clamp(n, a, b);
  }
  if (body.execution_mode !== undefined &&
    !['auto', 'semi_auto', 'manual'].includes(body.execution_mode)) {
    return { ok: false, error: 'Invalid execution_mode' };
  }
  if (body.trading_mode !== undefined && !['paper', 'live'].includes(body.trading_mode)) {
    return { ok: false, error: 'Invalid trading_mode' };
  }
  if (body.market_type !== undefined && !['spot', 'futures'].includes(body.market_type)) {
    return { ok: false, error: 'Invalid market_type (spot/futures only)' };
  }
  return { ok: true, body: out };
}

export function sanitizeEntityInput(name, body) {
  const b = body && typeof body === 'object' ? body : {};
  if (name === 'Trade') return guardTrade(b, false);
  if (name === 'Signal') return guardSignal(b);
  if (name === 'RiskSettings') return guardRisk(b);
  return { ok: true, body: b };
}

export function sanitizeEntityPatch(name, body) {
  const b = body && typeof body === 'object' ? body : {};
  if (name === 'Trade') return guardTrade(b, true);
  if (name === 'RiskSettings') return guardRisk(b);
  if (name === 'Signal') {
    // تحديث الإشارة: تحقق المستويات والثقة فقط (الحالة تُدار server-side)
    const out = { ...b };
    if (b.confidence !== undefined) {
      const c = num(b.confidence);
      if (Number.isNaN(c) || c < 0 || c > 100) return { ok: false, error: 'confidence must be 0..100' };
      out.confidence = c;
    }
    return { ok: true, body: out };
  }
  return { ok: true, body: b };
}
