/**
 * اختبارات العقل المحلي — تعمل بدون إنترنت (بيانات صناعية) وبدون مكتبات:
 *   node server/brain/brain.test.js
 */
import { sma, ema, rsi, macd, bollinger, atr, stochastic, swings, supportResistance, candlePatterns, marketRegime } from './indicators.js';
import { analyze } from './signals.js';
import { runBacktest, deriveLessons } from './backtest.js';
import { detectKind, extractPair } from './router.js';
import { buildSeries, evaluateSpec, getSpec, STRATEGY_REGISTRY, FAMILIES, analyzeMultiTF, computeLevels, rsiSeries } from './strategies.js';
import { walkForward, monteCarlo } from './backtest.js';

let pass = 0, fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
}

// ── بيانات صناعية: اتجاه صاعد مع تذبذب ──
function synthCandles(n = 250, start = 100, drift = 0.002, vol = 0.008, seed = 7) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;
  const out = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = open * (1 + drift + rnd() * vol);
    out.push({
      open, close,
      high: Math.max(open, close) * (1 + Math.abs(rnd()) * vol / 2),
      low: Math.min(open, close) * (1 - Math.abs(rnd()) * vol / 2),
      volume: 1000 + Math.abs(rnd()) * 2000,
    });
    price = close;
  }
  return out;
}

// ── 1) المؤشرات ──
const upCloses = Array.from({ length: 30 }, (_, i) => 100 + i); // صعود خالص
ok(rsi(upCloses) === 100, 'RSI صعود خالص = 100');
const dnCloses = Array.from({ length: 30 }, (_, i) => 200 - i); // هبوط خالص
ok(rsi(dnCloses) === 0, 'RSI هبوط خالص = 0');
ok(Math.abs(sma([1, 2, 3, 4, 5], 5) - 3) < 1e-9, 'SMA أساسي');
ok(ema([10, 10, 10, 10], 3) === 10, 'EMA ثابت');
const m = macd(upCloses);
ok(m.hist > 0, 'MACD إيجابي في الصعود');
const bb = bollinger(upCloses);
ok(bb && bb.upper > bb.mid && bb.mid > bb.lower, 'Bollinger مرتبة');
const candles = synthCandles();
ok(atr(candles) > 0, 'ATR موجب');
const st = stochastic(candles);
ok(st.k >= 0 && st.k <= 100 && st.d >= 0 && st.d <= 100, 'Stochastic في [0,100]');
const sw = swings(candles);
ok(sw.highs.length > 0 && sw.lows.length > 0, 'قمم وقيعان مكتشفة');
const sr = supportResistance(candles);
ok(Array.isArray(sr.supports) && Array.isArray(sr.resistances), 'دعوم ومقاومات');
const engulf = [
  { open: 100, high: 101, low: 98, close: 98.5, volume: 100 },
  { open: 98, high: 102, low: 97.5, close: 101.5, volume: 200 },
];
ok(candlePatterns(engulf).some((p) => p.name === 'ابتلاع شرائي'), 'كشف الابتلاع الشرائي');
const regime = marketRegime(synthCandles(250, 100, 0.004));
ok(regime.regime === 'trending' && regime.trend === 'up', 'نظام السوق: اتجاه صاعد');
const flat = synthCandles(250, 100, 0.0001, 0.001);
ok(marketRegime(flat).regime === 'ranging' || marketRegime(flat).trend === 'sideways', 'نظام السوق: عرضي للمسطح');

