# مراجعة مستقلة للمرحلة 6 (P06: الحجوزات والنزلاء والاستيراد) — تقرير

التاريخ: 15 سبتمبر 2026. النطاق: P06-01..P06-06 وG-06 في `/home/omar/Desktop/Hotel`.
المرجع الحاكم: `docs/49`، وبطاقات `docs/execution/P06-01..06`، `docs/execution/G-06.md`،
`docs/contracts/phase6.openapi.json`، و`docs/32` قسم P06.
هذا حكم توصيفي مستقل؛ **لا يقبل G-06 نيابة عن المستخدم** والقبول قراره وحده.

## 1) الحكم

**FAIL — إصلاح وإعادة فحص قبل أي قبول لـG-06.**

كل أرقام الأدلة المعلنة أُعيد إنتاجها بنجاح (بما فيها `test:identity` 48/48 بعد تنظيف
البيئة)، والعزل وRLS والتدقيق سليمة في الفحوص التي أجريتها. لكن المراجعة أثبتت:

- **F1 (عالٍ):** استثناءات مستهلك المراجعات تُعلَّم `applied_at` فتمنع أي إعادة معالجة
  لاحقة حتى بعد زوال السبب (تعارض خارجي/ربط مفقود)، خلافاً لما وثّقته بطاقة P06-04
  وخلافاً لمعنى "إعادة معالجة" في P06-05. هذا يكسر مسار استرجاع التعارض الخارجي.
- **F2..F6 (متوسطة):** تكرار حجز تحت تسابق الاستيراد بنفس المفتاح، وكون بصمة الملف
  تمنع تنفيذ dry-run ثم apply لنفس الملف، وسلوك `ModifyReservation` على بند غير مؤكد
  (تثبيت مخزون بلا تأكيد وفشل 409 لكمية أكبر من 1)، وإهمال `occupancy` القناة في
  المستهلك مع إمكان 500 على حمولة غير صالحة، وفرض `Idempotency-Key` في العقد دون
  تنفيذ/فرض في ثلاث عمليات.

هذه ليست عيوباً أمنية/عزل ولا فساد بيانات مثبتاً؛ لكن F1 يمنع قبول البوابة بحالتها.

## 2) بيان الاستقلال

- لم أكتب كود إنتاج ولم أعدّل أي اختبار أو مهاجرة. أضفت فقط: هذا التقرير، وسكربتات
  تحقيق مستقلة تحت `.local/verification/review-g06/` (بيانات اصطناعية P06-*)، وسجلات
  خام في المجلد نفسه و`/tmp/opencode/p06-review/`.
- لم أستخدم أدلة المنفّذ كحكم؛ أعدت تشغيل الأوامر بنفسي وفحصت قواعد البيانات مباشرة
  بدور المالك وبدور `hotel_api`/`hotel_worker`.
- لم تُطبع أي أسرار؛ كل المخرجات حالات/معرّفات/أعداد.

## 3) إعادة إنتاج الأرقام المعلنة

| البند | المعلن | المعاد مستقلاً | الدليل الخام |
|---|---|---|---|
| `pnpm build` | نجاح | نجاح | `.local/verification/review-g06/logs/01-build.log` |
| `pnpm check` | 79/79 | 79/79 (10 حزم) | `logs/02-check.log` |
| `pnpm contracts:check` | 15 عملية P06 | 43/30/36/21/15 | `logs/03-contracts-check.log` |
| `pnpm test:identity` | غير مدّعى في G-06 | **48/48** (تشغيل نظيف) | `logs/04d-test-identity-clean2.log` |
| `pnpm test:distribution` | 48/48 | 48/48 (11 حزمة) | `logs/05-test-distribution.log` |
| `pnpm test:property` | 132/132 (23) | 132/132 (23) | `logs/06-test-property.log` |
| `pnpm visual:phase5` | 19/19 | 19/19 | `logs/08-visual-phase5.log` |
| `pnpm visual:phase6` | 23/23 (بطاقة P06-06) | **24/24** (فحص إضافي، F8) | `logs/09-visual-phase6.log` |
| `pnpm visual:check` | 38/38 | 38/38 | `logs/10-visual-check.log` |
| `pnpm checksums` + `sha256sum -c` | 433 OK | 433/433 OK قبل التقرير، ثم 434/434 OK بعده | `logs/11-checksums.log` و`logs/12-sha256sum-check.log` و`logs/18..21` |

