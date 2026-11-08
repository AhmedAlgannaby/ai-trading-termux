/**
 * worker/adaptive — تعديل الوقف/الهدف حسب الرؤية التحليلية (Phase 4).
 *
 * مبدأ صارم: التعديل يُقلّل المخاطرة أو يُثبّت الربح فقط —
 * لا توسيع للوقف أبداً، ولا زيادة للمخاطرة بعد الدخول.
 *
 * القواعد (تُطبق بالترتيب، كل نقلة تُسجَّل بسببها):
 * 1) انعكاس النظام ضد الصفقة → تصفير نصف المخاطرة المتبقية
 * 2) إجهاد الزخم (RSI متطرف مع الاتجاه) → تقريب الهدف (جني أسرع)
 * 3) انفجار التقلب (ATR% > 3) → وقف أضيق بحد 2×ATR من السعر
 *
 * السوق (نظام 4h + RSI + ATR) يُجلَب مرة كل 15 دقيقة لكل زوج (cache).
 */
import { klines } from '../binance.js';
import { marketRegime, rsi, atr } from '../brain/indicators.js';

const CACHE_MS = 15 * 60 * 1000;
const _market = new Map(); // pair -> { at, regime, rsiV, atrPct, atrV, price }

function toCandles(raw) {
  return (raw || []).map((k) => ({ open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
}

export async function getMarket(pair) {
  const now = Date.now();
  const hit = _market.get(pair);
  if (hit && now - hit.at < CACHE_MS) return hit;
  const symbol = String(pair).replace('/', '');
  const raw = await klines(symbol, '4h', 80);
  const candles = toCandles(raw);
  if (candles.length < 30) throw new Error('no market snapshot');
  const closes = candles.map((c) => c.close);
  const regime = marketRegime(candles);
  const rsiV = rsi(closes);
  const price = closes[closes.length - 1];
  const atrV = atr(candles);
  const snap = { at: now, regime, rsiV, atrPct: regime.atrPct, atrV, price };
  _market.set(pair, snap);
  return snap;
}

export function clearMarketCache() {
  _market.clear();
}

/**
 * @returns { sl, tp, reasons[] } — القيم الجديدة (أو الحالية إن لا تعديل)
 */
export function adjustTrade(trade, price, market) {
  const reasons = [];
  let sl = Number(trade.stop_loss);
  let tp = Number(trade.take_profit_1);
  if (!isFinite(sl) || !isFinite(tp) || !isFinite(price)) return { sl, tp, reasons };
  const isLong = trade.type === 'long';
  const entry = Number(trade.entry_price);
  const { regime, rsiV, atrPct } = market;

  // 1) انعكاس النظام ضد الصفقة → خفّض المخاطرة للنصف
  // E: النقلة لا تتجاوز السعر أبداً (كانت قد تُسجَّل فوق السوق فيُغلق وهمياً)
  const against = (isLong && regime.trend === 'down') || (!isLong && regime.trend === 'up');
  if (against && regime.regime === 'trending') {
    const raw = isLong ? Math.max(sl, entry - Math.abs(entry - sl) / 2) : Math.min(sl, entry + Math.abs(sl - entry) / 2);
    const newSl = isLong ? Math.min(raw, price) : Math.max(raw, price);
    if ((isLong && newSl > sl) || (!isLong && newSl < sl)) {
      sl = newSl;
      reasons.push(`انعكاس النظام (${regime.trend === 'down' ? 'هابط' : 'صاعد'}) — خُفضت المخاطرة للنصف`);
    }
  }

  // 2) إجهاد الزخم → قرّب الهدف (لا تطارد القمة)
  // E: المخاطرة من الوقف الحالي — بعد التعادل تصبح صفراً فينهار الهدف للدخول.
  // يُشترط مخاطرة موجبة فوق الغبار وإلا لا يُلمس الهدف.
  const exhausted = (isLong && rsiV > 75) || (!isLong && rsiV < 25);
  if (exhausted) {
    const risk = Math.abs(entry - sl);
    const dust = Math.abs(entry) * 1e-6;
    if (risk > dust) {
      const nearer = isLong ? entry + risk * 1.5 : entry - risk * 1.5;
      const better = isLong ? Math.min(tp, nearer) : Math.max(tp, nearer);
      if ((isLong && better < tp) || (!isLong && better > tp)) {
        tp = better;
        reasons.push(`إجهاد زخم (RSI ${rsiV.toFixed(0)}) — قُرّب الهدف لجني أسرع`);
      }
    }
  }

  // 3) انفجار التقلب → وقف بحد 2×ATR من السعر الحالي (تضييق فقط)
  // E: السقف لا يتجاوز السعر أبداً (كان قد يُسجَّل فوق السوق فيُغلق وهمياً)
  if (atrPct > 3 && isFinite(market.atrV) && market.atrV > 0) {
    const atrV = market.atrV;
    const cap = isLong ? price - 2 * atrV : price + 2 * atrV;
    const tightened = isLong ? Math.min(cap, price) : Math.max(cap, price);
    if ((isLong && tightened > sl) || (!isLong && tightened < sl)) {
      sl = tightened;
      reasons.push(`تقلب متفجر (ATR ${atrPct.toFixed(1)}%) — ضُيّق الوقف لحد 2×ATR`);
    }
  }

  return { sl, tp, reasons };
}
