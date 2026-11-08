/**
 * محلل الإشارات — ينتج نفس شكل InvokeLLM للإشارات:
 * { direction, confidence, entry_price, stop_loss, take_profit_1/2/3,
 *   risk_reward, analysis_summary, strategy, indicators, patterns_detected }
 *
 * المنهج: تصويت مرجح متعدد الأبعاد (trend + momentum + mean-reversion + حجم + سيولة)
 * مستوحى من stock-analysis: قرار متعدد الأدلة لا مؤشر واحد.
 */
import { summarize } from './indicators.js';
import { buildSeries, evaluateSpec, computeLevels, getSpec } from './strategies.js';
import { MICRO_SL_PCT, MICRO_TP_R } from '../../shared/microStrategy.js';

function vote(list, name, value, signal, weight, reason) {
  list.push({ name, value, signal, weight, reason });
}

/**
 * @param {string} pair مثل BTC/USDT
 * @param {Array} candles شموع OHLCV (الأخيرة = الحالية)
 * @param {Array} knowledge معرفة Backtest سابقة [{strategy, win_rate, ...}]
 * @param {object} opts { spec?: StrategySpec|id } — مواصفة استراتيجية تُضيف صوتاً مرجحاً
 */
export function analyze(pair, candles, knowledge = [], opts = {}) {
  const s = summarize(candles);
  const price = s.price;
  const votes = [];

  // 1) الاتجاه (EMA stack) — أعلى وزن
  if (s.regime.trend === 'up') vote(votes, 'اتجاه EMA', 'صاعد (السعر فوق EMA20 فوق EMA50)', 'buy', 2, 'زخم صاعد مؤكد');
  else if (s.regime.trend === 'down') vote(votes, 'اتجاه EMA', 'هابط (السعر تحت EMA20 تحت EMA50)', 'sell', 2, 'زخم هابط مؤكد');
  else vote(votes, 'اتجاه EMA', 'عرضي — لا أفضلية اتجاهية', 'hold', 1, 'سوق بلا اتجاه');

  // 2) MACD
  if (s.macd.hist > 0 && s.macd.hist >= s.macd.prevHist) vote(votes, 'MACD', 'إيجابي متسارع', 'buy', 1.5, 'زخم شرائي متنامٍ');
  else if (s.macd.hist > 0) vote(votes, 'MACD', 'إيجابي متباطئ', 'buy', 0.75, 'زخم شرائي يضعف');
  else if (s.macd.hist < 0 && s.macd.hist <= s.macd.prevHist) vote(votes, 'MACD', 'سلبي متسارع', 'sell', 1.5, 'زخم بيعي متنامٍ');
  else vote(votes, 'MACD', 'سلبي متباطئ', 'sell', 0.75, 'زخم بيعي يضعف');

  // 3) RSI — واعٍ بالنظام: التشبع مع الاتجاه زخمٌ لا انعكاس
  const trendUp = s.regime.trend === 'up';
  const trendDown = s.regime.trend === 'down';
  if (s.rsi < 30) {
    if (trendDown) vote(votes, 'RSI', `تشبع بيعي مع اتجاه هابط (${s.rsi.toFixed(1)})`, 'sell', 1, 'ضغط متواصل — لا تصطد السكين');
    else vote(votes, 'RSI', `تشبع بيعي (${s.rsi.toFixed(1)})`, 'buy', 1.5, 'ارتداد محتمل من التشبع');
  } else if (s.rsi > 70) {
    if (trendUp) vote(votes, 'RSI', `زخم قوي متواصل (${s.rsi.toFixed(1)})`, 'buy', 0.75, 'المشترون مسيطرون رغم التشبع');
    else vote(votes, 'RSI', `تشبع شرائي (${s.rsi.toFixed(1)})`, 'sell', 1.5, 'جني أرباح محتمل');
  } else if (s.rsi > 55) vote(votes, 'RSI', `زخم إيجابي (${s.rsi.toFixed(1)})`, 'buy', 1, 'مشترون مسيطرون');
  else if (s.rsi < 45) vote(votes, 'RSI', `زخم سلبي (${s.rsi.toFixed(1)})`, 'sell', 1, 'بائعون مسيطرون');
  else vote(votes, 'RSI', `محايد (${s.rsi.toFixed(1)})`, 'hold', 0.5, 'لا حسم');

  // 3-ب) المسافة عن EMA50 + تغير 24h — صوتان دائمان يثريان الأدلة
  const dist50 = ((price - s.ema50) / s.ema50) * 100;
  if (dist50 > 1) vote(votes, 'التموضع', `فوق EMA50 بـ ${dist50.toFixed(2)}%`, 'buy', 0.75, 'تفوق على المتوسط الطويل');
  else if (dist50 < -1) vote(votes, 'التموضع', `تحت EMA50 بـ ${dist50.toFixed(2)}%`, 'sell', 0.75, 'تخلف عن المتوسط الطويل');
  else vote(votes, 'التموضع', `ملاصق لـ EMA50 (${dist50.toFixed(2)}%)`, 'hold', 0.5, 'توازن حول المتوسط');
  if (s.change24 > 2) vote(votes, 'تغير 24h', `+${s.change24.toFixed(2)}%`, 'buy', 0.5, 'دفع يومي إيجابي');
  else if (s.change24 < -2) vote(votes, 'تغير 24h', `${s.change24.toFixed(2)}%`, 'sell', 0.5, 'ضغط يومي سلبي');
  else vote(votes, 'تغير 24h', `${s.change24 >= 0 ? '+' : ''}${s.change24.toFixed(2)}%`, 'hold', 0.25, 'حركة يومية هادئة');

  // 4) Stochastic — تقاطعات عند الأطراف
  const { k, d, prevK, prevD } = s.stoch;
  if (prevK <= prevD && k > d && k < 30) vote(votes, 'Stochastic', 'تقاطع ذهبي في التشبع', 'buy', 1, 'إشارة انعكاس شرائية');
  else if (prevK >= prevD && k < d && k > 70) vote(votes, 'Stochastic', 'تقاطع موت في التشبع', 'sell', 1, 'إشارة انعكاس بيعية');

  // 5) Bollinger — اللمس + الاختراق
  if (s.bollinger) {
    const pb = s.bollinger.percentB;
    if (pb < 0) vote(votes, 'Bollinger', 'كسر الحد السفلي', 'buy', 1, 'تمدد بيعي مرشح للارتداد');
    else if (pb > 1) vote(votes, 'Bollinger', 'كسر الحد العلوي', 'sell', 1, 'تمدد شرائي مرشح للتهدئة');
    else if (pb < 0.2) vote(votes, 'Bollinger', 'قرب الحد السفلي', 'buy', 0.5, 'دعم متحرك');
    else if (pb > 0.8) vote(votes, 'Bollinger', 'قرب الحد العلوي', 'sell', 0.5, 'مقاومة متحركة');
  }

  // 6) الحجم — تأكيد
  if (s.volume.ratio > 1.5) {
    const dirBias = s.regime.trend === 'up' ? 'buy' : s.regime.trend === 'down' ? 'sell' : 'hold';
    vote(votes, 'الحجم', `مرتفع ${s.volume.ratio.toFixed(1)}x المتوسط`, dirBias, 0.75, 'سيولة تؤكد الحركة');
  }

  // 7) القرب من الدعم/المقاومة
  const nearSup = s.supports[0];
  const nearRes = s.resistances[0];
  if (nearSup && Math.abs(price - nearSup.price) / price < 0.004) {
    vote(votes, 'الدعم', `ارتكاز على ${nearSup.price.toLocaleString()} (تلامس ${nearSup.count}x)`, 'buy', 1, 'دعم يحترمه السعر');
  }
  if (nearRes && Math.abs(nearRes.price - price) / price < 0.004) {
    vote(votes, 'المقاومة', `اصطدام بـ ${nearRes.price.toLocaleString()} (تلامس ${nearRes.count}x)`, 'sell', 1, 'مقاومة ترد السعر');
  }

  // 8) أنماط الشموع
  for (const p of s.patterns) {
    if (p.bias !== 'neutral') vote(votes, `نمط ${p.name}`, p.name, p.bias, p.strength, 'سلوك سعري انعكاسي');
  }

  // 8-ب) صوت المواصفة (إن طُلبت): نفس عائلات strategies.js القابلة للقياس
  let activeSpec = null;
  if (opts.spec) {
    try {
      activeSpec = typeof opts.spec === 'string' ? getSpec(opts.spec) : opts.spec;
      const S = buildSeries(candles, {});
      const ev = evaluateSpec(activeSpec, S, S.n - 1);
      if (ev.direction === 'long') vote(votes, `استراتيجية ${activeSpec.name}`, `توافق ${ev.score.toFixed(2)}`, 'buy', 2, ev.reasons[0] || 'توافق العائلة');
      else if (ev.direction === 'short') vote(votes, `استراتيجية ${activeSpec.name}`, `توافق ${ev.score.toFixed(2)}`, 'sell', 2, ev.reasons[0] || 'توافق العائلة');
      else vote(votes, `استراتيجية ${activeSpec.name}`, 'محايد', 'hold', 0.5, 'لا إشارة من العائلة');
    } catch { /* تجاهل — يبقى التصويت الأصلي */ }
  }

  // 9) معرفة Backtest السابقة (إن وجدت) — ترجيح خفيف
  const relevant = (knowledge || []).filter((k) => !k.pair || k.pair === pair).slice(0, 3);
  let knowledgeNote = '';
  if (relevant.length) {
    const avgWin = relevant.reduce((a, k) => a + (k.win_rate || 50), 0) / relevant.length;
    knowledgeNote = ` (معرفة مكتسبة: متوسط نجاح ${avgWin.toFixed(0)}% في ${relevant.length} اختبارات)`;
  }

  // ── التجميع ──
  let score = 0;
  for (const v of votes) {
    if (v.signal === 'buy') score += v.weight;
    else if (v.signal === 'sell') score -= v.weight;
  }
  // خصم التذبذب العالي من الثقة (لا من الاتجاه)
  const volPenalty = s.regime.volatility === 'high' ? 0.85 : 1;

  const direction = score >= 2.5 ? 'buy' : score <= -2.5 ? 'sell' : 'hold';
  const rawConf = direction === 'hold'
    ? 45 + Math.min(15, (2.5 - Math.abs(score)) * 6)
    : 55 + Math.min(40, Math.abs(score) * 5.5);
  const confidence = Math.round(Math.max(5, Math.min(97, rawConf * volPenalty)));

  // ── المستويات من ATR والدعوم (tighten-only: لا نوسّع الوقف أبداً) ──
  const { stop, tps } = computeLevels(direction, price, s.atr, nearSup, nearRes, activeSpec?.risk || {});
  const risk = stop === null ? 0 : Math.max(1e-9, Math.abs(price - stop));
  const reward = tps[1] === null ? 0 : Math.abs(tps[1] - price);
  const rr = direction === 'hold' ? '—' : `1:${(reward / risk).toFixed(1)}`;

  const topReasons = [...votes]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((v) => `• ${v.name}: ${v.value}`);
  // سجل الأدلة المرقمة (منهجية market-research) + ما يُبطل الإشارة
  const evidence = [...votes]
    .sort((a, b) => b.weight - a.weight)
    .map((v, n) => `${n + 1}. [${v.name}] ${v.value} — ${v.reason}`);
  const stopStr = stop === null ? '—' : String(roundP(stop));
  const invalidation = direction === 'buy'
    ? `يُبطل الشراء: إغلاق شمعة تحت الوقف ${stopStr}`
    : direction === 'sell'
      ? `يُبطل البيع: إغلاق شمعة فوق الوقف ${stopStr}`
      : 'لا دخول — الشروط غير مكتملة';
  const dirAr = direction === 'buy' ? 'شراء' : direction === 'sell' ? 'بيع' : 'انتظار';
  const regimeAr = s.regime.regime === 'trending'
    ? `اتجاه ${s.regime.trend === 'up' ? 'صاعد' : 'هابط'}`
    : 'نطاق عرضي';
  const summary = `العقل الكمي لـ ${pair}: التوصية ${dirAr} بثقة ${confidence}% — السوق في ${regimeAr} وتقلب ${s.regime.volatility === 'high' ? 'عالٍ' : s.regime.volatility === 'low' ? 'منخفض' : 'طبيعي'} (ATR ${s.atrPct.toFixed(2)}%).\n${topReasons.join('\n')}${knowledgeNote}`;

  return {
    direction,
    confidence,
    entry_price: roundP(price),
    stop_loss: stop === null ? null : roundP(stop),
    take_profit_1: tps[0] === null ? null : roundP(tps[0]),
    take_profit_2: tps[1] === null ? null : roundP(tps[1]),
    take_profit_3: tps[2] === null ? null : roundP(tps[2]),
    risk_reward: rr,
    analysis_summary: summary,
    strategy: activeSpec ? activeSpec.name : 'عقل كمي: توافق الاتجاه والزخم والسيولة',
    strategy_id: activeSpec ? activeSpec.id : 'quant_hybrid_legacy',
    evidence,
    invalidation,
    indicators: votes.map((v) => ({ name: v.name, value: String(v.value), signal: v.signal })),
    patterns_detected: s.patterns.map((p) => p.name),
    _debug: { score: +score.toFixed(2), regime: s.regime, rsi: +s.rsi.toFixed(1) },
  };
}

