# مراجعة مركزة مستقلة على F1..F6 (بوابة G-06) — تقرير

التاريخ: 15 سبتمبر 2026. النطاق: إعادة إنتاج findings F1..F6 من
[docs/55](55_phase6_independent_review.md) بعد إصلاحات [docs/56](56_g06_fix_session.md)،
وإعادة تشغيل الأطقم المطلوبة. المراجع الحاكمة: [docs/49](49_phase6_execution_prompt.md)،
[docs/execution/G-06.md](execution/G-06.md)، وعقد `docs/contracts/phase6.openapi.json`.

هذا حكم تقني على **إغلاق F1..F6 فقط**؛ **لا يمنح قبول G-06** — القرار للمستخدم.
المنخفضات F7..F13 روجعت كتوثيق وصُنّفت في القسم 6.

## 1) الحكم

**PASS — أُغلقت F1..F6 بأدلة مستقلة، ولا يظهر في هذه الجولة أي finding جديد عالٍ/متوسط.**

| Finding | الحالة | جوهر الدليل |
|---|---|---|
| F1 (عالٍ) | **مغلق** | تعارض خارجي ثم تحرير ثم reprocess → `APPLIED` مرة واحدة، ثم `DUPLICATE` replay؛ ومثله `LINK_MISSING` بعد الربط؛ والأصل سليم أثناء الفشل |
| F2 (متوسط) | **مغلق** | طلبا APPLY متوازيان بملفين ونفس `external_key` → حجز واحد والثاني `DUPLICATE` بلا أثر |
| F3 (متوسط) | **مغلق** | DRY_RUN ثم APPLY → run مستقل يُطبِّق مرة واحدة؛ إعادة APPLY replay؛ القيد الفريد صار `(file_hash, mode, source)` |
| F4 (متوسط) | **مغلق** | تعديل بند INQUIRY بكمية 1 و2 → 200 بلا commitment ACTIVE وبقاء INQUIRY؛ المؤكد: 412 للنسخة القديمة وذريّ عند الفشل |
| F5 (متوسط) | **مغلق** | `occupancy` الحقيقي يُحترم (بند/ظرف)، والحمولة غير الصالحة → استثناء دائم `PAYLOAD_UNSUPPORTED` بلا 500 وبلا كتابة جزئية |
| F6 (متوسط) | **مغلق** | العمليات الست: غياب الرأس 400 `required`، المفتاح <16 حرفاً 400 `too_short`، replay آمن، 409 للمحتوى المختلف؛ والعقد `required:true` مطابق للruntime |

## 2) بيان الاستقلال

- لم أكتب أو أعدّل كود إنتاج ولا اختبارات ولا مهاجرات. أضفت فقط هذا التقرير وسكربتات
  تحقيق مستقلة تحت `.local/verification/review-g06-focused/` (بيانات اصطناعية `f1-*..f6-*`).
- لم أعتمد أرقام المنفّذ كحكم: أعدت تشغيل كل الأوامر، وبنيت requests من الصفر، وفحصت
  القاعدة مباشرة بدور المالك (`DATABASE_URL`) على قاعدة dev وقواعد الأطقم المؤقتة.
- لم تُطبع أي أسرار؛ المخرجات حالات/رموز/معرّفات/أعداد فقط. لا قناة حية ولا AT ولا بيانات نزلاء حقيقية.

## 3) إعادة تشغيل الأطقم المطلوبة

