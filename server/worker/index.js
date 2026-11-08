/**
 * worker/index — منسق عامل السيرفر (مراقب + مولد + متعلم).
 *
 * يعمل داخل عملية server/index.js — لا يحتاج متصفحاً مفتوحاً.
 * كل حلقة محمية ضد التداخل (single-flight) وتسجّل إحصاءات تُعرض في /api/health.
 *
 * البيئة:
 *   WORKER_ENABLED=false        تعطيل العامل كاملاً (افتراضي: مفعّل)
 *   WORKER_MONITOR_SECONDS=30   دورة المراقب (انظر monitor.js)
 *   AI_CRON_MINUTES=0           دورة المولد (0 = معطّل) — يُعاد استخدام نفس المتغير
 *   WORKER_LEARN_SECONDS=300    دورة المتعلم
 */
import { monitorTick, monitorStats, monitorConfig } from './monitor.js';
import { generatorTick, generatorStats } from './generator.js';
import { learnerTick, learnerStats } from './learner.js';
import { notifierTick, notifierStats } from './notifier.js';

export const workerStats = {
  enabled: process.env.WORKER_ENABLED !== 'false',
  startedAt: null,
  monitor: monitorStats,
  generator: generatorStats,
  learner: learnerStats,
  notifier: notifierStats,
};

function loop(fn, ms, label) {
  let active = false;
  const run = async () => {
    if (active) return;
    active = true;
    try {
      await fn();
    } catch (e) {
      console.error(`worker/${label} error:`, e.message);
    } finally {
      active = false;
    }
  };
  // First run shortly after boot (prices warm-up), then interval
  setTimeout(run, 15000);
  return setInterval(run, ms);
}

export function startWorker() {
  if (!workerStats.enabled) {
    console.log('⏸️  worker disabled (WORKER_ENABLED=false) — frontend engines remain authoritative');
    return workerStats;
  }
  const cfg = monitorConfig();
  loop(() => monitorTick(), cfg.everySec * 1000, 'monitor');
  console.log(`👁️  worker/monitor every ${cfg.everySec}s (liveClose=${cfg.liveClose})`);

  const cronMin = Number(process.env.AI_CRON_MINUTES || 0);
  generatorStats.everyMin = cronMin;
  if (cronMin > 0) {
    loop(() => generatorTick(), cronMin * 60 * 1000, 'generator');
    console.log(`⚙️  worker/generator every ${cronMin} min`);
  } else {
    console.log('⏸️  worker/generator off (AI_CRON_MINUTES=0)');
  }

  const learnSec = Math.min(Math.max(Number(process.env.WORKER_LEARN_SECONDS || 300), 60), 3600);
  learnerStats.everySec = learnSec;
  loop(() => learnerTick(), learnSec * 1000, 'learner');
  console.log(`📚 worker/learner every ${learnSec}s`);

  const notifySec = Math.min(Math.max(Number(process.env.WORKER_NOTIFY_SECONDS || 60), 30), 600);
  notifierStats.everySec = notifySec;
  loop(() => notifierTick(), notifySec * 1000, 'notifier');
  console.log(`📨 worker/notifier every ${notifySec}s`);

  workerStats.startedAt = new Date().toISOString();
  return workerStats;
}

export function workerStatus() {
  return {
    enabled: workerStats.enabled,
    startedAt: workerStats.startedAt,
    monitorActive: workerStats.enabled,
    generatorActive: workerStats.enabled && (generatorStats.everyMin || 0) > 0,
    monitor: { ...monitorStats },
    generator: { everyMin: generatorStats.everyMin, lastRun: generatorStats.lastRun, errors: generatorStats.errors },
    learner: { ...learnerStats },
    notifier: { ...notifierStats },
  };
}
