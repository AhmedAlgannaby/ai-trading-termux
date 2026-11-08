/**
 * محرك باكتست حقيقي — مبادئ backtesting-frameworks:
 *  - بلا Look-ahead: القرار عند إغلاق الشمعة i يُنفذ على افتتاح i+1
 *  - تكاليف واقعية: عمولة + انزلاق
 *  - تقسيم in-sample/out-of-sample + إحصائيات كاملة + منحنى رأس المال
 */
import { ema, rsi } from './indicators.js';
import { buildSeries, evaluateSpec, getSpec } from './strategies.js';

const FEE_PCT = 0.05;      // عمولة Binance الفعلية للصانع/الآخذ
const SLIPPAGE_PCT = 0.02; // انزلاق تقديري

function applyCost(price, side) {
  // side: +1 شراء (ندفع أكثر) / -1 بيع (نستلم أقل)
  return price * (1 + (side * (FEE_PCT + SLIPPAGE_PCT)) / 100);
}

/** قاعدة الدخول — نفس فلسفة المحلل: توافق الاتجاه والزخم (long/short) */
function signalAt(closes, macdHist, i) {
  if (i < 55) return null;
  const e20 = ema(closes.slice(0, i + 1), 20);
  const e50 = ema(closes.slice(0, i + 1), 50);
  const r = rsi(closes.slice(0, i + 1));
  const price = closes[i];
  const mh = macdHist[i];
  const longOk = price > e20 && e20 > e50 && r < 62 && r > 40 && mh > 0;
  const shortOk = price < e20 && e20 < e50 && r > 38 && r < 60 && mh < 0;
  if (longOk && !shortOk) return 'long';
  if (shortOk && !longOk) return 'short';
  return null;
}

/**
 * @param {object} cfg
 * @param {Array} cfg.candles شموع مرتبة زمنياً [{open,high,low,close}]
 * @param {number} cfg.initialBalance
 * @param {number} cfg.riskPerTrade نسبة المخاطرة % من الرصيد
 * @param {number} cfg.stopLossPercent وقف % من سعر الدخول
 * @param {number} cfg.takeProfitPercent هدف % من سعر الدخول
 * @param {number} [cfg.maxHoldBars=120] حد أقصى للبقاء في الصفقة
 * @param {string|object} [cfg.strategySpec] مواصفة استراتيجية من strategies.js
 *   (عند غيابها تُستخدم القاعدة الأصلية — نفس السلوك السابق تماماً)
 * @param {boolean} [cfg.returnTrades] إرجاع الصفقات الخامسة أيضاً (لـ walk-forward)
 * @param {boolean} [cfg.useAtr=false] استخدام وقف/هدف مبني على ATR (مطابق لـ Micro Growth)
 * @param {number} [cfg.slAtr=1.5] مضاعف ATR للوقف عند useAtr
 * @param {number|number[]} [cfg.tpR=3] مضاعف R للهدف الأول عند useAtr
 * @param {number} [cfg.minSizeUsd=10] أقل حجم صفقة بالدولار
 * @param {number} [cfg.maxLeverage=5] سقف الرافعة في الباكتست
 */
