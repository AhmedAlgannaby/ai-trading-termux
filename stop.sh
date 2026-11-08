#!/data/data/com.termux/files/usr/bin/bash
# إيقاف السيرفر
cd "$(dirname "$0")"
if pgrep -f "run.sh" >/dev/null 2>&1; then
  echo "Stopping run.sh supervisor…"
  pkill -f "run.sh" || true
fi
if pgrep -f "node server/index.js" >/dev/null 2>&1; then
  echo "Stopping server…"
  pkill -f "node server/index.js" || true
  sleep 1
fi
echo "✅ Stopped. Data kept in server/data/"
