# جلسة إصلاح findings المراجعة المستقلة للمرحلة 7 (G-07)

التاريخ: 15 سبتمبر 2026. المراجع الحاكم: [docs/62](62_phase7_independent_review.md) و[docs/60](60_phase7_design_freeze.md)
و[docs/32](32_execution_work_packages.md) قسم P07. النطاق: إغلاق F-RVW7-01 (عالٍ)، F-RVW7-02
(متوسط)، F-RVW7-03 وF-RVW7-04 (منخفضان)، وملاحظة GiST، وتعارض docs/32 («Dirty أو Block
يمنع التسليم») مع docs/60 — محلياً فقط وبلا commit. جلسة الإصلاح نفسها نُفذت بلا dev وبلا
أطقم كاملة وبلا checksums وبلا بصريات؛ استُكملت كلها في جولة الإغلاق P07-07 أدناه.

**الحالة: G-07 = REMEDIATED / REVIEW_PENDING.** هذا السجل لا يمنح قبولاً؛ الحكم في
[docs/64](64_g07_focused_review.md) والقبول قرار المستخدم، ولا تُفتح P08 قبل ذلك.
أُغلق التحقق الكامل والبصريات والبصمات في الجولة P07-07 (أدناه)، وكتلة جولة المراجعة المركزة
جاهزة في [docs/64](64_g07_focused_review.md) حيث يُكتب الحكم في الوثيقة نفسها.

## جدول الإغلاق

| Finding | الخطورة | الحالة | الدليل الأساسي |
|---|---|---|---|
| F-RVW7-01 — تخصيص حيّ بعد إلغاء/No-show | عالٍ | **مغلق** | `cancelPlannedAssignmentsForItem` في ثلاث مسارات + اختبارات `reservation-commitment` و`revision-consumer` |
| F-RVW7-02 — `inventory_block` لا يمنع التخصيص/الدخول/اللوحة | متوسط | **مغلق** | `authorizeRoom` بفحص حجب + `reason=BLOCKED` + اختبارات `front-office-board` و`stay-movement` |
| F-RVW7-03 — تاريخ المكتب الأمامي UTC | منخفض | **مغلق** | `businessToday(property.timezone)` + `date/timezone` في عقد اللوحة + واجهة تستخدم الاستجابة |
| F-RVW7-04 — مفتاح idempotency غير محصور بمنشأة | منخفض | **مغلق** | قيد `(tenant, operation, key, property_id)` + بحث بالمنشأة + اختبار `idempotency-scope` |
| ملاحظة GiST (tenant/property/resource) | تحصين | **مغلق** | مهاجرة `20260915150000_p07_hardening` (تفاصيلها أدناه) |

## F-RVW7-01 (عالٍ) — إغلاق التخصيصات الحية عند إنهاء البند

- أُضيف داخل معاملة الإنهاء نفسها استدعاء `cancelPlannedAssignmentsForItem`
  (`room_assignment` PLANNED → CANCELLED مع `version+1` و`updated_at=now()`) في المسارات
  الثلاثة التي تنهي البند:
  1. `cancelItem` المباشر من P06 — `packages/backend/src/modules/reservations/application/commitment-service.ts`.
  2. إلغاء القناة (`revision_type='cancelled'`) — `revision-service.ts`.
  3. `MarkItemNoShow` — `group-service.ts`.
- لم تُلمس أي `commitment`/`plan_allocation` في هذه الإضافة: P06 يتولاهما كما هو؛ الإصلاح
  يغلق القيد الفيزيائي فقط. `ACTIVE` لا يظهر في هذه المسارات لأن `cancelReservationItemRow`
  يشترط حالات ما قبل الإقامة، ومسار القناة يتخطى IN_HOUSE/CHECKED_OUT؛ لذا الافتراض الفعلي
  هو PLANNED → CANCELLED فقط بلا تغيير دلالة (موثق في docs/63).
- Audit: أُضيف `cancelled_assignment_ids` إلى `afterSafe` في `reservation.item_cancelled`
  و`reservation.item_no_show` (لا يغيّر عقود الاستجابة).