ملاحظة `test:identity`: الجولة الأولى (`logs/04-test-identity.log`) والثانية بعد إعادة
تشغيل Keycloak (`logs/04b`) سجّلتا 34/48 مع `startup_failed` متكرر للـAPI لأن منفذ 4100
كان مشغولاً (خدمة dev متزامنة ظهرت في البيئة أثناء الفحص)؛ بعد `pnpm dev:stop` وإزالة
العمليات العالقة مرّ التشغيل النظيف 48/48 وخرج دون عمليات متبقية. التفصيل في F9.

## 4) الفحوص العدائية المستقلة

كل السكربتات في `.local/verification/review-g06/`؛ المخرجات الخام في `logs/13..17`.

### (أ) تأكيد/تعديل/إلغاء متزامن ومفتاح idempotency مختلف المحتوى

- نفس المفتاح بمحتوى مختلف: أول تأكيد `200` (replayed=false)، والثاني `409 CONFLICT`،
  وسجل واحد في `api_idempotency` (`probe-api.log` → `B.idempotency-different-content`).
- سباق التأكيد على مورد واحد: مغطى في `test:property` (فائز واحد، `logs/06`).
- **جديد F4:** تعديل بند `INQUIRY` بكمية 1 ينجح ويتركه `INQUIRY` مع `commitment ACTIVE`
  (`A2.qty1`)، وبكمية 2 يفشل `409 CONFLICT` بلا تفاصيل (`A.qty2`، و`probe-api3.log`).

### (ب) Pickup/Split بلا تكرار أو تراكب

- Pickup مرة واحدة `200`، وإعادته `404`، وعدد التخصيصات النشطة 1، والـAllotment
  `PICKED_UP` (`G.pickup`/`G.pickup.db` في `logs/15`).
- Split: قطاعان متلاصقان `CONFIRMED`، تراكب 0، تخصيصان نشطان، وإعادة Split بنسخة قديمة
  `412 STALE_VERSION` (`logs/17`)، وNo-show يحرر الالتزام ويرفض `IN_HOUSE` `409`
  (`probe-api4.out.txt`).

### (ج) ReprocessChannelEvent

- duplicate: التكرار يعيد `DUPLICATE` بلا أثر (`logs/06`، و`D` في `logs/13`).
- out-of-order/LINK_MISSING/ITEM_COUNT_MISMATCH: استثناءات دائمة صريحة (`logs/06`).
- EXTERNAL_CONFLICT: `EXCEPTION` بلا كتابة، والتخصيص الأصلي سليم (`allocationsBefore`).
- **جديد F1:** بعد `EXTERNAL_CONFLICT` وإلغاء الحاجز وتحرير المورد، إعادة المعالجة
  تعيد `DUPLICATE` ولا تطبق التعديل؛ ومثله `LINK_MISSING` بعد إنشاء الربط
  (`D`/`D2` في `logs/13`، و`revisionRow.applied=true`).

### (د) الاستيراد

- بصمة ملف مكررة: replay بلا أثر (`logs/06`).
- **جديد F3:** `DRY_RUN` ثم `APPLY` لنفس المحتوى → `replayed=true` و**0 حجوزات**
  (`C.dry-run-then-apply-same-file` في `logs/13`).
- **جديد F2:** طلبا `APPLY` متوازيان، بملفين مختلفين ونفس `external_key` → `200/200`
  و**حجزان** (`C2.concurrent-same-key-different-files`).
- خبيث/كبير: 413 للحجم و`UNSAFE_CELL`/`INVALID_EXTERNAL_KEY`/`CROSS_SCOPE_REFERENCE`
  (`logs/06`)، وreports لا تتضمن محتوى خاماً.

### (هـ) RLS ومنح الأدوار والجداول الجديدة

من `logs/16` وسبر `hotel_api` المباشر:

- جميع الجداول العشرة (`guest`, `reservation`, `reservation_item`, `stay_segment`,
  `reservation_guest`, `api_idempotency`, `reservation_group_allotment`,
  `reservation_import_run`, `reservation_import_row`, `distribution_inbox_revision`)
  عليها `rowsecurity=true` و`forcerowsecurity=true`، والأدوار الثلاثة بلا
  superuser/BYPASSRLS.
