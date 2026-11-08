/**
 * اختبارات بوابة الدخول (P1) — معزولة في مجلد مؤقت، بلا شبكة:
 *   node server/worker/gate.test.js
 *
 * يغطي evaluateEntry (حظر الزوج الخاسر/الاستراتيجية الخاسرة/الخصومات/السقف)
 * و lossThrottle (نصف المخاطرة بعد خسارتين، الإيقاف عند الكبح).
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'ecc-gate-test-'));
const { db } = await import('../db.js');
const { evaluateEntry, lossThrottle, entryStats } = await import('./gate.js');

let pass = 0, fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
}

async function resetDir() {
  await fs.rm(process.env.DATA_DIR, { recursive: true, force: true });
  await fs.mkdir(process.env.DATA_DIR, { recursive: true });
}

// ── 1) بلا بيانات: لا حظر ولا خصم ──
await resetDir();
let r = await evaluateEntry({ pair: 'BTC/USDT', direction: 'buy', confidence: 70 });
ok(r.blocked === false && r.adjustedConfidence === 70, 'بلا مراجعات: يمر بنفس الثقة');

// ── 2) عينات قليلة (<5) لا تحظر ──
await resetDir();
for (let i = 0; i < 4; i++) {
  await db.create('TradeReview', { pair: 'BTC/USDT', direction: 'long', outcome: 'loss', cause: 'وقف مبكر' });
}
r = await evaluateEntry({ pair: 'BTC/USDT', direction: 'buy', confidence: 70 });
ok(r.blocked === false, 'أقل من 5 عينات: لا حظر');

// ── 3) زوج+اتجاه خاسر (<30% من 5+) → حظر ──
await resetDir();
for (let i = 0; i < 6; i++) {
  await db.create('TradeReview', { pair: 'ETH/USDT', direction: 'long', outcome: i === 0 ? 'win' : 'loss', cause: 'انعكاس' });
}
r = await evaluateEntry({ pair: 'ETH/USDT', direction: 'buy', confidence: 80 });
ok(r.blocked === true && r.adjustedConfidence === 0 && r.notes.length > 0, 'زوج خاسر 1/6: حظر مع ملاحظة');

// ── 4) نسبة متوسطة (30-50%) → خصم 10 بدون حظر ──
await resetDir();
for (let i = 0; i < 5; i++) {
  await db.create('TradeReview', { pair: 'SOL/USDT', direction: 'long', outcome: i < 2 ? 'win' : 'loss' });
}
r = await evaluateEntry({ pair: 'SOL/USDT', direction: 'buy', confidence: 70 });
ok(r.blocked === false && r.adjustedConfidence === 60, `خصم 10 لنجاح 40% (حصل: ${r.adjustedConfidence})`);

// ── 5) استراتيجية خاسرة (<35%) → حظر ──
await resetDir();
for (let i = 0; i < 6; i++) {
  await db.create('TradeReview', { pair: 'P' + i + '/USDT', direction: 'long', outcome: 'loss', strategy_id: 'bad_strat' });
}
r = await evaluateEntry({ pair: 'NEW/USDT', direction: 'buy', confidence: 90, strategyId: 'bad_strat' });
ok(r.blocked === true, 'استراتيجية 0/6: حظر');

// ── 6) سبب خسارة متكرر (3x) → خصم 10 ──
await resetDir();
for (let i = 0; i < 3; i++) {
  await db.create('TradeReview', { pair: 'BTC/USDT', direction: 'long', outcome: 'win' });
  await db.create('TradeReview', { pair: 'BTC/USDT', direction: 'long', outcome: 'loss', cause: 'أخبار مفاجئة' });
}
r = await evaluateEntry({ pair: 'BTC/USDT', direction: 'buy', confidence: 70 });
ok(r.blocked === false && r.adjustedConfidence <= 60 && r.notes.some((n) => n.includes('أخبار مفاجئة')),
  `سبب متكرر 3x: خصم (حصل: ${r.adjustedConfidence})`);

// ── 7) سقف الخصم MAX_PENALTY=25 (زوج 40% + استراتيجية 40% + سبب 3x = 28 → تُسقف) ──
await resetDir();
await db.create('TradeReview', { pair: 'XRP/USDT', direction: 'long', outcome: 'win' });
await db.create('TradeReview', { pair: 'XRP/USDT', direction: 'long', outcome: 'win' });
for (let i = 0; i < 3; i++) {
  await db.create('TradeReview', { pair: 'XRP/USDT', direction: 'long', outcome: 'loss', cause: 'تقلب' });
}
await db.create('TradeReview', { pair: 'Q1/USDT', direction: 'long', outcome: 'win', strategy_id: 'soso' });
await db.create('TradeReview', { pair: 'Q2/USDT', direction: 'long', outcome: 'win', strategy_id: 'soso' });
for (const q of ['Q3/USDT', 'Q4/USDT', 'Q5/USDT']) {
  await db.create('TradeReview', { pair: q, direction: 'long', outcome: 'loss', strategy_id: 'soso' });
}
r = await evaluateEntry({ pair: 'XRP/USDT', direction: 'buy', confidence: 90, strategyId: 'soso' });
ok(r.blocked === false && r.adjustedConfidence === 65, `الخصم 28 يُسقف عند 25 → ثقة 65 (حصل: ${r.adjustedConfidence})`);

// ── 8) entryStats: تجميع صحيح ──
const st = await entryStats();
ok(st.total >= 10 && st.pairDir['XRP/USDT|long'] && st.pairDir['XRP/USDT|long'].total >= 5, 'إحصاءات مجمعة للزوج+الاتجاه');

// ── 9) lossThrottle: بلا صفقات مغلقة → سماح كامل ──
await resetDir();
let lt = await lossThrottle();
ok(lt.allow === true && lt.riskMult === 1 && lt.consecLosses === 0, 'بلا خسائر: مخاطرة كاملة');

// ── 10) خسارتان متتاليتان → نصف المخاطرة ──
await db.create('Trade', { status: 'closed', pnl: -10, pair: 'A' });
await db.create('Trade', { status: 'closed', pnl: -20, pair: 'B' });
lt = await lossThrottle();
ok(lt.allow === true && lt.riskMult === 0.5 && lt.consecLosses === 2, `خسارتان: نصف المخاطرة (حصل: ${lt.riskMult})`);

// ── 11) بلوغ الكبح (3 افتراضياً) → إيقاف ──
await db.create('Trade', { status: 'closed', pnl: -30, pair: 'C' });
lt = await lossThrottle();
ok(lt.allow === false && lt.riskMult === 0 && lt.consecLosses === 3, 'ثلاث خسائر: إيقاف الدخول');

// ── 12) ربح حديث يكسر السلسلة ──
await db.create('Trade', { status: 'closed', pnl: 50, pair: 'D' });
lt = await lossThrottle();
ok(lt.consecLosses === 0 && lt.allow === true, 'الربح الأحدث يصفّر العد');

// تنظيف
await fs.rm(process.env.DATA_DIR, { recursive: true, force: true });

console.log(`\nالنتيجة: ${pass} ناجح / ${fail} فاشل`);
process.exit(fail ? 1 : 0);
