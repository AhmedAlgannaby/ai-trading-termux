#!/usr/bin/env node
// فحص صحة بسيط بدون اعتماديات — يشبه curl /api/health
const port = process.env.PORT || 3001;
try {
  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  const text = await res.text();
  console.log(text);
} catch (e) {
  console.error(`✗ No response on http://127.0.0.1:${port} — is server running? (${e.message})`);
  process.exit(1);
}