// ── 2) المحلل ──
const sig = analyze('BTC/USDT', synthCandles(300, 50000, 0.003));
const signalKeys = ['direction', 'confidence', 'entry_price', 'stop_loss', 'take_profit_1', 'take_profit_2', 'take_profit_3', 'risk_reward', 'analysis_summary', 'strategy', 'indicators', 'patterns_detected'];
ok(signalKeys.every((k) => k in sig), 'شكل الإشارة كامل (12 حقل)');
ok(['buy', 'sell', 'hold'].includes(sig.direction), 'اتجاه صالح');
ok(sig.confidence >= 5 && sig.confidence <= 97, 'ثقة في النطاق');
if (sig.direction === 'buy') ok(sig.stop_loss < sig.entry_price && sig.take_profit_1 > sig.entry_price, 'ترتيب مستويات الشراء');
else if (sig.direction === 'sell') ok(sig.stop_loss > sig.entry_price && sig.take_profit_1 < sig.entry_price, 'ترتيب مستويات البيع');
else ok(true, 'hold — بلا ترتيب مطلوب');
ok(sig.direction === 'buy', `اتجاه صاعد قوي → شراء (حصل: ${sig.direction} بثقة ${sig.confidence}%)`);
ok(sig.indicators.length >= 5, 'أدلة متعددة في الإشارة');

// ── 3) الباكتست ──
const btCandles = synthCandles(400, 100, 0.001, 0.012);
const stats = runBacktest({ candles: btCandles, initialBalance: 10000, riskPerTrade: 2, stopLossPercent: 2, takeProfitPercent: 4 });
const statKeys = ['total_return_percent', 'win_rate', 'total_trades', 'sharpe_ratio', 'max_drawdown', 'profit_factor', 'avg_win', 'avg_loss', 'equity_curve', 'monthly_returns'];
ok(statKeys.every((k) => k in stats), 'شكل إحصائيات الباكتست كامل');
ok(stats.equity_curve.length === 12 && stats.monthly_returns.length === 12, 'منحنى 12 شهر');
ok(stats.total_trades > 0, `صفقات منفذة (${stats.total_trades})`);
ok(isFinite(stats.sharpe_ratio) && isFinite(stats.profit_factor), 'شارب ومعامل ربح أرقام');
const lessons = deriveLessons(stats, { riskPerTrade: 2, stopLossPercent: 2 });
ok(['ai_lessons', 'best_conditions', 'avoid_conditions', 'optimal_risk', 'confidence_to_enter', 'score'].every((k) => k in lessons), 'شكل الدروس كامل');

// ── 4) الموجّه ──
ok(extractPair('حلل زوج ETH/USDT الآن') === 'ETH/USDT', 'استخراج الزوج');
ok(extractPair('نص بلا زوج') === 'BTC/USDT', 'الزوج الافتراضي');
const S = (props) => ({ type: 'object', properties: Object.fromEntries(props.map((p) => [p, { type: 'string' }])) });
ok(detectKind(S(['direction', 'confidence'])) === 'signal', 'توجيه: إشارة');
ok(detectKind(S(['total_return_percent', 'win_rate'])) === 'backtest', 'توجيه: باكتست');
ok(detectKind(S(['ai_lessons', 'score'])) === 'lessons', 'توجيه: دروس');
ok(detectKind(S(['overall_signal', 'dimensions'])) === 'ensemble', 'توجيه: محرك شامل');
ok(detectKind(S(['overall_sentiment_score'])) === 'sentiment', 'توجيه: مشاعر');
ok(detectKind(S(['estimated_win_rate'])) === 'strategy_score', 'توجيه: تقييم');
ok(detectKind(S(['smart_money_index'])) === 'whale', 'توجيه: حيتان');
ok(detectKind(S(['events'])) === 'events_unsupported', 'توجيه: أحداث غير مدعومة');
ok(detectKind(S(['risk_per_trade', 'timeframe'])) === 'params', 'توجيه: معاملات');

