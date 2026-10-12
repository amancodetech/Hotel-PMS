# جلسة إصلاح findings المراجعة المركزة للمرحلة 9 (G-09)

التاريخ: 16 سبتمبر 2026. المراجع الحاكمة: [docs/72](72_g09_focused_review.md) و[docs/71](71_g09_focused_review_prompt.md)
و[docs/24](24_inventory_design.md) و[docs/25](25_logical_model_contract.md) و[docs/26](26_api_permissions_events.md)
(سطر P09-02) و[docs/07](07_operations.md) و[docs/32](32_execution_work_packages.md) قسم P09.
النطاق: إغلاق **F-RVW9F-02** (متوسط) و**F-RVW9F-01** (منخفض) بتفويض المستخدم الصريح — محلياً فقط،
بلا commit، بلا مهاجرة جديدة (لا تغيير مخطط)، بلا تغيير عقد، وبلا مساس بحدود P09 أو P10 أو D-01..D-14.

**الحالة: G-09 = VERIFIED محلياً / REVIEW_PENDING، والعيبان المفتوحان أُغلقا.** هذا السجل لا يمنح
قبولاً؛ يلزم قرار المستخدم، ولا تُفتح P10 تلقائياً.

## جدول الإغلاق

| Finding | الخطورة | الحالة | الدليل الأساسي |
|---|---|---|---|
| F-RVW9F-02 — غياب Disruption إذا خالف التسليمُ `plan_allocation` | متوسط | **مغلق** | استعلام `listAssignedAllocationConflictsForResources` + دمج/dedupe في `block-service.ts`؛ «emergency disrupts divergent and aligned stays exactly once» في `operations-work-orders` |
| F-RVW9F-01 — Hold منتهٍ بلا سحب يترك Disruption زائفة | منخفض | **مغلق** | `expireDueHolds` قبل كشف التعارض في `createBlock` و`createEmergencyMaintenanceBlock`؛ «expired holds are swept before block conflict detection» في `inventory-api` |
| N-RVW9F-01..03 (ملاحظات المراجعة) | منخفض/ملاحظة | **تبقى موثقة كما هي** | خارج نطاق التفويض؛ لم تُمس |

## F-RVW9F-02 (متوسط) — تغطية Disruption للتسليم الفعلي خارج التخصيص

- **القرار:** لم نغيّر دلالات P07: لا منع Check-In إلى غرفة تخالف `plan_allocation`، ولا إعادة
  مواءمة `plan_allocation` عند التسليم. docs/07 يفصل التخصيص (تخطيط المخزون) عن التسليم
  (الواقع التشغيلي)، ومنع التسليم أو تحريك التخصيص يوسّع النطاق ويكسر تدفقات معتمدة في
  P05/P07. الإصلاح حُصر في كشف تعارض الطوارئ.
- **الإصلاح:** كشف تعارض Block الطارئ صار يجمع مسارين قبل إنشاء Disruptions:
  1. `plan_allocation` النشط على المورد المحجوب (كما كان، `listAllocationConflictsForResources`).
  2. استعلام جديد `listAssignedAllocationConflictsForResources` في
     `packages/backend/src/modules/inventory/persistence/guarantee-repository.ts`: يصل
     `room_assignment` (PLANNED/ACTIVE المتداخل مع فترة الـBlock) → `commitment`
     (`source_kind='ITEM'` و`state='ACTIVE'`) → `plan_allocation` النشط المتداخل مع فترة
     الإقامة. بهذا يُلتقط تخصيص الحجز حتى لو كان على غرفة أخرى ما دام الضيف مسلَّماً فعلياً
     للغرفة المحجوبة.
- **الدمج:** `listEmergencyDisruptionSources` في `block-service.ts` يوحّد المصدرين ويزيل التكرار
  حسب `allocation_id` (لا صف مزدوج عندما يتطابق التخصيص والتسليم). `resource_id` في صف
  الـDisruption = **الغرفة المتأثرة فعلياً** (المورد المحجوب) ليعمل المشغل على الواقع، بينما
  `allocation_id` يبقى مرجع تخطيط الحجز؛ و`start_date/end_date` من التخصيص اتساقاً مع القائم.
- **النطاق:** `createBlock` (وضع EMERGENCY فقط لما ينشئ Disruptions؛ PLANNED يبقى كما كان: رفض
  `BLOCK_CONFLICT` على تخصيصات `plan_allocation` فقط) و`createEmergencyMaintenanceBlock`
  (مسار أمر العمل). لا تغيير على `phase9.openapi.json` ولا على حل Disruptions عند الإغلاق ولا
  على تحرير Block.

## F-RVW9F-01 (منخفض) — سحب Holds المنتهية قبل كشف التعارض

