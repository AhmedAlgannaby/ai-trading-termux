/**
 * worker/monitor — مراقب الصفقات المفتوحة في السيرفر (يعمل بلا متصفح).
 *
 * كل دورة:
 *   1) يجلب أسعار جميع الصفقات المفتوحة (paper دائماً + live إن فُعّل العلم)
 *   2) يحدّث PnL الحالي
 *   3) ينقل الوقف للتعادل بعد +1R (إن فُعّل التتبع) ويطبّق الوقف المتحرك
 *   4) يغلق عند SL / TP1 / انتهاء المهلة، ويسجّل AlertLog لكل حدث
 *
 * البيئة:
 *   WORKER_MONITOR_SECONDS=30   كل كم ثانية يعمل (10..600)
 *   WORKER_LIVE_CLOSE=false     إغلاق صفقات live بأوامر حقيقية (افتراضياً معطّل)
 *   WORKER_MAX_HOLD_HOURS=0     إغلاق بعد N ساعة (0 = معطّل)
 */
import { db, getUser } from '../db.js';
import { ticker as binTicker, placeOrder } from '../binance.js';
import { getMarket, adjustTrade } from './adaptive.js';

const EVERY_SEC = Math.min(Math.max(Number(process.env.WORKER_MONITOR_SECONDS || 30), 10), 600);
const LIVE_CLOSE = process.env.WORKER_LIVE_CLOSE === 'true';
const MAX_HOLD_HOURS = Math.max(Number(process.env.WORKER_MAX_HOLD_HOURS || 0), 0);

export const monitorStats = { everySec: EVERY_SEC, lastRun: null, lastDurationMs: 0, checked: 0, updated: 0, closed: 0, errors: 0 };
let running = false;

export function calcPnL(trade, price) {
  if (!price || !trade.entry_price || !trade.position_size) return { pnl: 0, pnlPercent: 0 };
  const leverage = trade.leverage || 1;
  const qty = trade.position_size / trade.entry_price;
  const pnl = trade.type === 'long'
    ? (price - trade.entry_price) * qty * leverage
    : (trade.entry_price - price) * qty * leverage;
  const pnlPercent = trade.position_size ? (pnl / trade.position_size) * 100 : 0;
  return { pnl: Math.round(pnl * 100) / 100, pnlPercent: Math.round(pnlPercent * 100) / 100 };
}

async function alert({ pair, type, message, severity = 'info', price }) {
  try {
    await db.create('AlertLog', {
      alert_name: type === 'trade_closed' ? 'إغلاق تلقائي' : 'تعديل وقف تلقائي',
      pair,
      alert_type: type,
      message: String(message).slice(0, 500),
      severity,
      triggered_price: price,
      telegram_sent: false,
    });
  } catch (e) {
    console.error('monitor alert failed:', e.message);
  }
}

function riskDist(trade) {
  if (!trade.entry_price || !trade.stop_loss) return 0;
  return Math.abs(trade.entry_price - trade.stop_loss);
}

/** ينقل الوقف للتعادل بعد +1R ثم يلاحقه (trailing) — يعيد true إن عدّل الوقف */
function applyTrailing(trade, price, settings) {
  if (!settings?.trailing_stop_enabled) return false;
  if (!trade.stop_loss || !trade.entry_price || !price) return false;
  const trailPct = (Number(settings.default_stop_loss_percent) || 2) / 100;
  const isLong = trade.type === 'long';
  let sl = Number(trade.stop_loss);
  let peak = Number(trade.trailing_peak) || trade.entry_price;
  let moved = false;

  // 1) التعادل بعد تحقيق +1R من الربح غير المحقق
  // E: يُنقل للدخول فقط إن كان تضييقاً (كان قد يعيد وقفاً متحركاً للخلف = توسيع)
  const dist = riskDist(trade);
  const oneR = dist > 0 ? (trade.position_size * dist) / trade.entry_price : 0;
  const { pnl } = calcPnL(trade, price);
  if (!trade.breakeven_moved && oneR > 0 && pnl >= oneR) {
    const tightens = isLong ? sl < trade.entry_price : sl > trade.entry_price;
    if (tightens) {
      sl = trade.entry_price;
      trade.breakeven_moved = true;
      moved = true;
    }
  }

  // 2) الوقف المتحرك خلف القمة (يضيّق فقط — لا يوسّع أبداً)
  peak = isLong ? Math.max(peak, price) : Math.min(peak, price);
  const candidate = isLong ? peak * (1 - trailPct) : peak * (1 + trailPct);
  if ((isLong && candidate > sl) || (!isLong && candidate < sl)) {
    sl = candidate;
    moved = true;
  }
  if (moved) {
    trade.stop_loss = sl;
    trade.trailing_peak = peak;
  }
  return moved;
}

