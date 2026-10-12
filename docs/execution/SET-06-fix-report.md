# SET-06 — تقرير حزمة الإصلاح بعد المراجعة المستقلة

التاريخ: 22 سبتمبر 2026  
المرجع: [SET-06-independent-review.md](SET-06-independent-review.md) (الحكم NEEDS_FIXES).  
الحالة بعد الإصلاح: **FIXED_LOCAL (أدلة منفذ)** — تنتظر إعادة حكم مستقل؛ **SET-07 ما زالت محجوبة**. لا تغيير لـG-13 ولا قبول إنتاجي.

## النتائج والمعالجات

| # | النتيجة | المعالجة | الدليل |
| --- | --- | --- | --- |
| P0-1 | 170000 قد تعيد تفعيل `RETIRED` مقصود | هجرة أمامية `Migration20260922100000_composition_revival_provenance`: جدول `composition_status_audit` (سجل منشأ)، trigger `guard_composition_revival` يرفض أي `RETIRED → ACTIVE` بلا موافقة مسجلة، وإعادة تقاعد الصفوف التي أُحييت بخطأ اعتماداً على `audit_event` الموثوق (`composition.superseded` + `after_safe.retired = true`). | `tests/property/setup-changes.pg.test.mjs` — «migration-retired versions cannot return without provenance»؛ فحص dev: residual = 0 |
| P0-2 | `down()` يسجل رجوعاً لم يحدث | `down()` في 160000/170000/180000 و221000 يرمي خطأً تشغيلياً قبل أي SQL أو تعديل سجل، مع [خطة رجوع/استعادة](SET-06-rollback-plan.md) موثقة (forward-fix ثم استعادة من نسخة سابقة لـ160000 عند الكارثة). | «overlap and period migrations refuse an unsafe down()» |
| P1-1 | غياب idempotency فعلي في التطبيقين | `Idempotency-Key` مطلوب (`400` عند الغياب)، وإعادة استخدام `api_idempotency` عبر `checkIdempotency`/`storeIdempotency` تحت نفس القفل والمعاملة؛ replay يعيد الاستجابة الأصلية بـ`replayed=true`، واختلاف payload بنفس المفتاح → `409 CONFLICT`. | «apply operations demand an idempotency key and replay the stored result»، «migration apply replays and preserves resource ids end to end» |
| P1-2 | البصمة لا تتغير مع الحجب/المخزون | البصمة أصبحت تضم `inventory_version` + snapshot حتمي للأثر (التعارضات/المحتفظ به/السدود المتقاطعة) وتُعاد الحسبة تحت القفل قبل الكتابة؛ أي تغيير مؤثر → `412 PREVIEW_STALE`. | «preview fingerprint follows blocks added after the preview» (حاجز أُضيف بعد المعاينة) |
| P1-3 | تاريخ UTC بدل تاريخ المنشأة | التحقق يستخدم `businessToday(property.timezone)` (نفس مسار AT-28 بساعة قابلة للحقن عبر `HOTEL_CLOCK_NOW`/`setClockForTests`) في المعاينة والتطبيق للتغيير والترحيل. | «dated changes compare against the property business date» + اختبار حد منتصف الليل المحلي (`Asia/Makassar` = 22 بينما UTC = 21) |
| P1-4 | نافذة اليوم الواحد مرفوضة خدمياً | الرفض صار لـ`effective_to < effective_from` فقط، ما يطابق قيد `180000`. | «single day windows are accepted for changes and migrations» (تغيير + ترحيل) |
| P1-5 | المؤشر التالف يعيد 500 | تحقق صارم: timestamp ISO 8601 قابل للتحليل + UUID قبل الاستعلام، وإلا `400 INVALID_REQUEST`. | «setup change log rejects malformed cursors with 400» |
| P2 | `resource_ids_preserved` يقارن أعداداً | المقارنة الآن مجموعات IDs مرتبة قبل/بعد + تطابق أوراق النسخة المكتوبة مع المقترح + العدادات. | «migration apply replays and preserves resource ids end to end» + تحقق خارجي قبل/بعد |

## تغييرات الملفات

