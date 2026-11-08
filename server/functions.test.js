/**
 * تستات executeSignal (C3) — معزولة في مجلد مؤقت، بلا شبكة:
 *   node server/functions.test.js
 *
 * paper/auto لا يلمس الشبكة. مسار live الضخم يُرفض بالسقف قبل أي اتصال.
 * (نجاح live حقيقي غير مُختبَر هنا — يتطلب مفاتيح وشبكة.)
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'ecc-func-test-'));
const { db } = await import('./db.js');
const { executeSignal } = await import('./functions.js');

let pass = 0, fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
}

async function resetDir() {
  await fs.rm(process.env.DATA_DIR, { recursive: true, force: true });
  await fs.mkdir(process.env.DATA_DIR, { recursive: true });
}

async function seedSettings(patch = {}) {
  await db.create('RiskSettings', {
    execution_mode: 'auto', trading_mode: 'paper',
    paper_balance: 10000, max_risk_per_trade: 2, max_open_positions: 5,
    ...patch,
  });
}

async function seedSignal(patch = {}) {
  return db.create('Signal', {
    pair: 'BTC/USDT', direction: 'buy', confidence: 80,
    entry_price: 100, stop_loss: 98,
    take_profit_1: 104, take_profit_2: 106, take_profit_3: 110,
    status: 'pending', strategy: 'test',
    ...patch,
  });
}

// ── 1) paper/auto: تنفيذ ناجح بلا شبكة ──
await resetDir();
await seedSettings();
const s1 = await seedSignal();
const r1 = await executeSignal(s1.id);
const trades = await db.list('Trade', {});
const got1 = await db.get('Signal', s1.id);
ok(r1.success && r1.action === 'trade_executed', 'paper/auto ينفذ');
ok(trades.length === 1 && trades[0].mode === 'paper', 'الصفقة المنشأة paper');
ok(got1.status === 'executed', 'الإشارة تُختم منفذة');

// ── 2) ثقة منخفضة → منتهية ──
await resetDir();
await seedSettings();
const s2 = await seedSignal({ confidence: 50 });
const r2 = await executeSignal(s2.id);
ok(r2.skipped && (await db.get('Signal', s2.id)).status === 'expired', 'ثقة 50 تُرفض');

// ── 3) اتجاه غريب → منتهي (لا يُترجم لبيع ضمني) ──
await resetDir();
await seedSettings();
const s3 = await seedSignal({ direction: 'moon' });
const r3 = await executeSignal(s3.id);
const after3 = await db.list('Trade', {});
ok(r3.skipped && after3.length === 0, 'اتجاه غريب لا يفتح صفقة');

// ── 4) TTL منتهي → منتهية ──
await resetDir();
await seedSettings();
const s4 = await seedSignal();
await fs.writeFile(path.join(process.env.DATA_DIR, 'Signal.json'),
  JSON.stringify([{ ...(await db.get('Signal', s4.id)), created_date: new Date(Date.now() - 3 * 3600 * 1000).toISOString() }]));
const r4 = await executeSignal(s4.id);
ok(r4.skipped && /TTL|expired/.test(r4.reason), 'إشارة قديمة تُرفض بالـ TTL');

// ── 5) تاريخ فاسد → منتهية (لا تنفيذ أبدي) ──
await resetDir();
await seedSettings();
const s5 = await seedSignal();
await fs.writeFile(path.join(process.env.DATA_DIR, 'Signal.json'),
  JSON.stringify([{ ...(await db.get('Signal', s5.id)), created_date: 'garbage' }]));
const r5 = await executeSignal(s5.id);
ok(r5.skipped, 'تاريخ فاسد يُرفض');

// ── 6) live بحجم فلكي → سقف MAX_LIVE_NOTIONAL قبل أي شبكة ──
await resetDir();
await seedSettings({ trading_mode: 'live', paper_balance: 1e9, max_risk_per_trade: 10 });
const s6 = await seedSignal();
const r6 = await executeSignal(s6.id);
const after6 = await db.list('Trade', {});
ok(r6.skipped && /cap/.test(r6.reason) && after6.length === 0, `سقف الحي يرفض قبل الشبكة (${r6.reason})`);

// ── 7) بلا إعدادات → تخطي آمن ──
await resetDir();
const s7 = await seedSignal();
const r7 = await executeSignal(s7.id);
ok(r7.skipped, 'بلا RiskSettings: تخطي آمن');

// ── 8) منطق السوق: بيع في السبوت يُتخطى (لا شورت وهمي) ──
await resetDir();
await seedSettings(); // spot افتراضياً
const s8 = await seedSignal({ direction: 'sell', stop_loss: 102, take_profit_1: 96 });
const r8 = await executeSignal(s8.id);
const after8 = await db.list('Trade', {});
ok(r8.skipped && /short/i.test(r8.reason) && after8.length === 0 &&
  (await db.get('Signal', s8.id)).status === 'expired', 'بيع سبوت يُتخطى ويُختم');

// ── 9) بيع في الفيوتشر (paper) يُنفذ كصفقة فيوتشر ──
await resetDir();
await seedSettings({ market_type: 'futures', default_leverage: 3 });
const s9 = await seedSignal({ direction: 'sell', stop_loss: 102, take_profit_1: 96 });
const r9 = await executeSignal(s9.id);
const after9 = await db.list('Trade', {});
ok(r9.success && after9.length === 1 && after9[0].type === 'short' &&
  after9[0].market_type === 'futures' && after9[0].leverage === 3, 'بيع فيوتشر ينفذ برافعة الإعدادات');

// ── 10) micro: $10 → حجم صغير ورافعة ≤ 2x ──
await resetDir();
await seedSettings({ paper_balance: 10, market_type: 'futures', default_leverage: 5 });
const s10 = await seedSignal({ stop_loss: 98.5, take_profit_1: 104.5, take_profit_2: 106, take_profit_3: 109 });
const r10 = await executeSignal(s10.id);
const after10 = await db.list('Trade', {});
ok(r10.success && after10.length === 1 &&
  after10[0].position_size >= 5 && after10[0].position_size <= 20 &&
  after10[0].leverage === 2 && after10[0].mode === 'paper',
  'micro: $10 ينفذ بحجم $5–20 ورافعة 2x');

// ── 11) micro: زوج خارج القائمة يُرفض ──
await resetDir();
await seedSettings({ paper_balance: 10, market_type: 'futures' });
const s11 = await seedSignal({ pair: 'XRP/USDT' });
const r11 = await executeSignal(s11.id);
ok(r11.skipped && /liquid majors|micro/.test(r11.reason) &&
  (await db.get('Signal', s11.id)).status === 'expired',
  'micro: يرفض زوجاً خارج BTC/ETH/SOL/BNB');

// ── 12) micro: صفقة واحدة مفتوحة كحد أقصى ──
await resetDir();
await seedSettings({ paper_balance: 10, market_type: 'futures' });
await db.create('Trade', { pair: 'BTC/USDT', status: 'open', mode: 'paper', position_size: 10, created_date: new Date().toISOString() });
const s12 = await seedSignal({ pair: 'ETH/USDT', stop_loss: 98.5, take_profit_1: 104.5 });
const r12 = await executeSignal(s12.id);
ok(r12.skipped && /max open/i.test(r12.reason), 'micro: صفقة واحدة مفتوحة كحد أقصى');

// ── 13) زوج مفتوح: لا تكرار حتى في الحساب العادي ──
await resetDir();
await seedSettings({ paper_balance: 10, market_type: 'futures' });
await db.create('Trade', { pair: 'BTC/USDT', status: 'open', mode: 'paper', position_size: 10, created_date: new Date().toISOString() });
const s13 = await seedSignal({ pair: 'BTC/USDT' });
const r13 = await executeSignal(s13.id);
ok(r13.skipped && /already have an open/.test(r13.reason), 'صفقة مفتوحة لنفس الزوج: لا تكرار');

// ── 14) micro: حد صفقتين يومياً ──
await resetDir();
await seedSettings({ paper_balance: 10, market_type: 'futures' });
const today = new Date().toISOString();
for (let i = 0; i < 2; i++) {
  await db.create('Trade', {
    pair: i ? 'ETH/USDT' : 'BTC/USDT', status: 'closed', mode: 'paper',
    position_size: 10, pnl: 0, created_date: today, closed_at: today,
  });
}
const s14 = await seedSignal({ pair: 'SOL/USDT' });
const r14 = await executeSignal(s14.id);
ok(r14.skipped && /daily trade cap/.test(r14.reason), 'micro: حد صفقتين يومياً');

// ── 15) micro: ثقة 65% أقل من الحد 70% ──
await resetDir();
await seedSettings({ paper_balance: 10, market_type: 'futures' });
const s15 = await seedSignal({ confidence: 65 });
const r15 = await executeSignal(s15.id);
ok(r15.skipped && /minimum 70/.test(r15.reason), 'micro: ثقة 65% مرفوضة');

// ── 16) micro: هدف لا يغطي الرسوم يُرفض ──
await resetDir();
await seedSettings({ paper_balance: 10, market_type: 'futures' });
const s16 = await seedSignal({ stop_loss: 99.99, take_profit_1: 100.01, take_profit_2: 100.02, take_profit_3: 100.03 });
const r16 = await executeSignal(s16.id);
ok(r16.skipped && /fee guard/.test(r16.reason), 'micro: هدف لا يغطي الرسوم مرفوض');

// تنظيف
await fs.rm(process.env.DATA_DIR, { recursive: true, force: true });

console.log(`\nالنتيجة: ${pass} ناجح / ${fail} فاشل`);
process.exit(fail ? 1 : 0);
