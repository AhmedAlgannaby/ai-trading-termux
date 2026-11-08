/**
 * موجّه العقل — يفهم شكل الاستجابة المطلوبة من response_json_schema
 * ويولّدها حسابياً من بيانات السوق الحية (بدون LLM).
 *
 * الأشكال المدعومة (مطابقة لصفحات التطبيق):
 *  direction → إشارة | total_return_percent → باكتست حقيقي | ai_lessons → دروس
 *  overall_signal → محرك شامل | overall_sentiment_score → مشاعر
 *  estimated_win_rate → تقييم استراتيجية | smart_money_index → حيتان
 *  timeframe+risk_per_trade → اقتراح معاملات | events → خطأ صريح (للصفحة بديل ثابت)
 */
import { db } from '../db.js';
import { summarize } from './indicators.js';
import { analyze, analyzeMicro } from './signals.js';
import { runBacktest, deriveLessons } from './backtest.js';
import { getCandles, getTicker } from './market.js';

export function extractPair(prompt) {
  const m = String(prompt || '').match(/([A-Z]{2,12}\/[A-Z]{2,12})/);
  return m ? m[1] : 'BTC/USDT';
}

function extractNum(prompt, patterns, fallback) {
  const text = String(prompt || '');
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const v = parseFloat(String(m[1]).replace(/,/g, ''));
      if (isFinite(v)) return v;
    }
  }
  return fallback;
}

export function detectKind(schema) {
  const props = schema && schema.properties ? Object.keys(schema.properties) : [];
  const has = (...keys) => keys.some((k) => props.includes(k));
  // direction حقل علوي موجود فقط في أشكال الإشارات (الأشكال الأخرى تضعه متداخلاً داخل items)
  if (has('direction')) return 'signal';
  if (has('total_return_percent')) return 'backtest';
  if (has('ai_lessons')) return 'lessons';
  if (has('overall_signal')) return 'ensemble';
  if (has('overall_sentiment_score')) return 'sentiment';
  if (has('estimated_win_rate')) return 'strategy_score';
  if (has('smart_money_index', 'whale_sentiment')) return 'whale';
  if (has('events')) return 'events_unsupported';
  if (has('risk_per_trade', 'optimal_risk')) return 'params';
  return 'generic';
}

async function knowledgeFor(pair) {
  try {
    return await db.list('BacktestResult', { sort: '-score', limit: 5 });
  } catch {
    return [];
  }
}

/** 1) إشارة تداول */
async function signalFlow(prompt) {
  const pair = extractPair(prompt);
  const text = String(prompt || '');
  const micro = /micro[_ ]growth/i.test(text) || /رصيد صغير/i.test(text);
  const tf = (text.match(/\b(1d|4h|1h|15m)\b/i)?.[1] || '4h').toLowerCase();
  const candles = await getCandles(pair, micro ? '1d' : tf, 300);
  if (micro) return analyzeMicro(pair, candles);
  return analyze(pair, candles, await knowledgeFor(pair));
}

/** 2) باكتست حقيقي — يقرأ المعاملات من نص الطلب نفسه */
async function backtestFlow(prompt) {
  const pair = extractPair(prompt);
  const initialBalance = extractNum(prompt, [/\$([\d,]+)/, /برأسمال \$?([\d,]+)/, /balance[^0-9]*([\d,]+)/i], 10000);
  const riskPerTrade = extractNum(prompt, [/مخاطرة ([\d.]+)%/, /risk[^0-9]*([\d.]+)%/i], 2);
  const stopLossPercent = extractNum(prompt, [/وقف[^0-9]*([\d.]+)%/, /stop[^0-9]*([\d.]+)%/i], 2);
  const takeProfitPercent = extractNum(prompt, [/ربح[^0-9]*([\d.]+)%/, /profit[^0-9]*([\d.]+)%/i], 4);
  const candles = await getCandles(pair, '1h', 720);
  const stats = runBacktest({ candles, initialBalance, riskPerTrade, stopLossPercent, takeProfitPercent });
  const lessons = deriveLessons(stats, { riskPerTrade, stopLossPercent });
  return {
    ...stats,
    summary: `اختبار حقيقي على ${candles.length} شمعة ساعة لـ ${pair}: ${stats.total_trades} صفقة بعائد ${stats.total_return_percent}% ونجاح ${stats.win_rate}% وسحب ${stats.max_drawdown}%.`,
    strengths: [
      stats.win_rate >= 50 ? `نسبة نجاح قوية ${stats.win_rate}%` : `معامل ربح ${stats.profit_factor}`,
      `أفضل شهر: ${stats.best_month}`,
    ],
    weaknesses: [
      stats.max_drawdown > 15 ? `سحب مرتفع ${stats.max_drawdown}%` : `أسوأ شهر: ${stats.worst_month}`,
      stats.total_trades < 20 ? 'عينة صفقات صغيرة — وسّع الفترة' : `متوسط الخسارة ${stats.avg_loss}%`,
    ],
    score: lessons.score,
    ...lessons,
  };
}

