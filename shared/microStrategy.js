/**
 * Micro Growth — استراتيجية الرصيد الصغير ($100 أو أقل)
 *
 * تُستخدم من الواجهة (AutoPaperTrader / AutoTrading / بطاقة الاستراتيجية)
 * ومن السيرفر (executeSignal) كي لا يفتح أي مسار صفقات أكبر من طاقة الحساب.
 *
 * القواعد:
 *  - 4 أزواج رئيسية فقط عالية السيولة: BTC, ETH, SOL, BNB
 *  - صفقة واحدة مفتوحة كحد أقصى
 *  - مخاطرة 2% تحت $50، و1.5% حتى $200، و1% فوقها
 *  - رافعة قصوى 2x (فيوتشر) — الهامش المعزول
 *  - دخول 1D حتمي: EMA20/EMA50 + MACD
 *  - وقف ثابت 1.5% وهدف أول 4.5% (3R)
 *  - وقف يومي 2% وحد أقصى صفقتان يومياً
 *  - لا صفقة إذا كان الحجم أقل من حد Binance الأدنى ($5) أو الربح لا يغطي الرسوم
 */

export const MICRO_BALANCE_LIMIT = 100;
export const MICRO_PAIRS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT'];
export const MICRO_MAX_POSITIONS = 1;
export const MICRO_MAX_LEVERAGE = 2;
export const MICRO_MIN_NOTIONAL = 5; // Binance futures minimum notional ≈ $5
export const MICRO_TAKER_FEE = 0.0004; // 0.04% per side (futures taker)
export const MICRO_DAILY_LOSS_PCT = 2;
export const MICRO_MAX_TRADES_PER_DAY = 2;
export const MICRO_MIN_CONFIDENCE = 70;
export const MICRO_MIN_WIN_PROB = 0.55;
// القواعد الحية: وقف ثابت 1.5% وهدف أول 4.5% (3R) — هي النسخة التي اختُبرت تاريخياً.
// وقف ATR الواسع على 1D يجعل حجم $10 أقل من حد Binance ($5) فلا تُفتح صفقات.
export const MICRO_SL_PCT = 1.5;
export const MICRO_TP_R = [3, 4, 6]; // R multiples
export const MICRO_TP_PCT = MICRO_TP_R.map((r) => +(MICRO_SL_PCT * r).toFixed(2)); // [4.5, 6, 9]

export function isMicroBalance(balance) {
  const b = Number(balance);
  return Number.isFinite(b) && b > 0 && b <= MICRO_BALANCE_LIMIT;
}

export function microRiskPct(balance) {
  const b = Number(balance) || 0;
  if (b < 50) return 2;
  if (b < 200) return 1.5;
  return 1;
}

export function microDailyLossUsd(balance) {
  const b = Number(balance) || 0;
  return Math.round(b * MICRO_DAILY_LOSS_PCT) / 100;
}

/**
 * حجم الصفقة بالدولار (notional) مع مراعاة الوقف والرافعة والحد الأدنى والرسوم.
 * @returns {{ok:boolean,size:number,riskUsd:number,slPct:number,leverageUsed:number,fees:number,grossTp:number,netTp:number,reason:string|null}}
 */
export function microPositionSize({
  balance,
  entry,
  stop,
  riskPct = microRiskPct(balance),
  leverage = MICRO_MAX_LEVERAGE,
}) {
  const b = Number(balance);
  const e = Number(entry);
  const s = Number(stop);
  if (!(b > 0) || !(e > 0) || !(s > 0) || e === s) {
    return {
      ok: false, size: 0, riskUsd: 0, slPct: 0, leverageUsed: 0,
      fees: 0, grossTp: 0, netTp: 0, reason: 'سعر الدخول أو الوقف غير صالح',
    };
  }
  const slPct = Math.abs(e - s) / e;
  const riskUsd = (b * (Number(riskPct) || 1)) / 100;
  const rawSize = slPct > 0 ? riskUsd / slPct : 0;
  const cap = b * Math.min(Math.max(Number(leverage) || 1, 1), MICRO_MAX_LEVERAGE);
  const size = Math.min(rawSize, cap);
  const fees = size * MICRO_TAKER_FEE * 2;
  const tp1Pct = slPct * MICRO_TP_R[0];
  const grossTp = size * tp1Pct;
  const netTp = grossTp - fees;
  const ok = size >= MICRO_MIN_NOTIONAL && netTp > 0;
  return {
    ok,
    size: Math.round(size * 100) / 100,
    riskUsd: Math.round(riskUsd * 100) / 100,
    slPct: Math.round(slPct * 10000) / 100,
    leverageUsed: Math.round((size / b) * 100) / 100,
    fees: Math.round(fees * 100) / 100,
    grossTp: Math.round(grossTp * 100) / 100,
    netTp: Math.round(netTp * 100) / 100,
    reason: ok
      ? null
      : size < MICRO_MIN_NOTIONAL
        ? `الحجم ${size.toFixed(2)}$ أقل من الحد الأدنى $${MICRO_MIN_NOTIONAL}`
        : 'الربح المتوقع لا يغطي الرسوم',
  };
}

export const MICRO_RULES = [
  'الأزواج: BTC/USDT، ETH/USDT، SOL/USDT، BNB/USDT فقط.',
  'صفقة واحدة مفتوحة كحد أقصى — وصفقتان يومياً كحد أقصى.',
  'مخاطرة 2% تحت $50 (1.5% حتى $200) — خسارة واحدة توقف اليوم.',
  'رافعة قصوى 2x في سوق العقود الآجلة (هامش معزول).',
  'دخول مع اتجاه 1D: السعر فوق EMA20 وفوق EMA50 مع MACD إيجابي (والعكس للبيع).',
  'وقف ثابت 1.5% وهدف أول 4.5% (3R) — نسبة عائد/مخاطرة 1:3.',
  'وقف يومي عند -2% ووقف أسبوعي عند -4%.',
  'لا دخول إذا كان حجم الصفقة أقل من $5 أو الربح المتوقع لا يغطي الرسوم.',
];