async function closeLiveTrade(trade, user, reason) {
  const qty = trade.position_size / trade.entry_price;
  const side = trade.type === 'long' ? 'SELL' : 'BUY';
  const symbol = String(trade.pair).replace('/', '');
  try {
    const res = await placeOrder(user, { symbol, side, type: 'MARKET', quantity: Number(qty.toFixed(6)) });
    return { ok: true, orderId: res?.orderId };
  } catch (e) {
    await alert({ pair: trade.pair, type: 'live_close_failed', severity: 'error', price: trade.current_price, message: `فشل إغلاق live (${reason}): ${e.message}` });
    return { ok: false };
  }
}

export async function monitorTick() {
  if (running) return { skipped: true };
  running = true;
  const t0 = Date.now();
  const out = { checked: 0, updated: 0, closed: 0, errors: 0 };
  try {
    const settingsList = await db.list('RiskSettings', { sort: '-created_date', limit: 1 });
    const settings = settingsList[0] || {};
    const all = await db.list('Trade', { filter: { status: 'open' } });
    const trades = all.filter((t) => t.mode !== 'live' || LIVE_CLOSE);
    out.checked = trades.length;
    if (!trades.length) return out;

    const symbols = [...new Set(trades.map((t) => String(t.pair).replace('/', '')))];
    const tickers = await binTicker(symbols);
    const prices = {};
    for (const t of tickers || []) prices[t.symbol] = Number(t.lastPrice);

    const user = await getUser();
    for (const trade of trades) {
      try {
        const price = prices[String(trade.pair).replace('/', '')];
        if (!isFinite(price) || price <= 0) continue;
        const isLong = trade.type === 'long';

        // وقف متحرك / تعادل (قبل فحص الإغلاق حتى يحمي فوراً)
        let stopMoved = false;
        let adaptiveReasons = [];
        if (trade.mode !== 'live') {
          stopMoved = applyTrailing(trade, price, settings);
          // تعديل تكيفي حسب الرؤية التحليلية (Phase 4) — تضييق فقط، لا توسيع أبداً
          try {
            const mkt = await getMarket(trade.pair);
            const adj = adjustTrade(trade, price, mkt);
            if (adj.reasons.length && (adj.sl !== trade.stop_loss || adj.tp !== trade.take_profit_1)) {
              trade.stop_loss = adj.sl;
              trade.take_profit_1 = adj.tp;
              stopMoved = true;
              adaptiveReasons = adj.reasons;
            }
          } catch { /* لقطة السوق فشلت — نبقي المستويات */ }
        }

        // انتهاء المهلة
        let closeReason = '';
        let exitPrice = null;
        if (MAX_HOLD_HOURS > 0 && trade.created_date) {
          const ageH = (Date.now() - Date.parse(trade.created_date)) / 3600000;
          if (ageH >= MAX_HOLD_HOURS) { closeReason = 'انتهاء المهلة'; exitPrice = price; }
        }
        if (!exitPrice && trade.stop_loss) {
          const sl = Number(trade.stop_loss);
          // C8: الخروج بسعر السوق (أمر الوقف يُملأ بسعر السوق أو أسوأ — لا بسعر المستوى)
          if (isFinite(sl) && ((isLong && price <= sl) || (!isLong && price >= sl))) {
            closeReason = 'وقف الخسارة'; exitPrice = isLong ? Math.min(price, sl) : Math.max(price, sl);
          }
        }
        if (!exitPrice && trade.take_profit_1) {
          const tp = Number(trade.take_profit_1);
          if (isFinite(tp) && ((isLong && price >= tp) || (!isLong && price <= tp))) {
            closeReason = 'هدف الربح'; exitPrice = isLong ? Math.min(price, tp) : Math.max(price, tp);
          }
        }

        // مستشار الخروج التلقائي: للخاسرة فقط (توفيراً) وبثقة عالية.
        // تجريبي مفعّل افتراضياً؛ الحي يتطلب auto_exit_live + LIVE_CLOSE معاً.
        if (!exitPrice && isLong) {
          const autoExitOn = trade.mode === 'live'
            ? (settings.auto_exit_live === true && LIVE_CLOSE)
            : settings.auto_exit_enabled !== false;
          if (autoExitOn) {
            try {
              const { pnlPercent } = calcPnL(trade, price);
              if (pnlPercent < 0) {
                const { analyze } = await import('../brain/signals.js');
                const { getCandles } = await import('../brain/market.js');
                const { adviseExit } = await import('../brain/exitAdvice.js');
                const a = analyze(trade.pair, await getCandles(trade.pair, '4h', 300));
                const tpv = Number(trade.take_profit_1);
                const adv = adviseExit({
                  unrealizedPnlPct: pnlPercent,
                  tpDistancePct: isFinite(tpv) && tpv > 0 ? ((tpv - price) / price) * 100 : null,
                  positionType: 'long', freshDirection: a.direction, freshConfidence: a.confidence,
                });
                if (adv.verdict === 'close' && adv.confidence >= 75) {
                  closeReason = 'مستشار الخروج'; exitPrice = price;
                }
              }
            } catch { /* بلا تحليل طازج — تبقى مفتوحة */ }
          }
        }

        if (exitPrice) {
          const final = calcPnL(trade, exitPrice);
          if (trade.mode === 'live' && LIVE_CLOSE) {
            const r = await closeLiveTrade(trade, user, closeReason);
            if (!r.ok) continue; // نبقيها مفتوحة ونحاول الدورة القادمة
          }
          await db.update('Trade', trade.id, {
            status: 'closed', current_price: price, exit_price: exitPrice,
            pnl: final.pnl, pnl_percent: final.pnlPercent,
            exit_reason: closeReason, closed_at: new Date().toISOString(),
            ...(stopMoved ? { stop_loss: trade.stop_loss, trailing_peak: trade.trailing_peak, breakeven_moved: !!trade.breakeven_moved } : {}),
          });
          out.closed++;
          await alert({
            pair: trade.pair, type: 'trade_closed', price: exitPrice,
            severity: final.pnl >= 0 ? 'info' : 'warning',
            message: `أُغلقت صفقة ${isLong ? 'شراء' : 'بيع'} ${trade.pair} (${closeReason}) — PnL: $${final.pnl} (${final.pnlPercent}%)`,
          });
        } else {
          const { pnl, pnlPercent } = calcPnL(trade, price);
          const patch = { current_price: price, pnl, pnl_percent: pnlPercent };
          if (stopMoved) {
            patch.stop_loss = trade.stop_loss;
            patch.take_profit_1 = trade.take_profit_1;
            patch.trailing_peak = trade.trailing_peak;
            patch.breakeven_moved = !!trade.breakeven_moved;
            const why = adaptiveReasons.length
              ? adaptiveReasons.join('؛ ')
              : (trade.breakeven_moved && trade.stop_loss === trade.entry_price ? 'تعادل' : 'تتبع');
            await alert({
              pair: trade.pair, type: 'stop_adjusted', price,
              message: `نُقل وقف ${trade.pair} إلى ${Number(trade.stop_loss).toFixed(4)} (${why})`,
            });
          }
          await db.update('Trade', trade.id, patch);
          out.updated++;
        }
      } catch (e) {
        out.errors++;
        console.error('monitor trade error:', e.message);
      }
    }
    return out;
  } finally {
    running = false;
    monitorStats.lastRun = new Date().toISOString();
    monitorStats.lastDurationMs = Date.now() - t0;
    monitorStats.checked = out.checked;
    monitorStats.updated = out.updated;
    monitorStats.closed = out.closed;
    monitorStats.errors = out.errors;
  }
}

export function monitorConfig() {
  return { everySec: EVERY_SEC, liveClose: LIVE_CLOSE, maxHoldHours: MAX_HOLD_HOURS };
}