- الاختبارات:
  - `tests/property/reservation-commitment.pg.test.mjs`: «P07 F-RVW7-01 cancelling an item
    releases its live room assignment for reuse» (تخصيص ثم CancelItem → CANCELLED/RELEASED
    بلا تخصيص حيّ، ثم حجز ثانٍ يُخصص الغرفة نفسها 200 واللوحة `eligible=true`)، و«P07
    F-RVW7-01 no-show also releases the live room assignment».
  - `tests/property/revision-consumer.pg.test.mjs`: «P07 F-RVW7-01 a channel cancellation
    releases the live room assignment for reuse» (تخصيص ثم revision cancelled → CANCELLED
    ثم إعادة استخدام الغرفة بحجز ثانٍ 200).

## F-RVW7-02 (متوسط) — فرض `inventory_block` النشط

- `authorizeRoom` (`packages/backend/src/modules/front-office/application/front-office-service.ts`)
  صار يقبل فترة اختيارية ويفحص `inventory_block_resource`/`inventory_block` بحالة `ACTIVE`
  و`mode in ('PLANNED','EMERGENCY')` عبر `daterange` لأي ليلة ضمن الفترة، ويرفض بـ400
  `INVALID_REQUEST` و`details.reason='BLOCKED'` بلا أثر. تمرير الفترة:
  - `AssignRoom`: فترة التخصيص الفعلية `start_date..end_date`.
  - `CheckInStay`: فترة البند `arrival..departure`.
  - `MoveStay`: `effective_date..departure` (البديل المحجوب لا يُقبل).
- المستودع: `listBlockedResourceIds` في `room-assignment-repository.ts` (مفهرس قائم
  `inventory_block_resource_idx (tenant, property, resource)`).
- اللوحة: `candidateReason` يميز الآن `BLOCKED` عن `DIRTY/OOO/OOS/OCCUPIED`؛
  `eligible=false reason=BLOCKED`. أُضيف مفتاح i18n `boardReason.BLOCKED` في ar/en-US/id-ID.
- **حسم تعارض الوثيقة/السلوك**: اعتُمد سلوك docs/32 («Dirty أو Block يمنع التسليم») وحُدّث
  [docs/60](60_phase7_design_freeze.md) §1/§2/§3 و[docs/26](26_api_permissions_events.md)
  ليطابقاه (لا تغيير في العزل/المال/المراحل).
- الاختبارات:
  - `tests/property/front-office-board.pg.test.mjs`: «P07-01 an active inventory block
    prevents assignment and check-in and shows BLOCKED on the board» — PLANNED على R13
    وEMERGENCY على R14: AssignRoom 400 `BLOCKED`، CheckInStay 400 `BLOCKED`، البند بلا أثر،
    اللوحة `BLOCKED`، وفكّ الحجب يعيد الإتاحة (AssignRoom 200).
  - `tests/property/stay-movement.pg.test.mjs`: «P07-02 move rejects an actively blocked
    room and accepts it after release» — رفض حركة إلى غرفة محجوبة بلا أثر ثم قبولها بعد
    `ReleaseBlock`.

## F-RVW7-03 (منخفض) — تاريخ عمل المنشأة

- `businessToday(timezone)` (Intl) بدل `utcToday()`، ويُشتق التوقيت من `property.timezone`
  المحصورة Asia/Jakarta/Makassar/Jayapura في كل مسارات المكتب الأمامي: Check-In
  (`arrival ≤ اليوم المحلي`)، Move/EarlyDeparture (نطاق `effective_date`)، Check-Out
  (`business_date` في الحدث).
- `GetFrontDeskBoard` يقبل `date` اختيارياً ويعيد `{date, timezone}` حيث `date` هو التاريخ
  المستخدم فعلاً (المطلوب أو اليوم المحلي للمنشأة)؛ `findPropertyScope` أعاد `timezone`.
- العقد: `docs/contracts/phase7.openapi.json` → `info 0.19.0`، معامل `date` اختياري، وحقل
  `timezone` إلزامي في `BoardResult`؛ أُعيد توليد `packages/contracts/src/phase7.generated.ts`.
- الواجهة: `FrontDeskPage` يستخدم `date/timezone` من استجابة اللوحة كافتراضي (بدل `utcDate()`)،
  ويعرض اسم توقيت المنشأة، ويؤرخ حوارات Split/Early/Move من تاريخ اللوحة.
