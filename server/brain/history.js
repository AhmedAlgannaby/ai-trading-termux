/**
 * history.js — تنزيل البيانات التاريخية من Binance وتخزينها محلياً (Phase 1).
 *
 * التخزين: server/data/candles/<SYMBOL>_<interval>.json
 * الصف: { t, o, h, l, c, v } مرتبة زمنياً وبدون تكرار.
 *
 * الاستخدام:
 *   npm run history:fetch
 *   HISTORY_PAIRS=BTCUSDT,ETHUSDT HISTORY_INTERVALS=1d,4h HISTORY_FROM=2017-08-17 npm run history:fetch
 *
 * الخصائص: استئناف تلقائي (يكمل من آخر شمعة مخزنة)، صفحات 1000 شمعة،
 * احترام حد المعدل (450ms بين الطلبات + تراجع أسّي عند 429/418)، تقرير فجوات.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const BINANCE_BASE = process.env.BINANCE_BASE_URL || 'https://api.binance.com';
const DATA_DIR = process.env.DATA_DIR || './server/data';
const CANDLES_DIR = path.resolve(DATA_DIR, 'candles');

const INTERVAL_MS = {
  '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000, '30m': 1800000,
  '1h': 3600000, '2h': 7200000, '4h': 14400000, '6h': 21600000, '8h': 28800000,
  '12h': 43200000, '1d': 86400000, '3d': 259200000, '1w': 604800000, '1M': 2592000000,
};

export const HISTORY_PAIRS = (process.env.HISTORY_PAIRS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,LINKUSDT,DOTUSDT')
  .split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9]{4,20}$/.test(s));
export const HISTORY_INTERVALS = (process.env.HISTORY_INTERVALS || '1d,4h')
  .split(',').map((s) => s.trim()).filter((s) => INTERVAL_MS[s]);
const HISTORY_FROM = Date.parse(process.env.HISTORY_FROM || '2017-08-17T00:00:00Z');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fileFor(symbol, interval) {
  return path.join(CANDLES_DIR, `${symbol}_${interval}.json`);
}

export async function loadCandles(symbol, interval) {
  try {
    const raw = await fs.readFile(fileFor(symbol, interval), 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function saveCandles(symbol, interval, rows) {
  await fs.mkdir(CANDLES_DIR, { recursive: true });
  const tmp = fileFor(symbol, interval) + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(rows), 'utf-8');
  await fs.rename(tmp, fileFor(symbol, interval));
}

/** دمج + إزالة تكرار حسب t + ترتيب — يعيد { rows, added } */
export function mergeCandles(existing, incoming) {
  const map = new Map();
  for (const c of existing) map.set(c.t, c);
  let added = 0;
  for (const c of incoming) {
    if (!map.has(c.t)) { map.set(c.t, c); added++; }
  }
  const rows = [...map.values()].sort((a, b) => a.t - b.t);
  return { rows, added };
}

async function fetchKlines(symbol, interval, startTime, attempt = 0) {
  const url = `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&limit=1000`;
  const res = await fetch(url);
  if (res.status === 429 || res.status === 418) {
    const wait = Math.min(60000, 5000 * 2 ** attempt);
    console.log(`  ⏳ rate limited (${res.status}) — انتظار ${Math.round(wait / 1000)}s`);
    await sleep(wait);
    if (attempt > 5) throw new Error(`rate limited repeatedly for ${symbol} ${interval}`);
    return fetchKlines(symbol, interval, startTime, attempt + 1);
  }
  if (!res.ok) throw new Error(`klines ${res.status} for ${symbol} ${interval}`);
  const raw = await res.json();
  return (raw || []).map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
}

/** تعبئة خلفية: إن بدأ المخزن بعد التاريخ المطلوب (مثل ملف أُنشئ باختبار جزئي) */
async function backfill(symbol, interval, from, firstT) {
  const step = INTERVAL_MS[interval];
  let cursor = from;
  let added = 0, pages = 0;
  for (;;) {
    if (cursor >= firstT) break;
    const batch = await fetchKlines(symbol, interval, cursor);
    pages++;
    if (!batch.length) break;
    const rows = await loadCandles(symbol, interval);
    const { rows: merged, added: n } = mergeCandles(rows, batch.filter((c) => c.t < firstT));
    await saveCandles(symbol, interval, merged);
    added += n;
    cursor = batch[batch.length - 1].t + step;
    if (batch.length < 1000) break;
    await sleep(450);
  }
  return { added, pages };
}

