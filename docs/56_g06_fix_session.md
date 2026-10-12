# جلسة إصلاح G-06: معالجة findings المراجعة المستقلة (docs/55)

التاريخ: 15 سبتمبر 2026. المرجع الحاكم: [docs/55](55_phase6_independent_review.md) (حكم FAIL مع F1..F13)
و[docs/49](49_phase6_execution_prompt.md). هذه جلسة إصلاح من المنفّذ وليست قبولاً؛ القبول قرار المستخدم
بعد جولة مراجعة مركزة مستقلة على F1..F6 (الكتلة في القسم 4).

## 1) الإصلاحات F1..F6

### F1 (عالٍ) — إعادة معالجة استثناءات المستهلك
- `markChannelRevision` لا يضبط `applied_at`/`APPLIED` إلا عند النجاح، وكشف `DUPLICATE` صار على
  `processing_state='APPLIED'` لا على أي `applied_at`.
- عند إعادة المعالجة: نجاح → إغلاق استثناء `REVISION_CONFLICT` السابق (`RESOLVED/REPROCESSED`)،
  وفشل → `SUPERSEDED` مع استثناء جديد مرتبط بصف المراجعة.
- Migration جديد `Migration20260915120000_revision_exception_resolution.ts`:
  `grant update on distribution_exception_case to hotel_api` (لازم للإغلاق من مسار API).
- اختبارا انحدار: تعارض خارجي ثم تحرير المورد ثم reprocess يطبق، وLINK_MISSING ثم الربط ثم reprocess يطبق
  (كانا يفشلان قبل الإصلاح).

### F2 (متوسط) — تسابق الاستيراد بنفس `external_key`
- APPLY يقفل صف Property (`FOR UPDATE`) أولاً فتتسلسل طلبات المنشأة الواحدة، ويرى الثاني الحجز الذي
  أنشأه الأول عبر `findImportByIdentity` فيعيد `DUPLICATE` بلا أثر. لا migration ولا فهرس جزئي.

### F3 (متوسط) — dry-run يمنع apply لنفس الملف
- Migration `Migration20260915130000_import_run_replay_scope.ts`: توسيع القيد الفريد لبصمة run إلى
  `(tenant_id, property_id, file_hash, mode, source)`، و`findExistingRun` يفلتر بنفس الأعمدة.
- النتيجة: APPLY بعد DRY_RUN run مستقل يُطبَّق مرة واحدة، وإعادة APPLY نفسه replay، وFEED كما كان.

### F4 (متوسط) — تعديل بند غير مؤكد
- البنود `INQUIRY/TENTATIVE/WAITLIST` تُحدَّث حقولها فقط بلا resolve availability وبلا إنشاء/تثبيت
  commitment وبلا `QUANTITY_UNSUPPORTED` أو 409 للكمية>1، وتبقى غير مؤكدة مع Audit.
- البنود المؤكدة (`CONFIRMED/IN_HOUSE`) تبقي السلوك الذري؛ أي التزام ACTIVE شاذ لبند غير مؤكد يُحرَّر.
- إصلاح خريطة `commitmentByItem` عند إنشاء التزام جديد (كانت تسمح بمخالفة `commitment_source_unique`).

### F5 (متوسط) — `occupancy` بدل `adults`
- المستهلك يقرأ `occupancy` (من البند ثم الظرف) مع فحص صريح 1..20 قبل الكتابة، ويلف كتابات القاعدة
  بـ`translatePropertyWrite` فيحوّل 23514/23503/23P01 إلى استثناء دائم
  `PAYLOAD_UNSUPPORTED`/`LINK_MISSING`/`EXTERNAL_CONFLICT` بدل 500 وبقاء RECEIVED.

### F6 (متوسط) — `Idempotency-Key` مطابق للعقد
- فُرض `required:true` على العمليات الست كما في العقد: غياب الرأس → `400 INVALID_REQUEST` مع
  `details.field=idempotency_key` (`reason=required|too_short`)، ونفس المفتاح بنفس المحتوى replay
  بنفس الاستجابة، ونفس المفتاح بمحتوى مختلف → `409 CONFLICT`.
- `idempotency-service.ts` مشترك (check/store/requireIdempotencyKey)، والاستيراد عبر قفل
  `pg_advisory_xact_lock` حول check→import→store. **لا تغيير في العقد أو الأنواع المولّدة.**

## 2) المنخفضات F7..F13

- **F7**: شاشة الاستيراد/الاستثناءات وإعادة المعالجة نُقلت صراحةً إلى P07 ووثقت في G-06؛ لا ادعاء تنفيذ.
- **F8**: صُححت الأرقام والحالة (property 145/145، `visual:phase6` 24/24، وسطر P06-01 في README).
- **F9**: السبب الفعلي لفشل أطقم الهوية كان تنازع منفذ 4100 (dev/عملية عالقة) لا Keycloak؛ التشغيل
  النظيف بعد `pnpm dev:stop` = 48/48، وصُححت ملاحظة G-06. تقوية هارنس الهوية (تحقق PID) مؤجلة كمنخفض.
