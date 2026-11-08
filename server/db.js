/**
 * قاعدة بيانات JSON محلية بسيطة (بديل Entities في Base44).
 * كل مجموعة تُحفظ في ملف: <DATA_DIR>/<name>.json
 * السجلات تحمل: id, created_date, updated_date, created_by (مثل SDK الأصلي).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = process.env.DATA_DIR || './server/data';

// Entities starting with "_" are internal (e.g. _user) and must never be
// accessed via the generic /api/entities/:name routes.
export function isBlockedEntity(name) {
  const n = String(name || '');
  return n.startsWith('_') || n === '';
}

const PROTECTED_FIELDS = new Set(['id', 'created_date', 'updated_date', 'created_by']);
// مفاتيح تلوث النموذج الأولي — تُرفض دائماً (prototype pollution عبر API)
const POISON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function sanitizeData(data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (PROTECTED_FIELDS.has(k) || POISON_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function fileFor(name) {
  const safe = String(name).replace(/[^A-Za-z0-9_]/g, '_');
  return path.resolve(DATA_DIR, `${safe}.json`);
}

// Simple per-file async mutex to make read-modify-write safe within one process.
// (Does not help multi-process; use SQLite for that.)
const _locks = new Map();
async function withLock(name, fn) {
  const prev = _locks.get(name) || Promise.resolve();
  let release;
  const cur = new Promise((r) => { release = r; });
  _locks.set(name, prev.then(() => cur));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (_locks.get(name) === cur) _locks.delete(name);
  }
}

async function readAll(name) {
  let raw;
  try {
    raw = await fs.readFile(fileFor(name), 'utf-8');
  } catch (e) {
    if (e?.code === 'ENOENT') return []; // ملف غير موجود بعد = مجموعة فارغة
    throw e; // خطأ صلاحيات/قرص: فشل مغلق بدل بيانات فارغة
  }
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    // ملف تالف: حجْر نسخة للتشخيص ثم فشل مغلق (لا مسح صامت بأول كتابة)
    const q = `${fileFor(name)}.corrupt-${Date.now()}`;
    try { await fs.rename(fileFor(name), q); } catch { /* تجاهل */ }
    const err = new Error(`Corrupt data file quarantined: ${name}`);
    err.status = 500;
    throw err;
  }
}

async function writeAll(name, rows) {
  await fs.mkdir(path.resolve(DATA_DIR), { recursive: true });
  const tmp = fileFor(name) + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(rows, null, 2), 'utf-8');
  await fs.rename(tmp, fileFor(name)); // كتابة ذرية
  if (name === '_user') {
    // مفاتيح نصية على القرص — أقل صلاحيات ممكنة
    try { await fs.chmod(fileFor(name), 0o600); } catch { /* أنظمة بلا chmod */ }
  }
}

function applyFilter(rows, filter = {}) {
  const keys = Object.keys(filter || {});
  if (!keys.length) return rows;
  return rows.filter((r) => keys.every((k) => {
    const want = filter[k];
    if (want === undefined) return true;
    return r?.[k] === want;
  }));
}

function applySort(rows, sort) {
  if (!sort) return rows;
  const desc = sort.startsWith('-');
  const field = desc ? sort.slice(1) : sort;
  return [...rows].sort((a, b) => {
    const av = a?.[field];
    const bv = b?.[field];
    if (av === bv) return 0;
    if (av === undefined || av === null) return 1;
    if (bv === undefined || bv === null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') {
      return desc ? bv - av : av - bv;
    }
    const cmp = String(av).localeCompare(String(bv));
    return desc ? -cmp : cmp;
  });
}

