/**
 * strategies.js — عائلات استراتيجيات بارامترية قابلة للقياس والتدوير (Phase 2).
 *
 * الفكرة (منهجية stock-analysis + backtesting-frameworks):
 * - كل استراتيجية = StrategySpec JSON: { id, name, family, params, threshold, risk }
 * - كل عائلة دالة خالصة على سلاسل محسوبة مسبقاً → نفس الكود يعمل حياً وفي الباكتست
 *   (يصلح انحراف "الباكتست لا يطابق الحي" القديم).
 * - analyzeMultiTF: توافق 4h + تأكيد 1h + نظام 1d + اتساع السوق + سجل أدلة مرقمة.
 */
import { emaSeries, marketRegime } from './indicators.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/** RSI Wilder كسلسلة كاملة (للاستخدام الشريطي في الباكتست) */
export function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(50);
  if (closes.length < period + 1) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/**
 * سلاسل محسوبة مرة واحدة O(n) — تُقيّم كل عائلة عليها بـ O(1) لكل شمعة.
 * candles: [{open,high,low,close,volume}] الأخيرة = الحالية.
 */
export function buildSeries(candles, o = {}) {
  const {
    emaFast = 20, emaSlow = 50, rsiP = 14,
    macdF = 12, macdS = 26, macdSig = 9,
    stochK = 14, stochD = 3, bbP = 20, bbM = 2,
    atrP = 14, donN = 20, volP = 20,
  } = o;
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const vols = candles.map((c) => c.volume || 0);

  const ef = emaSeries(closes, emaFast);
  const es = emaSeries(closes, emaSlow);
  const rsi = rsiSeries(closes, rsiP);
  // ملاحظة: emaSeries كاملة لكل استدعاء — نحسب مرة واحدة خارج الحلقة
  const efF = emaSeries(closes, macdF);
  const esS = emaSeries(closes, macdS);
  const dif = closes.map((_, i) => efF[i] - esS[i]);
  const dea = emaSeries(dif, macdSig);
  const hist = dif.map((d, i) => (d - dea[i]) * 2);

  const k = new Array(n).fill(50);
  for (let i = stochK - 1; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - stochK + 1; j <= i; j++) {
      if (highs[j] > hi) hi = highs[j];
      if (lows[j] < lo) lo = lows[j];
    }
    k[i] = hi === lo ? 50 : ((closes[i] - lo) / (hi - lo)) * 100;
  }
  const d = new Array(n).fill(50);
  for (let i = 0; i < n; i++) {
    const s = k.slice(Math.max(0, i - stochD + 1), i + 1);
    d[i] = s.reduce((a, v) => a + v, 0) / s.length;
  }

  const pb = new Array(n).fill(0.5);
  const bw = new Array(n).fill(0);
  for (let i = bbP - 1; i < n; i++) {
    const sl = closes.slice(i - bbP + 1, i + 1);
    const mid = sl.reduce((a, v) => a + v, 0) / bbP;
    const sd = Math.sqrt(sl.reduce((a, v) => a + (v - mid) ** 2, 0) / bbP);
    const up = mid + bbM * sd, lo = mid - bbM * sd;
    pb[i] = up === lo ? 0.5 : (closes[i] - lo) / (up - lo);
    bw[i] = mid === 0 ? 0 : (up - lo) / mid;
  }

  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  const atrArr = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const s = tr.slice(Math.max(0, i - atrP + 1), i + 1);
    atrArr[i] = s.reduce((a, v) => a + v, 0) / Math.max(1, s.length);
  }

  const volAvg = new Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    const s = vols.slice(Math.max(0, i - volP + 1), i + 1);
    volAvg[i] = s.reduce((a, v) => a + v, 0) / Math.max(1, s.length);
  }

  const donHigh = new Array(n).fill(0);
  const donLow = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const s0 = Math.max(0, i - donN);
    donHigh[i] = Math.max(...highs.slice(s0, i), closes[i]);
    donLow[i] = Math.min(...lows.slice(s0, i), closes[i]);
  }

  return {
    n, closes, highs, lows, vols,
    emaFast: ef, emaSlow: es, rsi, macdHist: hist,
    stochK: k, stochD: d, bbPB: pb, bbBW: bw,
    atr: atrArr, volAvg, donHigh, donLow, donN,
    paramsUsed: { emaFast, emaSlow, rsiP, macdF, macdS, macdSig, stochK, stochD, bbP, bbM, atrP, donN, volP },
  };
}

