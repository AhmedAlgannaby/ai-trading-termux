/**
 * تستات مستشار الخروج (خالصة):
 *   node server/brain/exitAdvice.test.js
 */
import { adviseExit } from './exitAdvice.js';

let pass = 0, fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
}

// 1) الهدف قريب + رابح → انتظار
let v = adviseExit({ unrealizedPnlPct: 1.5, tpDistancePct: 0.3, positionType: 'long', freshDirection: 'buy', freshConfidence: 70 });
ok(v.verdict === 'hold' && /قريب/.test(v.reasons.join('')), 'هدف قريب → انتظار');

// 2) خاسر + تحليل مع الصفقة → انتظار (ارتداد)
v = adviseExit({ unrealizedPnlPct: -2, tpDistancePct: 5, positionType: 'long', freshDirection: 'buy', freshConfidence: 75 });
ok(v.verdict === 'hold' && /الارتداد/.test(v.reasons.join('')), 'خسارة + تحليل معاك → انتظار');

// 3) خاسر + تحليل ضد الصفقة → إغلاق
v = adviseExit({ unrealizedPnlPct: -3, tpDistancePct: 6, positionType: 'long', freshDirection: 'sell', freshConfidence: 80 });
ok(v.verdict === 'close', 'خسارة + انعكاس → إغلاق');

// 4) خاسر + تحليل ضعيف → انتظار (لا إغلاق عند الشك)
v = adviseExit({ unrealizedPnlPct: -3, tpDistancePct: 6, positionType: 'long', freshDirection: 'sell', freshConfidence: 50 });
ok(v.verdict === 'hold', 'ثقة ضعيفة → انتظار (افتراضي آمن)');

// 5) رابح + انعكاس قوي → إغلاق لحماية الربح
v = adviseExit({ unrealizedPnlPct: 2, tpDistancePct: 3, positionType: 'long', freshDirection: 'sell', freshConfidence: 85 });
ok(v.verdict === 'close' && /الربح/.test(v.reasons.join('')), 'ربح + انعكاس قوي → إغلاق');

// 6) رابح عادي → انتظار
v = adviseExit({ unrealizedPnlPct: 1, tpDistancePct: 3, positionType: 'long', freshDirection: 'buy', freshConfidence: 60 });
ok(v.verdict === 'hold', 'ربح بلا عكس → انتظار');

// 7) خاسر + hold → انتظار
v = adviseExit({ unrealizedPnlPct: -1, tpDistancePct: 4, positionType: 'long', freshDirection: 'hold', freshConfidence: 50 });
ok(v.verdict === 'hold', 'خسارة بلا قناعة → انتظار');

// 8) مدخلات فارغة → انتظار آمن
v = adviseExit({});
ok(v.verdict === 'hold' && v.confidence <= 60, 'فراغ → انتظار آمن');

// 9) الشكل ثابت
v = adviseExit({ unrealizedPnlPct: 0, positionType: 'long', freshDirection: 'hold', freshConfidence: 0 });
ok(['hold', 'close'].includes(v.verdict) && Array.isArray(v.reasons) && isFinite(v.confidence), 'شكل الناتج ثابت');

console.log(`\nالنتيجة: ${pass} ناجح / ${fail} فاشل`);
process.exit(fail ? 1 : 0);
