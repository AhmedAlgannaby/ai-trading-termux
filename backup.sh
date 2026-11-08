#!/data/data/com.termux/files/usr/bin/bash
# نسخ احتياطي لبيانات التداول (JSON) + الإعدادات
set -e
cd "$(dirname "$0")"
mkdir -p backups
stamp=$(date +%Y%m%d-%H%M%S)
tar -czf "backups/ai-trading-data-$stamp.tar.gz" server/data .env 2>/dev/null || tar -czf "backups/ai-trading-data-$stamp.tar.gz" server/data
echo "✅ Backup created: backups/ai-trading-data-$stamp.tar.gz"
ls -lh backups/ | tail -n 10
# امسح backups أقدم من 30 يوم
find backups -name "ai-trading-data-*.tar.gz" -mtime +30 -delete 2>/dev/null || true