export const db = {
  async list(name, { sort, limit, filter } = {}) {
    if (isBlockedEntity(name)) throw Object.assign(new Error('Unknown entity'), { status: 404 });
    let rows = applyFilter(await readAll(name), filter);
    rows = applySort(rows, sort);
    if (limit !== undefined && limit !== null && limit !== '') {
      const n = Math.min(Math.max(1, Number(limit) || 50), 200);
      rows = rows.slice(0, n);
    }
    return rows;
  },

  async get(name, id) {
    if (isBlockedEntity(name)) return null;
    const rows = await readAll(name);
    return rows.find((r) => r.id === id) || null;
  },

  async create(name, data, createdBy) {
    if (isBlockedEntity(name)) throw Object.assign(new Error('Unknown entity'), { status: 404 });
    return withLock(name, async () => {
      const rows = await readAll(name);
      const now = new Date().toISOString();
      const record = {
        ...sanitizeData(data),
        id: crypto.randomUUID(),
        created_date: now,
        updated_date: now,
        created_by: createdBy || null,
      };
      rows.push(record);
      await writeAll(name, rows);
      return record;
    });
  },

  async bulkCreate(name, items, createdBy) {
    if (isBlockedEntity(name)) throw Object.assign(new Error('Unknown entity'), { status: 404 });
    const capped = (items || []).slice(0, 100);
    return withLock(name, async () => {
      const rows = await readAll(name);
      const now = new Date().toISOString();
      const created = capped.map((data) => ({
        ...sanitizeData(data),
        id: crypto.randomUUID(),
        created_date: now,
        updated_date: now,
        created_by: createdBy || null,
      }));
      rows.push(...created);
      await writeAll(name, rows);
      return created;
    });
  },

  async update(name, id, patch) {
    if (isBlockedEntity(name)) return null;
    return withLock(name, async () => {
      const rows = await readAll(name);
      const i = rows.findIndex((r) => r.id === id);
      if (i === -1) return null;
      rows[i] = { ...rows[i], ...sanitizeData(patch), id, updated_date: new Date().toISOString() };
      // Never allow created_date / created_by overwrite via patch
      rows[i].created_date = rows[i].created_date;
      await writeAll(name, rows);
      return rows[i];
    });
  },

  async remove(name, id) {
    if (isBlockedEntity(name)) return false;
    return withLock(name, async () => {
      const rows = await readAll(name);
      const kept = rows.filter((r) => r.id !== id);
      if (kept.length === rows.length) return false;
      await writeAll(name, kept);
      return true;
    });
  },
};

// ── الملف الشخصي للمستخدم المحلي (بديل base44.auth) ──
const DEFAULT_USER = {
  id: 'local-user',
  email: 'trader@local',
  full_name: 'متداول محلي',
  role: 'admin',
};

// Fields a client is allowed to change via PATCH /api/auth/me.
// NOTE: id / email / role / created_* can never be changed via API.
const USER_EDITABLE = new Set([
  'full_name',
  'binance_api_key',
  'binance_secret_key',
  'binance_testnet_api_key',
  'binance_testnet_secret_key',
  'binance_network',
  'telegram_bot_token',
  'telegram_chat_id',
  'notify_trade_open',
  'notify_trade_close',
  'notify_take_profit',
  'notify_stop_loss',
  'notify_daily_report',
  'notify_signal',
  'notify_risk_warning',
]);

const SECRET_FIELDS = new Set(['binance_api_key', 'binance_secret_key', 'binance_testnet_api_key', 'binance_testnet_secret_key', 'telegram_bot_token']);

function maskSecrets(user) {
  const out = { ...user };
  for (const f of SECRET_FIELDS) {
    if (out[f]) out[f] = '';
  }
  return out;
}

export async function getUser({ includeSecrets = true } = {}) {
  const rows = await readAll('_user');
  const merged = rows[0] ? { ...DEFAULT_USER, ...rows[0] } : { ...DEFAULT_USER };
  // Always enforce fixed identity fields server-side
  merged.id = 'local-user';
  merged.email = DEFAULT_USER.email;
  merged.role = DEFAULT_USER.role;
  if (!includeSecrets) return maskSecrets(merged);
  return { ...merged };
}

export async function updateUser(patch) {
  // القراءة+الدمج+الكتابة كلها داخل القفل (كانت القراءة خارجه — TOCTOU)
  return withLock('_user', async () => {
    const current = await getUser();
    const next = { ...current };
    for (const [k, v] of Object.entries(patch || {})) {
      if (!USER_EDITABLE.has(k)) continue;
      // Empty string means "keep existing secret" (frontend sends masked values)
      if (SECRET_FIELDS.has(k) && (v === '' || v === undefined || v === null)) continue;
      if (k === 'binance_network') {
        if (v !== 'mainnet' && v !== 'testnet') continue;
        next[k] = v;
        continue;
      }
    if (k.startsWith('notify_')) next[k] = v === true || v === 1 || v === 'true' || v === '1'; // I: بوليانية صريحة أولاً
    else if (typeof v === 'string') next[k] = v.trim().slice(0, 500);
    else next[k] = v;
    }
    next.id = 'local-user';
    next.email = DEFAULT_USER.email;
    next.role = DEFAULT_USER.role;
    await writeAll('_user', [next]);
    return next;
  });
}