export function runBacktest(cfg) {
  const {
    candles, initialBalance = 10000, riskPerTrade = 2,
    stopLossPercent = 2, takeProfitPercent = 4, maxHoldBars = 120,
    strategySpec = null, returnTrades = false,
    useAtr = false, slAtr = 1.5, tpR = 3,
    minSizeUsd = 10, maxLeverage = 5,
  } = cfg;
  if (!candles || candles.length < 80) {
    throw new Error('بيانات غير كافية للاختبار (يلزم 80+ شمعة)');
  }

  // المواصفة: نفس عائلات strategies.js حياً واختباراً (بلا تسرب — القرار عند i-1 فقط)
  const spec = strategySpec
    ? (typeof strategySpec === 'string' ? getSpec(strategySpec) : strategySpec)
    : null;
  const S = spec ? buildSeries(candles, {}) : null;

  const closes = candles.map((c) => c.close);
  // MACD محسوب مرة واحدة على كامل السلسلة، لكن القرار يستخدم hist[i] فقط (لا تسرب للمستقبل)
  // (يُحسب فقط للمسار الأصلي — مسار المواصفة يستخدم سلاسل S الجاهزة)
  let hist = null;
  if (!spec) {
    const fast = emaSeriesLocal(closes, 12);
    const slow = emaSeriesLocal(closes, 26);
    const dif = closes.map((_, i) => fast[i] - slow[i]);
    const dea = emaSeriesLocal(dif, 9);
    hist = dif.map((d, i) => (d - dea[i]) * 2);
  }

  let balance = initialBalance;
  let position = null;
  const trades = [];
  const equityByBar = [];
  const splitAt = Math.floor(candles.length * 0.7); // تقييم خارج العينة
  let oosTrades = 0, oosWins = 0;

  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];

    // ── إدارة الصفقة المفتوحة (على شمعة i بأعلى/أدنى حقيقي) ──
    let justExited = false;
    if (position) {
      const p = position;
      p.bars++;
      let exitRaw = null;
      let exitReason = '';
      if (p.dir === 'long') {
        if (cur.low <= p.sl) { exitRaw = p.sl; exitReason = 'SL'; }
        else if (cur.high >= p.tp) { exitRaw = p.tp; exitReason = 'TP'; }
      } else {
        if (cur.high >= p.sl) { exitRaw = p.sl; exitReason = 'SL'; }
        else if (cur.low <= p.tp) { exitRaw = p.tp; exitReason = 'TP'; }
      }
      let exitPrice = null;
      if (exitRaw !== null) {
        // Apply exit costs too (was entry-only → inflated returns)
        exitPrice = applyCost(exitRaw, p.dir === 'long' ? -1 : 1);
      } else if (p.bars >= maxHoldBars) {
        exitPrice = applyCost(cur.open, p.dir === 'long' ? -1 : 1);
        exitReason = 'TIME';
      }
      if (exitPrice) {
        const grossPct = p.dir === 'long'
          ? ((exitPrice - p.entry) / p.entry) * 100
          : ((p.entry - exitPrice) / p.entry) * 100;
        const pnlUsd = (p.sizeUsd * grossPct) / 100;
        balance += pnlUsd;
        const t = { ...p, exit: exitPrice, exitReason, pnlPct: grossPct, pnlUsd, endIndex: i, oos: i >= splitAt };
        delete t.bars;
        trades.push(t);
        if (i >= splitAt) { oosTrades++; if (grossPct > 0) oosWins++; }
        position = null;
        justExited = true;
      }
    }

    // ── إشارة جديدة (تُبنى على شمعة i-1 المغلقة فقط — بلا مستقبل) ──
    // Skip entry on the same bar we just exited: cur.open already passed intrabar.
    if (!position && !justExited) {
      const sig = spec ? evaluateSpec(spec, S, i - 1).direction : signalAt(closes, hist, i - 1);
      if (sig) {
        const entryRaw = cur.open;
        // ATR-based micro levels (same as the live Micro Growth strategy) or fixed %.
        const atrValue = useAtr && S && S.atr ? S.atr[i - 1] : 0;
        const slDist = atrValue > 0 ? atrValue * slAtr : (entryRaw * stopLossPercent) / 100;
        const riskUsd = (balance * riskPerTrade) / 100;
        const sizeUsd = slDist > 0 ? riskUsd / (slDist / entryRaw) : 0;
        if (sizeUsd >= minSizeUsd && sizeUsd <= balance * maxLeverage) {
          const entry = applyCost(entryRaw, sig === 'long' ? 1 : -1);
          const tpMultiple = Array.isArray(tpR) ? (Number(tpR[0]) || 3) : (Number(tpR) || 3);
          const tpDist = atrValue > 0 ? slDist * tpMultiple : (entry * takeProfitPercent) / 100;
          position = {
            dir: sig,
            entry,
            sizeUsd: Math.min(sizeUsd, balance * maxLeverage),
            sl: sig === 'long' ? entry - slDist : entry + slDist,
            tp: sig === 'long' ? entry + tpDist : entry - tpDist,
            startIndex: i, bars: 0,
            slPct: entryRaw ? (slDist / entryRaw) * 100 : stopLossPercent,
            specId: spec ? spec.id : null,
          };
        }
      }
    }
    // ── الأسهم اللحظية (mark-to-market): الرصيد + الربح غير المحقق (D)
    // (كانت تُدفع عند الإغلاق فقط فيُخفى السحب داخل الصفقة)
    let eq = balance;
    if (position) {
      const upnlPct = position.dir === 'long'
        ? ((cur.close - position.entry) / position.entry) * 100
        : ((position.entry - cur.close) / position.entry) * 100;
      eq = balance + (position.sizeUsd * upnlPct) / 100;
    }
    equityByBar.push(eq);
  }

  // إغلاق أي صفقة معلقة بسعر السوق (مع التكلفة)
  if (position) {
    const lastRaw = closes[closes.length - 1];
    const last = applyCost(lastRaw, position.dir === 'long' ? -1 : 1);
    const grossPct = position.dir === 'long'
      ? ((last - position.entry) / position.entry) * 100
      : ((position.entry - last) / position.entry) * 100;
    balance += (position.sizeUsd * grossPct) / 100;
    trades.push({ ...position, exit: last, exitReason: 'END', pnlPct: grossPct, endIndex: candles.length - 1, oos: true });
    equityByBar.push(balance); // نقطة الإغلاق النهائية (تُبقي الطول = عدد الشموع)
  }

  const stats = buildStats(trades, equityByBar, initialBalance, candles, { oosTrades, oosWins });
  if (spec) {
    stats.strategy_id = spec.id;
    stats.strategy_name = spec.name;
    stats.strategy_family = spec.family;
  }
  if (returnTrades) stats.trades = trades;
  return stats;
}