- هجرات: `Migration20260922100000_composition_revival_provenance.ts` (جديد)، وحُرّاس `down()` في 160000/170000/180000.
- خدمة: `composition-change-service.ts` (idempotency، بصمة، business date، يوم واحد، مقارنة IDs)، `setup-insights-service.ts` (cursor)، `setup-insights-repository.ts` (`listResourceIds`).
- API: `composition.controller.ts` + `setup-insights.controller.ts` (ترويسة المفتاح و`replayed`).
- عقد: `docs/contracts/set.openapi.json` (+`IdempotencyKey` للعمليتين، +`replayed`) وإعادة توليد `set.generated.ts`.
- واجهة: `apps/web/src/api/property.ts` يرسل مفتاح idempotency عشوائياً لكل تطبيق.
- توثيق: [خطة الرجوع](SET-06-rollback-plan.md) + هذا التقرير + تحديث البطاقة ونقطة الاستئناف.

## الأدلة الخضراء (كاملة)

| الفحص | النتيجة | الدليل |
| --- | --- | --- |
| `setup-changes` (17 اختباراً) | **17/17** ×3 | `.local/verification/SET-06-fix-tests{1,2,3}.log` |
| مركّز SET (7 ملفات) | **83/83** | `.local/verification/SET-06-fix-focused.log` |
| طقم property كامل | **407/407 في 53 حزمة** | `.local/verification/SET-06-fix-property-full.log` |
| طقم التوزيع | **48/48 في 11 حزمة** | `.local/verification/SET-06-fix-distribution.log` |
| `pnpm check` | **99/99 في 14 حزمة** + بناء/عقود/typecheck/lint/format | `.local/verification/SET-06-fix-check.log` |
| البصري | **37/37** و13 لقطة | `.local/verification/SET-06-fix-visual.log` |
| هجرة الإصلاح على dev | مطبقة؛ الجدول وtrigger موجودان؛ residual = 0؛ `composition_status_audit` فارغ | `pnpm db:migrate` + فحص SQL مباشر |
| البصمة | `4861207504955c3aca24e3cd21d3d07ec423087e07088193c8f96bc55d7fd4c0` | — |

## حدود وملاحظات للإعادة

- 221000 يعتمد `audit_event` كسجل منشأ للتقاعد المقصود؛ أي تقاعد مقصود أقدم من SET-06 ولم يسجل بهذا الشكل يبقى مراجعة يدوية (موثق في خطة الرجوع).
- idempotency تطبق على عمليتي SET-06 فقط؛ لا تعميم على مسارات أخرى.
- القبول الإنتاجي وG-13 وبوابات القنوات كما هي؛ SET-AT تبقى NOT_TESTED.

## جولة RZ — إصلاح المؤشر التقويمي (بعد إعادة القبول المستقلة)

المرجع: [إعادة القبول المستقلة](SET-06-independent-reacceptance.md) — الحكم `NEEDS_FIXES` لنتيجة واحدة: `P1-RZ-06-01` (تواريخ تقويمية مستحيلة مثل `2026-02-30T00:00:00Z` تمرّ `Date.parse` المعياري ثم يسقط cast PostgreSQL بـ`22008` → 500).

**الإصلاح (وحدة واحدة بلا هجرة):** `setup-insights-service.ts:parseCursor` صار يتحقق تقويمياً صارماً عبر مقارنة مكوّنات `YYYY-MM-DD` بدورة `Date.UTC`/`getUTC*`، فالتاريخ المستحيل يُرفض مبكراً بـ`400 INVALID_REQUEST` قبل أي استعلام. لم يتغير العقد ولا الاستعلام ولا سلوك المؤشرات الصالحة.

**الاختبارات:** اختبار «setup change log rejects malformed cursors with 400» وُسّع ليغطي الفئة كاملة: `2026-02-30`، `2026-02-29`، `2026-04-31`، `2026-06-31`، `2026-09-31`، `2026-11-31` → 400، مع شاهد صالح `2028-02-29` → 200.

**الأدلة:** `setup-changes` **17/17**، property كامل **421/421 في 55 حزمة**، توزيع **48/48**، `pnpm check` **103/103 في 15 حزمة** (`.local/verification/RZ06-{setup,property-full,distribution,check}.log`). البصمة بعد RZ: `113b5201ee066defbd5115e2e55b8462b58cf9b31d30ed338439351b7ecc6fe5`.

**الحالة:** أُغلقت SET-06 بقرار المستخدم (22 سبتمبر 2026) **دون** تنفيذ جولة التحقق المركزة الموصى بها؛ إصلاح RZ مُثبت بأدلة منفذ فقط (لا ادعاء تحقق مستقل للفئة المصححة). باقي النتائج الأصلية R01–R06 وR08 مبطلَبة بإعادة قبول مستقلة.
