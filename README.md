# AI Trading — Termux 24/7

Lightweight Termux copy of the AI Trading platform, built to run **24/7 on an Android phone** for paper-trading output testing.

- Server-only (`server/`) + prebuilt frontend (`dist/`) — no Vite build needed on the phone
- Local quant brain works immediately, no LLM key required
- JSON data lives in `server/data/` on the phone (not in git)

## Quick start (on the phone)

```bash
pkg update -y && pkg install -y nodejs git curl
git clone https://github.com/AhmedAlgannaby/ai-trading-termux.git
cd ai-trading-termux
bash install.sh
bash run.sh
# open http://localhost:3001 in the phone browser
```

See [`README_TERMUX.md`](./README_TERMUX.md) for the full Arabic guide (battery settings, auto-boot, backups, LAN access, troubleshooting).

## Configure

```bash
cp .env.example .env   # then edit .env (AI_CRON_MINUTES=60 for hourly signals)
```

API keys (Binance/Telegram) are entered from the in-app Settings page, or via `server/data/_user.json` on the phone — never via git.

> **Privacy note:** Secrets and runtime data (`server/data/*.json`, `.env`) are git-ignored. This repo is private.
