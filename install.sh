#!/data/data/com.termux/files/usr/bin/bash
# تثبيت AI Trading على Termux
# الاستخدام: bash install.sh
set -e
cd "$(dirname "$0")"

echo "=== AI Trading — Termux install ==="
echo "Working dir: $(pwd)"
node --version 2>/dev/null || echo "Node not found — installing…"

if ! command -v node >/dev/null 2>&1; then
  echo "Installing Node.js…"
  pkg update -y
  pkg install -y nodejs
fi

# أدوات مفيدة للمراقبة والنسخ الاحتياطي
pkg install -y curl git 2>/dev/null || true

echo "Node: $(node --version)  npm: $(npm --version 2>/dev/null || echo '?')"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — edit it if needed."
fi

echo "Installing server dependencies (lightweight)…"
npm install --omit=dev

mkdir -p logs backups server/data

# فحص سريع (بلا إنترنت)
echo ""
echo "--- Self test ---"
npm test || echo "⚠️ Some tests failed — server may still run. Check logs."

echo ""
echo "✅ Install done."
echo "Next steps:"
echo "  ./run.sh          # start 24/7 (wake-lock + auto-restart)"
echo "  ./status.sh       # health check"
echo "  Then open in phone browser: http://localhost:3001"
echo "  Settings page: set Telegram token + RiskSettings (paper, auto, max_open_positions…)"
