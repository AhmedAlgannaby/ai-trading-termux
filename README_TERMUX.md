# AI Trading — نسخة Termux (24/7)

هذه نسخة خفيفة من التطبيق مصممة للتشغيل **24/7 على هاتف Android عبر Termux** لاختبار مخرجات المنصة (paper trading).

- **خفيفة:** السيرفر فقط + واجهة جاهزة (`dist/`) — لا حاجة لبناء الواجهة على الهاتف (يوفّر ذاكرة ووقت).
- **بلا متصفح مطلوب:** العامل (monitor + generator + learner + notifier) يعمل داخل السيرفر.
- **البيانات:** ملفات JSON في `server/data/` — تُنسخ احتياطياً بنسخ المجلد.

## ماذا في هذا المجلد؟

| ملف | الغرض |
|---|---|
| `server/` | سيرفر Node (Express) + العقل الكمي + العامل 24/7 |
| `dist/` | الواجهة المبنية — يقدّمها السيرفر على نفس المنفذ |
| `shared/` | تقنيات مشتركة (microStrategy) يستوردها السيرفر |
| `.env` | إعدادات Termux الجاهزة (توليد كل 60 دقيقة، عامل مفعّل) |
| `install.sh` | تثبيت Node + الاعتماديات + فحص |
| `run.sh` | تشغيل 24/7 مع wake-lock وإعادة تشغيل تلقائية |
| `status.sh` / `stop.sh` | فحص الحالة / الإيقاف |
| `backup.sh` | نسخ احتياطي للبيانات |
| `history-weekly.sh` | الصيانة الأسبوعية (شموع + قياس استراتيجيات) |
| `boot.sh` | تشغيل تلقائي بعد إعادة تشغيل الهاتف (Termux:Boot) |

## 1) على الهاتف — التجهيز (مرة واحدة)

ثبّت من **F-Droid** (لا تستخدم Play Store — نسخة قديمة):
- **Termux** (com.termux)
- **Termux:API** (لـ wake-lock) — اختياري لكن موصى به
- **Termux:Boot** — للتشغيل التلقائي بعد Reboot

ثم في Termux:

```bash
pkg update -y
pkg install -y nodejs git curl
termux-setup-storage   # اختياري: وصول لملفات المشاركة
```

## 2) نقل النسخة إلى الهاتف

انسخ مجلد `termux-app` كاملاً إلى الهاتف (USB / Drive / adb)، ثم:

```bash
cd ~/ai-trading-termux      # أو مسار المجلد عندك
bash install.sh
```

`install.sh` يثبّت Node إن غاب + `npm install --omit=dev` (3 حزم فقط: express, cors, dotenv) + يشغّل الاختبارات.

> ⚠️ انسخ **بدون** `node_modules` (تولّد على الهاتف). انسخ `dist/` و `server/` و `shared/` وكل ملفات `.sh` و `.env`.

## 3) التشغيل 24/7

```bash
bash run.sh
```

- يطلب **wake-lock** لمنع أندرويد من قتل العملية أثناء النوم.
- إن ماتت العملية تُعاد تلقائياً بعد 10 ثوانٍ.
- السجلات: `logs/server.log` — راقبها بـ `tail -n 50 logs/server.log` أو `tail -f logs/server.log`.

للتشغيل في الخلفية من Termux (بدون إبقاء التطبيق مفتوحاً):

```bash
nohup bash run.sh > logs/run.log 2>&1 &
echo $!
```

وافتح الواجهة في **متصفح الهاتف**:

```
http://localhost:3001
```

## 4) إعدادات التجربة قبل البدء (في الواجهة)

1. **صفحة إدارة المخاطر:** `execution_mode=auto` (أو `semi_auto` للموافقة اليدوية)، `trading_mode=paper`
2. `max_open_positions` و `max_risk_per_trade` و `circuit_breaker_losses` حسب راحتك
3. **الإعدادات:** Telegram Bot Token + Chat ID (المنبّه يرسل تلقائياً)
4. مفاتيح Binance **غير مطلوبة** للتجريبي (الأسعار عامة). مفاتيح testnet اختيارية لاحقاً.
5. `AI_CRON_MINUTES=60` في `.env` يولّد إشارة تلقائية كل ساعة — يكفي لاختبار المخرجات.

فحص سريع:

```bash
bash status.sh
curl -s http://127.0.0.1:3001/api/health
```