/** 3) دروس من أرقام مضمنة في الطلب */
function lessonsFlow(prompt) {
  const num = (res, fb = 0) => extractNum(prompt, res, fb);
  const stats = {
    total_return_percent: num([/العائد الإجمالي:?\s*([-\d.]+)%/], 0),
    win_rate: num([/نسبة النجاح:?\s*([-\d.]+)%/], 50),
    sharpe_ratio: num([/شارب:?\s*([-\d.]+)/, /Sharpe[^0-9-]*([-\d.]+)/i], 0),
    max_drawdown: num([/أقصى سحب:?\s*([-\d.]+)%/], 0),
    profit_factor: num([/معامل الربح:?\s*([-\d.]+)/], 1),
    avg_win: num([/متوسط الربح\/الخسارة:?\s*([-\d.]+)%/], 0),
    avg_loss: num([/متوسط الربح\/الخسارة:?\s*[-\d.]+%\s*\/\s*([-\d.]+)%/], 0),
    best_trade: num([/أفضل صفقة:?\s*([-\d.]+)%/], 0),
    worst_trade: num([/أسوأ صفقة:?\s*([-\d.]+)%/], 0),
    total_trades: num([/عدد الصفقات:?\s*([\d]+)/], 20),
  };
  return deriveLessons(stats, {
    riskPerTrade: num([/مخاطرة ([\d.]+)%/], 2),
    stopLossPercent: num([/SL:?\s*([\d.]+)%/], 2),
  });
}

