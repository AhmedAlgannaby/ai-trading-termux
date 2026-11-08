/**
 * جلب بيانات السوق الحية (Binance العامة — بلا مفاتيح) مع تخزين مؤقت قصير.
 */
import { ticker as binTicker, klines as binKlines } from '../binance.js';

const cache = new Map();
const TTL_MS = 30 * 1000;

function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const p = fn().then((v) => {
    cache.set(key, { at: Date.now(), value: v });
    return v;
  }).catch((e) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, { at: Date.now(), value: p });
  return p;
}

export function toPair(s) {
  return String(s || 'BTC/USDT').toUpperCase();
}

export function toSymbol(pair) {
  return toPair(pair).replace('/', '');
}

export async function getCandles(pair, interval = '4h', limit = 300) {
  const symbol = toSymbol(pair);
  const raw = await cached(`klines:${symbol}:${interval}:${limit}`, () =>
    binKlines(symbol, interval, limit));
  if (!Array.isArray(raw)) throw new Error('تعذر جلب الشموع من Binance');
  if (raw.length === 0) throw new Error('تعذر جلب الشموع من Binance (فارغة)');
  const now = Date.now();
  // Drop the forming/unclosed last kline (k[6] = closeTime) to avoid repaint.
  let rows = raw;
  const lastCloseTime = raw[raw.length - 1]?.[6];
  if (typeof lastCloseTime === 'number' && lastCloseTime > now) {
    rows = raw.slice(0, -1);
  }
  if (rows.length === 0) throw new Error('تعذر جلب شموع مغلقة من Binance');
  return rows.map((k) => ({
    openTime: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
  }));
}

export async function getTicker(pair) {
  const symbol = toSymbol(pair);
  try {
    const all = await cached('ticker24', () => binTicker());
    const row = (Array.isArray(all) ? all : []).find((t) => t.symbol === symbol);
    if (row) {
      return {
        price: +row.lastPrice,
        change24: +row.priceChangePercent,
        high24: +row.highPrice,
        low24: +row.lowPrice,
        volume24: +row.quoteVolume,
      };
    }
  } catch {
    // احتياط: اشتقاق من الشموع
  }
  const candles = await getCandles(pair, '1h', 25);
  const price = candles[candles.length - 1].close;
  const prev = candles[0].close;
  return {
    price,
    change24: ((price - prev) / prev) * 100,
    high24: Math.max(...candles.map((c) => c.high)),
    low24: Math.min(...candles.map((c) => c.low)),
    volume24: candles.reduce((s, c) => s + (c.volume || 0), 0),
  };
}
