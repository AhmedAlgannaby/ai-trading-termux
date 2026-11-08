/**
 * عميل LLM بصيغة OpenAI المتوافقة (بديل base44.integrations.Core.InvokeLLM).
 * يعمل مع: OpenAI / DeepSeek / Groq / OpenRouter / Ollama المحلي / أي بوابة متوافقة.
 *
 * الإعداد عبر .env:
 *   LLM_BASE_URL=https://api.openai.com/v1
 *   LLM_API_KEY=sk-...
 *   LLM_MODEL=gpt-4o-mini
 */
const DEFAULT_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
// Only allow models matching this pattern (prevents client-driven cost/model abuse).
// Override via LLM_ALLOWED_MODELS="gpt-4o-mini,gpt-4o,deepseek-chat" if needed.
const ALLOWED_MODELS = (process.env.LLM_ALLOWED_MODELS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
function pickModel(requested) {
  if (requested && ALLOWED_MODELS.includes(requested)) return requested;
  if (requested && ALLOWED_MODELS.length === 0 && /^[a-zA-Z0-9._:-]{1,80}$/.test(requested)) {
    // No allowlist configured: accept sane-looking names but prefer server default.
    // To lock down, set LLM_ALLOWED_MODELS.
    return requested;
  }
  return DEFAULT_MODEL;
}

function stripFences(text) {
  let t = String(text || '').trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (m) t = m[1].trim();
  return t;
}

export function tryParseJson(text) {
  // F: سقف الطول + 3 محاولات فقط (كانت حلقة O(n²) تعلّق الحدث مع رد كبير)
  const clean = stripFences(String(text || '').slice(0, 50000));
  try {
    return { ok: true, value: JSON.parse(clean) };
  } catch {
    // ليس JSON خالصاً — نحاول الاستخراج
  }
  const start = clean.search(/[{[]/);
  if (start !== -1) {
    const candidates = new Set([clean.length, clean.lastIndexOf('}') + 1, clean.lastIndexOf(']') + 1]);
    for (const end of candidates) {
      if (end <= start) continue;
      try {
        return { ok: true, value: JSON.parse(clean.slice(start, end)) };
      } catch {
        // المرشح التالي
      }
    }
  }
  return { ok: false };
}

async function chatOnce({ baseUrl, apiKey, model, messages, wantJson }) {
  const body = { model, messages, temperature: 0.3 };
  if (wantJson) body.response_format = { type: 'json_object' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  let res;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    const err = new Error(e?.name === 'AbortError' ? 'LLM timeout' : 'LLM network error');
    err.status = 502;
    throw err;
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) {
    await res.text().catch(() => '');
    const err = new Error('LLM request failed');
    err.status = res.status >= 500 ? 502 : 400;
    throw err;
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

/**
 * @param {object} args
 * @param {string} args.prompt - نفس حقل InvokeLLM الأصلي
 * @param {string} [args.system]
 * @param {object} [args.schema] - نفس response_json_schema الأصلي
 * @param {string} [args.model]
 * @returns {Promise<object|string>} كائن JSON (عند وجود schema) أو { text }
 */
export async function callLLM({ prompt, system, schema, model }) {
  const baseUrl = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    // العقل المحلي: تحليل كمي حقيقي من بيانات السوق الحية — بدون أي مفتاح
    const { brainAnswer } = await import('./brain/router.js');
    return brainAnswer({ prompt, schema });
  }
  const useModel = pickModel(model);
  // Ignore client-supplied `system` unless explicitly allowed — prevents
  // system-prompt override attacks. Set ALLOW_CUSTOM_SYSTEM=true to permit.
  const allowSystem = process.env.ALLOW_CUSTOM_SYSTEM === 'true';
  const sys = (allowSystem && typeof system === 'string' && system.length < 4000 && system)
    || 'You are a financial markets analyst. Always answer in the same language as the user prompt. When a JSON schema is implied, output valid JSON only with no markdown fences.';
  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: String(prompt || '') },
  ];

  let raw;
  try {
    raw = await chatOnce({ baseUrl, apiKey, model: useModel, messages, wantJson: !!schema });
  } catch (e) {
    // بعض البوابات ترفض response_format — إعادة المحاولة بدونه
    if (schema && e.status === 400) {
      raw = await chatOnce({ baseUrl, apiKey, model: useModel, messages, wantJson: false });
    } else {
      throw e;
    }
  }

  if (!schema) return { text: raw };
  const parsed = tryParseJson(raw);
  if (parsed.ok) return parsed.value;
  return { text: raw }; // احتياط: نص خام بدل الفشل
}