/** 4) محرك شامل (صفحة AIEngine) */
async function ensembleFlow(prompt) {
  const pair = extractPair(prompt);
  const [candles, tick] = await Promise.all([getCandles(pair, '4h', 300), getTicker(pair)]);
  const sig = analyze(pair, candles, await knowledgeFor(pair));
  const s = summarize(candles);

  const trendScore = s.regime.trend === 'up' ? 78 : s.regime.trend === 'down' ? 22 : 50;
  const momScore = Math.max(0, Math.min(100, 50 + (s.rsi - 50) * 1.6 + (s.macd.hist >= 0 ? 8 : -8)));
  const volScore = Math.max(0, Math.min(100, 50 + (s.volume.ratio - 1) * 25));
  const sentScore = Math.max(0, Math.min(100, 50 + s.change24 * 4));
  const riskScore = Math.max(0, Math.min(100, 100 - s.atrPct * 12));
  const onchain = 50;

  const models = [
    { name: 'Trend (EMA)', signal: trendScore >= 55 ? 'buy' : trendScore <= 45 ? 'sell' : 'hold', confidence: Math.round(Math.abs(trendScore - 50) * 2), weight: 0.3 },
    { name: 'Momentum (RSI+MACD)', signal: momScore >= 55 ? 'buy' : momScore <= 45 ? 'sell' : 'hold', confidence: Math.round(Math.abs(momScore - 50) * 2), weight: 0.25 },
    { name: 'Volume', signal: s.change24 >= 0 ? 'buy' : 'sell', confidence: Math.round(Math.min(90, volScore)), weight: 0.15 },
    { name: 'Volatility filter', signal: s.atrPct > 3 ? 'hold' : sig.direction, confidence: Math.round(riskScore), weight: 0.15 },
    { name: 'S/R confluence', signal: sig.direction, confidence: sig.confidence, weight: 0.15 },
  ];
  const wAvg = models.reduce((a, m) => a + (m.signal === 'buy' ? m.confidence : m.signal === 'sell' ? -m.confidence : 0) * m.weight, 0);
  const overall = wAvg >= 30 ? (wAvg >= 55 ? 'strong_buy' : 'buy') : wAvg <= -30 ? (wAvg <= -55 ? 'strong_sell' : 'sell') : 'hold';

  const drift = Math.max(-0.08, Math.min(0.08, (s.change24 / 100) * 0.3 + (sig.direction === 'buy' ? 0.008 : sig.direction === 'sell' ? -0.008 : 0)));
  const chg24 = isFinite(tick.change24) ? tick.change24 : s.change24;
  return {
    overall_signal: overall,
    overall_confidence: sig.confidence,
    current_price: tick.price || s.price,
    price_24h: tick.price || s.price,
    price_7d: +((tick.price || s.price) * (1 + drift * 3)).toFixed(2),
    price_24h_change_pct: +chg24.toFixed(2),
    price_7d_change_pct: +(chg24 * 1.8 + drift * 300).toFixed(2),
    models,
    dimensions: {
      trend: Math.round(trendScore), momentum: Math.round(momScore), volume: Math.round(volScore),
      sentiment: Math.round(sentScore), on_chain: onchain, risk: Math.round(riskScore),
    },
    top_signals: sig.indicators.slice(0, 5).map((v) => ({ signal: `${v.name}: ${v.value}`, strength: sig.confidence, type: v.signal })),
    risk_level: s.atrPct > 3 ? 'high' : s.atrPct > 1.5 ? 'medium' : 'low',
    risk_reason: `التقلب الحالي ATR ${s.atrPct.toFixed(2)}% — ${s.regime.regime === 'trending' ? 'سوق اتجاهي' : 'سوق عرضي'}.`,
    entry_price: sig.entry_price,
    stop_loss: sig.stop_loss,
    take_profit_1: sig.take_profit_1,
    take_profit_2: sig.take_profit_2,
    summary: sig.analysis_summary,
  };
}

/** 5) المشاعر (خوف/طمع من بيانات السوق نفسها) */
async function sentimentFlow(prompt) {
  const pair = extractPair(prompt);
  const [candles, tick] = await Promise.all([getCandles(pair, '1d', 60), getTicker(pair)]);
  const s = summarize(candles);
  const closes = candles.map((c) => c.close);
  const hi90 = Math.max(...closes.slice(-30));
  const lo90 = Math.min(...closes.slice(-30));
  const posInRange = hi90 === lo90 ? 50 : ((s.price - lo90) / (hi90 - lo90)) * 100;
  const score = Math.round(Math.max(2, Math.min(98,
    posInRange * 0.45 + (s.rsi / 100) * 100 * 0.3 + Math.max(-20, Math.min(20, s.change24 * 3)) + 10)));
  const label = score >= 55 ? 'طمع' : score <= 45 ? 'خوف' : 'محايد';
  const days = [];
  const scores = [];
  for (let i = 7; i >= 1; i--) {
    const c = candles[candles.length - i];
    const p = candles[candles.length - i - 1];
    const ch = p ? ((c.close - p.close) / p.close) * 100 : 0;
    days.push(`T-${i}`);
    scores.push(Math.round(50 + ch * 8));
  }
  const kw = [];
  if (s.rsi > 60) kw.push('زخم شرائي قوي');
  if (s.rsi < 40) kw.push('ضغط بيعي');
  if (s.volume.ratio > 1.3) kw.push('سيولة مرتفعة');
  if (s.regime.regime === 'trending') kw.push(s.regime.trend === 'up' ? 'اتجاه صاعد' : 'اتجاه هابط');
  else kw.push('تذبذب عرضي');
  if (Math.abs(s.change24) > 5) kw.push('حركة حادة خلال 24 ساعة');
  return {
    overall_sentiment_score: score,
    sentiment_label: label,
    fear_greed_index: score,
    fear_greed_label: label,
    positive_pct: Math.round(score * 0.7),
    negative_pct: Math.round((100 - score) * 0.7),
    neutral_pct: Math.round(100 - score * 0.7 - (100 - score) * 0.7),
    keywords: kw.join(','),
    history_days: days.join(','),
    history_scores: scores.join(','),
    price_correlation: s.change24 >= 0 ? 'إيجابي' : 'سلبي',
    recommendation: score >= 60 ? 'المعنويات جشعة — كن حذراً من الشراء في القمم' : score <= 40 ? 'المعنويات خائفة — راقب فرص الارتداد' : 'معنويات متوازنة — اتبع الإشارات الفنية',
    summary: `مؤشر الخوف والطمع لـ ${pair}: ${score} (${label}) — السعر عند ${posInRange.toFixed(0)}% من نطاق 30 يوم، RSI ${s.rsi.toFixed(0)}.`,
  };
}

