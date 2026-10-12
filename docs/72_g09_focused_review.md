# جولة الفحص المركّز لبوابة G-09 (المرحلة 9: التدبير والصيانة)

التاريخ: 16 سبتمبر 2026. النطاق: التحقق من P09-01..P09-03 وادعاءات
[docs/execution/G-09.md](execution/G-09.md) و[docs/execution/P09-01.md](execution/P09-01.md)
و[P09-02](execution/P09-02.md)/[P09-03](execution/P09-03.md)، بنمط
[docs/64](64_g07_focused_review.md) و[docs/69](69_phase8_focused_review.md)، وبمرجع
[docs/71](71_g09_focused_review_prompt.md). **لا يمنح هذا التقرير قبول G-09**؛ القبول قرار
المستخدم، وG-09 تبقى `VERIFIED محلياً / REVIEW_PENDING`.

> **ملاحظة استقلال وأدوات:** أُجريت الجولة في جلسة خارج جلسة تنفيذ P09، ولم يُعتمد أي رقم من
> أدلة المنفذ: كل الأرقام والسياقات أُعيد توليدها في هذه الجولة. الأدوات الخام في
> `.local/verification/review-g09-focused/` ببادئة `RVW9F` (برامج `RVW9F-m1..m9` + مكتبة
> `lib/rvw9f-*` مؤلَّفة في هذه الجولة). **Computer Use غير متاح في هذه البيئة**، فأُعيد تشغيل
> `visual:phase9` بـPlaywright ضمن الاستثناء المعلن نفسه المطبق في P05..P08
> ([docs/70](70_phase9_execution_prompt.md) بند الوثائق)، مع فحص لقطات فعلية بالعين المجردة
> (`RVW9F-ops-tasks-ready.png` و`RVW9F-ops-390.png`) وفحص إضافي مستقل لِلغات/الاتجاه.
> لا ادعاء اختبار جهاز حقيقي ولا قناة حية ولا AT خارجية.

## بوابة البدء (شُغّلت بنفسي)

| الفحص | النتيجة | السجل |
|---|---|---|
| `git status` | المستودع غير مُقيَّد كما هو موثق (26 مدخلاً untracked؛ لا commit/remote) | `RVW9F-env-gate.log` |
| `pnpm dev:stop` قبل الأطقم | نُفذ؛ 4100/4101/5173 **FREE** عند البدء | `RVW9F-env-gate.log` |
| المنافذ عند الانتهاء | 4100/4101/5173 **FREE** بعد `dev:stop` النهائي | `RVW9F-dev-stop.log` |
| المهاجرات بعد `20260915210000` | أربع فقط: `090000/120000/130000/150000` ومطبَّقة بالترتيب | `RVW9F-m8.log` |

## أسئلة الحكم والأدلة

### 1) استهلاك الأحداث (AT-O01) — **PASS** (`RVW9F-m1.log` 14/14)

- الفهرس الفريد الجزئي قائم فعلاً:
  `ops_task_source_unique ... UNIQUE (tenant_id, property_id, source_event_id) WHERE source_event_id IS NOT NULL`
  (`Migration20260916090000_operations_core.ts:105-109`)، و`insertPrepTask` يستعمل
  `on conflict ... where source_event_id is not null do nothing`
  (`operations-repository.ts:199-230`).
- مغادرة فعلیة: مهمة HOUSEKEEPING واحدة PENDING مرتبطة بحدث `STAY_CHECKED_OUT` الوحيد،
  الغرفة `DIRTY`، وaudit `ops.task_created` واحد مع correlation.
- إعادة `CheckOutStay` بنفس المفتاح: `200 replayed=true` وبلا مهمة أو حدث ثانٍ. مفتاح جديد
  على بند `CHECKED_OUT`: `409 INVALID_STATE_TRANSITION` وبلا أثر جزئي.
- `runOperationsIntake` مرتين بعد الاستهلاك المباشر: `processed=0/created=0`؛ وحدث backfill
  اصطناعي بلا مهمة: `created=1` مرة واحدة فقط ثم `0/0`.
- حدث بلا مورد (`resource_id` وpayload بلا `resource_id`): **لا ينشئ مهمة زائفة** (`created=0`
  وبلا صف). ملاحظة منخفضة N-RVW9F-01 أدناه حول بقائه غير «مستهلك».
