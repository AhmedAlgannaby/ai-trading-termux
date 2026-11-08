/**
 * worker/learner — تسجيل الدروس من الصفقات المغلقة في السيرفر.
 * (نقل لمنطق tradeLearning.js من المتصفح — يعمل بلا متصفح مفتوح)
 *
 * كل دورة: الصفقات المغلقة (paper) التي بلا TradeLesson ← سجل درساً بنفس الشكل:
 * { trade_id, pair, direction, outcome, pnl, pnl_percent, factors, exit_reason, lesson }
 * التدريب الإحصائي/النموذجي العميق (Phase 4) يقرأ من TradeLesson.
 */
import { db } from '../db.js';
import { klines } from '../binance.js';
import { marketRegime, rsi } from '../brain/indicators.js';

export const learnerStats = { everySec: 300, lastRun: null, lastDurationMs: 0, recorded: 0, errors: 0 };
let running = false;

function extractFactors(trade) {
  const reason = String(trade.entry_reason || '').replace('[تلقائي]', '');
  const factors = reason.split('—').map((s) => s.trim()).filter((s) => s && !s.startsWith('تعلّم:'))
    .map((f) => f.replace(/\d+/g, '').trim());
  return [...new Set(factors)];
}

export async function learnerTick() {
  if (running) return { skipped: true };
  running = true;
  const t0 = Date.now();
  try {
    const [closed, lessons] = await Promise.all([
      db.list('Trade', { sort: '-created_date', limit: 50, filter: { status: 'closed' } }),
      db.list('TradeLesson', { sort: '-created_date', limit: 200 }),
    ]);
    const paperClosed = closed.filter((t) => (t.mode || 'paper') === 'paper');
    const known = new Set(lessons.map((l) => l.trade_id));
    const fresh = paperClosed.filter((t) => !known.has(t.id));
    if (!fresh.length) {
      learnerStats.recorded = 0;
      return { recorded: 0 };
    }
    const records = fresh.map((t) => {
      const win = (t.pnl || 0) > 0;
      const factors = extractFactors(t);
      return {
        trade_id: t.id,
        pair: t.pair,
        direction: t.type,
        outcome: win ? 'win' : 'loss',
        pnl: t.pnl || 0,
        pnl_percent: t.pnl_percent || 0,
        factors,
        exit_reason: t.exit_reason || '',
        lesson: win
          ? `نجحت صفقة ${t.type === 'long' ? 'شراء' : 'بيع'} ${t.pair}`
          : `خسرت صفقة ${t.type === 'long' ? 'شراء' : 'بيع'} ${t.pair} (${t.exit_reason || '—'}) — عوامل الدخول: ${factors.join('، ') || '—'}`,
      };
    });
    await db.bulkCreate('TradeLesson', records, 'worker/learner');
    learnerStats.recorded = records.length;
    // تشريح لاحق لكل صفقة جديدة (Phase 4) — لا يفشل الدورة إن تعثر
    let reviewed = 0;
    try {
      const knownReviews = new Set(
        (await db.list('TradeReview', { sort: '-created_date', limit: 300 })).map((r) => r.trade_id),
      );
      for (const t of fresh) {
        if (knownReviews.has(t.id)) continue;
        try {
          const review = await postMortem(t);
          await db.create('TradeReview', review, 'worker/learner');
          reviewed++;
        } catch (e) {
          console.error('postMortem:', t.id, e.message);
        }
      }
    } catch (e) {
      console.error('reviews batch:', e.message);
    }
    return { recorded: records.length, reviewed };
  } catch (e) {
    learnerStats.errors++;
    console.error('learner error:', e.message);
    return { error: e.message };
  } finally {
    running = false;
    learnerStats.lastRun = new Date().toISOString();
    learnerStats.lastDurationMs = Date.now() - t0;
  }
}

/**
 * تشريح ما بعد الصفقة: يعيد بناء الماضي كما كان وقت الدخول
 * (شموع تنتهي عند الدخول) + مسار السعر حتى الخروج لحساب MFE/MAE.
 * لا يخمّن أبداً — ما تعذّر قياسه يُسجَّل null والسبب unknown_*.
 */
const CAUSE_AR = {
  take_profit: 'جني الربح',
  left_money: 'ربح لكن متروك على الطاولة (خروج مبكر)',
  no_momentum: 'دخول بلا زخم — توقف سريع',
  chopped_range: 'تقطيع في نطاق عرضي',
  chased_extreme: 'مطاردة قمة/قاع متطرف',
  high_vol_stop: 'وقف ضيق في تقلب متفجر',
  against_trend: 'ضد اتجاه الفريم الأكبر',
  timeout_exit: 'انتهاء المهلة',
  manual_exit: 'إغلاق يدوي',
  unknown_loss: 'سبب غير محدد (بيانات ناقصة)',
};