/** ينزّل تاريخ زوج/فريم (استئناف من المخزن + تعبئة خلفية) — يعيد إحصاءات */
export async function fetchHistory(symbol, interval, { from = HISTORY_FROM, to = Date.now(), log = true } = {}) {
  const step = INTERVAL_MS[interval];
  let rows = await loadCandles(symbol, interval);
  // تعبئة خلفية أولاً إن لزم
  if (rows.length && rows[0].t > from) {
    const bf = await backfill(symbol, interval, from, rows[0].t);
    if (log && bf.added) console.log(`  ↩️ ${symbol} ${interval}: تعبئة خلفية +${bf.added}`);
    rows = await loadCandles(symbol, interval);
  }
  let cursor = rows.length ? rows[rows.length - 1].t + step : from;
  // آخر شمعة قد تكون غير مغلقة — أعد جلبها دائماً
  if (rows.length) cursor = rows[rows.length - 1].t;
  let totalAdded = 0;
  let pages = 0;
  for (;;) {
    if (cursor >= to) break;
    const batch = await fetchKlines(symbol, interval, cursor);
    pages++;
    if (!batch.length) break;
    // أسقط الشمعة غير المغلقة (الأخيرة إن كان إغلاقها في المستقبل)
    let usable = batch;
    const lastClose = batch[batch.length - 1].t + step;
    if (lastClose > Date.now()) usable = batch.slice(0, -1);
    const { rows: merged, added } = mergeCandles(rows, usable);
    rows = merged;
    totalAdded += added;
    cursor = batch[batch.length - 1].t + step;
    if (batch.length < 1000) break;
    await sleep(450); // احترام حد الوزن
  }
  await saveCandles(symbol, interval, rows);
  const gaps = countGaps(rows, step);
  if (log) console.log(`  ✅ ${symbol} ${interval}: ${rows.length} شمعة (+${totalAdded}, ${pages} صفحات, فجوات: ${gaps})`);
  return { symbol, interval, count: rows.length, added: totalAdded, pages, gaps };
}

function countGaps(rows, step) {
  let gaps = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].t - rows[i - 1].t > step * 1.5) gaps++;
  }
  return gaps;
}

/** تقرير فجوات سريع بدون تنزيل */
export async function gapReport(symbol, interval) {
  const rows = await loadCandles(symbol, interval);
  if (!rows.length) return { symbol, interval, count: 0, gaps: -1, from: null, to: null };
  return {
    symbol, interval, count: rows.length,
    gaps: countGaps(rows, INTERVAL_MS[interval]),
    from: new Date(rows[0].t).toISOString().slice(0, 10),
    to: new Date(rows[rows.length - 1].t).toISOString().slice(0, 10),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--gaps')) {
    console.log('تقرير الفجوات:');
    for (const s of HISTORY_PAIRS) {
      for (const i of HISTORY_INTERVALS) console.log(' ', JSON.stringify(await gapReport(s, i)));
    }
    return;
  }
  console.log(`تنزيل التاريخ: ${HISTORY_PAIRS.length} أزواج × ${HISTORY_INTERVALS.join(',')} من ${new Date(HISTORY_FROM).toISOString().slice(0, 10)}`);
  for (const s of HISTORY_PAIRS) {
    for (const i of HISTORY_INTERVALS) {
      try {
        await fetchHistory(s, i);
      } catch (e) {
        console.error(`  ❌ ${s} ${i}: ${e.message}`);
      }
    }
  }
  console.log('انتهى. للمتابعة لاحقاً أعد نفس الأمر (استئناف تلقائي).');
}

const isCLI = process.argv[1] && path.resolve(process.argv[1]).endsWith('history.js');
if (isCLI) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
