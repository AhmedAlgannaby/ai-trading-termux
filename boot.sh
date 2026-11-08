#!/data/data/com.termux/files/usr/bin/bash
# نسخة termux-boot: تشغيل تلقائي بعد إعادة تشغيل الهاتف
# التثبيت: انسخ هذا الملف إلى ~/.termux/boot/trading ثم chmod +x
# المطلوب: تطبيق Termux:Boot من F-Droid (منح صلاحية الخلفية)
cd "$HOME/ai-trading-termux" 2>/dev/null || cd "$(dirname "$0")"
sleep 15
bash ./run.sh >> logs/boot.log 2>&1 &
echo "[$(date '+%Y-%m-%d %H:%M:%S')] boot start" >> logs/boot.log