- لا `DELETE` لـ`hotel_api` على الجداول الجديدة، ولا `UPDATE` على
  `reservation_import_row`، و`hotel_worker` للقراءة فقط على جداول الحجز؛ فقط
  `stay_segment UPDATE` و`distribution_inbox_revision SELECT/UPDATE` (مقصودان، الأخير
  لمستهلك P06-04).
- سياق API بعميل A لا يرى سجلات B: `crossGuest=0`, `crossImport=0`, ومحاولة تعديل
  نزيل B من سياق A أرجعت `rowCount=0`; وبلا سياق `app.tenant_id` كل الأعداد 0.
- عبر API: `owner-b` على مسار منشأة A يعيد `403 TENANT_CONTEXT_MISMATCH`، ونزيل A عبر
  مسار B يعيد `404` (`E.cross-tenant-api` في `logs/13`).

### (و) استقلال `guest.read` وعدم كشف نزلاء/مال

- `auditor-a`: قائمة وتفاصيل الحجز `200` و`guests=null` ولا يظهر اسم النزيل ولا بريده،
  و`/guests` يعيد `403` (`F.auditor-read-independence`).
- إضافة LEAD باسم مميز: المدقق لا يراه، والمالك يراه، ولا حقول مالية في تفاصيل الحجز
  (`moneyFieldsInDetail=false`، `F.guest-name-hidden-without-permission`).
- `member-a`: لا يرى قائمة النزلاء `403`، وتفاصيل الحجز لا تكشف نزيلاً.

## 5) الأسئلة الحرجة

| السؤال | الجواب والدليل |
|---|---|
| كتابة بلا Audit/Outbox عند اللزوم؟ | لا للـAudit: كل مسارات P06 سجلت أحداثاً (`H.audit-actions`: draft/confirmed/modified/item_cancelled/group/pickup/split/no_show/import_run/revision). Outbox: confirm/modify/cancel/no-show ترسله للحجز المرتبط بقناة، أما Pickup/Split على حجز مرتبط فسكوت (F10). |
| هل يمكن تحرير الأصل عند فشل؟ | لا: تعديل فاشل يحفظ التخصيص والقطاع (`logs/06` و`A.qty2`)، وEXTERNAL_CONFLICT حفظ الأصل 100% (`D`). |
| ادعاءات AT/قنوات حية بلا دليل؟ | لا توجد في بطاقات P06 (صفر إشارات AT-*)، والقنوات صريحة كغير حية (محاكي فقط). |
| الحدود المعلنة مطابقة للواقع؟ | نعم لـ"لا مالية" و"لا أزرار تأكيد/تعديل/إلغاء" (الواجهة لا تعرض مالاً ولا أزرار lifecycle). لكن شاشة الاستثناءات/الاستيراد المنصوص عليها في `docs/32` P06-05 والمؤجلة إلى P06-06 غير منفذة (F7). |
| findings عالية/متوسطة جديدة؟ | نعم: F1 عالٍ، وF2..F6 متوسطة، وفوق ما هو موثق في G-06. |

## 6) Findings

### F1 (عالٍ) — استثناء المستهلك يُعلَّم `applied_at` فلا يقبل إعادة معالجة

- **الموضع:** `packages/backend/src/modules/reservations/persistence/channel-revision-repository.ts:68-79`
  (تحديث `applied_at = now()` لأي `processing_state` بما فيه `EXCEPTION`) و
  `packages/backend/src/modules/reservations/application/revision-service.ts:148-153`
  (أي `applied_at != null` → `DUPLICATE`).
- **التعارض:** `docs/execution/P06-04.md` يقول "والنجاح يعلّم APPLIED وapplied_at"،
  و`docs/32` P06-05 يعد بإعادة معالجة الاستثناءات.
- **إعادة الإنتاج:**
  1. حجز OTA مؤكد (`ReservationConfirmed` + تخصيص ACTIVE).
  2. Revision `modified` إلى فترة يشغلها حجز آخر → `EXCEPTION`/`EXTERNAL_CONFLICT`،
     والأصل محفوظ.
  3. إلغاء الحاجز (تحرير المورد).
  4. `POST .../inbox/{revisionId}/reprocess` ثانية → `DUPLICATE` ولا يُطبَّق التعديل،
     و`revisionRow.applied=true`.
  والمثل مع `LINK_MISSING` ثم إنشاء الربط. الدليل: `logs/13` (`D`/`D2`).
