#!/data/data/com.termux/files/usr/bin/bash
# تشغيل 24/7 على Termux مع wake-lock وإعادة تشغيل تلقائية
# الاستخدام: bash run.sh   (اتركه يعمل، أو شغّله عبر nohup/termux-boot)
set -e
cd "$(dirname "$0")"

mkdir -p logs
export PORT="${PORT:-3001}"

# منع نوم أندرويد عن العملية (يُعيد المحاولة لو فشل — لا نوقف التشغيل بسببه)
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock || echo "⚠️ termux-wake-lock failed (battery saver may kill app later)."
else
  echo "⚠️ termux-wake-lock not found — install Termux:API addon + app for wake-lock."
fi

# تأكد أن .env موجود
if [ ! -f .env ]; then
  cp .env.example .env
  echo "No .env found — copied .env.example. Edit .env then restart."
fi

echo "=== AI Trading 24/7 ==="
echo "Dir:  $(pwd)"
echo "Port: $PORT  (http://localhost:$PORT)"
echo "Data: $(pwd)/server/data"
echo "Logs: $(pwd)/logs/server.log"

# حلقة إعادة تشغيل: إن ماتت العملية لسبب ما تُعاد بعد 10 ثوانٍ
while true; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] starting server…"
  node server/index.js >> logs/server.log 2>&1
  code=$?
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] server exited with code $code — restarting in 10s…"
  sleep 10
done
