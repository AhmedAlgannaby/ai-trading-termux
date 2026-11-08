/**
 * تستات حراس Entities API (C2) — خالصة بلا IO:
 *   node server/entityGuards.test.js
 */
import { sanitizeEntityInput, sanitizeEntityPatch } from './entityGuards.js';

let pass = 0, fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
}

// ── Trade: فرض paper ──
let r = sanitizeEntityInput('Trade', { type: 'long', entry_price: 100, position_size: 500, mode: 'live', status: 'open' });
ok(r.ok && r.body.mode === 'paper', 'إنشاء صفقة live عبر API يُجبر paper');
r = sanitizeEntityPatch('Trade', { mode: 'live' });
ok(r.ok && r.body.mode === 'paper', 'تعديل الوضع لـ live عبر API يُجبر paper');

// ── منطق السوق: السبوت شراء فقط ──
r = sanitizeEntityInput('Trade', { type: 'short', entry_price: 100, position_size: 500, market_type: 'spot' });
ok(!r.ok && /short/i.test(r.error), 'شورت سبوت مرفوض (لا تملك الأصل)');
r = sanitizeEntityInput('Trade', { type: 'short', entry_price: 100, position_size: 500 });
ok(!r.ok, 'شورت بلا سوق = سبوت ضمني مرفوض');
r = sanitizeEntityInput('Trade', { type: 'short', entry_price: 100, position_size: 500, market_type: 'futures', leverage: 5 });
ok(r.ok && r.body.market_type === 'futures', 'شورت فيوتشر مسموح');
r = sanitizeEntityInput('Trade', { type: 'long', entry_price: 100, position_size: 500, market_type: 'spot' });
ok(r.ok, 'شراء سبوت مسموح');
r = sanitizeEntityInput('Trade', { type: 'long', market_type: 'margin' });
ok(!r.ok, 'سوق غريب مرفوض');
r = sanitizeEntityPatch('Trade', { type: 'short', market_type: 'spot' });
ok(!r.ok, 'تحويل صفقة لشورت سبوت مرفوض');

// ── Trade: نوع وحالة ──
r = sanitizeEntityInput('Trade', { type: 'moon', entry_price: 100, position_size: 10 });
ok(!r.ok && /type/.test(r.error), 'نوع صفقة غريب مرفوض');
r = sanitizeEntityInput('Trade', { entry_price: 100, position_size: 10 });
ok(!r.ok, 'إنشاء بلا نوع مرفوض');
r = sanitizeEntityInput('Trade', { type: 'long', entry_price: 100, position_size: 10, status: 'hacked' });
ok(!r.ok, 'حالة صفقة غريبة مرفوضة');

// ── Trade: أرقام ──
r = sanitizeEntityInput('Trade', { type: 'long', entry_price: NaN, position_size: 10 });
ok(!r.ok, 'سعر NaN مرفوض');
r = sanitizeEntityInput('Trade', { type: 'long', entry_price: 100, position_size: -5 });
ok(!r.ok, 'حجم سالب مرفوض');
r = sanitizeEntityInput('Trade', { type: 'long', entry_price: 100, position_size: 10, leverage: 999 });
ok(r.ok && r.body.leverage === 125, 'الرافعة تُثبَّت عند 125');
r = sanitizeEntityPatch('Trade', { pnl: 'abc' });
ok(!r.ok, 'pnl نصي في التحديث مرفوض');

// ── Signal: زوج واتجاه وثقة ──
r = sanitizeEntityInput('Signal', { pair: 'BTC/USDT', direction: 'buy', confidence: 80, entry_price: 100, stop_loss: 98 });
ok(r.ok && r.body.pair === 'BTC/USDT', 'إشارة سليمة تمر');
r = sanitizeEntityInput('Signal', { pair: 'FAKE!!!', direction: 'buy' });
ok(!r.ok, 'زوج مزيف مرفوض');
r = sanitizeEntityInput('Signal', { pair: 'BTC/USDT', direction: 'moon' });
ok(!r.ok, 'اتجاه غريب مرفوض');
r = sanitizeEntityInput('Signal', { pair: 'BTC/USDT', direction: 'buy', confidence: 999 });
ok(!r.ok, 'ثقة 999 مرفوضة');
r = sanitizeEntityInput('Signal', { pair: 'eth/usdt', direction: 'sell' });
ok(r.ok && r.body.pair === 'ETH/USDT', 'الزوج يُوحَّد لكبير');

// ── RiskSettings: تثبيت بدل رفض ──
r = sanitizeEntityInput('RiskSettings', { paper_balance: 1e15, max_risk_per_trade: 99, max_open_positions: 500, default_leverage: 500 });
ok(r.ok && r.body.paper_balance === 100_000_000 && r.body.max_risk_per_trade === 10 &&
  r.body.max_open_positions === 20 && r.body.default_leverage === 125, 'قيم شاذة تُثبَّت');
r = sanitizeEntityInput('RiskSettings', { execution_mode: 'godmode' });
ok(!r.ok, 'وضع تنفيذ غريب مرفوض');
r = sanitizeEntityInput('RiskSettings', { trading_mode: 'live', execution_mode: 'auto' });
ok(r.ok, 'live/auto قيم مسموحة (تُحرس عند التنفيذ بالسقف)');
r = sanitizeEntityInput('RiskSettings', { paper_balance: 'abc' });
ok(!r.ok, 'رصيد نصي مرفوض');

// ── كيانات أخرى تمر كما هي ──
r = sanitizeEntityInput('BacktestResult', { foo: 1 });
ok(r.ok && r.body.foo === 1, 'الكيانات غير المالية تمر');

console.log(`\nالنتيجة: ${pass} ناجح / ${fail} فاشل`);
process.exit(fail ? 1 : 0);