- النقل: مهمة واحدة للغرفة المُخلّاة بسبب `STAY_MOVED`، R2 `DIRTY`، ولا تكرار عند intake.

### 2) الجاهزية والفحص (AT-O02/AT-29) — **PASS** (`RVW9F-m2.log` 24/24)

- الترتيب الفعلي: `DIRTY` ← `CLEANING` ← `OOO` ← `OOS` ← `INSPECTION_REQUIRED` ← `BLOCKED`
  (في `authorizeRoom` و`candidateReason`، `front-office-service.ts:117-125,147-184`). أُثبت:
  DIRTY على CLEANING على OOO مع فحص مطلوب تُبلَّغ أولاً؛ و`INSPECTION_REQUIRED` تسبق `BLOCKED`.
- `CLEAN` بلا `INSPECTED` والسياسة مفعّلة → `400 INSPECTION_REQUIRED`؛ `CLEANING` →
  `400 CLEANING`؛ `INSPECTED` → التسليم ينجح 200.
- الفحص الذاتي: المنفَّذ نفسه يعيد `403 SELF_INSPECTION_DENIED` وتبقى الغرفة `CLEAN`؛
  مفتش آخر يعيد `200/INSPECTED`.
- تغيير السياسة بين Complete وInspect: عند إطفاء الاشتراط يجتاز `CLEAN` (السياسة الحالية
  تحكم التسليم)، وعند إعادته يُرفض `INSPECTION_REQUIRED` ويُرفض الفحص الذاتي. مأخوذ بالنسخة
  (`STALE_VERSION` عند نسخة خاطئة).
- AT-29: أمر OOO بانتهاء فترة سابقة وما زال OPEN يستمر في المنع `OOO`، وبعد إغلاق دورة
  VERIFIED→CLOSED وحدها يُرفع OOO، وتبقى الجاهزية محكومة بسياسة الفحص (لا الجاهزية الزمنية).

### 3) أوامر العمل (AT-O03) — **PASS** (`RVW9F-m3.log` 21/21)

- الحالة مشتقة من **الأوامر المفتوحة فقط** (`listOpenWorkOrderImpacts` ثم `maxImpact`،
  `work-order-service.ts:133-164`): إغلاق أمر OOO من أمرين يُبقي OOO؛ إغلاق الأخير → NONE.
- لا مساس بأي `inventory_block` مستقل: Block مخطط مستقل بقي ACTIVE عبر كل الأوامر والعمليات
  حتى `ReleaseBlock` الصريح؛ والأوامر غير الطارئة `block_id=null`.
- إعادة الفتح: `200 OPEN` مع `reopen_count=1` و`last_reopen_reason` و`closed_at=null`، ويُعيد
  OOO؛ وبعد إغلاق المُعاد فتحه مع وجود أمر OOS أحدث تعود الحالة إلى `OOS` (السبب الأحدث لا
  يُتجاوَز) ثم `NONE` بعد إغلاقه.
- الانتقالات الخلفية مرفوضة: `IN_PROGRESS→TRIAGED` 409، الإغلاق من `IN_PROGRESS` 409،
  إعادة فتح غير مغلق 409، و`OPEN` عبر مسار transitions مرفوض (DTO ثم قيد قاعدة البيانات).
- سباقات: إعادة فتح متزامنة بنفس النسخة → فائز واحد (200 + 409) و`reopen_count=1`؛ إغلاقان
  متزامنان لأمرين منفصلين → 200/200 والحالة المشتقة NONE؛ بدء مهمة متزامن → 200 + 412؛
  تعيين متزامن → 200 + 412 مع نسخة +1 وفائز واحد. كلها تحت قفل Property.

### 4) الطوارئ — **PASS** مع Finding متوسط (`RVW9F-m4.log` 18/18)

- بلا MFA: `403 MFA_REQUIRED` وبلا أي أمر/Block. مع MFA: Block `ACTIVE` وDisruption `OPEN`
  لكل تخصيص متعارض (ارتباط `allocation_id`/`commitment_id` مُثبت)، والغرفة OOO، والتسليم
  لوصول آخر مرفوض `OOO`.
- صفوف `reservation_item` و`commitment` و`plan_allocation` و`stay_segment` و`reservation`
  **متطابقة بايت-ببايت** قبل/بعد الطوارئ وقبل/بعد الإغلاق (لم تُمس).