- **الأثر:** لا سبيل تشغيلي (API/واجهة) لتسوية تعارض خارجي بعد زوال سببه؛ يلزم تدخل
  يدوي بقاعدة البيانات أو إصدار جديد من القناة.
- **الإصلاح المقترح:** لا تضبط `applied_at` عند `EXCEPTION` (أو أعد الحالة إلى
  قابلة للمعالجة)، واستخدم `processing_state` (لا `applied_at`) لكشف التكرار، مع
  اختبارين مستقلين: تعارض ثم تحرير ثم إعادة معالجة، وربط مفقود ثم ربط ثم إعادة معالجة.

### F2 (متوسط) — تسابق الاستيراد بنفس `external_key` ينتج حجزين

- **الموضع:** `application/import-service.ts:198-210, 230-268` (لا قفل Property، والفحص
  `findImportByIdentity` غير ذري) مع غياب قيد فريد لـ`external_booking_key` عندما
  `channel_connection_id is null` (`Migration20260915050000_reservation_core.ts:62-66`).
- **الدليل:** طلبا `APPLY` متوازيان بملفين مختلفي البصمة ونفس المفتاح → `200/200`
  و`reservationCount=2` (`logs/13`).
- **الإصلاح المقترح:** قفل Property كما في مسارات الالتزام، أو فهرس فريد جزئي على
  `(tenant_id, property_id, external_booking_key)` لمصادر الاستيراد، مع معالجة القيد
  كـ`DUPLICATE` لا كخطأ 500.

### F3 (متوسط) — dry-run يمنع apply لنفس الملف

- **الموضع:** بصمة الملف وحدها (`import-service.ts:198` وقيد
  `reservation_import_run_hash_unique` في `Migration20260915110000_reservation_import.ts:32`)،
  والفحص `findExistingRun` بلا اعتبار `mode`/`source` (`import-service.ts:204-210`).
- **الدليل:** `DRY_RUN` (accepted=1) ثم `APPLY` لنفس المحتوى → `replayed=true` و
  `reservationCount=0` (`logs/13`).
- **الإصلاح المقترح:** اجعل البصمة مقيدة بـ`mode`، أو اسمح لـ`APPLY` بإعادة استخدام
  تقرير dry-run وتطبيق الصفوف المقبولة مع أثر واحد فقط، ووثّق أي قيد متبقٍ.

### F4 (متوسط) — `ModifyReservation` على بند غير مؤكد: تثبيت مخزون وفشل كمية>1

- **الموضع:** `application/commitment-service.ts:42-48` يقبل `INQUIRY/TENTATIVE/WAITLIST`،
  وفي حلقة الوحدات (نحو السطر 659) يُنشأ التزام جديد عند غياب التزام نشط دون تحديث
  `commitmentByItem`، فيصطدم الخطان بالقيد `commitment_source_unique`.
- **الدليل:** تعديل كمية 1 → `200` مع `commitment ACTIVE` وبند ما زال `INQUIRY`
  (`A2.qty1`)؛ تعديل كمية 2 → `409 CONFLICT` بلا تفاصيل وبلا أثر (`A.qty2`،
  `logs/15`). مرجع القيد: `Migration20260915020000_inventory_guarantee.ts:40`.
- **الإصلاح المقترح:** إما حصر التعديل على البنود المؤكدة (رفض `INVALID_STATE_TRANSITION`
  لغير المؤكد)، أو إكمال خريطة الالتزام بعد الإنشاء الجديد وتحديث الحالة/الـAudit بشكل
  متسق، مع اختبار كمية>1 لغير المؤكد.

### F5 (متوسط) — المستهلك يقرأ `adults` بينما العقد يرسل `occupancy`

- **الموضع:** `RevisionItem.occupancy` في `packages/contracts/src/distribution.ts:121-132`،
  و`payloadSafe: envelope` في `packages/backend/src/modules/distribution/application/inbox-store.ts:143`،
  بينما `revision-service.ts:60-64` يقرأ `item['adults']`.
