/**
 * worker/notifier — إرسال تنبيهات Telegram من السيرفر (يعمل بلا متصفح).
 *
 * كل دورة: AlertLog غير المرسلة (telegram_sent=false) والتي يوافق نوعها
 * إعدادات المستخدم (notify_*) ← تُرسل عبر Bot API ← تُوسم مرسلة.
 * حد 3 محاولات للرسالة الفاشلة (حتى لا يعلق على توكن خاطئ).
 *
 * البيئة: WORKER_NOTIFY_SECONDS=60 (30..600). بدون bot_token/chat_id يسكت.
 */
import { db, getUser } from '../db.js';

export const notifierStats = { everySec: 60, lastRun: null, lastDurationMs: 0, sent: 0, skipped: 0, errors: 0 };
let running = false;

const TYPE_TO_FLAG = {
  trade_opened: 'notify_trade_open',
  trade_closed: 'notify_trade_close',
  stop_adjusted: 'notify_stop_loss',
  risk_throttle: 'notify_risk_warning',
  new_signal: 'notify_signal',
  live_close_failed: 'notify_risk_warning',
  take_profit: 'notify_take_profit',
  stop_loss: 'notify_stop_loss',
};

async function sendTelegram(token, chatId, text) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 3500) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) {
      throw new Error(data?.description || `telegram ${res.status}`);
    }
  } finally {
    clearTimeout(t);
  }
}

export async function notifierTick() {
  if (running) return { skipped: true };
  running = true;
  const t0 = Date.now();
  const out = { sent: 0, skipped: 0, errors: 0 };
  try {
    const user = await getUser();
    const token = user.telegram_bot_token || '';
    const chatId = user.telegram_chat_id || '';
    if (!token || !chatId) return out; // غير مضبوط — سكوت تام
    // C9: جلب غير المرسلة فقط من الخادم (القديم كان يجلب أول 20 سجلاً
    // فيموت جوعاً بعد امتلائها) + حد أعلى لتصريف المتراكم
    const pending = await db.list('AlertLog', { sort: 'created_date', limit: 50, filter: { telegram_sent: false } });
    const fresh = pending.filter((a) => (a.telegram_attempts || 0) < 3);
    for (const a of fresh) {
      const flag = TYPE_TO_FLAG[a.alert_type] || 'notify_signal';
      if (user[flag] === false) {
        await db.update('AlertLog', a.id, { telegram_sent: true });
        out.skipped++;
        continue;
      }
      try {
        await sendTelegram(token, chatId, `🤖 ${a.alert_name || a.alert_type}\n${a.pair || ''}\n${a.message || ''}`);
        await db.update('AlertLog', a.id, { telegram_sent: true });
        out.sent++;
      } catch (e) {
        out.errors++;
        await db.update('AlertLog', a.id, { telegram_attempts: (a.telegram_attempts || 0) + 1 });
        console.error('telegram send failed:', e.message);
      }
    }
    return out;
  } finally {
    running = false;
    notifierStats.lastRun = new Date().toISOString();
    notifierStats.lastDurationMs = Date.now() - t0;
    notifierStats.sent = out.sent;
    notifierStats.skipped = out.skipped;
    notifierStats.errors = out.errors;
  }
}