// ── 5) الاستراتيجيات البارامترية ──
ok(Object.keys(FAMILIES).length >= 6, `عائلات الاستراتيجيات (${Object.keys(FAMILIES).length})`);
ok(STRATEGY_REGISTRY.length >= 8 && STRATEGY_REGISTRY.every((s) => s.id && s.family && FAMILIES[s.family]), 'سجل الاستراتيجيات صالح');
ok(getSpec('nope').id === 'quant_hybrid', 'مواصفة افتراضية لمعرف مجهول');
const trendCandles = synthCandles(300, 100, 0.004, 0.004); // صعود واضح قليل الضجيج
const ST = buildSeries(trendCandles, {});
ok(ST.n === 300 && ST.rsi.length === 300 && ST.macdHist.length === 300, 'سلاسل مكتملة الطول');
const rsiLast = rsiSeries(trendCandles.map((c) => c.close));
ok(rsiLast[rsiLast.length - 1] > 60, `RSI اتجاه صاعد مرتفع (${rsiLast[rsiLast.length - 1].toFixed(0)})`);
const evT = evaluateSpec(getSpec('ema_cross_pro'), ST, ST.n - 1);
ok(evT.direction === 'long' && evT.score > 0, `trend_ema تكشف الصعود (${evT.score.toFixed(2)})`);
const dnCandles = synthCandles(300, 5000, -0.006, 0.003);
const SDN = buildSeries(dnCandles, {});
const evD = evaluateSpec(getSpec('ema_cross_pro'), SDN, SDN.n - 1);
ok(evD.score < -0.3 && evD.direction !== 'long', `trend_ema تميل هبوطاً ولا تشتري أبداً (${evD.score.toFixed(2)}/${evD.direction})`);
// نفس العائلة حياً وفي الباكتست: تقييم منتصف السلسلة حتمي
const mid1 = evaluateSpec(getSpec('macd_wave'), ST, 150);
const mid2 = evaluateSpec(getSpec('macd_wave'), ST, 150);
ok(JSON.stringify(mid1) === JSON.stringify(mid2), 'تقييم حتمي (live = backtest)');
const lv = computeLevels('buy', 100, 2, { price: 97.5, count: 3 }, null);
ok(lv.stop >= 97 && lv.stop < 98 && lv.tps[1] > 100, 'مستويات tighten-only', JSON.stringify(lv));
const flatSig = analyze('BTC/USDT', flat, []);
ok(Array.isArray(flatSig.evidence) && flatSig.evidence.length > 0 && typeof flatSig.invalidation === 'string', 'analyze يُرجع evidence/invalidation');
const mtf = analyzeMultiTF('BTC/USDT', { h4: synthCandles(300, 50000, 0.003, 0.008), d1: synthCandles(120, 45000, 0.002, 0.01) }, { spec: 'ema_cross_pro' });
ok(['buy', 'sell', 'hold'].includes(mtf.direction) && mtf.strategy_id === 'ema_cross_pro' && mtf.evidence.length > 0, `ensemble متعدد الفريمات (${mtf.direction} ${mtf.confidence}%)`);

// ── 6) الباكتست بالمواصفات + walk-forward + مونت كارلو ──
const specBT = runBacktest({ candles: btCandles, strategySpec: 'macd_wave' });
ok(specBT.strategy_id === 'macd_wave' && specBT.total_trades > 0, `باكتست بمواصفة (${specBT.total_trades} صفقة)`);
const wfCandles = synthCandles(600, 100, 0.001, 0.012);
const wf = walkForward({ candles: wfCandles, spec: 'macd_wave', windows: 3 });
ok(wf.windows.length >= 2 && typeof wf.oos_win_rate === 'number' && wf.monte_carlo.sims === 500, `walk-forward ${wf.windows.length} نوافذ + مونت كارلو`);
ok(wf.monte_carlo.prob_profit >= 0 && wf.monte_carlo.prob_profit <= 100, 'احتمال الربح في [0,100]');
const mcEmpty = monteCarlo([], {});
ok(mcEmpty.sims === 0 && mcEmpty.median_return === 0, 'مونت كارلو فارغ آمن');

console.log(`\nالنتيجة: ${pass} ناجح / ${fail} فاشل`);
process.exit(fail ? 1 : 0);