- **الأثر:** `occupancy` الوارد من القناة يُهمل دائماً (adults=1)، وأي شكل غير معروف
  (`adults=0/50`) يسبب خطأ قيد غير مترجم → `500 INTERNAL_ERROR` مع بقاء المراجعة
  `RECEIVED` بلا استثناء دائم (`logs/17`). ليست ثغرة، لكنها فقدان بيانات ومسلك فشل غير محكوم.
- **الإصلاح المقترح:** اقرأ `occupancy` (أو `occupancy` على مستوى الظرف)، وأضف تحقق
  zod للحقول قبل الكتابة، وحوّل أخطاء القيود إلى استثناء دائم بـ`safe_error_code`.

### F6 (متوسط) — تعاقد `Idempotency-Key` غير مطابق للتنفيذ

- **الموضع:** `docs/contracts/phase6.openapi.json` يشترط الرأس (`required:true`) في
  `ConfirmReservation`/`CreateReservationDraft`/`ModifyReservation`/`CreateGuest`/
  `CancelItem`/`ImportReservations` (الأسطر 1279/1326/1407/1485/1565/1837)، والكود
  يقرأه فقط في Confirm/Modify/Cancel (`apps/api/src/reservations/reservations.controller.ts:247,271,435`)
  ولا يفرضه على أي عملية.
- **الدليل:** تأكيد بلا رأس → `200`، وإنشاء نزيل بلا رأس → `201`
  (`B2.required-idempotency-header` في `logs/13`).
- **الإصلاح المقترح:** إما تنفيذ idempotency وفرض الرأس في العمليات الثلاث وتحديث
  الاختبارات، أو تعديل العقد ليعكس الواقع (`required:false` أو حذف الرأس) بقرار موثق.

### F7 (منخفض) — شاشة الاستثناءات/الاستيراد المؤجلة إلى P06-06 غير منفذة

- `docs/32` P06-05 يعد بـ"شاشة استثناءات وإعادة معالجة"، وبطاقة P06-05 تؤجلها إلى
  P06-06، وبطاقة P06-06 لا تذكرها، وG-06 لا يعدّها من الحدود. `apps/web` لا يحتوي أي
  UI لـ`imports` أو `inbox/.../reprocess` (تحقق Grep). إعادة المعالجة متاحة API فقط
  ومعطوبة أصلاً بسبب F1. يوصى بتصحيح نطاق G-06 أو تنفيذ الشاشة.

### F8 (منخفض) — انحراف توثيقي في الأرقام والحالة

- البطاقة وG-06 يقولان `visual:phase6` 23/23، والسكربت الحالي ينتج **24/24** (الفحص
  الإضافي: "sidebar link opens the reservations page")، وتقرير المنفّذ المحفوظ يحوي 23
  فحصاً (`visual-phase6-report.json`). كما أن سطر P06-01 في `README.md:11` ما زال يقول
  "الواجهة متبقية" بعد تنفيذها. تحديث الأرقام والسطر عند الإصلاح.

### F9 (منخفض) — تلوث تشغيل أطقم الهوية بمنفذ 4100 وملاحظة G-06 غير دقيقة

- `tests/identity/support/harness.mjs:226-279` يكتفي بـ`/api/v1/system/ready` من أي
  عملية على المنفذ، ولا يتحقق أن العملية التي استجابت هي ابنه؛ فتلوثت جولتا الفحص
  الأوليتان (34/48 مع `startup_failed`) بسبب dev متزامن/عملية API عالقة، وخرج الحكم
  النظيف 48/48 بعد التنظيف. ملاحظة G-06 عن "فشل Keycloak بعد تشغيل متكرر" لم تُعد إنتاجها
  كسبب؛ الأرجح أنه تنازع منافذ. يوصى بتحسين الأداة (PID/عملية ابن) وتوثيق دليل 48/48
  النظيف في G-06.

### F10 (منخفض) — Pickup/Split على حجز مرتبط بقناة بلا Outbox

- `group-service.ts` يسجل Audit في Pickup/Split لكنه لا يستدعي `enqueueOutbox`، بينما
  Confirm/Modify/Cancel/No-show تفعل. إن كان مقصوداً (لأن OTA يمر عبر المستهلك) فيلزم
  توثيق الحد صراحةً.

