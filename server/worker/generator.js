/**
 * worker/generator — توليد الإشارات الدوري في السيرفر (بديل AI_CRON + AutoPaperTrader).
 *
 * - يحترم AI_CRON_MINUTES (0 = معطّل) و execution_mode (يتخطى manual)
 * - يتخطى الأزواج التي لها صفقة paper مفتوحة (منع التكديس على نفس الزوج)
 * - يفوّض التوليد والتنفيذ لـ generateSignals (عقل السيرفر الموحّد)
 * - اختيار الاستراتيجية الدوري (Phase 2/3) سيُحقن هنا عبر strategySpec
 */
import { db } from '../db.js';
import { generateSignals } from '../functions.js';

export const GENERATOR_PAIRS = [
  // الأزواج الأساسية
  'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT', 'ADA/USDT',
  // أزواج إضافية عالية السيولة
  'DOGE/USDT', 'AVAX/USDT', 'LINK/USDT', 'DOT/USDT', 'TRX/USDT', 'LTC/USDT',
  'BCH/USDT', 'NEAR/USDT', 'ATOM/USDT', 'FIL/USDT', 'APT/USDT', 'ARB/USDT',
  'OP/USDT', 'SUI/USDT', 'INJ/USDT', 'TIA/USDT', 'SEI/USDT', 'PEPE/USDT',
  'SHIB/USDT', 'UNI/USDT', 'XLM/USDT', 'ETC/USDT',
];

export const generatorStats = { everyMin: 0, lastRun: null, lastDurationMs: 0, lastResults: [], errors: 0 };
let running = false;

export async function generatorTick() {
  if (running) return { skipped: true };
  running = true;
  const t0 = Date.now();
  try {
    const settingsList = await db.list('RiskSettings', { sort: '-created_date', limit: 1 });
    const settings = settingsList[0];
    if (!settings) return { skipped: true, reason: 'no RiskSettings' };
    if ((settings.execution_mode || 'semi_auto') === 'manual') {
      return { skipped: true, reason: 'manual mode' };
    }
    const maxOpen = Math.min(Math.max(Number(settings.max_open_positions) || 5, 1), 20);
    const open = await db.list('Trade', { filter: { status: 'open' } });
    if (open.length >= maxOpen) return { skipped: true, reason: `max open (${open.length}/${maxOpen})` };
    const busyPairs = new Set(open.map((t) => t.pair));
    const pairs = GENERATOR_PAIRS.filter((p) => !busyPairs.has(p));
    if (!pairs.length) return { skipped: true, reason: 'all pairs busy' };

    const r = await generateSignals(pairs);
    generatorStats.lastResults = r.results || [];
    return { success: true, results: r.results };
  } catch (e) {
    generatorStats.errors++;
    console.error('generator error:', e.message);
    return { error: e.message };
  } finally {
    running = false;
    generatorStats.lastRun = new Date().toISOString();
    generatorStats.lastDurationMs = Date.now() - t0;
  }
}