- الاختبارات: «P07-01 board without a date uses the property-local date and echoes timezone»
  (المتوقع محسوب مستقلاً بـIntl في الاختبار)، و«P07-01 check-in accepts an arrival on the
  property-local date across the UTC window». **ملاحظة نزاهة:** وقت التشغيل الحالي
  (05:xx UTC) وقع فيه UTC وJakarta في اليوم نفسه، فتعذّر إظهار فرق فعلي؛ الاختبار يثبت
  التساوي بشكل مستقل ويصبح رفض/قبول الفرق دليلاً فعلياً حين تختلفان (نافذة 17:00–24:00 UTC)،
  وهذا موثق هنا بدل ادعاء اختبار نافذة لم تحدث.

## F-RVW7-04 (منخفض) — نطاق مفتاح idempotency

- `findIdempotencyKey` صار يطابق `property_id is not distinct from ?`، و`checkIdempotency`
  يستقبل `propertyId`، وكل عمليات المنشأة الـ13 (8 في P07 + 5 في P06: Draft/Confirm/Modify/
  Cancel/Import) تمرره؛ `CreateGuest` يبقى على مستوى العميل (`property_id=null`) كما كان.
- القيد: مهاجرة `20260915150000_p07_hardening` تستبدل `api_idempotency_unique`
  بـ`unique nulls not distinct (tenant_id, operation, key, property_id)` (PostgreSQL 17)،
  و`insertIdempotencyKey` يستخدم `on conflict on constraint`. النتيجة: إعادة استخدام المفتاح
  عبر منشأتين تنشئ سجلاً مستقلاً ولا ترجع استجابة منشأة أخرى، وإعادة الاستخدام بمحتوى مختلف
  على المنشأة نفسها تبقى 409 `idempotency_key_reused` fail-closed.
- الاختبار: `tests/property/idempotency-scope.pg.test.mjs` — نفس المفتاح/العملية على
  منشأتين: استجابتان مستقلتان، replay لكل منشأة يستعيد سجلها فقط، صفّان في `api_idempotency`
  بملكية منشأة صحيحة، و409 عند اختلاف المحتوى. **حد معلن:** لا يوجد حساب اصطناعي بمنحة منشأة
  واحدة في هذا المستودع (owner-a/admin-a يملكان كل منشآت العميل)، فالاختبار يثبت استقلال
  السجلات وعدم تسريب استجابة عبر المنشآت بحساب يملك الاثنتين؛ فحص «مستخدم يملك منشأة واحدة»
  يبقى مسنداً إلى منطق المطابقة بالمنشأة نفسه.

## تحصين GiST والمهاجرة `20260915150000_p07_hardening`

أُنشئت مهاجرة تصاعدية واحدة (لا تُعدّل `20260915140000` المطبقة) تضم:

1. إعادة إنشاء قيد `room_assignment_no_overlap` بأبعاد `(tenant_id, property_id, resource_id)`
   بدل `resource_id` فقط، بنفس شرط `state in ('PLANNED','ACTIVE')` ونفس دلالة المنع (لا تغيير
   سلوك).
2. استبدال قيد idempotency لقيد F-RVW7-04. لا فهرس جديد لفحص الحجب: فهرس
   `inventory_block_resource_idx` القائم يغطيه.

`down()` نظير كامل (يعيد القيدين لسابقيهما) ولم يُشغَّل تراجعاً فعلياً (خارج نطاق الطلب).
أثر قاعدة البيانات الخام في `.local/verification/P07-06/db-effect.txt` يثبت القيدين الجديدين.

## الوثائق المحدثة

- [docs/60](60_phase7_design_freeze.md) §1 (Block يمنع التسليم)، §2 (GiST ثلاثة أبعاد)،
  §3 (قواعد اللوحة والتخصيص والدخول مع `BLOCKED` و`date/timezone`).
- [docs/26](26_api_permissions_events.md): سطر تحديث P07-06 (اللوحة/الحجب/الإلغاء/idempotency/المهاجرة).
- بطاقات [P07-01](execution/P07-01.md) و[P07-02](execution/P07-02.md) و[P07-03](execution/P07-03.md)
  بملاحظات الإصلاح ودلائله، و[G-07](execution/G-07.md) (REMEDIATED / REVIEW_PENDING)،
  و[docs/17](17_decisions_readiness.md) و[README](../README.md).
- جولة الإغلاق P07-07 حدّثت أرقام ما بعد الإصلاح في [P07-05](execution/P07-05.md)
  و[G-07](execution/G-07.md) و[docs/17](17_decisions_readiness.md) و[README](../README.md)،
  وهذا الجدول.