/**
 * Walk-forward (منهجية backtesting-frameworks):
 * نوافذ متوسعة للتدريب + نافذة اختبار ثابتة، تُجمع صفقات الاختبار فقط (OOS صرف)
 * وتُعاد مركبة الرصيد عليها — ثم مونت كارلو على تسلسلها.
 */
export function walkForward({ candles, spec, windows = 4, minTestTrades = 1, ...risk }) {
  if (!candles || candles.length < 300) {
    throw new Error('walk-forward يحتاج 300+ شمعة');
  }
  const n = candles.length;
  const segLen = Math.max(60, Math.floor(n / (windows + 1)));
  const winStats = [];
  const oosTrades = [];
  for (let w = 0; w < windows; w++) {
    const trainEnd = Math.min(n - segLen, segLen * (w + 1));
    const testEnd = Math.min(n, trainEnd + segLen);
    if (testEnd - trainEnd < 60) break;
    const run = runBacktest({
      candles: candles.slice(0, testEnd), ...risk, strategySpec: spec, returnTrades: true,
    });
    const oos = (run.trades || []).filter((t) => t.startIndex >= trainEnd && t.endIndex < testEnd);
    winStats.push({
      window: w + 1,
      from: candles[trainEnd]?.openTime ?? null,
      to: candles[testEnd - 1]?.openTime ?? null,
      trades: oos.length,
      win_rate: oos.length ? +((oos.filter((t) => t.pnlPct > 0).length / oos.length) * 100).toFixed(1) : null,
      return_pct: +oos.reduce((s, t) => s + (t.pnlUsd || 0), 0).toFixed(2),
    });
    oosTrades.push(...oos);
  }
  // إعادة تركيب الرصيد على صفقات OOS بالترتيب الزمني (مخاطرة ثابتة %)
  const initialBalance = Number(risk.initialBalance) || 10000;
  const riskPct = Number(risk.riskPerTrade) || 2;
  const maxLeverage = Number(risk.maxLeverage) || 5;
  const minSizeUsd = Number(risk.minSizeUsd) || 0;
  let balance = initialBalance;
  const equity = [balance];
  let peak = balance, maxDD = 0;
  const byTime = [...oosTrades].sort((a, b) => a.endIndex - b.endIndex);
  for (const t of byTime) {
    const slPct = t.slPct > 0 ? t.slPct : 2;
    const sizeUsd = Math.min(((balance * riskPct) / 100) / (slPct / 100), balance * maxLeverage);
    // نفس حد Binance الأدنى: الصفقات التي لا يمكن أخذها بهذا الرصيد لا تُحتسب
    if (sizeUsd < minSizeUsd) continue;
    balance += (sizeUsd * t.pnlPct) / 100;
    equity.push(balance);
    if (balance > peak) peak = balance;
    maxDD = Math.max(maxDD, ((peak - balance) / peak) * 100);
  }
  const mc = monteCarlo(byTime, { sims: 500, riskPct, initialBalance, maxLeverage, minSizeUsd });
  const wins = byTime.filter((t) => t.pnlPct > 0).length;
  return {
    strategy_id: spec?.id || (typeof spec === 'string' ? spec : null),
    windows: winStats,
    oos_trades: byTime.length,
    oos_win_rate: byTime.length ? +((wins / byTime.length) * 100).toFixed(1) : null,
    oos_return_percent: +(((balance - initialBalance) / initialBalance) * 100).toFixed(2),
    oos_final_balance: +balance.toFixed(2),
    oos_max_drawdown: +maxDD.toFixed(1),
    stable_windows: winStats.filter((w) => (w.win_rate ?? 0) >= 40).length,
    monte_carlo: mc,
    meets_min: byTime.length >= minTestTrades,
  };
}

