#!/data/data/com.termux/files/usr/bin/bash
# فحص حالة السيرفر والعامل والبيانات
cd "$(dirname "$0")"
PORT="${PORT:-3001}"

echo "=== AI Trading status ==="
echo "Dir: $(pwd)"

if pgrep -f "node server/index.js" >/dev/null 2>&1; then
  echo "✅ Server process: RUNNING (pid $(pgrep -f 'node server/index.js' | tr '\n' ' '))"
else
  echo "❌ Server process: NOT running — run ./run.sh"
fi

echo ""
echo "--- Health (/api/health) ---"
curl -s "http://127.0.0.1:$PORT/api/health" || echo "(no response — is server up?)"
echo ""

echo "--- Quick checks ---"
curl -s -o /dev/null -w "UI http://localhost:$PORT/  -> HTTP %{http_code}\n" "http://127.0.0.1:$PORT/" || true

echo ""
echo "--- Data files ---"
ls -lh server/data/*.json 2>/dev/null || echo "(no data yet)"
echo ""
echo "Logs: tail -n 50 logs/server.log"
echo "Worker stats: curl -s http://127.0.0.1:$PORT/api/health | python3 -m json.tool 2>/dev/null || curl -s http://127.0.0.1:$PORT/api/health"
