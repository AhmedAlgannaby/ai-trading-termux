/**
 * learn.js — قياس الاستراتيجيات على التاريخ المحلي (Phase 3).
 *
 * لكل زوج (4h من server/data/candles) × كل مواصفة في السجل:
 *   walk-forward (4 نوافذ) + مونت كارلو → صف StrategyScore
 * النتيجة تقود تدوير الاستراتيجيات في pickActiveSpec (functions.js).
 *
 *   npm run history:learn            (يتخطى المقاس حديثاً < 7 أيام)
 *   npm run history:learn -- --force (إعادة قياس الكل)
 *   LEARN_PAIRS=BTCUSDT,ETHUSDT LEARN_WINDOWS=3 npm run history:learn
 */
import { db } from '../db.js';
import { loadCandles } from './history.js';
import { walkForward } from './backtest.js';
import { STRATEGY_REGISTRY } from './strategies.js';

const PAIRS = (process.env.LEARN_PAIRS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,LINKUSDT,DOTUSDT')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const INTERVAL = process.env.LEARN_INTERVAL || '4h';
const WINDOWS = Math.min(Math.max(Number(process.env.LEARN_WINDOWS || 4), 2), 8);
const FORCE = process.argv.includes('--force');
const FRESH_DAYS = 7;

const RISK = {
  initialBalance: 10000,
  riskPerTrade: 2,
  stopLossPercent: 2,
  takeProfitPercent: 4,
  maxHoldBars: 120,
};

/** درجة 0..100 من مقاييس OOS */
export function strategyScore(wf) {
  const wr = wf.oos_win_rate ?? 0;
  const med = wf.monte_carlo?.median_return ?? 0;
  const stab = wf.windows.length ? (wf.stable_windows / wf.windows.length) * 100 : 0;
  const prob = wf.monte_carlo?.prob_profit ?? 0;
  const parts = [
    wr * 0.4,
    Math.max(0, Math.min(20, ((med + 10) / 30) * 20)),
    stab * 0.2,
    prob * 0.2,
  ];
  let score = Math.round(parts.reduce((a, b) => a + b, 0));
  if (!wf.meets_min || (wf.oos_trades ?? 0) < 10) score = Math.min(score, 30);
  return Math.max(0, Math.min(100, score));
}

function toBrain(rows) {
  return rows.map((c) => ({ openTime: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v }));
}

async function freshScoreExists(strategyId, pair) {
  if (FORCE) return false;
  const rows = await db.list('StrategyScore', { sort: '-created_date', limit: 5, filter: { strategy_id: strategyId, pair } });
  if (!rows.length) return false;
  const age = Date.now() - Date.parse(rows[0].created_date || 0);
  return age < FRESH_DAYS * 86400000;
}

async function main() {
  console.log(`قياس ${STRATEGY_REGISTRY.length} استراتيجيات × ${PAIRS.length} أزواج (${INTERVAL}, ${WINDOWS} نوافذ)`);
  let done = 0, skipped = 0, failed = 0;
  for (const symbol of PAIRS) {
    const pair = symbol.replace(/USDT$/, '/USDT');
    const rows = await loadCandles(symbol, INTERVAL);
    if (rows.length < 300) {
      console.log(`  ⏭️  ${symbol}: بيانات ناقصة (${rows.length}) — نفّذ history:fetch أولاً`);
      continue;
    }
    const candles = toBrain(rows);
    for (const spec of STRATEGY_REGISTRY) {
      try {
        if (await freshScoreExists(spec.id, pair)) { skipped++; continue; }
        const wf = walkForward({ candles, spec, windows: WINDOWS, minTestTrades: 10, ...RISK });
        const score = strategyScore(wf);
        await db.create('StrategyScore', {
          strategy_id: spec.id,
          strategy_name: spec.name,
          family: spec.family,
          pair,
          interval: INTERVAL,
          candles: rows.length,
          from: new Date(rows[0].t).toISOString(),
          to: new Date(rows[rows.length - 1].t).toISOString(),
          windows: wf.windows,
          oos_trades: wf.oos_trades,
          oos_win_rate: wf.oos_win_rate,
          oos_return_percent: wf.oos_return_percent,
          oos_final_balance: wf.oos_final_balance,
          oos_max_drawdown: wf.oos_max_drawdown,
          stable_windows: wf.stable_windows,
          mc_median_return: wf.monte_carlo.median_return,
          mc_p5_return: wf.monte_carlo.p5_return,
          mc_p95_return: wf.monte_carlo.p95_return,
          mc_prob_profit: wf.monte_carlo.prob_profit,
          mc_median_max_dd: wf.monte_carlo.median_max_dd,
          score,
          source: 'engine-walkforward',
        }, 'history:learn');
        done++;
        console.log(`  ✅ ${spec.id} @ ${pair}: score ${score} (trades ${wf.oos_trades}, win ${wf.oos_win_rate}%, OOS ${wf.oos_return_percent}%)`);
      } catch (e) {
        failed++;
        console.error(`  ❌ ${spec.id} @ ${pair}: ${e.message}`);
      }
    }
  }
  console.log(`انتهى: ${done} مقاس / ${skipped} حديث / ${failed} فاشل`);
}

const isCLI = process.argv[1] && process.argv[1].endsWith('learn.js');
if (isCLI) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