- **F10**: Pickup/Split على حجز مرتبط بقناة يسجلان Audit بلا Outbox (OTA يمر بالمستهلك) — حد معلن في G-06.
- **F11**: بحث النزلاء يهرّب `%` و`_` و`\` مع `ESCAPE` + اختبار يثبت أن `%` لا يسرد الكل.
- **F12**: مطابقة بنود المراجعة بالفهرس لا بـ`item_ref` — حد معلوم موثق في G-06.
- **F13**: مفتاح idempotency بنطاق `(tenant, operation, key)` لا property — حد معلن.

## 3) الأدلة المعادة (بعد الإصلاح، dev متوقف للأطقم ثم أعيد للبصريات)

| الأمر | النتيجة |
|---|---|
| `pnpm db:migrate` + `pnpm db:check` | مطبق حتى `15140000` |
| `pnpm check` | 79/79 |
| `pnpm build` | نجاح |
| `pnpm test:property` | **145/145 في 23 حزمة** (كانت 132) |
| `pnpm test:distribution` | 48/48 |
| `pnpm test:identity` (نظيف، 4100 حر) | **48/48** |
| `pnpm contracts:check` | 43/30/36/21/**15** بلا تغيير عقد |
| `pnpm visual:phase6` | **24/24** |
| `pnpm visual:phase5` | 19/19 |
| `pnpm visual:check` | 38/38 |
| `pnpm checksums` + `sha256sum -c` | في نهاية الجلسة (بعد الوثائق) |

المigrations الجديدة: `Migration20260915120000_revision_exception_resolution.ts`،
`Migration20260915130000_import_run_replay_scope.ts`.

## 4) كتلة جولة المراجعة المركزة المستقلة (F1..F6)

> انسخ الكتلة التالية إلى جلسة مستقلة منفصلة. اكتب تقريرك في
> `docs/58_phase6_focused_review.md` ولا تعدل كود الإنتاج أو الاختبارات.

```
أنت مراجع مستقل مركز على F1..F6 في /home/omar/Desktop/Hotel.
اقرأ: docs/55_phase6_independent_review.md (الحكم الأول وF1..F13)،
docs/56_g06_fix_session.md (الإصلاحات)، docs/execution/G-06.md.
لا تثق بأدلة المنفّذ: أعد إنتاج كل finding بنفسك بأدوات مستقلة تحت
.local/verification/review-g06-focused/ (بيانات اصطناعية فقط، بلا أسرار).
البيئة: export PATH="/tmp/hotel-pnpm10/node_modules/.bin:$PATH".
شغّل `pnpm dev:stop` قبل أطقم property/identity لتجنب تنازع 4100.
المطلوب إثباته أو نقضه:
1) F1: EXTERNAL_CONFLICT ثم تحرير المورد ثم POST reprocess → التعديل يُطبق مرة واحدة
   (لا DUPLICATE)، ومثله LINK_MISSING بعد إنشاء الربط، مع سلامة الأصل عند الفشل.
2) F2: طلبا APPLY متوازيان بملفين ونفس external_key → حجز واحد والثاني DUPLICATE بلا أثر.
3) F3: DRY_RUN ثم APPLY لنفس الملف → يُطبَّق مرة واحدة بـrun مستقل، وإعادة APPLY replay.
4) F4: تعديل بند INQUIRY بكمية 1 و2 → 200 بلا commitment ACTIVE وبقاء INQUIRY،
   وتعديل المؤكد ما زال ذرياً بـ412 للنسخة القديمة.
5) F5: occupancy الحقيقي يُحترم (لا fallback إلى 1)، وحمولة غير صالحة → استثناء دائم
   بـsafe_error_code بلا 500 وبلا كتابة جزئية.
6) F6: العمليات الست: غياب الرأس 400، replay بنفس المفتاح/المحتوى بلا أثر إضافي،
   409 لنفس المفتاح بمحتوى مختلف، وأن العقد required:true مطابق للruntime.
ثم أعد تشغيل: pnpm check / test:property / test:distribution / test:identity (نظيف بعد
dev:stop) / contracts:check / visuals 24+19+38 / checksums+N.
المنخفضات F7..F13 تُراجع كتوثيق فقط وتُصنّف (مقبولة كحد/تحتاج إصلاحاً لاحقاً).
اكتب الحكم: PASS أو FAIL مع بند لكل finding (مغلق/غير مغلق) وأدلتك الخام،
ولا تمنح قبول G-06 (القرار للمستخدم).
```

## 5) الخطوة التالية

1. تشغيل جلسة المراجعة المركزة (القسم 4) وكتابة حكمها في `docs/58`.
2. قرار المستخدم: قبول G-06 (مع توثيق المنخفضات) أو إصلاح ما يتبقى، ثم فتح P07.