### F11 (منخفض) — بحث النزلاء لا يهرّب محارف LIKE

- `persistence/guest-repository.ts:78` يستخدم `%${search}%` دون تهريب `%`/`_`؛ حامل
  `guest.read` يستطيع تمرير `%` لسرد الكل (لا تجاوز صلاحية، لكن سلوك غير متوقع).

### F12 (منخفض) — مطابقة بنود المراجعة بالترتيب وتتجاهل `item_ref`

- `revision-service.ts:394-485` يطابق `payload_safe.items` مع بنود الحجز حسب الفهرس،
  بلا استخدام `item_ref`/`external_room_ref` من الظرف؛ إعادة ترتيب بنود OTA متعددة
  قد تعيد توزيع الفترات على البنود الخطأ. يوصى بمطابقة مستقرة أو توثيق الحد.

### F13 (منخفض) — مفتاح idempotency باسم Tenant دون Property

- القيد `api_idempotency_unique (tenant_id, operation, key)` (مهاجرة 15070000): إعادة
  استخدام المفتاح نفسه في منشأة أخرى لنفس العملية تعيد `409` لأن hash يختلف. مقبول
  كحد معلن أو يُضاف `property_id` للنطاق.

## 7) ما لم يُختبر وحدود المراجعة

- لا AT ولا قناة حية ولا مزود ولا OTA حقيقي؛ المحاكي فقط كما هو معلن.
- لم أشغّل مكتباً أمامياً (لا Check-In/IN_HOUSE حقيقي)؛ اختبرت رفض No-show للمقيم
  بضبط الحالة مباشرة كما تفعل الأطقم.
- لم أختبر crash/استئناف عامل الاستيراد أو استهلاك Outbox الفعلي ولا المالية (P08).
- لا حكم على UX/التزامن البصري بعد إصلاحات مقترحة.

## 8) ترتيب الإصلاح المقترح

1. **F1 أولاً** (عالٍ): تصحيح `applied_at`/كشف التكرار + اختبارا إعادة معالجة
   (`EXTERNAL_CONFLICT` بعد التحرير، `LINK_MISSING` بعد الربط) وإثبات فشل السلوك القديم.
2. **F2/F3** (الاستيراد): منع التكرار تحت التسابق وفصل بصمة dry-run عن apply.
3. **F4** (التعديل): حسم سلوك البنود غير المؤكدة + تحديث خريطة الالتزام.
4. **F5/F6** (المستهلك والعقد): قراءة `occupancy`، تحقق schema، ومطابقة العقد للرuntime.
5. **F7/F8/F9**: الواجهة المؤجلة، تصحيح الأرقام/الحالة، وتقوية أداة أطقم الهوية.
6. **F10..F13**: توثيق حدود أو صقل لاحق غير حاجب.

بعد الإصلاح: إعادة `pnpm check` و`test:property` و`test:distribution` و`test:identity`
النظيف والفحوص البصرية، ثم جولة مراجعة مركزة على F1..F6 قبل طلب قرار المستخدم.

## 9) الأدلة الخام

- سجلات كاملة: `.local/verification/review-g06/logs/01..19` (نسخة من `/tmp/opencode/p06-review/`).
- سكربتات الفحص: `.local/verification/review-g06/probe-api.mjs`, `probe-api2.mjs`,
  `probe-api3.mjs`, `probe-api4.mjs`, `probe-api5.mjs`, `probe-sql.mjs`.
- تقرير جولة API: `.local/verification/review-g06/probe-api-report.json`.
- التقاط split/no-show: `.local/verification/review-g06/probe-api4.out.txt`.
- مقارنة عدد الفحوص البصرية: `.local/verification/review-g06/stored-checks.txt` و`my-checks2.txt`.

## 10) حالة البيئة بعد المراجعة

`pnpm dev` يعمل (api 4100، worker 4101، web 5173) بعد إعادة تشغيله لأدلة البصر.
`CHECKSUMS.sha256` أُعيد توليده أثناء المراجعة: 433/433 OK قبل إضافة هذا التقرير،
و**434/434 OK** بعده (`logs/18-checksums-final.log` و`logs/19-sha256sum-final.log`)،
ويُنصح المنفّذ بإعادة توليده مرة أخرى بعد الإصلاحات.
