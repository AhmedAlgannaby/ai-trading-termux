#!/data/data/com.termux/files/usr/bin/bash
# الصيانة الأسبوعية (دقيقتان): تحديث الشموع + إعادة قياس الاستراتيجيات
# شغّله يدوياً كل أسبوع، أو اجدوله عبر cron في Termux
cd "$(dirname "$0")"
echo "Fetching candles…"
node server/brain/history.js
echo ""
echo "Learning / measuring strategies…"
node server/brain/learn.js
echo ""
echo "✅ Weekly history done."