/** العائلات: كل واحدة (i, S, p) → { score ∈ [-1,1], reasons[] } */
export const FAMILIES = {
  trend_ema: {
    label: 'تقاطع الاتجاه',
    defaults: { fast: 20, slow: 50, macdConfirm: true },
    evalBar(i, S, p) {
      const reasons = [];
      const price = S.closes[i], ef = S.emaFast[i], es = S.emaSlow[i];
      if (price == null || ef == null || es == null) return { score: 0, reasons };
      let s = 0;
      if (price > ef && ef > es) { s += 0.7; reasons.push('السعر فوق EMA السريع فوق البطيء (اتجاه صاعد)'); }
      else if (price < ef && ef < es) { s -= 0.7; reasons.push('السعر تحت EMA السريع تحت البطيء (اتجاه هابط)'); }
      else { reasons.push('لا تكدس اتجاهي للمتوسطات'); }
      if (p.macdConfirm) {
        const h = S.macdHist[i];
        if (h > 0) { s += 0.3; reasons.push('MACD إيجابي يؤكد'); }
        else if (h < 0) { s -= 0.3; reasons.push('MACD سلبي يؤكد'); }
      }
      return { score: clamp(s, -1, 1), reasons };
    },
  },
  momentum_macd: {
    label: 'زخم MACD',
    defaults: { rsiLow: 40, rsiHigh: 60 },
    evalBar(i, S, p) {
      const reasons = [];
      const h = S.macdHist[i], r = S.rsi[i];
      let s = h > 0 ? 0.6 : h < 0 ? -0.6 : 0;
      reasons.push(h > 0 ? 'زخم MACD إيجابي' : h < 0 ? 'زخم MACD سلبي' : 'MACD محايد');
      if (r > p.rsiHigh) { s += 0.4; reasons.push(`RSI قوي ${r.toFixed(0)}`); }
      else if (r < p.rsiLow) { s -= 0.4; reasons.push(`RSI ضعيف ${r.toFixed(0)}`); }
      else { s += r >= 50 ? 0.15 : -0.15; reasons.push(`RSI محايد مائل ${r >= 50 ? 'إيجاباً' : 'سلباً'}`); }
      return { score: clamp(s, -1, 1), reasons };
    },
  },
  mean_rsi_bb: {
    label: 'انعكاس RSI/BB',
    defaults: { oversold: 30, overbought: 70 },
    evalBar(i, S, p) {
      const reasons = [];
      const r = S.rsi[i], pb = S.bbPB[i];
      let s = 0;
      if (r < p.oversold) {
        s += 0.8; reasons.push(`تشبع بيعي RSI ${r.toFixed(0)} — ارتداد محتمل`);
        if (i > 1 && S.macdHist[i] > S.macdHist[i - 1]) { s += 0.2; reasons.push('تباعد إيجابي: MACD يتحسن مع التشبع'); }
      } else if (r > p.overbought) {
        s -= 0.8; reasons.push(`تشبع شرائي RSI ${r.toFixed(0)} — جني أرباح محتمل`);
        if (i > 1 && S.macdHist[i] < S.macdHist[i - 1]) { s -= 0.2; reasons.push('تباعد سلبي: MACD يضعف مع التشبع'); }
      } else if (pb < 0.15) { s += 0.4; reasons.push('السعر عند الحد السفلي لبولينجر'); }
      else if (pb > 0.85) { s -= 0.4; reasons.push('السعر عند الحد العلوي لبولينجر'); }
      else { reasons.push('لا تطرف سعري للدخول العكسي'); }
      return { score: clamp(s, -1, 1), reasons };
    },
  },
  breakout_sr: {
    label: 'اختراق الدعم/المقاومة',
    defaults: { volMult: 1.5 },
    evalBar(i, S, p) {
      const reasons = [];
      if (i < 1) return { score: 0, reasons };
      const c = S.closes[i];
      const volR = S.volAvg[i] ? S.vols[i] / S.volAvg[i] : 1;
      let s = 0;
      if (c > S.donHigh[i]) {
        s += 0.7; reasons.push(`اختراق أعلى قمة ${S.donN} شمعة`);
        if (volR > p.volMult) { s += 0.3; reasons.push(`تأكيد بحجم ${volR.toFixed(1)}x`); }
        else { s -= 0.2; reasons.push('اختراق بلا حجم — حذر'); }
      } else if (c < S.donLow[i]) {
        s -= 0.7; reasons.push(`كسر أدنى قاع ${S.donN} شمعة`);
        if (volR > p.volMult) { s -= 0.3; reasons.push(`تأكيد بحجم ${volR.toFixed(1)}x`); }
        else { s += 0.2; reasons.push('كسر بلا حجم — حذر'); }
      } else {
        reasons.push('السعر داخل النطاق — لا اختراق');
      }
      return { score: clamp(s, -1, 1), reasons };
    },
  },
  stoch_cross: {
    label: 'تقاطع Stochastic',
    defaults: { lowX: 20, highX: 80 },
    evalBar(i, S, p) {
      const reasons = [];
      if (i < 1) return { score: 0, reasons };
      const k = S.stochK[i], d = S.stochD[i], pk = S.stochK[i - 1], pd = S.stochD[i - 1];
      let s = 0;
      if (pk <= pd && k > d && k < p.lowX + 10) { s += 0.9; reasons.push(`تقاطع ذهبي عند ${k.toFixed(0)} (تشبع بيعي)`); }
      else if (pk >= pd && k < d && k > p.highX - 10) { s -= 0.9; reasons.push(`تقاطع موت عند ${k.toFixed(0)} (تشبع شرائي)`); }
      else if (k > d) { s += 0.2; reasons.push('Stochastic إيجابي بلا تقاطع حاسم'); }
      else if (k < d) { s -= 0.2; reasons.push('Stochastic سلبي بلا تقاطع حاسم'); }
      else { reasons.push('Stochastic محايد'); }
      return { score: clamp(s, -1, 1), reasons };
    },
  },
  squeeze: {
    label: 'انضغاط البولينجر',
    defaults: { lookback: 20, quietVol: 1.0 },
    evalBar(i, S, p) {
      const reasons = [];
      const from = Math.max(0, i - p.lookback + 1);
      const win = S.bbBW.slice(from, i + 1);
      const avg = win.reduce((a, v) => a + v, 0) / Math.max(1, win.length);
      const ratio = avg ? S.bbBW[i] / avg : 1;
      if (ratio > 0.75) return { score: 0, reasons: ['لا انضغاط حالي في النطاقات'] };
      const dirUp = S.emaFast[i] > S.emaSlow[i];
      const volR = S.volAvg[i] ? S.vols[i] / S.volAvg[i] : 1;
      let s = dirUp ? 0.55 : -0.55;
      reasons.push(`انضغاط (العرض ${Math.round(ratio * 100)}% من المتوسط) — انفجار وشيك`);
      reasons.push(dirUp ? 'الميل مع الاتجاه الصاعد' : 'الميل مع الاتجاه الهابط');
      if (volR < p.quietVol) { s *= 1.15; reasons.push('هدوء حجمي يسبق الحركة عادة'); }
      return { score: clamp(s, -1, 1), reasons };
    },
  },
};

