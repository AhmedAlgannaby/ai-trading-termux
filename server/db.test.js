/**
 * اختبارات طبقة قاعدة البيانات (P1) — معزل تماماً في مجلد مؤقت:
 *   node server/db.test.js
 *
 * لا شبكة، لا قاعدة حقيقية: DATA_DIR يُوجَّه لمجلد مؤقت قبل الاستيراد.
 * يغطي: isBlockedEntity, دورة CRUD, الحقول المحمية, حظر _user عبر المسارات
 * العامة, حدود limit, والتزامن الأساسي (توثيق سلوك القفل الحالي).
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'ecc-db-test-'));
const { db, isBlockedEntity } = await import('./db.js');

let pass = 0, fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
}

// ── 1) حظر الكيانات الداخلية ──
ok(isBlockedEntity('_user') === true, 'حظر _user');
ok(isBlockedEntity('_anything') === true, 'حظر أي كيان يبدأ بشرطة');
ok(isBlockedEntity('') === true, 'حظر الاسم الفارغ');
ok(isBlockedEntity('Trade') === false, 'السماح لـ Trade');
ok(isBlockedEntity('RiskSettings') === false, 'السماح لـ RiskSettings');

// ── 2) المسارات العامة ترفض الكيانات المحظورة ──
let blockedErr = null;
try { await db.create('_user', { x: 1 }); } catch (e) { blockedErr = e; }
ok(blockedErr && blockedErr.status === 404, 'create على _user يرمي 404');
ok((await db.get('_user', 'whatever')) === null, 'get على _user يعيد null');
ok((await db.update('_user', 'x', { a: 1 })) === null, 'update على _user يعيد null');
ok((await db.remove('_user', 'x')) === false, 'remove على _user يعيد false');

// ── 3) دورة CRUD كاملة ──
const created = await db.create('TestEntity', { pair: 'BTC/USDT', pnl: -5 });
ok(created.id && created.created_date && created.pair === 'BTC/USDT', 'إنشاء يعيد سجلاً بهوية وتواريخ');
const got = await db.get('TestEntity', created.id);
ok(got && got.pnl === -5, 'قراءة السجل المنشأ');
const updated = await db.update('TestEntity', created.id, { pnl: 10 });
ok(updated && updated.pnl === 10 && updated.id === created.id, 'تحديث السجل');
const missing = await db.update('TestEntity', 'no-such-id', { pnl: 1 });
ok(missing === null, 'تحديث غير الموجود يعيد null');
ok((await db.remove('TestEntity', created.id)) === true, 'حذف الموجود يعيد true');
ok((await db.get('TestEntity', created.id)) === null, 'المحذوف لم يعد موجوداً');
ok((await db.remove('TestEntity', created.id)) === false, 'حذف غير الموجود يعيد false');

// ── 4) الحقول المحمية لا تُكتب عبر API ──
const evil = await db.create('TestEntity', {
  pair: 'ETH/USDT', id: 'hacked', created_date: '2000-01-01', created_by: 'attacker',
});
ok(evil.id !== 'hacked' && evil.created_date !== '2000-01-01' && evil.created_by !== 'attacker',
  'الحقول المحمية (id/created_date/created_by) تُتجاهل');
await db.remove('TestEntity', evil.id);

// ── 5) الفلترة والفرز وحدود limit ──
await db.bulkCreate('TestEntity', [
  { pair: 'A', pnl: 1 }, { pair: 'B', pnl: -2 }, { pair: 'A', pnl: 3 },
]);
const filtered = await db.list('TestEntity', { filter: { pair: 'A' } });
ok(filtered.length === 2 && filtered.every((r) => r.pair === 'A'), 'فلترة المساواة الصارمة');
const sorted = await db.list('TestEntity', { sort: '-pnl' });
ok(sorted[0].pnl === 3, 'فرز تنازلي');
const limited = await db.list('TestEntity', { limit: 500 });
ok(limited.length <= 200, 'سقف limit عند 200');
const one = await db.list('TestEntity', { limit: 1 });
ok(one.length === 1, 'limit=1 يعيد سجلاً واحداً');

// ── 6) التزامن: إنشاء + حذف متوازيان لا يفسدان الملف ──
const conc = await Promise.all([
  db.create('TestEntity', { pair: 'C1' }),
  db.create('TestEntity', { pair: 'C2' }),
  db.list('TestEntity', {}),
]);
let fileValid = true;
try {
  const raw = await fs.readFile(path.join(process.env.DATA_DIR, 'TestEntity.json'), 'utf-8');
  const rows = JSON.parse(raw);
  fileValid = Array.isArray(rows) && rows.every((r) => r.id);
} catch { fileValid = false; }
ok(conc[0].id && conc[1].id && fileValid, 'عمليات متوازية: الملف صالح وكل سجل بهوية');

// ── 7) تلوث النموذج الأولي مرفوض ──
const poison = await db.create('TestEntity', JSON.parse('{"pair":"P","__proto__":{"polluted":true},"constructor":{"x":1}}'));
ok(({}).polluted === undefined && !Object.keys(poison).includes('__proto__'),
  'مفاتيح __proto__/constructor تُرفض');
await db.remove('TestEntity', poison.id);

// ── 8) ملف مفقود = مجموعة فارغة (لا خطأ) ──
ok((await db.list('NeverCreated', {})).length === 0, 'كيان جديد فارغ بلا خطأ');

// ── 9) ملف تالف: حجر + فشل مغلق (لا مسح صامت) ──
await fs.writeFile(path.join(process.env.DATA_DIR, 'TestCorrupt.json'), '{broken json!!!');
let threw500 = false;
try { await db.list('TestCorrupt', {}); }
catch (e) { threw500 = e?.status === 500; }
const files = await fs.readdir(process.env.DATA_DIR);
ok(threw500 && files.some((f) => f.startsWith('TestCorrupt.json.corrupt-')),
  'ملف تالف يُحجر ويرمي 500 بدل المسح');

// ── 10) updateUser: بوليانية الإشعارات + ثبات الهوية ──
const { updateUser, getUser } = await import('./db.js');
await updateUser({ notify_trade_open: 'false', notify_signal: 1, full_name: 'مختبر', role: 'hacker', id: 'x' });
const u = await getUser();
ok(u.notify_trade_open === false && u.notify_signal === true, 'notify تُجبر بوليانية');
ok(u.role === 'admin' && u.id === 'local-user' && u.full_name === 'مختبر', 'الهوية ثابتة والاسم يُقبل');

// تنظيف المجلد المؤقت
await fs.rm(process.env.DATA_DIR, { recursive: true, force: true });

console.log(`\nالنتيجة: ${pass} ناجح / ${fail} فاشل`);
process.exit(fail ? 1 : 0);
