/**
 * باكتست استراتيجية Micro Growth على BTC/ETH — إطار يومي 1D.
 * التشغيل: npm run backtest:micro
 *
 * يختبر القواعد الحية نفسها: رصيد $10، مخاطرة 2%، وقف ثابت 1.5%، هدف أول 4.5% (3R)،
 * حد أدنى $5، رافعة قصوى 2x، مع رسوم وانزلاق محافظين (0.05% + 0.02% لكل جانب).
 * ويعرض أيضاً نسخة ATR (1.5×ATR) التي ترفضها القيود العملية للرصيد الصغير.
 */
import { getCandles } from '../server/brain/market.js';
import { runBacktest, walkForward } from '../server/brain/backtest.js';
import { getSpec } from '../server/brain/strategies.js';

const PAIRS = ['BTC/USDT', 'ETH/USDT'];
const spec = getSpec('micro_growth');
const common = {
  initialBalance: 10,
  riskPerTrade: 2,
  maxHoldBars: 60,
  minSizeUsd: 5,
  maxLeverage: 2,
};
const variants = [
  {
    label: 'القواعد الحية: ثابت 1.5% / 4.5%',
    cfg: { ...common, useAtr: false, stopLossPercent: 1.5, takeProfitPercent: 4.5 },
  },
  {
    label: 'ATR 1.5× (غير قابل للتنفيذ عملياً على $10)',
    cfg: { ...common, useAtr: true, slAtr: 1.5, tpR: [3, 4, 6] },
  },
];

for (const pair of PAIRS) {
  try {
    const candles = await getCandles(pair, '1d', 1000);
    console.log(`\n=== ${pair} | 1D | ${candles.length} شمعة ===`);
    for (const { label, cfg } of variants) {
      const full = runBacktest({ candles, ...cfg, strategySpec: spec });
      const wf = walkForward({ candles, spec, windows: 4, ...cfg });
      console.log(`\n[${label}]`);
      console.log(`الصفقات: ${full.total_trades} | الفوز: ${full.win_rate}% | العائد: ${full.total_return_percent}% | أقصى سحب: ${full.max_drawdown}% | شارب: ${full.sharpe_ratio}`);
      console.log(`خارج العينة: ${wf.oos_trades} صفقة | فوز ${wf.oos_win_rate}% | عائد ${wf.oos_return_percent}% | سحب ${wf.oos_max_drawdown}%`);
      console.log(`مونت كارلو: احتمال الربح ${wf.monte_carlo?.prob_profit}% | وسيط العائد ${wf.monte_carlo?.median_return}% | وسيط أقصى سحب ${wf.monte_carlo?.median_max_dd}%`);
    }
  } catch (err) {
    console.error(`تعذر اختبار ${pair}: ${err.message}`);
  }
}
