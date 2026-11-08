/**
 * العقل الكمي — مؤشرات فنية خالصة (بدون أي اعتماد خارجي).
 * الدخل: شموع [{open, high, low, close, volume}] — الأخيرة = الحالية.
 * مستوحى من منهجيات: stock-analysis (تحليل متعدد الأبعاد) + market-research (أدلة مرقمة).
 */

export function sma(values, period) {
  if (values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
}

export function ema(values, period) {
  if (!values.length) return null;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length);
  let e = values[0];
  out[0] = e;
  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

/** RSI بطريقة Wilder (الأصلية) */
export function rsi(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const ef = emaSeries(closes, fast);
  const es = emaSeries(closes, slow);
  const difLine = closes.map((_, i) => ef[i] - es[i]);
  const deaLine = emaSeries(difLine, signal);
  const i = closes.length - 1;
  const dif = difLine[i];
  const dea = deaLine[i];
  const prevHist = (difLine[i - 1] ?? dif) - (deaLine[i - 1] ?? dea);
  return { dif, dea, hist: (dif - dea) * 2, prevHist: prevHist * 2 };
}

export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  if (mid === null) return null;
  const slice = closes.slice(-period);
  const variance = slice.reduce((s, c) => s + (c - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = mid + mult * sd;
  const lower = mid - mult * sd;
  const price = closes[closes.length - 1];
  return {
    mid, upper, lower,
    percentB: upper === lower ? 0.5 : (price - lower) / (upper - lower),
    bandwidth: mid === 0 ? 0 : (upper - lower) / mid,
  };
}

export function atr(candles, period = 14) {
  if (candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

export function stochastic(candles, kPeriod = 14, dPeriod = 3) {
  if (candles.length < kPeriod) return { k: 50, d: 50 };
  const ks = [];
  for (let i = kPeriod - 1; i < candles.length; i++) {
    const slice = candles.slice(i - kPeriod + 1, i + 1);
    const highest = Math.max(...slice.map((c) => c.high));
    const lowest = Math.min(...slice.map((c) => c.low));
    ks.push(highest === lowest ? 50 : ((candles[i].close - lowest) / (highest - lowest)) * 100);
  }
  const k = ks[ks.length - 1];
  const d = ks.slice(-dPeriod).reduce((s, v) => s + v, 0) / Math.min(dPeriod, ks.length);
  const prevKs = ks.slice(0, -1);
  const prevD = prevKs.length
    ? prevKs.slice(-dPeriod).reduce((s, v) => s + v, 0) / Math.min(dPeriod, prevKs.length)
    : d;
  return { k, d, prevK: ks.length > 1 ? ks[ks.length - 2] : k, prevD };
}

export function obv(candles) {
  let v = 0;
  for (let i = 1; i < candles.length; i++) {
    const vol = candles[i].volume || 0;
    if (candles[i].close > candles[i - 1].close) v += vol;
    else if (candles[i].close < candles[i - 1].close) v -= vol;
  }
  return v;
}

/** قمم/قيعان فركتلية (n شمعة على كل جانب) */
export function swings(candles, n = 2) {
  const highs = [], lows = [];
  for (let i = n; i < candles.length - n; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= n; j++) {
      if (candles[i].high < candles[i - j].high || candles[i].high < candles[i + j].high) isH = false;
      if (candles[i].low > candles[i - j].low || candles[i].low > candles[i + j].low) isL = false;
    }
    if (isH) highs.push({ index: i, price: candles[i].high });
    if (isL) lows.push({ index: i, price: candles[i].low });
  }
  return { highs, lows };
}

/** تجميع مستويات قريبة (دعوم/مقاومات) — العنقدة بنسبة من السعر */
export function clusterLevels(points, price, tolerancePct = 0.4) {
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters = [];
  for (const p of sorted) {
    const c = clusters.find((cl) => Math.abs(cl.price - p.price) / price <= tolerancePct / 100);
    if (c) {
      c.price = (c.price * c.count + p.price) / (c.count + 1);
      c.count++;
    } else {
      clusters.push({ price: p.price, count: 1 });
    }
  }
  return clusters.sort((a, b) => b.count - a.count || Math.abs(a.price - price) - Math.abs(b.price - price));
}

export function supportResistance(candles) {
  const price = candles[candles.length - 1].close;
  const { highs, lows } = swings(candles, 2);
  const supports = clusterLevels(lows.slice(-12).map((l) => ({ price: l.price })), price)
    .filter((c) => c.price < price).slice(0, 3);
  const resistances = clusterLevels(highs.slice(-12).map((h) => ({ price: h.price })), price)
    .filter((c) => c.price > price).slice(0, 3);
  return { supports, resistances };
}

/** أنماط شموع يابانية على آخر شمعتين */
export function candlePatterns(candles) {
  const out = [];
  if (candles.length < 2) return out;
  const a = candles[candles.length - 2];
  const b = candles[candles.length - 1];
  const body = (c) => Math.abs(c.close - c.open);
  const range = (c) => c.high - c.low || 1e-9;
  const bullA = a.close > a.open, bullB = b.close > b.open;

  if (!bullA && bullB && b.close > a.open && b.open < a.close && body(b) > body(a) * 0.9) {
    out.push({ name: 'ابتلاع شرائي', bias: 'buy', strength: 2 });
  }
  if (bullA && !bullB && b.close < a.open && b.open > a.close && body(b) > body(a) * 0.9) {
    out.push({ name: 'ابتلاع بيعي', bias: 'sell', strength: 2 });
  }
  const lowerWick = Math.min(b.open, b.close) - b.low;
  const upperWick = b.high - Math.max(b.open, b.close);
  if (lowerWick > body(b) * 2 && upperWick < body(b) * 0.5 && range(b) > 0) {
    out.push({ name: 'مطرقة', bias: 'buy', strength: 1.5 });
  }
  if (upperWick > body(b) * 2 && lowerWick < body(b) * 0.5 && range(b) > 0) {
    out.push({ name: 'شهاب', bias: 'sell', strength: 1.5 });
  }
  if (body(b) / range(b) < 0.15) {
    out.push({ name: 'دوجي (حيرة)', bias: 'neutral', strength: 0.5 });
  }
  return out;
}

/** نظام السوق: trending / ranging + الاتجاه + نظام التقلب */
export function marketRegime(candles) {
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const bb = bollinger(closes);
  const a = atr(candles);
  const atrPct = price ? (a / price) * 100 : 0;

  const trendUp = price > e20 && e20 > e50;
  const trendDown = price < e20 && e20 < e50;
  const bw = bb ? bb.bandwidth * 100 : 1;
  // نطاق ضيق + تقارب متوسطات = تجميع سعري
  const ranging = bw < 4 || (!trendUp && !trendDown && Math.abs((e20 - e50) / price) < 0.003);
  return {
    regime: ranging ? 'ranging' : 'trending',
    trend: trendUp ? 'up' : trendDown ? 'down' : 'sideways',
    volatility: atrPct > 3 ? 'high' : atrPct > 1 ? 'normal' : 'low',
    atrPct,
  };
}

export function volumeRegime(candles, period = 20) {
  const vols = candles.slice(-period).map((c) => c.volume || 0);
  const avg = vols.reduce((s, v) => s + v, 0) / Math.max(1, vols.length);
  const last = vols[vols.length - 1] || 0;
  return { avg, last, ratio: avg ? last / avg : 1 };
}

/** لقطة شاملة — تُستخدم من المحلل والباكتست والمشاعر */
export function summarize(candles) {
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  const bb = bollinger(closes);
  const m = macd(closes);
  const st = stochastic(candles);
  const a = atr(candles);
  const sr = supportResistance(candles);
  const regime = marketRegime(candles);
  const vol = volumeRegime(candles);
  const patterns = candlePatterns(candles);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const r = rsi(closes);
  const chg24 = closes.length > 24
    ? ((price - closes[closes.length - 25]) / closes[closes.length - 25]) * 100
    : ((price - closes[0]) / closes[0]) * 100;
  return {
    price, rsi: r, ema20: e20, ema50: e50, macd: m, bollinger: bb,
    stoch: st, atr: a, atrPct: price ? (a / price) * 100 : 0,
    supports: sr.supports, resistances: sr.resistances,
    regime, volume: vol, patterns, change24: chg24, obv: obv(candles),
  };
}