/** يقيّم StrategySpec على السلسلة عند الشمعة i */
export function evaluateSpec(spec, S, i) {
  const fam = FAMILIES[spec.family];
  if (!fam) return { score: 0, reasons: [`عائلة غير معروفة: ${spec.family}`] };
  const params = { ...fam.defaults, ...(spec.params || {}) };
  const { score, reasons } = fam.evalBar(i, S, params);
  const th = Number(spec.threshold ?? 0.35);
  const direction = score >= th ? 'long' : score <= -th ? 'short' : null;
  return { score, direction, reasons, family: spec.family, threshold: th };
}

/**
 * سجل الاستراتيجيات — نُقلت القوالب الثمانية من السوق (بلا أرقامها التسويقية)
 * إلى مواصفات قابلة للتنفيذ والقياس. avg_* القديمة تُتجاهل عمداً.
 */
export const STRATEGY_REGISTRY = [
  { id: 'ema_cross_pro', name: 'EMA Crossover Pro', family: 'trend_ema', threshold: 0.4, params: { fast: 20, slow: 50, macdConfirm: true }, risk: { slAtr: 1.5, tpR: [1.5, 2.5, 4] }, category: 'trend_following', timeframes: ['1h', '4h', '1d'] },
  { id: 'rsi_divergence', name: 'RSI Divergence Hunter', family: 'mean_rsi_bb', threshold: 0.4, params: { oversold: 30, overbought: 70 }, risk: { slAtr: 1.5, tpR: [1.5, 2.5, 4] }, category: 'mean_reversion', timeframes: ['4h', '1d'] },
  { id: 'breakout_sniper', name: 'Breakout Sniper', family: 'breakout_sr', threshold: 0.4, params: { volMult: 1.5 }, risk: { slAtr: 1.5, tpR: [1.5, 2.5, 4] }, category: 'breakout', timeframes: ['15m', '1h', '4h'] },
  { id: 'stoch_scalper', name: 'Scalping Lightning', family: 'stoch_cross', threshold: 0.45, params: { lowX: 20, highX: 80 }, risk: { slAtr: 1.0, tpR: [1, 2, 3] }, category: 'scalping', timeframes: ['1m', '5m', '15m'] },
  { id: 'swing_master', name: 'Swing Master AI', family: 'trend_ema', threshold: 0.5, params: { fast: 20, slow: 50, macdConfirm: true }, risk: { slAtr: 2, tpR: [1.5, 2.5, 4] }, category: 'swing', timeframes: ['4h', '1d', '3d'] },
  { id: 'ai_sentiment_hybrid', name: 'AI Sentiment Trader', family: 'momentum_macd', threshold: 0.4, params: { rsiLow: 40, rsiHigh: 60 }, risk: { slAtr: 1.5, tpR: [1.5, 2.5, 4] }, category: 'ai_hybrid', timeframes: ['1h', '4h'] },
  { id: 'bb_squeeze', name: 'Bollinger Squeeze', family: 'squeeze', threshold: 0.4, params: { lookback: 20, quietVol: 1.0 }, risk: { slAtr: 1.5, tpR: [2, 3, 5] }, category: 'breakout', timeframes: ['1h', '4h', '1d'] },
  { id: 'macd_wave', name: 'MACD Momentum Wave', family: 'momentum_macd', threshold: 0.35, params: { rsiLow: 40, rsiHigh: 60 }, risk: { slAtr: 1.5, tpR: [1.5, 2.5, 4] }, category: 'trend_following', timeframes: ['4h', '1d'] },
  { id: 'micro_growth', name: 'Micro Growth ($100 أو أقل)', family: 'trend_ema', threshold: 0.5, params: { fast: 20, slow: 50, macdConfirm: true }, risk: { slAtr: 1.5, tpR: [3, 4, 6] }, category: 'low_balance', timeframes: ['1d'] },
  { id: 'quant_hybrid', name: 'العقل الكمي الهجين', family: 'trend_ema', threshold: 0.3, params: { fast: 20, slow: 50, macdConfirm: true }, risk: { slAtr: 1.5, tpR: [1.5, 2.5, 4] }, category: 'ai_hybrid', timeframes: ['1h', '4h', '1d'] },
];

