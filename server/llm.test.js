/**
 * تستات محلل LLM (F) — خالصة بلا شبكة:
 *   node server/llm.test.js
 */
import { tryParseJson } from './llm.js';

let pass = 0, fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
}

let r = tryParseJson('{"a":1}');
ok(r.ok && r.value.a === 1, 'JSON خالص');
r = tryParseJson('```json\n{"a":2}\n```');
ok(r.ok && r.value.a === 2, 'JSON بسياج fences');
r = tryParseJson('إليك النتيجة {"a":3} وشكراً');
ok(r.ok && r.value.a === 3, 'استخراج كائن مضمّن');
r = tryParseJson('لا يوجد جيسون هنا');
ok(!r.ok, 'نص بلا JSON → فشل صريح');
r = tryParseJson('[1,2,3] tail');
ok(r.ok && Array.isArray(r.value), 'استخراج مصفوفة');

// رد ضخم خبيث: يجب أن يعود بسرعة (لا O(n²))
const big = 'x'.repeat(200000) + '{"a":1}';
const t0 = Date.now();
r = tryParseJson(big);
const dt = Date.now() - t0;
ok(dt < 1000, `رد 200KB يُحلل بأمان (${dt}ms)`);

console.log(`\nالنتيجة: ${pass} ناجح / ${fail} فاشل`);
process.exit(fail ? 1 : 0);