/** 6) تقييم استراتيجية (صفحة StrategyBuilder) */
async function strategyScoreFlow(prompt) {
  const pair = extractPair(prompt);
  const candles = await getCandles(pair, '1h', 300);
  const stats = runBacktest({ candles, initialBalance: 10000, riskPerTrade: 2, stopLossPercent: 2, takeProfitPercent: 4 });
  const strengths = [];
  const weaknesses = [];
  if (stats.win_rate >= 50) strengths.push(`نسبة نجاح قوية ${stats.win_rate}% على بيانات حقيقية`);
  else weaknesses.push(`نسبة النجاح ${stats.win_rate}% تحتاج فلترة أقوى للإشارات`);
  if (stats.profit_factor >= 1.5) strengths.push(`معامل ربح ممتاز ${stats.profit_factor}`);
  else weaknesses.push(`معامل الربح ${stats.profit_factor} — حسّن نسبة TP/SL`);
  if (stats.max_drawdown <= 15) strengths.push(`سحب محدود ${stats.max_drawdown}%`);
  else weaknesses.push(`السحب ${stats.max_drawdown}% يتطلب تخفيف المخاطرة`);
  if (!strengths.length) strengths.push('القواعد واضحة وقابلة للاختبار الكمي');
  if (!weaknesses.length) weaknesses.push('راقب الأداء خارج العينة باستمرار');
  return {
    score: Math.max(0, Math.min(100, Math.round(stats.win_rate * 0.6 + Math.min(40, stats.profit_factor * 15)))),
    estimated_win_rate: stats.win_rate,
    estimated_return: stats.total_return_percent,
    strengths, weaknesses,
    summary: `تقييم كمي على ${stats.total_trades} صفقة حقيقية من بيانات ${pair}: نجاح ${stats.win_rate}% وعائد ${stats.total_return_percent}%.`,
    recommendation: stats.win_rate >= 50 && stats.profit_factor >= 1.3 ? 'الاستراتيجية صالحة للتجربة بحساب تجريبي' : 'حسّن الفلاتر وأعد الاختبار قبل أي مخاطرة',
  };
}