export function getSpec(id) {
  return STRATEGY_REGISTRY.find((s) => s.id === id) || STRATEGY_REGISTRY[STRATEGY_REGISTRY.length - 1];
}

function roundP(x) {
  if (!isFinite(x)) return 0;
  const abs = Math.abs(x);
  const dec = abs >= 1000 ? 2 : abs >= 100 ? 3 : abs >= 1 ? 4 : 6;
  return +x.toFixed(dec);
}

/** مستويات الوقف/الأهداف (نفس قاعدة tighten-only في signals.js) */
export function computeLevels(direction, price, atrV, nearSup, nearRes, risk = {}) {
  // C7: ATR/سعر فاسد = مستويات معدومة (لا وقف عند الدخول ولا عند الصفر أبداً)
  if (!isFinite(price) || price <= 0 || !isFinite(atrV) || atrV <= 0) {
    return { stop: null, tps: [null, null, null] };
  }
  const slAtr = Number(risk.slAtr) || 1.5;
  const tpR = Array.isArray(risk.tpR) && risk.tpR.length === 3 ? risk.tpR : [1.5, 2.5, 4];
  const riskDist = atrV * slAtr;
  let stop = null;
  let tps = [null, null, null];
  if (direction === 'buy') {
    stop = price - riskDist;
    if (nearSup && nearSup.price < price && price - nearSup.price < riskDist * 1.5) {
      stop = Math.max(stop, nearSup.price - atrV * 0.2);
    }
    const r = Math.max(1e-9, price - stop);
    tps = tpR.map((m) => price + r * m);
  } else if (direction === 'sell') {
    stop = price + riskDist;
    if (nearRes && nearRes.price > price && nearRes.price - price < riskDist * 1.5) {
      stop = Math.min(stop, nearRes.price + atrV * 0.2);
    }
    const r = Math.max(1e-9, stop - price);
    tps = tpR.map((m) => price - r * m);
  }
  return { stop, tps };
}

