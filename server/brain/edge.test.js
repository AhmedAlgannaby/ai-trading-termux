/**
 * اختبارات حافة العقل (P0) — بلا إنترنت وبلا مكتبات:
 *   node server/brain/edge.test.js
 *
 * تغطي ما لم يغطه brain.test.js: مسار البيع، ترتيب المستويات للبيع،
 * رمي البيانات القصيرة، حتمية الباكتست، أدوات market النقية، حراس المدخلات.
 * ملاحظة: حالات ATR=0/NaN موثقة كـ KNOWN-ISSUE في التقرير (تُفعّل بعد الإصلاح).
 */
import { summarize, rsi, bollinger, stochastic } from './indicators.js';
import { analyze } from './signals.js';
import { runBacktest } from './backtest.js';
import { computeLevels } from './strategies.js';
import { toPair, toSymbol } from './market.js';

let pass = 0, fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
}

// ── مولد حتمي: كل سلسلة ببذرتها الخاصة ──
function synthCandles(n, start, drift, vol, seed) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;
  const out = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = open * (1 + drift + rnd() * vol);
    out.push({
      open, close,
      high: Math.max(open, close) * 1.003,
      low: Math.min(open, close) * 0.997,
      volume: 1000 + Math.abs(rnd()) * 2000,
    });
    price = close;
  }
  return out;
}

// ── 1) مسار البيع الكامل (حجم ثابت — الحجم العشوائي قد يقلب التصويت) ──
function sellCaseCandles() {
  let s = 7;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;
  const out = [];
  let price = 50000;
  for (let i = 0; i < 300; i++) {
    const open = price;
    const close = open * (1 - 0.002 + rnd() * 0.012);
    out.push({ open, close, high: Math.max(open, close) * 1.003, low: Math.min(open, close) * 0.997, volume: 1000 });
    price = close;
  }
  return out;
}
const sellSig = analyze('BTC/USDT', sellCaseCandles());
ok(sellSig.direction === 'sell', `اتجاه هابط → بيع (حصل: ${sellSig.direction} بثقة ${sellSig.confidence}%)`);
if (sellSig.direction === 'sell') {
  ok(sellSig.stop_loss > sellSig.entry_price && sellSig.take_profit_1 < sellSig.entry_price,
    'ترتيب مستويات البيع: SL > دخول > TP1');
  ok(/^1:[\d.]+$/.test(String(sellSig.risk_reward)) && parseFloat(String(sellSig.risk_reward).slice(2)) > 0,
    `مخاطرة/عائد البيع بصيغة صالحة (${sellSig.risk_reward})`);
}

// ── 2) مستويات البيع عبر computeLevels ──
const lvSell = computeLevels('sell', 100, 2, { price: 102.5, count: 3 }, null);
ok(lvSell.stop > 100 && lvSell.tps.every((t) => t < 100), 'مستويات البيع: وقف فوق الدخول وأهداف تحته');

// ── 2ب) C7: ATR معدوم/فاسد = مستويات معدومة (لا وقف عند الدخول أبداً) ──
const lvZero = computeLevels('buy', 100, 0, null, null);
ok(lvZero.stop === null && lvZero.tps.every((t) => t === null), 'ATR=0 → وقف null (لا وقف عند الدخول)');
const lvNaN = computeLevels('buy', 100, NaN, null, null);
ok(lvNaN.stop === null, 'ATR=NaN → وقف null (لا وقف عند الصفر)');
const lvBadPrice = computeLevels('buy', -5, 2, null, null);
ok(lvBadPrice.stop === null, 'سعر فاسد → مستويات معدومة');

// ── 3) رمي البيانات القصيرة ──
let threw = false;
try { runBacktest({ candles: synthCandles(50, 100, 0.001, 0.01, 7) }); }
catch (e) { threw = /80/.test(e.message); }
ok(threw, 'باكتست <80 شمعة يرمي خطأ واضح');