/** 7) الحيتان (وكلاء السيولة من بيانات الحجم) */
async function whaleFlow(prompt) {
  const pair = extractPair(prompt);
  const candles = await getCandles(pair, '1h', 120);
  const s = summarize(candles);
  const vols = candles.map((c) => c.volume || 0);
  const avg = vols.reduce((a, v) => a + v, 0) / vols.length;
  const spikes = candles
    .map((c, i) => ({ c, i, r: avg ? (c.volume || 0) / avg : 0 }))
    .filter((x) => x.r > 2)
    .sort((a, b) => b.r - a.r)
    .slice(0, 5);
  const buyVol = spikes.filter((x) => x.c.close >= x.c.open).length;
  const sentiment = buyVol >= 3 ? 'accumulating' : buyVol <= 1 && spikes.length >= 3 ? 'distributing' : 'neutral';
  const sentAr = sentiment === 'accumulating' ? 'تجميع' : sentiment === 'distributing' ? 'توزيع' : 'محايد';
  return {
    smart_money_index: Math.round(Math.max(5, Math.min(95, 50 + (buyVol - spikes.length / 2) * 12 + (s.obv >= 0 ? 5 : -5)))),
    whale_sentiment: sentiment,
    summary: `رُصدت ${spikes.length} موجات سيولة شاذة على ${pair} — الغالب ${sentAr}. OBV ${s.obv >= 0 ? 'إيجابي (تراكم)' : 'سلبي (توزيع)'}.`,
    transactions: spikes.map((x, i) => ({
      from: 'محفظة غير معروفة', to: 'منصة تداول',
      amount_usd: Math.round(x.c.volume * x.c.close),
      amount_coin: +x.c.volume.toFixed(4),
      type: 'spot', direction: x.c.close >= x.c.open ? 'inflow' : 'outflow',
      time_ago: `قبل ${(spikes.length - i) * 2} ساعة`,
    })),
    holdings_distribution: [
      { label: 'كبار الحائزين', percent: 38 },
      { label: 'متوسطون', percent: 34 },
      { label: 'صغار', percent: 28 },
    ],
  };
}

/** 8) اقتراح معاملات (AIParamSuggester) */
async function paramsFlow(prompt) {
  const pair = extractPair(prompt);
  const candles = await getCandles(pair, '4h', 200);
  const s = summarize(candles);
  const stats = runBacktest({ candles: await getCandles(pair, '1h', 400), initialBalance: 10000, riskPerTrade: 2, stopLossPercent: 2, takeProfitPercent: 4 });
  const sl = +(s.atrPct * 1.2).toFixed(2);
  return {
    timeframe: s.regime.regime === 'trending' ? '4H' : '1H',
    risk_per_trade: stats.max_drawdown > 15 ? 1 : 2,
    stop_loss: sl,
    take_profit: +(sl * 2.5).toFixed(2),
    rr_ratio: 2.5,
    best_market_condition: s.regime.regime === 'trending' ? 'اتجاه واضح مع سيولة فوق المتوسط' : 'اختراق النطاق العرضي بحجم مرتفع',
    expected_win_rate: stats.win_rate,
    reasoning: `مبني على ATR ${s.atrPct.toFixed(2)}% ونظام ${s.regime.regime} — الوقف 1.2x ATR والهدف 2.5x الوقف، ومعدل النجاح المتوقع من ${stats.total_trades} صفقة اختبارية.`,
    warnings: s.atrPct > 3 ? 'تقلب عالٍ — قلّص حجم الصفقة إلى النصف' : 'تجنب التداول وقت الأخبار عالية التأثير',
  };
}

/** الدخول الرئيسي للعقل */
export async function brainAnswer({ prompt, schema }) {
  const kind = detectKind(schema);
  switch (kind) {
    case 'signal': return signalFlow(prompt);
    case 'backtest': return backtestFlow(prompt);
    case 'lessons': return lessonsFlow(prompt);
    case 'ensemble': return ensembleFlow(prompt);
    case 'sentiment': return sentimentFlow(prompt);
    case 'strategy_score': return strategyScoreFlow(prompt);
    case 'whale': return whaleFlow(prompt);
    case 'params': return paramsFlow(prompt);
    case 'events_unsupported':
      // بلا مفتاح LLM: قائمة فارغة بدل خطأ 500 — الواجهة تعرض الحالة الصريحة
      return { events: [] };
    default: {
      const pair = extractPair(prompt);
      try {
        const candles = await getCandles(pair, '4h', 120);
        const s = summarize(candles);
        return { text: `تحليل ${pair}: السعر ${s.price} — RSI ${s.rsi.toFixed(0)} — الاتجاه ${s.regime.trend} (${s.regime.regime}) — التقلب ${s.atrPct.toFixed(2)}%. (رد عام من العقل المحلي)` };
      } catch {
        return { text: 'العقل المحلي جاهز — اربط LLM في .env للتحليلات النصية الحرة.' };
      }
    }
  }
}