/** مونت كارلو: إعادة خلط تسلسل الصفقات (bootstrap) لتوزيع العائد والسحب */
export function monteCarlo(trades, { sims = 500, riskPct = 2, initialBalance = 10000, maxLeverage = 5, minSizeUsd = 0, seed = 42 } = {}) {
  if (!trades || !trades.length) {
    return { sims: 0, median_return: 0, p5_return: 0, p95_return: 0, prob_profit: 0, median_max_dd: 0 };
  }
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const rets = [];
  const dds = [];
  let profitable = 0;
  for (let k = 0; k < sims; k++) {
    let bal = initialBalance, pk = initialBalance, dd = 0;
    for (let j = 0; j < trades.length; j++) {
      const t = trades[Math.floor(rnd() * trades.length)];
      const slPct = t.slPct > 0 ? t.slPct : 2;
      const size = Math.min(((bal * riskPct) / 100) / (slPct / 100), bal * maxLeverage);
      if (size < minSizeUsd) continue;
      bal += (size * t.pnlPct) / 100;
      if (bal > pk) pk = bal;
      dd = Math.max(dd, ((pk - bal) / pk) * 100);
    }
    const r = ((bal - initialBalance) / initialBalance) * 100;
    rets.push(r);
    dds.push(dd);
    if (r > 0) profitable++;
  }
  rets.sort((a, b) => a - b);
  dds.sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
  return {
    sims,
    median_return: +q(rets, 0.5).toFixed(2),
    p5_return: +q(rets, 0.05).toFixed(2),
    p95_return: +q(rets, 0.95).toFixed(2),
    prob_profit: +((profitable / sims) * 100).toFixed(1),
    median_max_dd: +q(dds, 0.5).toFixed(1),
  };
}

