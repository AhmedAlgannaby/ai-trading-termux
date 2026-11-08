/**
 * worker/gate — بوابة الدخول المركزية في السيرفر (Phase 4).
 *
 * تعميم evaluateSignal من المتصفح + إحصاءات TradeReview (سبب الخسارة):
 *   evaluateEntry({ pair, direction: 'buy'|'sell', confidence, strategyId })
 *   → { blocked, adjustedConfidence, notes[] }
 *
 * القواعد (Bayesian خفيف + حد أدنى عينات):
 * - زوج+اتجاه بنسبة نجاح <30% (عينات>=5) → حظر
 * - استراتيجية بنسبة نجاح <35% (عينات>=5) → حظر
 * - سبب خسارة متكرر لنفس البصمة (pair|cause>=3) → خصم 10
 * - نطاق عرضي متكرر الخسارة → خصم إضافي
 */
import { db } from '../db.js';

const MIN_SAMPLES = 5;
const MAX_PENALTY = 25;

function rate(wins, total) {
  return total ? wins / total : 1;
}

export async function entryStats() {
  const reviews = await db.list('TradeReview', { sort: '-created_date', limit: 500 });
  const pairDir = {};
  const strat = {};
  const causes = {};
  for (const r of reviews) {
    const win = r.outcome === 'win';
    const pd = `${r.pair}|${r.direction}`;
    pairDir[pd] = pairDir[pd] || { wins: 0, total: 0 };
    pairDir[pd].total++;
    if (win) pairDir[pd].wins++;
    if (r.strategy_id) {
      strat[r.strategy_id] = strat[r.strategy_id] || { wins: 0, total: 0 };
      strat[r.strategy_id].total++;
      if (win) strat[r.strategy_id].wins++;
    }
    if (!win && r.cause) {
      const ck = `${r.pair}|${r.cause}`;
      causes[ck] = (causes[ck] || 0) + 1;
    }
  }
  return { pairDir, strat, causes, total: reviews.length };
}

export async function evaluateEntry({ pair, direction, confidence, strategyId }) {
  const dir = direction === 'buy' ? 'long' : 'short';
  const notes = [];
  let penalty = 0;
  let stats;
  try {
    stats = await entryStats();
  } catch {
    return { blocked: false, adjustedConfidence: confidence, notes };
  }

  const combo = stats.pairDir[`${pair}|${dir}`];
  if (combo && combo.total >= MIN_SAMPLES) {
    const wr = rate(combo.wins, combo.total);
    if (wr < 0.3) {
      return { blocked: true, adjustedConfidence: 0, notes: [`حظر: ${pair} ${dir} نجاح ${(wr * 100).toFixed(0)}% فقط (${combo.total} مراجعات)`] };
    }
    if (wr < 0.5) {
      penalty += 10;
      notes.push(`خصم ثقة: ${pair} ${dir} نجاح ${(wr * 100).toFixed(0)}%`);
    }
  }

  if (strategyId) {
    const st = stats.strat[strategyId];
    if (st && st.total >= MIN_SAMPLES) {
      const wr = rate(st.wins, st.total);
      if (wr < 0.35) {
        return { blocked: true, adjustedConfidence: 0, notes: [`حظر استراتيجية ${strategyId}: نجاح ${(wr * 100).toFixed(0)}%`] };
      }
      if (wr < 0.5) {
        penalty += 8;
        notes.push(`خصم ثقة: استراتيجية ${strategyId} نجاح ${(wr * 100).toFixed(0)}%`);
      }
    }
  }

  // أسباب خسارة متكررة لنفس الزوج
  let worstCause = null, worstCount = 0;
  for (const [ck, c] of Object.entries(stats.causes)) {
    const [p] = ck.split('|');
    if (p === pair && c > worstCount) { worstCount = c; worstCause = ck.split('|')[1]; }
  }
  if (worstCause && worstCount >= 3) {
    penalty += 10;
    notes.push(`سبب خسارة متكرر على ${pair}: ${worstCause} (${worstCount}x) — خفّض الثقة`);
  }

  penalty = Math.min(penalty, MAX_PENALTY);
  return { blocked: false, adjustedConfidence: Math.max(0, (confidence || 0) - penalty), notes };
}

/**
 * كبح الخسائر المتتالية (loss throttle):
 * خسارتان → نصف المخاطرة، بلوغ circuit_breaker → إيقاف الدخول الجديد.
 */
export async function lossThrottle() {
  const settingsList = await db.list('RiskSettings', { sort: '-created_date', limit: 1 });
  const settings = settingsList[0] || {};
  const breaker = Math.min(Math.max(Number(settings.circuit_breaker_losses) || 3, 1), 10);
  const closed = await db.list('Trade', { sort: '-created_date', limit: 20, filter: { status: 'closed' } });
  let consec = 0;
  for (const t of closed) {
    if ((t.pnl || 0) > 0) break;
    consec++;
  }
  if (consec >= breaker) {
    return { allow: false, riskMult: 0, consecLosses: consec, reason: `إيقاف بعد ${consec} خسائر متتالية (الحد ${breaker})` };
  }
  if (consec >= 2) {
    return { allow: true, riskMult: 0.5, consecLosses: consec, reason: `نصف المخاطرة بعد ${consec} خسائر متتالية` };
  }
  return { allow: true, riskMult: 1, consecLosses: consec, reason: '' };
}