- أُضيف `expireDueHolds(em, tenantId, propertyId)` **قبل** `listAllocationConflictsForResources`
  في المسارين:
  - `createEmergencyMaintenanceBlock` (المسار الذي رصده الفحص m8).
  - `createBlock` (المساران PLANNED/EMERGENCY — النمط نفسه الموروث من P05).
- **الأثر:** Hold انتهى وقته في القاعدة ولم يسحبه أي تدفق بعد لم يعد يُنتج `BLOCK_CONFLICT`
  زائفاً لـBlock مخطط، ولا Disruption `OPEN` على allocation `RELEASED` لـBlock طارئ. السلوك
  متسق مع كل كتّاب المخزون الآخرين (quote/holds/availability/groups/revisions) الذين يسحبون
  المنتهي قبل الفحص، و`bumpPropertyInventoryVersion` قائم في المسارين بعد العملية.

## اختبارات الانحدار

- `tests/property/operations-work-orders.pg.test.mjs` —
  «emergency disrupts divergent and aligned stays exactly once (F-RVW9F-02)»:
  (a) تسليم فعلي على غرفة تخالف التخصيص ثم طوارئ على الغرفة المشغولة → **Disruption واحد**
  بـ`allocation_id` المتباعد و`resource_id` الغرفة الفعلية، والتخصيص لم يُمس؛
  (b) تسليم مطابق للتخصيص ثم طوارئ → **Disruption واحد فقط** (إثبات إزالة التكرار بين المسارين).
- `tests/property/inventory-api.pg.test.mjs` —
  «expired holds are swept before block conflict detection (F-RVW9F-01)»: Hold بـ`expires_at`
  في الماضي ثم Block مخطط → **201** (لا 409 زائف)، وطارئ → **0 Disruptions**، والحالة النهائية
  `EXPIRED`/`RELEASED`.
- قبل الإصلاح كان `RVW9F-m4.log` يثبت الحالة (a) بعيب (0 Disruptions) و`RVW9F-m8.log` يثبت
  الـDisruption الزائفة؛ الاختباران الجديدان يقفلان الحالتين ضمن الأطقم الرسمية.

## الأدلة (جولة الإصلاح)

- `pnpm check` **85/85 في 11 حزمة** (build/contracts/typecheck/lint/format/jest) —
  `.local/verification/g09-fixes/FIXG09-check.log`.
- `pnpm test:property:fast` **257/257 في 36 حزمة** (كان 255؛ +2 اختبارات إصلاح) —
  `FIXG09-test-property-full.log`، وملفا الفحص المركز: `FIXG09-operations-work-orders.log` (6/6)
  و`FIXG09-inventory-api.log` (9/9).
- `pnpm test:identity:fast` **48/48** و`pnpm test:distribution:fast` **48/48** —
  `FIXG09-test-identity.log` و`FIXG09-test-distribution.log`.
- البصريات (بعد `pnpm dev:start`): phase9 **28/28**، phase5 **19/19**، phase7 **35/35**،
  `visual:check` **38/38** — `FIXG09-visual-*.log`؛ ثم `pnpm dev:stop` والمنافذ حرة —
  `FIXG09-dev-start.log`/`FIXG09-dev-stop.log`.
- البصمات: `pnpm checksums` ثم `sha256sum -c CHECKSUMS.sha256` بعد الوثائق —
  `FIXG09-checksums.log`.

## حدود ما زالت معلنة

- لا AT خارجية منفذة ولا إنتاج ولا قناة OTA ولا مزود دفع؛ لا P10.
- **لا مهاجرة ولا تغيير مخطط ولا عقد**: الإصلاح استعلامات ومسارات خدمة فقط.
- تبقى ملاحظات N-RVW9F-01 (حدث بلا مورد «غير مستهلك») وN-RVW9F-02 (عدّادات اللوحة على 100
  مهمة) وN-RVW9F-03 (منح UPDATE نصابي) موثقة في docs/72 بلا تغيير.
- Visual بـPlaywright كاستثناء معلن مطابق P05..P08 ويكفي للبوابة المحلية فقط.

## التالي

القبول قرار المستخدم: عند رسالة قبول صريحة تُحدَّث G-09/27/34/README إلى ACCEPTED محلياً ويُفتح
**P10 (التدقيق الليلي)** وفق docs/32؛ لا تفتح تلقائياً. لا حاجة لجولة مراجعة مستقلة جديدة وفق
docs/34، وإن أراد المستخدم تأكيداً مستقلاً يعاد فحص مركز بنمط docs/71.

**تحديث 16 سبتمبر 2026:** قُبلت **G-09 = ACCEPTED محلياً** بقرار المستخدم؛ P10 مفتوحة عبر
[docs/74](74_phase10_execution_prompt.md) والمراجعة المستقلة الإلزامية قبل G-10 عبر
[docs/75](75_phase10_review_prompt.md) والحكم في `docs/76`. هذا السجل يبقى كما هو.