function toBrain(raw) {
  return (raw || []).map((k) => ({ open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
}

export async function postMortem(t) {
  const isLong = t.type === 'long';
  const entry = Number(t.entry_price);
  const sl = Number(t.stop_loss);
  const tp1 = Number(t.take_profit_1);
  const entryMs = Date.parse(t.created_date || 0);
  const exitMs = t.closed_at ? Date.parse(t.closed_at) : Date.now();
  const holdH = isFinite(entryMs) && isFinite(exitMs) ? Math.max(0, (exitMs - entryMs) / 3600000) : null;
  const slPct = entry && sl ? (Math.abs(entry - sl) / entry) * 100 : 0;
  const tpPct = entry && tp1 ? (Math.abs(tp1 - entry) / entry) * 100 : 0;

  // 1) لقطة الدخول: شموع 1h تنتهي عند الدخول (كما كان السوق فعلاً)
  let entryRsi = null, entryRegime = null, entryAtrPct = null, dailyTrend = null;
  try {
    const symbol = String(t.pair).replace('/', '');
    if (isFinite(entryMs)) {
      const pre = toBrain(await klines(symbol, '1h', 80, { endTime: entryMs }));
      if (pre.length >= 30) {
        const closes = pre.map((c) => c.close);
        entryRsi = rsi(closes);
        const rg = marketRegime(pre);
        entryRegime = rg.regime;
        entryAtrPct = rg.atrPct;
      }
      const daily = toBrain(await klines(symbol, '1d', 60, { endTime: entryMs }));
      if (daily.length >= 55) dailyTrend = marketRegime(daily).trend;
    }
  } catch { /* تبقى null — بصراحة */ }
  // احتياط: سمات ml المحفوظة وقت الدخول
  if (entryRsi === null && Array.isArray(t.ml_features) && t.ml_features.length >= 6) {
    entryRsi = t.ml_features[1] * 50 + 50;
    entryAtrPct = t.ml_features[5] * 5;
  }

  // 2) مسار السعر: أعلى/أدنى انحراف لصالح/ضد الصفقة (MFE/MAE)
  // ملاحظة: نجلب بـ endTime فقط ثم نصفّي محلياً (startTime+S قد تُعيد [] في بعض البيئات)
  let mfePct = null, maePct = null, truncated = false;
  try {
    if (isFinite(entryMs) && isFinite(exitMs)) {
      const symbol = String(t.pair).replace('/', '');
      const raw = await klines(symbol, '1h', 1000, { endTime: exitMs + 3600000 });
      truncated = raw.length >= 1000;
      const range = toBrain(raw).map((c, idx) => ({ ...c, t: raw[idx][0] })).filter((c) => c.t >= entryMs);
      if (range.length) {
        if (isLong) {
          mfePct = ((Math.max(...range.map((c) => c.high)) - entry) / entry) * 100;
          maePct = ((entry - Math.min(...range.map((c) => c.low))) / entry) * 100;
        } else {
          mfePct = ((entry - Math.min(...range.map((c) => c.low))) / entry) * 100;
          maePct = ((Math.max(...range.map((c) => c.high)) - entry) / entry) * 100;
        }
      }
    }
  } catch { /* تبقى null */ }

  // 3) التصنيف الحتمي المرتب
  const win = (t.pnl || 0) > 0;
  const reason = String(t.exit_reason || '');
  const mfeR = mfePct !== null && slPct > 0 ? mfePct / slPct : null;
  let cause = 'unknown_loss';
  if (/هدف الربح|take_profit/i.test(reason)) {
    cause = win && mfeR !== null && tpPct > 0 && mfePct > tpPct * 2 ? 'left_money' : 'take_profit';
  } else if (/انتهاء المهلة|TIME|timeout/i.test(reason)) {
    cause = 'timeout_exit';
  } else if (/يدوي|manual/i.test(reason)) {
    cause = 'manual_exit';
  } else if (!win) {
    if (holdH !== null && holdH < 6 && (mfeR === null || mfeR < 0.5)) cause = 'no_momentum';
    else if (entryRegime === 'ranging') cause = 'chopped_range';
    else if ((isLong && entryRsi !== null && entryRsi > 70) || (!isLong && entryRsi !== null && entryRsi < 30)) cause = 'chased_extreme';
    else if (entryAtrPct !== null && entryAtrPct > 3) cause = 'high_vol_stop';
    else if ((isLong && dailyTrend === 'down') || (!isLong && dailyTrend === 'up')) cause = 'against_trend';
  }

  const lesson = win
    ? (cause === 'left_money'
      ? `ربحت ${t.pair} لكن تركت ${(mfePct - tpPct).toFixed(2)}% على الطاولة (MFE ${mfePct?.toFixed(2)}% مقابل هدف ${tpPct.toFixed(2)}%) — راجع توسيع الهدف في الزخم`
      : `ربحت ${t.pair} (${reason || '—'}) — كرر نفس البصمة`)
    : `خسرت ${t.pair}: ${CAUSE_AR[cause]} — دخول RSI ${entryRsi !== null ? entryRsi.toFixed(0) : '؟'} نظام ${entryRegime || '؟'} ATR ${entryAtrPct !== null ? entryAtrPct.toFixed(1) + '%' : '؟'} مدة ${holdH !== null ? holdH.toFixed(1) + 'h' : '؟'}`;

  return {
    trade_id: t.id,
    pair: t.pair,
    direction: t.type,
    outcome: win ? 'win' : 'loss',
    cause,
    cause_ar: CAUSE_AR[cause] || cause,
    mfe_pct: mfePct !== null ? +mfePct.toFixed(2) : null,
    mae_pct: maePct !== null ? +maePct.toFixed(2) : null,
    mfe_r: mfeR !== null ? +mfeR.toFixed(2) : null,
    hold_hours: holdH !== null ? +holdH.toFixed(1) : null,
    entry_rsi: entryRsi !== null ? +entryRsi.toFixed(1) : null,
    entry_regime: entryRegime,
    entry_atr_pct: entryAtrPct !== null ? +entryAtrPct.toFixed(2) : null,
    confidence: t.confidence ?? null,
    strategy_id: t.strategy_id || null,
    truncated_path: truncated,
    lesson,
  };
}