function emaSeriesLocal(values, period) {
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

function buildStats(trades, equityByBar, initialBalance, candles, oos) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnlPct > 0);
  const losses = trades.filter((t) => t.pnlPct <= 0);
  const winRate = n ? (wins.length / n) * 100 : 0;
  const finalBalance = equityByBar.length ? equityByBar[equityByBar.length - 1] : initialBalance;
  const totalReturnPct = ((finalBalance - initialBalance) / initialBalance) * 100;

  // أقصى سحب من منحنى الرصيد
  let peak = initialBalance, maxDD = 0;
  for (const eq of equityByBar) {
    if (eq > peak) peak = eq;
    maxDD = Math.max(maxDD, ((peak - eq) / peak) * 100);
  }

  const grossWin = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUsd, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;

  // منحنى شهري + عوائد شهرية (C):
  // - إن توفرت openTime للشموع وتمتد لشهرين+ → تجميع تقويمي حقيقي.
  // - وإلا (بيانات صناعية بلا زمن) → 12 فترة رقمية موسومة بصراحة.
  const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  const equityCurve = [];
  const monthlyReturns = [];
  const barTime = (k) => candles[Math.min(k + 1, candles.length - 1)]?.openTime;
  const timedIdx = equityByBar.map((_, k) => k).filter((k) => isFinite(barTime(k)));
  const monthKeys = [...new Set(timedIdx.map((k) => {
    const d = new Date(barTime(k));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }))];
  if (monthKeys.length >= 2) {
    let prevEnd = initialBalance;
    for (const mk of monthKeys) {
      const inMonth = timedIdx.filter((k) => {
        const d = new Date(barTime(k));
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` === mk;
      });
      const val = equityByBar[inMonth[inMonth.length - 1]];
      const label = `${AR_MONTHS[Number(mk.slice(5)) - 1]} ${mk.slice(0, 4)}`;
      equityCurve.push({ month: label, value: +val.toFixed(2) });
      monthlyReturns.push({ month: label, return_pct: prevEnd ? +(((val - prevEnd) / prevEnd) * 100).toFixed(2) : 0 });
      prevEnd = val;
    }
  } else {
    for (let m = 0; m < 12; m++) {
      const idx = Math.min(equityByBar.length - 1, Math.floor(((m + 1) / 12) * equityByBar.length));
      const val = equityByBar.length ? equityByBar[Math.max(0, idx)] : initialBalance;
      const prevIdx = Math.min(equityByBar.length - 1, Math.floor((m / 12) * equityByBar.length));
      const prev = equityByBar.length ? equityByBar[Math.max(0, prevIdx)] : initialBalance;
      const label = `فترة ${m + 1}`; // ليست شهراً تقويمياً — تسمية صريحة
      equityCurve.push({ month: label, value: +val.toFixed(2) });
      monthlyReturns.push({ month: label, return_pct: prev ? +(((val - prev) / prev) * 100).toFixed(2) : 0 });
    }
  }

  // Sharpe سنوي على العوائد الشهرية (كان مضروباً في sqrt(عدد الصفقات) — مضلل)
  const mrets = monthlyReturns.map((m) => m.return_pct);
  const mmean = mrets.length ? mrets.reduce((s, x) => s + x, 0) / mrets.length : 0;
  const msd = mrets.length > 1
    ? Math.sqrt(mrets.reduce((s, x) => s + (x - mmean) ** 2, 0) / (mrets.length - 1))
    : 0;
  const sharpe = msd > 0 ? (mmean / msd) * Math.sqrt(12) : 0;

  const best = n ? Math.max(...trades.map((t) => t.pnlPct)) : 0;
  const worst = n ? Math.min(...trades.map((t) => t.pnlPct)) : 0;

  return {
    total_return_percent: +totalReturnPct.toFixed(2),
    total_return_usd: +(finalBalance - initialBalance).toFixed(2),
    final_balance: +finalBalance.toFixed(2),
    win_rate: +winRate.toFixed(1),
    total_trades: n,
    winning_trades: wins.length,
    losing_trades: losses.length,
    sharpe_ratio: +sharpe.toFixed(2),
    max_drawdown: +maxDD.toFixed(1),
    profit_factor: +profitFactor.toFixed(2),
    avg_win: +avgWin.toFixed(2),
    avg_loss: +avgLoss.toFixed(2),
    avg_win_percent: +avgWin.toFixed(2),
    avg_loss_percent: +avgLoss.toFixed(2),
    best_trade: +best.toFixed(2),
    worst_trade: +worst.toFixed(2),
    best_month: monthlyReturns.reduce((a, b) => (b.return_pct > a.return_pct ? b : a), monthlyReturns[0]).month,
    worst_month: monthlyReturns.reduce((a, b) => (b.return_pct < a.return_pct ? b : a), monthlyReturns[0]).month,
    equity_curve: equityCurve,
    monthly_returns: monthlyReturns,
    oos_win_rate: oos.oosTrades ? +((oos.oosWins / oos.oosTrades) * 100).toFixed(1) : null,
    oos_trades: oos.oosTrades,
  };
}

/** استخلاص الدروس والتوصيات من الإحصائيات — تغذي ai_lessons في الواجهة */
export function deriveLessons(stats, config = {}) {
  const s = stats;
  const lessons = [];
  if (s.total_trades < 10) lessons.push('عدد الصفقات قليل — النتائج غير ذات دلالة إحصائية، اختبر فترة أطول.');
  if (s.win_rate >= 55 && s.profit_factor >= 1.5) lessons.push('الاستراتيجية متوازنة: نسبة نجاح ومعامل ربح صحيان — مناسبة للتداول الحقيقي بحجم محسوب.');
  else if (s.win_rate < 40) lessons.push('نسبة النجاح منخفضة — ارفع حد الثقة للدخول واقتصر على إشارات التوافق العالي.');
  if (s.max_drawdown > 20) lessons.push(`السحب ${s.max_drawdown}% مرتفع — خفّض المخاطرة لكل صفقة إلى النصف.`);
  if (s.profit_factor < 1.2) lessons.push('معامل الربح ضعيف — وسّع الهدف أو ضيّق الوقف لتحسين نسبة العائد/المخاطرة.');
  if (s.avg_loss !== 0 && Math.abs(s.avg_win / s.avg_loss) < 1.5) lessons.push('متوسط الربح قريب من متوسط الخسارة — استهدف نسبة TP/SL أعلى من 2.');
  if (s.oos_win_rate !== null && s.oos_win_rate < s.win_rate - 10) lessons.push('الأداء خارج العينة أضعف — احتمال overfitting، تجنب تحسين المعاملات على نفس البيانات.');
  if (!lessons.length) lessons.push('أداء مستقر عبر المقاييس — حافظ على نفس المعاملات وراقب السحب.');

  const risk = s.max_drawdown > 20 ? 1 : s.max_drawdown > 10 ? 1.5 : (config.riskPerTrade || 2);
  const sl = s.max_drawdown > 20 ? Math.max(1, (config.stopLossPercent || 2) * 0.75) : (config.stopLossPercent || 2);
  const tpRatio = s.profit_factor >= 1.5 ? 2.5 : 2;
  return {
    ai_lessons: lessons.join(' '),
    best_conditions: 'اتجاه واضح (السعر فوق/تحت EMA50) + RSI بين 40-60 + تأكيد MACD + حجم أعلى من المتوسط.',
    avoid_conditions: 'النطاقات العرضية الضيقة، الأخبار عالية التأثير، التقلب الشديد (ATR% > 3)، السيولة الضعيفة.',
    market_regime: s.win_rate >= 50 ? 'trend-following فعال' : 'متذبذب — فضّل الانتظار',
    optimal_risk: +risk.toFixed(2),
    optimal_stop_loss: +sl.toFixed(2),
    optimal_take_profit: +(sl * tpRatio).toFixed(2),
    optimal_tp_sl_ratio: tpRatio,
    confidence_to_enter: s.win_rate >= 55 ? 60 : 70,
    recommended_timeframe: '4H',
    parameter_reasoning: `بُنيت المعاملات على ${s.total_trades} صفقة: عائد ${s.total_return_percent}% ونجاح ${s.win_rate}% وسحب ${s.max_drawdown}%. المخاطرة عُدّلت عكسياً مع السحب، ونسبة TP/SL ${tpRatio} للحفاظ على معامل ربح فوق 1.5.`,
    score: Math.max(0, Math.min(100, Math.round(s.win_rate * 0.5 + Math.min(30, Math.max(0, s.profit_factor * 10)) + Math.max(0, 20 - s.max_drawdown)))),
  };
}