/** مستويات Micro Growth الثابتة: وقف 1.5% وأهداف 3R/4R/6R (4.5%/6%/9%). */
function microLevels(direction, price) {
  if (!isFinite(price) || price <= 0) return { stop: null, tps: [null, null, null] };
  const sl = MICRO_SL_PCT / 100;
  const sign = direction === 'buy' ? 1 : -1;
  return {
    stop: price - sign * price * sl,
    tps: MICRO_TP_R.map((r) => price + sign * price * sl * r),
  };
}

/**
 * Micro Growth — إشارة 1D حتمية مطابقة للاستراتيجية التي اختُبرت تاريخياً.
 * عائلة trend_ema: السعر فوق EMA20 فوق EMA50 + MACD إيجابي (والعكس للبيع).
 * الوقف ثابت 1.5% والهدف الأول 4.5% (3R ثم 6% و9%).
 * تعيد نفس شكل analyze() كي لا يحتاج الراوتر/المنفذ إلى معالجة خاصة.
 */
export function analyzeMicro(pair, candles) {
  const empty = (reason) => ({
    direction: 'hold',
    confidence: 50,
    entry_price: null,
    stop_loss: null,
    take_profit_1: null,
    take_profit_2: null,
    take_profit_3: null,
    risk_reward: '—',
    analysis_summary: `Micro Growth (1D) — لا إشارة: ${reason}`,
    strategy: 'Micro Growth',
    strategy_id: 'micro_growth',
    indicators: [],
    patterns_detected: [],
  });

  if (!candles || candles.length < 80) return empty('بيانات غير كافية (يلزم 80+ شمعة يومية)');

  const spec = getSpec('micro_growth');
  const S = buildSeries(candles, {});
  const i = S.n - 1;
  const ev = evaluateSpec(spec, S, i);
  const price = S.closes[i];
  const atr = S.atr[i];
  const direction = ev.direction === 'long' ? 'buy' : ev.direction === 'short' ? 'sell' : 'hold';
  if (direction === 'hold') return empty(ev.reasons.join('؛ ') || 'لا توافق اتجاهي على 1D');

  const levels = microLevels(direction, price);
  const confidence = 75;
  const dirAr = direction === 'buy' ? 'شراء' : 'بيع';
  return {
    direction,
    confidence,
    entry_price: roundP(price),
    stop_loss: levels.stop === null ? null : roundP(levels.stop),
    take_profit_1: levels.tps[0] === null ? null : roundP(levels.tps[0]),
    take_profit_2: levels.tps[1] === null ? null : roundP(levels.tps[1]),
    take_profit_3: levels.tps[2] === null ? null : roundP(levels.tps[2]),
    risk_reward: '1:3',
    analysis_summary: `Micro Growth (1D) — ${dirAr} بثقة ${confidence}%: ${ev.reasons.join('؛ ')}. الوقف 1.5% والهدف الأول 4.5% (3R).`,
    strategy: 'Micro Growth',
    strategy_id: 'micro_growth',
    indicators: [
      { name: 'EMA20', value: String(roundP(S.emaFast[i])), signal: direction },
      { name: 'EMA50', value: String(roundP(S.emaSlow[i])), signal: direction },
      { name: 'MACD', value: String(roundP(S.macdHist[i])), signal: direction },
      { name: 'ATR', value: String(roundP(atr)), signal: 'hold' },
    ],
    patterns_detected: [],
  };
}

function roundP(x) {
  if (!isFinite(x)) return 0;
  const abs = Math.abs(x);
  const dec = abs >= 1000 ? 2 : abs >= 100 ? 3 : abs >= 1 ? 4 : 6;
  return +x.toFixed(dec);
}