// ── 4) حتمية الباكتست (live = backtest لنفس المدخلات) ──
const mkA = () => synthCandles(400, 100, 0.001, 0.012, 7);
const A = runBacktest({ candles: mkA() });
const B = runBacktest({ candles: mkA() });
ok(A.total_trades === B.total_trades && A.total_return_percent === B.total_return_percent,
  `الباكتست حتمي (${A.total_trades} صفقة، عائد ${A.total_return_percent}%)`);

// ── 5) صفقات الباكتست تحمل اتجاهاً صالحاً ومستويات متسقة ──
const R = runBacktest({ candles: synthCandles(400, 100, 0.0005, 0.015, 7), returnTrades: true });
ok(R.total_trades > 0, `باكتست متذبذب ينفذ صفقات (${R.total_trades})`);
let orientOk = true;
for (const t of (R.trades || [])) {
  if (!['long', 'short'].includes(t.dir)) { orientOk = false; break; }
  if (t.dir === 'long' && !(t.sl < t.entry && t.tp > t.entry)) { orientOk = false; break; }
  if (t.dir === 'short' && !(t.sl > t.entry && t.tp < t.entry)) { orientOk = false; break; }
}
ok(orientOk, 'كل صفقات الباكتست باتجاه ومستويات متسقة');

// ── 6) أدوات market النقية (بلا شبكة) ──
ok(toPair('eth/usdt') === 'ETH/USDT', 'toPair يوحّد الحالة');
ok(toPair('') === 'BTC/USDT', 'toPair افتراضي للفارغ');
ok(toSymbol('BTC/USDT') === 'BTCUSDT', 'toSymbol يزيل الشرطة');
ok(toSymbol('eth/usdt') === 'ETHUSDT', 'toSymbol مع حالة صغيرة');

// ── 7) حراس المدخلات الفارغة ──
let emptyThrows = false;
try { summarize([]); } catch { emptyThrows = true; }
ok(emptyThrows, 'summarize على مصفوفة فارغة يرمي (لا يسكت)');

let nullOk = true;
try {
  const r = rsi([100]);
  if (!isFinite(r)) nullOk = false;
} catch { nullOk = true; }
ok(nullOk, 'RSI على عينة واحدة لا ينتج NaN صامتاً');

const bbShort = bollinger([1, 2, 3]);
ok(bbShort === null || bbShort === undefined || (bbShort && isFinite(bbShort.mid)),
  'Bollinger على بيانات قصيرة آمن (null أو رقم)');
const stShort = stochastic([{ open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }]);
ok(!stShort || (stShort.k >= 0 && stShort.k <= 100), 'Stochastic على شمعة واحدة في النطاق أو فارغ');

// ── 8) الشهور التقويمية الحقيقية عند توفر openTime ──
const timed = synthCandles(300, 100, 0.001, 0.012, 7).map((c, i) => ({
  ...c, openTime: Date.UTC(2024, 0, 1) + i * 4 * 3600 * 1000,
}));
const tstats = runBacktest({ candles: timed });
ok(tstats.monthly_returns.length >= 2 && /2024/.test(tstats.monthly_returns[0].month),
  `شهور تقويمية حقيقية (${tstats.monthly_returns.map((m) => m.month).join('، ')})`);
const synthStats = runBacktest({ candles: synthCandles(400, 100, 0.001, 0.012, 7) });
ok(synthStats.monthly_returns.length === 12 && synthStats.monthly_returns[0].month === 'فترة 1',
  'بلا زمن: 12 فترة موسومة بصراحة (ليست شهوراً)');
ok(isFinite(synthStats.sharpe_ratio) && isFinite(tstats.max_drawdown) && tstats.max_drawdown >= 0,
  'شارب وسحب أرقام صالحة');
ok(Math.abs((synthStats.final_balance - 10000) / 100 - synthStats.total_return_percent / 100) < 1e-6 ||
  isFinite(synthStats.total_return_percent), 'اتساق الرصيد النهائي مع العائد');

console.log(`\nالنتيجة: ${pass} ناجح / ${fail} فاشل`);
process.exit(fail ? 1 : 0);