- إغلاق الأمر: Disruptions الخاصة ببلكه فقط إلى `RESOLVED` مع `resolved_at`، والـBlock يبقى
  `ACTIVE` حتى `ReleaseBlock` الصريح.
- **Finding F-RVW9F-02 (متوسط، أُغلق لاحقاً في [docs/73](73_g09_fix_session.md)):** إذا نُفّذ Check-In إلى غرفة تختلف عن غرفة `plan_allocation`
  (P07 يسمح؛ `front-office-service.ts:638-656`)، فإن طوارئ على الغرفة المشغولة فعلياً تُنشئ
  Block/OOO لكن **صفر Disruption** لأن كشف التعارض يعتمد `plan_allocation` فقط
  (`guarantee-repository.ts:295-318`). التفاصيل أدناه.

### 5) العزل والصلاحيات وAT-O06 — **PASS** (`RVW9F-m5.log` 18/18، `RVW9F-m6.log`)

- RLS نافذة بدور التشغيل: `hotel_api` يرى صفوف عميله فقط (23 صفاً مقابل **0** لعميل آخر) ورفض
  الإدراج بمرجع عميل أجنبي بـ**42501** (WITH CHECK). المنح: `ops_notification`/`ops_shift_handover`
  قراءة+إدراج فقط (لا UPDATE/DELETE)، و`inventory_disruption` UPDATE بلا DELETE.
- `task.read` لا يكشف هوية ضيف ولا مالاً: مفاتيح العرض كلها تشغيلية فقط (لا `guest*/document/
  money/balance/folio/payer`)، و`resource_code` = رمز الوحدة الفعلي.
- عضو بلا صلاحية: 403 على المهام واللوحة والإنشاء؛ عميل آخر: 403 `TENANT_CONTEXT_MISMATCH`؛
  نطاق المنشأة الثانية: صفر مهام.
- إشعار موجّه: لا يظهر لعضو آخر، ومحاولة `MarkNotificationRead` من غيره → `422
  CROSS_SCOPE_REFERENCE`، وللمستلم إيصال واحد فقط (`newly_read=true` ثم `false`).
- عضو بلا MFA على الطوارئ: 403 (Q4). grant تحديث `inventory_disruption`: المشروع الوحيد في
  الخادم هو `guarantee-repository.ts:477` عبر `resolveBlockDisruptions ← CloseWorkOrder`
  (`work-order-service.ts:650`) — لا مستهلك آخر (سجل `RVW9F-declared-mods.log`)، والمنح
  موثق في docs/25/26 وP09-02.

### 6) تسليم الوردية والإشعارات — **PASS** (`RVW9F-m6.log` 11/11)

- العدّادات لحظية داخل معاملة التسليم تحت قفل Property: `open_tasks=2/open_work_orders=1/
  active_dnd=1` طابقت `count(*)` في قاعدة البيانات لحظة الإنشاء، وبقيت **لقطة ثابتة** بعد
  إنشاء مهمة جديدة (snapshot=2 مقابل live=3).
- مرجع الصندوق لقطة: `cashier_session` لم يتغير صفّه إطلاقاً بعد التسليم (نسخة/حالة/مبالغ)،
  والتسليم يحتوي نسخة `currency/expected/counted/variance`، وصفر قيود Journal جديدة (لا مال).
- إشعارات داخلية فقط: الأنواع محصورة بالقائمة (`WORK_ORDER_EMERGENCY/TASK_READY_FOR_
  INSPECTION/SHIFT_HANDOVER`)، وبلا أي صف `distribution_outbox_event` (لا Adapter خارجي).

### 7) الواجهة والبصريات — **PASS** (`RVW9F-visual-*.log`، `RVW9F-m7.log`، `RVW9F-m9.log`)

- `pnpm visual:phase9` أُعيد تشغيله من الصفر: **28/28** و9 لقطات وبلا `page_errors` أو
  `console_errors`؛ الدورة الكاملة خروج→مهمة PENDING→تعيين→Start→Report clean (CLEAN)→
  Inpect (INSPECTED)→Ready مثبتة بأثر DB (`RVW9F-visual-db-evidence.json`)، وسياسة الفحص
  وأوامر العمل والطارئ والإشعار وإيصال القراءة وDND وتسليم الوردية كلها من الواجهة الحقيقية.