- [docs/64](64_g07_focused_review.md): كتلة لصق جاهزة لجلسة المراجعة المركزة (بنمط
  [docs/56](56_g06_fix_session.md) §4) تغطي F-RVW7-01..04 وسؤالَي docs/62 رقم 2 و10 وعدم
  الارتداد، والحكم يُكتب داخل docs/64 نفسه لا في وثيقة جديدة.

## الأرقام الخام (محلياً)

| الأمر | النتيجة | السجل |
|---|---|---|
| `pnpm dev:stop` | No development process recorded | `.local/verification/P07-06/dev-stop.log` |
| `pnpm build` | ناجح (10 حزم) | `.local/verification/P07-06/build.log` |
| `pnpm db:migrate` | Successfully migrated up to the latest version (تطبيق `20260915150000`) | `.local/verification/P07-06/db-migrate.log` |
| `pnpm db:check` | database connection successful | `.local/verification/P07-06/db-check.log` |
| `pnpm contracts:generate` | ناجح | `.local/verification/P07-06/contracts-generate.log` |
| `pnpm contracts:check` | 43/30/36/21/15/**10** ومطابقة الأنواع | `.local/verification/P07-06/contracts-check.log` |
| `pnpm test:property:fast -- --filter='front-office-board\|idempotency-scope\|reservation-commitment\|revision-consumer\|stay-movement\|stay-checkout'` | **50/50 في 6 حزم** | `.local/verification/P07-06/property-fast-final.log` |
| `pnpm check` | **79/79 في 10 حزم** مع lint/typecheck/format/contracts (تشغيل نهائي بعد تجميد الكود) | `.local/verification/P07-06/check-final.log` (وتشغيل سابق `check.log`) |
| أثر القيود في القاعدة | GiST بثلاثة أبعاد + `UNIQUE NULLS NOT DISTINCT (...)` + المهاجرة مسجلة | `.local/verification/P07-06/db-effect.txt` |

ملاحظات: `test:property:fast` أُعيد أيضاً منفرداً على `reservation-commitment` بعد إضافة
اختبار No-show (**10/10**، `property-fast-reservation-commitment.log`). لم تُشغَّل أطقم
كاملة ولا `checksums` ولا بصريات وفق حدود طلب جلسة الإصلاح؛ استُكملت كلها في جولة الإغلاق
P07-07 أدناه.

## الأرقام النهائية بعد الجولة الكاملة (P07-07، 15 سبتمبر 2026)

جولة إغلاق منفذة على الكود المجمّد نفسه: `dev:stop` قبل الأطقم (المنافذ 4100/4101/5173 حرة)،
والسجلات الخام في `.local/verification/P07-07/`.

| الأمر | النتيجة | السجل |
|---|---|---|
| `pnpm dev:stop` (قبل) | No development process recorded؛ المنافذ الثلاثة حرة | `dev-stop-pre.log` |
| `pnpm db:check` | database connection successful | `db-check.log` |
| `pnpm check` | **79/79 في 10 حزم** مع build/typecheck/lint/format/contracts (وشُغّل مرتين: قبل وبعد تعديل سكربتي البصريات) | `check.log` و`check-final.log` |
| `pnpm test:property` | **179/179 في 27 حزمة** (كان 171/26 قبل الإصلاح؛ +8 اختبارات إصلاح وحزمة `idempotency-scope` الجديدة) | `test-property.log` |
| `pnpm test:distribution` | **48/48 في 11 حزمة** بلا ارتداد | `test-distribution.log` |
| `pnpm test:identity` | **48/48 في 7 حزم** نظيف بعد `dev:stop` والمنافذ حرة | `test-identity.log` |
| `pnpm contracts:check` | 43/30/36/21/15/**10** ومطابقة الأنواع | `contracts-check.log` |
| `pnpm visual:phase7` | **35/35** بعد إضافة 5 فحوص إصلاح (كان 30/30) + 9 لقطات + `report.json` | `visual-phase7.log` |
| `pnpm visual:phase6` | **24/24** بعد إصلاح فحص النزلاء أدناه | `visual-phase6.log` (فشل بيئي) و`visual-phase6-retry.log` |
| `pnpm visual:phase5` | **19/19** | `visual-phase5.log` |
| `pnpm visual:check` | **38/38** | `visual-check.log` |
| `pnpm dev:stop` (بعد) + تحرر المنافذ | Development shutdown requested؛ 4100/4101/5173 حرة | `dev-stop.log` |
| `pnpm format` | لا تغييرات (كل الملفات مطابقة) | `format.log` |
| `pnpm checksums` + `sha256sum -c CHECKSUMS.sha256` | **473/473 OK** | `checksums.log` و`sha256sum-check.log` |

### تعديلا البصريات في هذه الجولة (تحصين لا تخفيف)

- `scripts/phase7-visual.mjs`: أُضيفت 5 فحوص تغطي سلوك ما بعد الإصلاح — صدى اللوحة
  `{date, timezone}` للمنشأة (F-RVW7-03)؛ ظهور المرشح `eligible=false reason=BLOCKED`؛ رفض
  `AssignRoom` للغرفة المحجوبة 400 `BLOCKED` بلا أثر؛ تسمية «Room is blocked» وتعطيل اختيارها
  في حوار التخصيص؛ عودة الأهلية بعد فك الحجب (F-RVW7-02). المجموع 35/35، ولم يُخفَّف أي فحص
  قائم.
- `scripts/phase6-visual.mjs`: فحص «guest registry lists the guest» صار يستخدم حقل البحث في
  السجل (`Search guests`) قبل التأكيد. السبب: قاعدة dev للعميل تراكم فيها 113 نزيلاً وسجل
  النزلاء يعرض 50 بترتيب الاسم، فسقط النزيل الجديد خارج الصفحة الأولى — عيب ثبات اختبار
  بيئي لا عيب تطبيق (السجل المباشر: النزيل أُنشئ 201 وبحث السجل يعرضه). أُعيد الفحص 24/24.
- أُعيد `pnpm check` بعد التعديلين (79/79، `check-final.log`)، ثم `pnpm format` و`checksums`.

## إعادة إنتاج أداتي المراجع (s2/s9)

`tools/s2-readiness.mjs` و`tools/s9-cross-module-cancel.mjs` تقودان API خارجياً وKeycloak
(جلسة حقيقية) وتتطلبان `pnpm dev` (api 4100 + Keycloak 58080)؛ الطلب منع dev، ولم تُشغّلا.
أُعيد التعبير عن سيناريوهيهما حرفياً كاختبارات property داخل حوضن الاختبارات:

| سيناريو الأداة | التغطية البديلة |
|---|---|
| s9: تخصيص PLANNED ثم CancelItem → لا تخصيص حيّ + إعادة تخصيص 200 + لوحة غير OCCUPIED | اختبار F-RVW7-01 في `reservation-commitment` (يحقق CANCELLED/RELEASED + reassign 200 + `eligible=true`) |
| s9: إلغاء قناة + room free | اختبار F-RVW7-01 في `revision-consumer` |
| s2: Dirty/OOO/OOS مرفوضة وOOO يمنع Check-In | اختبارات P07-01 القائمة (بقيت خضراء: 50/50) |
| s2: Block PLANNED يمنع التخصيص/الدخول واللوحة تعلن السبب | اختبار Blocks في `front-office-board` (`BLOCKED` + release) |
| s2: Block EMERGENCY يمنع التخصيص | نفس الاختبار (R14 EMERGENCY) |

التشغيل الحرفي للأداتين يبقى بند إعادة تحقق في [docs/64](64_g07_focused_review.md) عند تشغيل
dev، ويلزمه عدم وجود عمليات كتابة أخرى على قاعدة التطوير أثناء الجولة.

## حدود (لا تُدّعى)

- لا AT منفذة ولا قناة/مزود حي ولا محاكي حقيقي ولا جاهزية إنتاج؛ لا مال ولا تسوية ولا PAN/CVV
  (P08)، ولا فتح P08.
- لا تُعدّلت مهاجرات مطبقة (`≤ 20260915140000`)؛ المهاجرة الجديدة `20260915150000` فقط.
- لا commit/remote ولا أسرار/بيانات نزلاء حقيقية. `checksums` شُغّلت في جولة الإغلاق P07-07
  بنتيجة **473/473 OK** (بعد تعديلَي سكربتي البصريات).
- `down()` للمهاجرة مكتوب نظيراً ولم يُشغَّل. الأطقم الكاملة والبصريات أُعيدت كلها في P07-07
  (179/179 و48/48 و48/48 و35/35+24/24+19/19+38/38).
