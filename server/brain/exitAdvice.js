/**
 * مستشار الخروج — منطق خالص قابل للاختبار (بلا IO وبلا شبكة):
 *   node server/brain/exitAdvice.test.js
 *
 * القاعدة الذهبية: الافتراضي انتظار — لا توصية إغلاق عند الشك.
 * يُغلق فقط: ربح تحقق + انعكاس قوي، أو خسارة + تحليل طازج ضد الصفقة.
 *
 * @param {object} a
 * @param {number} a.unrealizedPnlPct الربح/الخسارة غير المحققة %
 * @param {number|null} a.tpDistancePct المسافة للهدف % (موجبة = قبل الهدف)
 * @param {number|null} a.slDistancePct المسافة للوقف % (موجبة = قبل الوقف)
 * @param {string} a.positionType 'long' فقط حالياً (السبوت شراء فقط)
 * @param {string} a.freshDirection اتجاه التحليل الطازج buy/sell/hold
 * @param {number} a.freshConfidence ثقة التحليل الطازج 0..100
 * @returns {{verdict:'hold'|'close', confidence:number, reasons:string[]}}
 */
const MIN_CONF = 65;
const TP_NEAR_PCT = 0.5;

export function adviseExit(a = {}) {
  const reasons = [];
  const pnl = Number(a.unrealizedPnlPct) || 0;
  const tpD = a.tpDistancePct === null || a.tpDistancePct === undefined ? null : Number(a.tpDistancePct);
  const dir = a.freshDirection;
  const conf = Number(a.freshConfidence) || 0;
  const withPos = dir === 'buy';
  const againstPos = dir === 'sell';

  // 1) الهدف قريب ونحن رابحون → انتظار (لا تخرج قبل القطف)
  if (pnl > 0 && tpD !== null && isFinite(tpD) && tpD <= TP_NEAR_PCT) {
    reasons.push(`أخذ الربح قريب (${tpD.toFixed(2)}% فقط) — الانتظار أوصى به`);
    return { verdict: 'hold', confidence: 80, reasons };
  }

  // 2) خاسر + التحليل الطازج مع الصفقة بثقة → انتظار (ارتداد متوقع)
  if (pnl < 0 && withPos && conf >= MIN_CONF) {
    reasons.push(`خسارة حالية ${pnl.toFixed(2)}% لكن التحليل الطازج مع الصفقة (شراء ${conf}%) — متوقع الارتداد`);
    return { verdict: 'hold', confidence: Math.min(85, conf), reasons };
  }

  // 3) خاسر + التحليل ضد الصفقة بثقة → إغلاق
  if (pnl < 0 && againstPos && conf >= MIN_CONF) {
    reasons.push(`خسارة ${pnl.toFixed(2)}% والتحليل الطازج انعكس ضد الصفقة (بيع ${conf}%) — الإغلاق أوصى به`);
    return { verdict: 'close', confidence: Math.min(90, conf), reasons };
  }

  // 4) رابح + انعكاس قوي جداً (بيع بثقة عالية) → إغلاق لحماية الربح
  if (pnl > 0 && againstPos && conf >= 80) {
    reasons.push(`ربح ${pnl.toFixed(2)}% لكن انعكاس قوي (بيع ${conf}%) — احمِ الربح بالإغلاق`);
    return { verdict: 'close', confidence: Math.min(88, conf), reasons };
  }

  // 5) رابح بلا إشارة عكسية → انتظار (دع الربح ينمو للهدف/التتبع)
  if (pnl > 0) {
    reasons.push(`ربح غير محقق ${pnl.toFixed(2)}% بلا إشارة عكسية — الانتظار أوصى به`);
    return { verdict: 'hold', confidence: 70, reasons };
  }

  // 6) خاسر بلا قناعة تحليلية → انتظار (الوقف والتتبع يتوليان الحماية)
  reasons.push('لا قناعة تحليلية كافية — القرار: انتظار (الحماية عبر الوقف)');
  return { verdict: 'hold', confidence: 55, reasons };
}