- حالات الواجهة: `loading` (CircularProgress أثناء تعليق طلب اللوحة)، `error` (Alert عند فشل
  اللوحة 500 قسرياً — لا نجاح صامت)، و`forbidden` (لوحة تحذير للعضو بلا `task.read` وبلا أي
  جدول بيانات) — `RVW9F-m7.log` 5/5.
- 390px بلا فائض (`documentDelta=bodyDelta=0`) في الإنجليزية والعربية RTL/`dir=rtl` معاً
  (`RVW9F-m9.log` 2/2، ولقطة `RVW9F-ops-390.png`).
- **حكم الأداة:** Playwright استثناء معلن مطابق P05..P08 في بيئة بلا Computer Use؛ يكفي
  **للبوابة المحلية** كنمط G-07/G-08، ولا يُغني عن قبول المستخدم البصري/الجهازي، ولا يُعلن
  جاهزية جهاز حقيقي.

### 8) عدم الارتداد والجودة — **PASS** (`RVW9F-official-suites.log`)

| الأمر | النتيجة | السجل |
|---|---|---|
| `pnpm check` | **85/85 في 11 حزمة** (build/contracts/typecheck/lint/format/jest) | `RVW9F-official-suites.log` |
| `pnpm db:check` | database connection successful | `RVW9F-official-suites.log` |
| `pnpm contracts:check` | 43/30/36/21/15/10/35/**22** ومطابقة الأنواع | `RVW9F-official-suites.log` |
| `pnpm test:identity` | **48/48 في 7 حزم** | `RVW9F-official-suites.log` |
| `pnpm test:distribution` | **48/48 في 11 حزمة** | `RVW9F-official-suites.log` |
| `pnpm test:property` | **255/255 في 36 حزمة** (تشغيلان: `RVW9F-official-suites.log` ثم `RVW9F-test-property-run2.log`) | كليهما |
| `pnpm visual:phase9` | **28/28** و9 لقطات | `RVW9F-visual-phase9.log` |
| `pnpm visual:phase8/7/6/5` | **34/34، 35/35، 24/24، 19/19** | `RVW9F-visual-regression.log` |
| `pnpm visual:check` | **38/38** | `RVW9F-visual-regression.log` |
| `sha256sum -c CHECKSUMS.sha256` قبل التقرير | **557/557 OK** (`RVW9F-checksums-before.log`) وبعد كتابة الوثائق **558/558 OK** (`RVW9F-checksums-verify-final.log`) | `RVW9F-checksums-*.log` |
| فحوص G-09 المركزة (m1..m9) | **122/122 PASS** | `RVW9F-m1..m9.log` |

**التعديلات المشروعة المعلنة — مبرَّرة وموثقة ولا تخفي عيباً:**

1. **تاريخ اليوم المحلي في stay-checkout/phase7-visual:** يطابق سلوك المنتج
   `businessToday(property.timezone)` (Asia/Jakarta)؛ أثبت m1 أن `due_date`/`business_date`
   تأتي Jakarta. إصلاح طقم زمني لا سلوك منتج.
2. **توقع FIX-R8 بعد إعادة منح UPDATE لـ`inventory_disruption`:** منح حقيقي لمستهلك واحد
   منفَّذ (`CloseWorkOrder → resolveBlockDisruptions`)، وموثق في المهاجرة وdocs/25/26 وتعليق
   الاختبار نفسه؛ الفحص المستقل وجد مسار UPDATE واحداً فقط في الخادم.
3. **`resource_code` الإضافي:** موثق في docs/25/26 وعقد phase9، ويُعرض بلا أي هوية ضيف أو مال
   (m5)؛ عرض تشغيلي مشروع.
4. **ترتيب فحص maintenance قبل سياسة الفحص:** متسق مع docs/07 وF-RVW7-02؛ أثبتته m2 (OOO
   قبل INSPECTION_REQUIRED، وDIRTY قبل OOO).

**الأقفال/المعاملات/CAS/idempotency/audit:** كل أوامر P09 الكتابية تأخذ `lockProperty` أولاً ثم
`authorize` ثم idempotency ثم CAS بالنسخة (`applyTaskTransition`/`applyWorkOrderTransition`
بشرط `version = expected`) مع audit وcorrelation؛ القراءات محصورة بـTenant/Property. أثر P09
على P05/P07/المالية: لا تعديل قواعد P05 (الاستهلاك عبر عقده)، وP07 صار يستهلك الحدث داخل
معاملته ذرياً، والمالية لم تُمس (تسليم الوردية بلا Journal؛ `finance-integration` ضمن
255/255).

## العيوب المفتوحة

| المعرف | الخطورة | الموقع | مثال فشل قابل للتكرار | الأثر |
|---|---|---|---|---|
| **F-RVW9F-02** | **متوسط** | `front-office-service.ts:638-656` (check-in يسمح بغرفة غير المخصصة) + `guarantee-repository.ts:295-318` (تعارض الطوارئ على `plan_allocation` فقط) | `RVW9F-m4.log`: Check-In لغرفة بلا تخصيص، ثم أمر طارئ عليها → Block ACTIVE وOOO لكن **0 Disruption** | عامل التشغيل قد لا يرى الضيف المتأثر في مسار Disruption؛ التسليم الجديد يبقى مرفوضاً OOO، ولا يُمس الحجز/الالتزام. مسار طرفي موروث من دلالات P07 (التخصيص ≠ التسليم). اختبار AT الرسمي يمر لأن تخصيصه صادف نفس الغرفة. **مغلق — [docs/73](73_g09_fix_session.md).** |
| **F-RVW9F-01** | **منخفض** | `block-service.ts:168-201` (`createEmergencyMaintenanceBlock` بلا `expireDueHolds`) + `work-order-service.ts:249-267` | `RVW9F-m8.log`: Hold بـ`ttl=30` ينتهي بوقت القاعدة ثم أمر طارئ خلال ثوانٍ قبل أي تدفق يسحب Holds → Disruption `OPEN` لـHold منتهٍ؛ وبعد سحبه لاحقاً (quote 201) يبقى Disruption `OPEN` على allocation `RELEASED` حتى إغلاق الأمر | صفوف Disruption زائفة/قديمة الإشارة. لا فساد مخزون أو حجز. نفس النمط موجود في `createBlock` (P05) وP09 يرثه. **مغلق — [docs/73](73_g09_fix_session.md).** |
| N-RVW9F-01 | منخفض | `operations-repository.ts:414-416` و`operations-service.ts:1152-1157` | `RVW9F-m1.log`: حدث `STAY_CHECKED_OUT` بلا مورد يعود `processed=1/created=0` في كل intake | لا مهمة زائفة (المطلوب)، لكن الحدث يبقى «غير مستهلك» ويُعاد عدّه؛ ضجيج تقارير intake فقط. |
| N-RVW9F-02 | منخفض | `operations-service.ts:303-328` (حد 100 لأقدم المهام) | لوحة بمهام >100: الاحتساب من أول 100 مهمة فقط | عدّادات حزم اللوحة قد تنقص ولا تظهر أحدث المهام؛ عدّادات تسليم الوردية سليمة (SQL count). |
| N-RVW9F-03 | ملاحظة | `Migration20260916130000...` + `guarantee-repository.ts:477` | المنح نصابي (جدول كامل) لمستهلك واحد فقط | مشروع وموثق؛ لا حاجة لإجراء الآن، ويمكن تضييقه لاحقاً بدالة ضيقة الصلاحية. |

## ما لم يُنفذ / حدود المراجعة

- لا AT خارجية (AT-C/AT-I/AT-L النهائية) ولا قناة OTA ولا رسائل ولا مزود دفع؛ لا P10 ولا
  إنتاج؛ لا تحويل عملات ولا جمع IDR/USD.
- Computer Use غير متاح؛ البصريات بـPlaywright (استثناء معلن) + قراءة بشرية للقطات، ولا
  ادعاء جهاز حقيقي أو قارئ شاشة.
- لم تُراجع تفاصيل P10 (التدقيق الليلي) ولا P11+؛ وحدود P09 المعلنة (لا واجهة لسياسة
  الإشعارات الموسّعة، لا SLA) تبقى كما هي.
- التكرار: `test:property` أُعيد تشغيله مرتين كاملتين بنتيجة 255/255 (بلا أثر ترتيب مرصود
  هذه المرة)، مقابل درس F-RVW8F-01؛ يبقى ضمان الحتمية صالحاً لهاتين الجولتين فقط.

## الحكم النهائي

**PASS — جاهزة لعرض القبول على المستخدم، مع إبقاء `G-09 = REVIEW_PENDING`.**

- كل أسئلة الحكم الثمانية أُجيبت بأدلة قابلة للتكرار (122/122 فحصاً مركزاً)، والعقد والصلاحيات
  وRLS واللقطات وقاعدة البيانات أُعيد إنتاجها من الصفر، والأطقم الرسمية كلها خضراء.
- لا عيب **عالٍ** في العزل أو التكرار أو الأقفال أو المال، ولا ارتداد P05/P07/P08. العيبان
  المفتوحان F-RVW9F-02 (متوسط) وF-RVW9F-01 (منخفض) لا يمسان الثوابت الحاجبة أعلاه، ومسجَّلان
  للعرض على المستخدم؛ أي إصلاح حزمة منفصلة بتفويض صريح.
- **المراجعة المستقلة الكاملة غير إلزامية لـG-09** وفق docs/34؛ هذه جولة مركزة تحقق شرط
  الأدلة، والقبول قرار المستخدم حصراً.

### الحزمة التالية المقترحة (بعد قرار المستخدم فقط)

1. إن أراد المستخدم الإغلاق: قبول G-09 محلياً وتحديث G-09/27/34/README، ثم **P10 (التدقيق
   الليلي)** وفق [docs/32](32_execution_work_packages.md).
2. حزمة اختيارية مستقلة (بتفويض صريح) لمعالجة F-RVW9F-02 (تغطية Disruption للتسليم الفعلي
   أو منع Check-In خارج التخصيص) وF-RVW9F-01 (سحب Holds المنتهية قبل كشف تعارض Block)، مع
   إعادة فحص مركزة. لا تُفتح تلقائياً ضمن هذه الجولة.

## تحديث ما بعد الإصلاح (16 سبتمبر 2026)

بتفويض المستخدم الصريح نُفذت الحزمة أعلاه في جلسة منفصلة — [docs/73](73_g09_fix_session.md):

- **F-RVW9F-02 مغلق:** كشف تعارض الطوارئ في `createBlock`/`createEmergencyMaintenanceBlock`
  صار يجمع `plan_allocation` مع تخصيصات الحجوزات المسلَّمة فعلياً (`room_assignment` →
  `commitment` → `plan_allocation`) بإزالة تكرار حسب `allocation_id`، وDisruption تحمل
  `resource_id` = الغرفة المتأثرة فعلياً، بلا مساس بدلالات P07 ولا بالمخطط.
- **F-RVW9F-01 مغلق:** `expireDueHolds` قبل كشف التعارض في المسارين، فلا Disruption زائفة
  لـHold منتهٍ ولا `BLOCK_CONFLICT` زائف.
- **الأدلة:** اختباران انحدار جديدان (تغطية Disruption للتباعد ومنع التكرار؛ وسحب Hold منتهٍ)؛
  `pnpm test:property` **257/257 في 36 حزمة** (+2)، `check` 85/85، identity 48/48،
  distribution 48/48، visual phase9/5/7 و`visual:check` **28/19/35/38**.
- تبقى **G-09 = VERIFIED محلياً / REVIEW_PENDING** حتى قرار المستخدم، وملاحظات
  N-RVW9F-01..03 كما هي، ولا تُفتح P10 تلقائياً.
- **تحديث 16 سبتمبر 2026:** قُبلت **G-09 = ACCEPTED محلياً** بقرار المستخدم عبر
  [G-09](execution/G-09.md)؛ هذا التقرير يبقى سجل المراجعة كما كان، ويفتح القبول P10 عبر
  [docs/74](74_phase10_execution_prompt.md) مع مراجعة مستقلة إلزامية
  [docs/75](75_phase10_review_prompt.md) قبل G-10.

## الأدلة الخام

- الأدوات: `.local/verification/review-g09-focused/RVW9F-m1..m9*.mjs` و`lib/rvw9f-lib.mjs`
  و`lib/rvw9f-fixtures.mjs` (بيانات اصطناعية ببادئة `RVW9F-` فقط).
- السجلات: `RVW9F-env-gate.log`، `RVW9F-official-suites.log`، `RVW9F-test-property-run2.log`،
  `RVW9F-m1.log`..`RVW9F-m9.log`، `RVW9F-visual-*.log/json`، `RVW9F-declared-mods.log`،
  `RVW9F-checksums-before.log`، و`RVW9F-dev-stop.log`.
- البصمات: يُعاد توليد `CHECKSUMS.sha256` بعد كتابة هذا التقرير ويُتحقق بـ`sha256sum -c`
  (السجل النهائي يُضاف بجانب الأدلة).