## 5) متابعة المخرجات

- **سجل `AlertLog`** (فتح/إغلاق/تعديل وقف/كبح) + **صفحة الأداء** + **`TradeReview`** (سبب كل خسارة) + **`StrategyScore`** (درجات walk-forward).
- العامل يعمل بلا متصفح — أغلقه إن أردت، وافتحه للمراجعة فقط.
- الصيانة الأسبوعية (دقيقتان):
  ```bash
  bash history-weekly.sh
  ```

## 6) التشغيل التلقائي بعد Reboot (اختياري)

```bash
pkg install termux-tools
mkdir -p ~/.termux/boot
cp boot.sh ~/.termux/boot/trading
chmod +x ~/.termux/boot/trading
```

ثم أعطِ تطبيق **Termux:Boot** صلاحية الخلفية من إعدادات أندرويد. وعدّل مسار `cd` داخل `boot.sh` لمجلدك إن اختلف.

## 7) بقاء الهاتف حياً (مهم!)

أندرويد يقتل التطبيقات في الخلفية لتوفير البطارية. لتقليل ذلك:
- عطّل **تحسين البطارية (Battery Optimization)** لتطبيق Termux من الإعدادات.
- اترك التطبيق **مقفلاً (locked)** في قائمة التطبيقات الحديثة (القلب/القفل حسب الجهاز).
- لا تستخدم وضع توفير البطارية الأقصى أثناء التجربة.
- الشارح `termux-wake-lock` يساعد لكنه **لا يلغي** سياسات بعض المصنّعين (Xiaomi/Samsung/Oppo...). إن قُتلت العملية، أعد التشغيل بـ `nohup bash run.sh ... &` أو فعّل Boot.

## 8) النسخ الاحتياطي

```bash
bash backup.sh   # ينتج backups/ai-trading-data-YYYYMMDD-HHMMSS.tar.gz
```

انقل النسخ خارج الهاتف دورياً (البيانات في `server/data/` هي كل شيء: الصفقات والإشارات والنتائج).

## 9) الفتح من جهاز آخر (PC) عبر الشبكة

افتراضياً السيرفر يسمح بـ **localhost فقط** (آمن). للفتح من PC:

1. وصّل الهاتف وPC على نفس Wi-Fi (أو Tailscale) — لا تفتح منفذاً للإنترنت العام.
2. ضع توكناً قوياً في `.env` (`LOCAL_API_TOKEN=...`) وأعد **بناء الواجهة** بـ `VITE_API_TOKEN` مطابق — لأن التوكن يُدمج في الواجهة عند البناء (لا يعمل بلا إعادة بناء).
3. اعد التشغيل: `bash stop.sh && nohup bash run.sh > logs/run.log 2>&1 &`
4. افتح `http://<IP-الهاتف>:3001` من PC.

إن لم ترد التعقيد، استخدم **adb port-forward** أو **Tailscale** وافتح `http://localhost:3001` من PC عبر الأنفاق — أبسط وأأمن.

## 10) تحديث النسخة لاحقاً

- انسخ `server/` + `dist/` + `shared/` الجديدين فوق القديمين (تجنّب `server/data/` و `.env`).
- `npm install --omit=dev` ثم `bash stop.sh && nohup bash run.sh > logs/run.log 2>&1 &`
- قبل ذلك: `bash backup.sh`

## استكشاف الأخطاء

| المشكلة | الحل |
|---|---|
| `node: command not found` | `pkg install -y nodejs` ثم `bash install.sh` |
| المنفذ 3001 مشغول | `pkill -f "node server/index.js"` ثم `bash run.sh` |
| العملية تموت عند قفل الشاشة | عطّل تحسين البطارية لـ Termux + `termux-wake-lock` + اقفل التطبيق في الخلفية |
| البيانات فارغة | افتح الواجهة وادخل الإعدادات، ثم انتظر دورة المراقب (30s) |
| `dist/` قديم | أعد بناء الواجهة على PC (`npm run build`) وانسخ `dist/` الجديد |

> ملاحظة: لا تشغّل نسختين على نفس `server/data/` — نسخة Termux و PC متزامنة ليست مدعومة (ملفات JSON). النسختان المكرّتان مختلفتا البيانات. إن أردت الاستمرار على PC، أوقف Termux أولاً، وانسخ `server/data/` منه إلى PC.