| الأمر | النتيجة المعادة مستقلاً | الدليل الخام |
|---|---|---|
| `pnpm check` (build + contracts + typecheck + lint + format + jest) | **79/79** (10 حزم) | `logs/01-check.log` |
| `pnpm test:property` | **145/145 في 23 حزمة** | `logs/02-test-property.log` |
| `pnpm test:distribution` | **48/48 في 11 حزمة** | `logs/03-test-distribution.log` |
| `pnpm test:identity` (بعد `pnpm dev:stop`، منفذ 4100 حر) | **48/48 في 7 حزم** بلا عمليات متبقية | `logs/04-test-identity.log` |
| `pnpm contracts:check` | 43/30/36/21/**15** بلا تغيير عقد | `logs/05-contracts-check.log` |
| `pnpm visual:phase6` | **24/24** | `logs/07-visual-phase6.log` |
| `pnpm visual:phase5` | **19/19** | `logs/08-visual-phase5.log` |
| `pnpm visual:check` | **38/38** | `logs/09-visual-check.log` |
| `pnpm checksums` + `sha256sum -c` | **440/440 OK** بعد إضافة هذا التقرير (كان 439/439 قبله) | `logs/11-checksums.log` و`logs/12-sha256sum-check.log` |

ملاحظة F9: قبل أطقم property/identity كان `pnpm dev:stop` قد نُفّذ والمنافذ 4100/4101/5173
خالية (تحقق `ss`)؛ مرّت الأطقم نظيفة. أعيد تشغيل dev للـprobes والبصريات ثم أُوقف في نهاية الجولة
(تحقق `ss`: لا listeners). لا علاقة لـKeycloak بالفشل السابق؛ التنازع كان على المنفذ كما وثّق docs/56.

## 4) إعادة إنتاج F1..F6 (أدوات مستقلة)

كل السكربتات في `.local/verification/review-g06-focused/`، ومخرجاتها الخام JSONL في
`logs/f1..f6-*.jsonl`. كل سيناريو أنشأ Property/منتج/خطة أسعار جديدة عبر API باسم `admin-a`.

### F1 — إعادة معالجة استثناءات المستهلك (مغلق)

السكربت: `f1-revision-reprocess.mjs` — الدليل: `logs/f1-revision-reprocess.jsonl`.

1) تعارض خارجي: حجز OTA مؤكد (تخصيص `ACTIVE`) + حاجز مؤكد في الفترة المستهدفة، ثم revision
`modified` مباشرة في `distribution_inbox_revision`، ثم
`POST /inbox/{id}/reprocess`:

```json
{"id":"F1.conflict-first-reprocess","status":200,"outcome":"EXCEPTION","errorCode":"EXTERNAL_CONFLICT",
 "revision":{"processing_state":"EXCEPTION","safe_error_code":"EXTERNAL_CONFLICT","applied":false},
 "allocationsBefore":[{"start":"2026-11-06","end":"2026-11-08","state":"ACTIVE"}],
 "allocationsAfterConflict":[{"start":"2026-11-06","end":"2026-11-08","state":"ACTIVE"}],
 "originalIntact":true,"exceptions":[{"state":"OPEN","resolution":null}]}
```

2) بعد `cancel` الحاجز (200) وإعادة reprocess:

```json
{"id":"F1.conflict-reprocess-after-release","status":200,"outcome":"APPLIED","errorCode":null,
 "revision":{"processing_state":"APPLIED","applied":true},
 "itemPeriod":{"arrival":"2026-11-09","departure":"2026-11-11"},
 "allocationsAfterApply":[{"state":"RELEASED"},{"state":"ACTIVE"}],
 "exceptions":[{"state":"RESOLVED","resolution":"REPROCESSED"}]}
```

3) إعادة reprocess ثالثة → `DUPLICATE`/`replayed=true` مع بقاء التخصيصات وعدد حجوزات المفتاح = 1
(`allocationsUnchanged=true`, `reservationCount=1`) — أي التعديل طُبّق **مرة واحدة**.

4) `LINK_MISSING`: revision لحجز غير مرتبط → `EXCEPTION/LINK_MISSING` و`applied=false` وبلا أي
حجز (`reservationCount=0`)؛ ثم إنشاء الحجز وربطه وتأكيده → reprocess → `APPLIED` مع تحديث الفترة
وحلّ الاستثناء `RESOLVED/REPROCESSED` و`reservationCount=1`.

مطابقة الكود: `channel-revision-repository.ts:68-75` لا يضبط `applied_at` إلا عند `APPLIED`،
و`revision-service.ts:198-203` يكشف التكرار بـ`processing_state='APPLIED'` لا بـ`applied_at`.

**الحكم: مغلق** — كان الفشل القديم يعيد `DUPLICATE`؛ الآن يُعاد التطبيق مرة واحدة بدقة.

### F2 — تسابق الاستيراد بنفس المفتاح (مغلق)

السكربت: `f2-import-race.mjs` — الدليل: `logs/f2-import-race.jsonl`.

طلبا `POST /imports` (mode=APPLY, source=FEED) متوازيان (`Promise.all`) بملفين مختلفي المحتوى
(فترتان مختلفتان ⇒ بصفة مختلفة) ونفس `external_key`، وبمفتاحي idempotency مستقلين:

```json
{"id":"F2.concurrent-apply-same-key","leftStatus":200,"leftAccepted":1,"leftDuplicate":0,
 "rightStatus":200,"rightAccepted":0,"rightDuplicate":1,
 "reservationCount":1,"items":[{"state":"INQUIRY","arrival":"2026-11-24","departure":"2026-11-26"}],
 "importRunCount":2}
```

طلب واحد فقط أنشأ الحجز، والثاني أعاد `DUPLICATE` (صف تقرير فقط) بلا حجز/بند إضافي — لا خطأ 500
ولا كسر قيد. الآلية المرصودة: `import-service.ts:208-209` يقفل صف Property (`FOR UPDATE`) قبل
`findExistingRun`/`findImportByIdentity`، فيرى الثاني أثر الأول ويعيد `DUPLICATE`
(`import-service.ts:238-246`).

**الحكم: مغلق** — لا تكرار تحت التسابق.

### F3 — فصل DRY_RUN عن APPLY (مغلق)

السكربت: `f3-import-dry-run.mjs` — الدليل: `logs/f3-import-dry-run.jsonl`.

```json
{"dryStatus":200,"dryAccepted":1,"reservationsAfterDry":0,
 "applyStatus":200,"applyRunId":"...cf5bc488...","applyReplayed":false,"applyAccepted":1,"reservationsAfterApply":1,
 "replayStatus":200,"replayReplayed":true,"replayRunId":"...cf5bc488...","reservationsAfterReplay":1,
 "otherSourceStatus":200,"otherSourceReplayed":false,"otherSourceAccepted":0,"otherSourceDuplicate":1,
 "distinctRunIds":3,"runCount":3}
```

`APPLY` بعد `DRY_RUN` لنفس المحتوى أنشأ **run مستقلاً** وطُبّق مرة واحدة، وإعادة `APPLY` لنفس
الملف أعادت نفس `run_id` مع `replayed=true` وبلا حجز إضافي (استُخدم مفتاح idempotency جديد في
الإعادة لإثبات أن replay يأتي من بصمة الملف لا من مفتاح الطلب). كما تحقق قيد القاعدة المطابق:

```
reservation_import_run_hash_unique USING btree (tenant_id, property_id, file_hash, mode, source)
```

**الحكم: مغلق** — DRY_RUN لم يعد يحجب APPLY، وreplay ما زال آمناً.

### F4 — تعديل البنود غير المؤكدة والمؤكدة (مغلق)

السكربت: `f4-inquiry-modify.mjs` — الدليل: `logs/f4-inquiry-modify.jsonl`.

- بند `INQUIRY` كمية 1: `PATCH` → **200**، الفترة تحدثت، والحالة بقيت `INQUIRY`،
  `activeCommitments=0`, `activeAllocations=0`.
- بند `INQUIRY` كمية 2: `PATCH` → **200**، الكمية بقيت 2، بلا commitment وبقاء `INQUIRY`.
- بند مؤكد: `PATCH` بنسخة قديمة → **412 `STALE_VERSION`** (`details={expected,current}`) مع بقاء
  البند والتخصيص حرفياً كما كانا؛ ثم `PATCH` صحيح → 200 مع تحرير التخصيص القديم وإنشاء تخصيص
  `ACTIVE` واحد جديد (ذريّ)؛ ثم محاولة تعديل لفترة مشغولة → **409 `RESOURCE_UNAVAILABLE`**
  بلا أي تغيير على البند/التخصيص.

```json
{"staleStatus":412,"staleCode":"STALE_VERSION","staleItemUnchanged":true,"staleCommitmentUnchanged":true,
 "goodStatus":200,"goodCommitment":{"activeCommitments":1,"allocations":[{"state":"RELEASED"},{"state":"ACTIVE"}]},
 "blockedStatus":409,"blockedCode":"RESOURCE_UNAVAILABLE","blockedItemPeriod":{"arrival":"2026-10-30","departure":"2026-11-01"}}
```

مطابقة الكود: `commitment-service.ts:44-52` يفرّق بين حالات `modifiableStates` وحالات
`inventoryHoldingStates`؛ حلقة الالتزام لا تعمل لغير المؤكد.

**الحكم: مغلق** — لا تثبيت مخزون لبند غير مؤكد، ولا فشل 409 لكمية >1، والمؤكد بقي ذرياً.

### F5 — `occupancy` والحمولات غير الصالحة (مغلق)

السكربت: `f5-occupancy.mjs` — الدليل: `logs/f5-occupancy.jsonl`.

```json
{"id":"F5.item-occupancy-4","outcome":"CREATED","items":[{"state":"INQUIRY","adults":4}]}
{"id":"F5.envelope-occupancy-3","outcome":"CREATED","items":[{"state":"INQUIRY","adults":3}]}
{"id":"F5.legacy-adults-ignored","outcome":"EXCEPTION","errorCode":"PAYLOAD_UNSUPPORTED","reservations":[],"items":[]}
{"id":"F5.invalid-occupancy-0","outcome":"EXCEPTION","errorCode":"PAYLOAD_UNSUPPORTED","reservations":[],"items":[]}
{"id":"F5.invalid-occupancy-50","outcome":"EXCEPTION","errorCode":"PAYLOAD_UNSUPPORTED","reservations":[],"items":[]}
{"id":"F5.modified-occupancy-5","outcome":"APPLIED","items":[{"state":"CONFIRMED","adults":5}]}
```

- `occupancy` من البند يُحترم (4)، ومن الظرف عند غيابه في البند (3)؛ لا fallback إلى 1.
- shape قديم `adults` فقط يُرفض الآن كحمولة غير مدعومة (العقد يرسل `occupancy`).
- قيم 0/50 (وخارج 1..20) → استثناء دائم `PAYLOAD_UNSUPPORTED` مع `safe_error_code` و`applied=false`،
  **بلا 500** وبلا أي كتابة جزئية (`reservations=[]`, `items=[]`).
- revision `modified` حدّث `adults` إلى 5 (أي `occupancy` محترم في مسار التعديل أيضاً).

مطابقة الكود: `revision-service.ts:44-53` (قراءة/تحقق 1..20) و`:77-78` (بند ثم ظرف).

**الحكم: مغلق** — لا فقدان `occupancy` ولا مسلك 500 غير محكوم.

### F6 — Idempotency-Key للعمليات الست (مغلق)

السكربت: `f6-idempotency.mjs` — الدليل: `logs/f6-idempotency.jsonl`.

- قراءة العقد مستقلة: العمليات الست (`ConfirmReservation`, `CreateReservationDraft`,
  `ModifyReservation`, `CreateGuest`, `CancelItem`, `ImportReservations`) تشير إلى
  `#/components/parameters/IdempotencyKey` بـ`required=true, minLength=16, maxLength=128`.
- غياب الرأس في كل عملية → **400** `INVALID_REQUEST` مع `details={field:"idempotency_key",reason:"required"}`.
- مفتاح قصير (<16) → **400** بنفس الحقل و`reason:"too_short"`.
- replay (نفس المفتاح/المحتوى) → نفس المورد/النسخة/`run_id` مع `replayed=true` وبلا أثر إضافي:
  نزيل واحد، مسودة واحدة، تخصيص نشط واحد للبند، نسخة تعديل واحدة، حالة `CANCELLED` واحدة،
  وصف استيراد واحد.
- نفس المفتاح بمحتوى مختلف → **409** `CONFLICT` مع `details.reason="idempotency_key_reused"`
  في العمليات الست.

عينة خام:

```json
{"id":"F6.missing-header.CreateGuest","status":400,"details":{"field":"idempotency_key","reason":"required"}}
{"id":"F6.ConfirmReservation","firstStatus":200,"replayStatus":200,"replayed":true,"sameReservation":true,
 "differentStatus":409,"differentReason":"idempotency_key_reused","activeAllocations":1}
{"id":"F6.ImportReservations","firstRunId":"...83809955...","replayReplayed":true,"sameRunId":true,
 "differentStatus":409,"reservationsForImportPrefix":1}
```

**الحكم: مغلق** — العقد والruntime متطابقان، بلا تغيير في العقد أو الأنواع المولّدة
(`contracts:check` 15 عملية كما هو).

## 5) التحقق من سلامة الأصل/عدم الكتابة الجزئية (عبر F1/F4/F5)

- F1: `allocationsBefore == allocationsAfterConflict` حرفياً، والاستثناء لا يكتب شيئاً.
- F4: محاولتا 412 و409 لم تغيّرا البند/التخصيص؛ النجاح الوحيد أنتج تخصيصاً `ACTIVE` واحداً.
- F5: كل الحمولات المرفوضة تركت صفر حجوزات وصفر بنود.

## 6) المنخفضات F7..F13 (مراجعة توثيقية وتصنيف)

| Finding | التوثيق الحالي | التصنيف |
|---|---|---|
| F7 شاشة الاستيراد/الاستثناءات | مؤجلة صراحةً إلى P07 في G-06 وفي docs/32؛ لا ادعاء تنفيذ | مقبولة كحد/مؤجلة — تبقى متابعة في P07. ملاحظة: بطاقة P06-05 سطر 3 ما زال يقول "ضمن P06-06" بينما سطر 35 يذكر النقل؛ انحراف صغير غير حاجب |
| F8 أرقام/حالة | صُححت في G-06 وP06-06 وREADME؛ تحققنا مستقلاً: property **145/145**، `visual:phase6` **24/24**، وسطر P06-01 محدّث | مغلق توثيقياً |
| F9 تنازع منفذ أطقم الهوية | السبب موثق كتنازع 4100؛ التشغيل النظيف **48/48** بعد `dev:stop` | مغلق تشخيصياً؛ تقوية الهارنس (تحقق PID) مؤجلة كمنخفض |
| F10 Pickup/Split بلا Outbox | حد معلن في G-06؛ تحققنا من الكود: `enqueueOutbox` يُستدعى في No-show فقط (`group-service.ts:117,801`) ولا يُستدعى في Pickup/Split (`:310,472`) | مقبول كحد معلن |
| F11 تهريب محارف LIKE | منفَّذ في `guest-repository.ts:78-87` (`escape '\\'` + تهريب `\ % _`) مع اختبار داخل طقم property الذي مرّ 145/145 | مغلق |
| F12 مطابقة البنود بالفهرس | حد معلن في G-06؛ الكود يطابق بالفهرس (`revision-service.ts:466-468`) | مقبول كحد معلن؛ يُحسّن لاحقاً إن لزم |
| F13 نطاق مفتاح idempotency | حد معلن في G-06؛ القيد `(tenant, operation, key)` | مقبول كحد معلن |

## 7) حدود هذه الجولة وما لم يُختبر

- لا AT ولا قناة/مزود حي ولا OTA حقيقي؛ المحاكي/الصفوف الاصطناعية فقط.
- الأطقم property/identity شغّلت APIها على قواعد اختبار مؤقتة أُنشئت وأُسقطت؛ مراجعة القاعدة
  للـF1..F6 تمت على قاعدة dev بدور المالك.
- لم أختبر crash/استئناف عامل الاستيراد ولا استهلاك Outbox الفعلي ولا المالية (P08).
- F2 يتناول طلبين متوازيين؛ القفل يضمن التسلسل عبر عمليات API/worker لأنه قفل صف قاعدة بيانات.

## 8) الأدلة الخام

- سكربتات: `support.mjs` و`f1-revision-reprocess.mjs` .. `f6-idempotency.mjs` تحت
  `.local/verification/review-g06-focused/` (النسخة الأصلية للعقد تُقرأ من المستودع؛ لا أسرار).
- JSONL لكل finding: `logs/f1..f6-*.jsonl`، وإخراجات التنفيذ `logs/f*-console.txt`.
- أطقم/بصريات: `logs/01..05` و`logs/07..09`، والبصريات المخزنة في `.local/verification/P06-06`.
- الفحوص السياقية: قيد F3 الفريد (`pg_indexes`) ومسارات الكود المذكورة أعلاه.
- checksums: `logs/10a-sha-before.log` (439/439 قبل التقرير)، و`logs/11-checksums.log` +
  `logs/12-sha256sum-check.log` (440/440 بعده).

## 9) حالة القرار

F1..F6 **مغلقة تقنياً وفق هذه الجولة**؛ المنخفضات F7..F13 مصنفة أعلاه.
**G-06 لا يزال REMEDIATED / REVIEW_PENDING — لا يمنح هذا التقرير قبول G-06؛ القرار للمستخدم،
والخطوة التالية (قبول مع توثيق المنخفضات أو إصلاح إضافي ثم فتح P07) بيده.**
