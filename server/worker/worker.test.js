/**
 * اختبارات العامل — خالصة بلا شبكة ولا قاعدة بيانات:
 *   node server/worker/worker.test.js
 */
import { adjustTrade } from './adaptive.js';

let pass = 0, fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
}

const long = { type: 'long', entry_price: 100, stop_loss: 98, take_profit_1: 106 };
const short = { type: 'short', entry_price: 100, stop_loss: 102, take_profit_1: 94 };

// 1) انعكاس النظام ضد الشراء → تصفير نصف المخاطرة (98 → 99)
const r1 = adjustTrade({ ...long }, 101, { regime: { trend: 'down', regime: 'trending' }, rsiV: 55, atrPct: 1 });
ok(r1.sl === 99 && r1.tp === 106 && r1.reasons.length === 1, 'انعكاس النظام يصفّر نصف المخاطرة', JSON.stringify(r1));

// 2) إجهاد الزخم → تقريب الهدف (106 → 103)
const r2 = adjustTrade({ ...long }, 104, { regime: { trend: 'up', regime: 'trending' }, rsiV: 80, atrPct: 1 });
ok(r2.tp === 103 && r2.sl === 98 && r2.reasons.length === 1, 'إجهاد RSI يقرّب الهدف', JSON.stringify(r2));

// 3) تقلب متفجر → سقف 2×ATR (101-2=99)
const r3 = adjustTrade({ ...long }, 101, { regime: { trend: 'up', regime: 'trending' }, rsiV: 55, atrPct: 4, atrV: 1 });
ok(r3.sl === 99 && r3.reasons.length === 1, 'التقلب يضيّق الوقف', JSON.stringify(r3));

// 4) لا توسيع أبداً: وقف أضيق من السقف يبقى كما هو
const tight = { ...long, stop_loss: 99.5 };
const r4 = adjustTrade(tight, 101, { regime: { trend: 'up', regime: 'trending' }, rsiV: 55, atrPct: 4, atrV: 1 });
ok(r4.sl === 99.5 && r4.reasons.length === 0, 'لا توسيع للوقف الضيق أصلاً');

// 5) البيع معكوس الاتجاهات
const r5 = adjustTrade({ ...short }, 99, { regime: { trend: 'up', regime: 'trending' }, rsiV: 45, atrPct: 1 });
ok(r5.sl === 101 && r5.reasons.length === 1, 'انعكاس النظام للبيع', JSON.stringify(r5));
const r6 = adjustTrade({ ...short }, 96, { regime: { trend: 'down', regime: 'trending' }, rsiV: 20, atrPct: 1 });
ok(r6.tp === 97 && r6.sl === 102, 'إجهاد البيع يقرّب الهدف', JSON.stringify(r6));

// 6) سوق هادئ موافق → لا تعديل إطلاقاً
const r7 = adjustTrade({ ...long }, 101, { regime: { trend: 'up', regime: 'trending' }, rsiV: 55, atrPct: 1 });
ok(r7.sl === 98 && r7.tp === 106 && r7.reasons.length === 0, 'لا تعديل بلا سبب');

// 7) مدخلات فاسدة → إرجاع آمن
const r8 = adjustTrade({ ...long, stop_loss: null }, 101, { regime: { trend: 'up', regime: 'trending' }, rsiV: 55, atrPct: 1 });
ok(r8.reasons.length === 0, 'مدخلات ناقصة آمنة');

// ── E: حراس الدفعة الثالثة ──
// 8) بعد التعادل (وقف = دخول) + إجهاد RSI → الهدف لا ينهار للدخول
const be = adjustTrade({ ...long, stop_loss: 100 }, 105, { regime: { trend: 'up', regime: 'trending' }, rsiV: 80, atrPct: 1 });
ok(be.tp === 106 && be.sl === 100, 'مخاطرة صفرية: الهدف ثابت لا ينهار');

// 9) انعكاس النظام لا يدفع الوقف فوق السعر أبداً
const wide = adjustTrade({ ...long, stop_loss: 90 }, 97, { regime: { trend: 'down', regime: 'trending' }, rsiV: 55, atrPct: 1 });
ok(wide.sl === 95 && wide.sl <= 97, `تضييق تحت السعر (${wide.sl})`);
const cross = adjustTrade({ ...long }, 97, { regime: { trend: 'down', regime: 'trending' }, rsiV: 55, atrPct: 1 });
ok(cross.sl === 98 && cross.reasons.length === 0, 'وقف قديم فوق السوق: لا نقلة وهمية (المراقب يغلق بسعر السوق)');

console.log(`\nالنتيجة: ${pass} ناجح / ${fail} فاشل`);
process.exit(fail ? 1 : 0);