/**
 * تحليل متعدد الفريمات — نفس شكل إشارة analyze() + حقول إضافية:
 * strategy_id, timeframes, evidence[], invalidation, regime
 *
 * @param {string} pair
 * @param {object} tfs { h4: [...], d1?: [...], h1?: [...] } شموع بصيغة العقل
 * @param {object} opts { spec?, knowledge?, breadth?: {aligned,total}, summarize4h? }
 */
export function analyzeMultiTF(pair, tfs, opts = {}) {
  const spec = typeof opts.spec === 'string' ? getSpec(opts.spec) : (opts.spec || getSpec('quant_hybrid'));
  const h4 = tfs.h4 || [];
  if (h4.length < 60) throw new Error('شموع 4h غير كافية (يلزم 60+)');
  const S = buildSeries(h4, {});
  const i = S.n - 1;
  const price = S.closes[i];
  const ev = evaluateSpec(spec, S, i);

  // النظام من اليومي (أطول نظرة)، والتأكيد من الساعة
  let regime = null;
  try {
    if (tfs.d1 && tfs.d1.length >= 30) regime = marketRegime(tfs.d1);
  } catch { /* تجاهل */ }
  let tfNote = '';
  let agreeBoost = 0;
  if (tfs.h1 && tfs.h1.length >= 60) {
    try {
      const S1 = buildSeries(tfs.h1, {});
      const ev1 = evaluateSpec(spec, S1, S1.n - 1);
      const agree = (ev.direction === 'long' && ev1.direction === 'long') || (ev.direction === 'short' && ev1.direction === 'short');
      const conflict = ev.direction && ev1.direction && !agree;
      if (agree) { agreeBoost = 8; tfNote = 'تأكيد إطار 1h مع اتجاه 4h (+8)'; }
      else if (conflict) { agreeBoost = -10; tfNote = 'تعارض إطار 1h مع 4h (−10) — حذر'; }
      else { tfNote = 'إطار 1h محايد'; }
    } catch { /* تجاهل */ }
  }

  // بوابة النظام للاستراتيجيات الاتجاهية
  const trendFam = spec.family === 'trend_ema' || spec.family === 'momentum_macd';
  let regimePenalty = 1;
  let regimeNote = '';
  if (regime) {
    if (regime.regime === 'ranging' && trendFam && ev.direction) {
      regimePenalty = 0.8; regimeNote = 'سوق عرضي على اليومي — خصم 20% لاستراتيجية اتجاهية';
    }
    if (regime.volatility === 'high') {
      regimePenalty *= 0.85; regimeNote += (regimeNote ? ' + ' : '') + 'تقلب عالٍ — خصم 15%';
    }
  }

  // اتساع السوق (منهجية financial-analysis: شهية المخاطرة الجماعية)
  let breadthNote = '';
  if (opts.breadth && typeof opts.breadth.aligned === 'number') {
    const { aligned, total } = opts.breadth;
    breadthNote = `اتساع السوق: ${aligned}/${total} من الكبار بنفس الاتجاه`;
    if (ev.direction && total > 0 && aligned / total >= 0.6) agreeBoost += 4;
  }

  const direction = !ev.direction ? 'hold' : ev.direction === 'long' ? 'buy' : 'sell';
  const rawConf = direction === 'hold'
    ? 45 + Math.min(15, 15 * (1 - Math.abs(ev.score)))
    : 55 + Math.min(40, Math.abs(ev.score) * 45);
  const confidence = Math.round(Math.max(5, Math.min(97, rawConf * regimePenalty)) + (direction === 'hold' ? 0 : agreeBoost));
  const conf = Math.max(5, Math.min(97, confidence));

  // المستويات (تحتاج دعم/مقاومة 4h — نحسبها هنا خفيفاً عبر summarize الكامل مرة واحدة)
  let atrV = S.atr[i] || 0;
  let nearSup = null, nearRes = null, patterns = [], atrPct = 0;
  if (opts.summarize4h) {
    const s = opts.summarize4h;
    atrV = s.atr || atrV;
    nearSup = (s.supports || [])[0] || null;
    nearRes = (s.resistances || [])[0] || null;
    patterns = (s.patterns || []).map((p) => p.name);
    atrPct = s.atrPct || (price ? (atrV / price) * 100 : 0);
  } else {
    atrPct = price ? (atrV / price) * 100 : 0;
  }
  const { stop, tps } = computeLevels(direction, price, atrV, nearSup, nearRes, spec.risk);
  const risk = stop === null ? 0 : Math.max(1e-9, Math.abs(price - stop));
  const reward = tps[1] === null ? 0 : Math.abs(tps[1] - price);
  const rr = direction === 'hold' ? '—' : `1:${risk > 0 ? (reward / risk).toFixed(1) : '—'}`;

  // سجل الأدلة المرقمة (منهجية market-research) + ما يُبطل الإشارة
  const evidence = [
    ...ev.reasons.map((r, n) => `${n + 1}. [${spec.name}] ${r}`),
    ...(regime ? [`${ev.reasons.length + 1}. [النظام اليومي] ${regime.regime === 'trending' ? `اتجاه ${regime.trend}` : 'نطاق عرضي'} — تقلب ${regime.volatility} (ATR ${regime.atrPct.toFixed(2)}%)`] : []),
    ...(tfNote ? [`${ev.reasons.length + (regime ? 2 : 1)}. [تعدد الفريمات] ${tfNote}`] : []),
    ...(breadthNote ? [`${ev.reasons.length + (regime ? 2 : 1) + (tfNote ? 1 : 0)}. [الاتساع] ${breadthNote}`] : []),
  ];
  const stopStr = stop === null ? '—' : String(roundP(stop));
  const invalidation = direction === 'buy'
    ? `يُبطل الشراء: إغلاق شمعة 4h تحت الوقف ${stopStr} أو انكسار EMA20/50 للأسفل`
    : direction === 'sell'
      ? `يُبطل البيع: إغلاق شمعة 4h فوق الوقف ${stopStr} أو اختراق EMA20/50 للأعلى`
      : 'لا دخول — الشروط غير مكتملة على 4h';

  const relevant = (opts.knowledge || []).filter((k) => !k.pair || k.pair === pair).slice(0, 3);
  let knowledgeNote = '';
  if (relevant.length) {
    const avgWin = relevant.reduce((a, k) => a + (k.win_rate || 50), 0) / relevant.length;
    knowledgeNote = ` (معرفة مكتسبة: متوسط نجاح ${avgWin.toFixed(0)}% في ${relevant.length} اختبارات)`;
  }
  const dirAr = direction === 'buy' ? 'شراء' : direction === 'sell' ? 'بيع' : 'انتظار';
  const summary = `العقل الكمي (${spec.name}) لـ ${pair}: التوصية ${dirAr} بثقة ${conf}% — score ${ev.score.toFixed(2)}${regime ? `، السوق ${regime.regime === 'trending' ? 'اتجاهي' : 'عرضي'}` : ''} (ATR ${atrPct.toFixed(2)}%).${knowledgeNote}\n${evidence.slice(0, 4).join('\n')}\n⚠️ الإبطال: ${invalidation}`;

  return {
    direction,
    confidence: conf,
    entry_price: roundP(price),
    stop_loss: stop === null ? null : roundP(stop),
    take_profit_1: tps[0] === null ? null : roundP(tps[0]),
    take_profit_2: tps[1] === null ? null : roundP(tps[1]),
    take_profit_3: tps[2] === null ? null : roundP(tps[2]),
    risk_reward: rr,
    analysis_summary: summary,
    strategy: spec.name,
    strategy_id: spec.id,
    timeframes: ['4h', ...(tfs.d1 ? ['1d'] : []), ...(tfs.h1 ? ['1h'] : [])],
    evidence,
    invalidation,
    regime: regime ? { regime: regime.regime, trend: regime.trend, volatility: regime.volatility } : null,
    indicators: ev.reasons.map((r) => ({ name: spec.name, value: r, signal: direction })),
    patterns_detected: patterns,
    _debug: { score: +ev.score.toFixed(3), family: spec.family, regimePenalty, agreeBoost },
  };
}
