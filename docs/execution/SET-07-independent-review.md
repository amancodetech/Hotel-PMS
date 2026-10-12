# SET-07 — المراجعة المستقلة (إكمال المكتب الأمامي والتدبير والتقارير لكل قالب)

- **التاريخ:** 22 سبتمبر 2026.
- **النطاق:** SET-07 بمهامها 07.1..07.6، على النسخة المحلية الحالية (بما فيها إصلاحات SET-06 `FIXED_LOCAL`).
- **الحكم:** **`NEEDS_FIXES`** — نتيجة مانعة واحدة (P0) في فرض سياسة المشاركة عبر مسارات مجموعات الحجز، ونتيجة تعريب P1، ونتيجتان P2.
- **إعلان الاستقلال:** أُجريت هذه المراجعة بجلسة/نموذج مختلف عن المنفذ. لم أعدّل منطق التطبيق ولا الاختبارات الدائمة ولا العقود ولا بطاقة SET-07. كل محاولات التكذيب أُعدت في أطقم مؤقتة وملفات probes (**أُزيلت بعد التشغيل**) وعلى قاعدة اختبار معزولة تُنشئ وتُسقط ذاتياً. لم أبدأ SET-08 ولا أي حزمة أخرى، ولم أغيّر G-13 (تبقى NOT ACCEPTED)، وSET-AT كلها تبقى NOT_TESTED، ولا قبول إنتاجي. سجلات المنفذ في `.local/verification/SET-07-*` لم تُستخدم دليلاً.

---

## 1) الخلاصة

ما **ثبت** بإعادة إنتاج مستقلة:

- أرقام البطاقة الرسمية للأطقم الأساسية: `property` **55 حزمة / 419 اختباراً**، `distribution` **48/48**، `check` **99/99** (بناء + عقود + typecheck + lint + format).
- البصريات الخمس: phase6 **27/27**، phase7 **35/35**، phase9 **28/28**، phase11 **14/14**، SET-01 **37/37** (مع ملاحظة بيئية مشروحة في §3 عن سباق إعادة تشغيل `dev` في أول محاولتين).
- 07.1: الرف يعرض ROOM/BED/SITE/TENT/CABIN بأنواعها وأبها ويستبعد الآباء المركّبين فعلاً؛ ثابت `supported=true ⇔ reason=null` صحيح على كل الصفوف التي فُحصت (CONFIRMED/IN_HOUSE، مفرد/مجموعة، بإسناد/بدونه).
- 07.2/07.3: جاهزية الأب المباشر تمنع تسكين الابن (`PARENT_DIRTY`)، تعيين الأب المركّب يُرفض `RESOURCE_HAS_CHILDREN`، تمديد/مغادرة مجموعة يعالجان **كل** الإسنادات و**كل** الحصص، ونقل/تجزئة المجموعة يُرفضان 422 بلا كتابة جزئية، والسباق (تمديدان / تمديد+خروج) ينتهي بحالة واحدة متسقة (200 و412).
- 07.4: `inspection_required` من خطوة المعالج يُطبَّق على `property_operations_policy` فعلاً (قُرئ بعده عبر API)، والأوقات غير المنفَّذة تبقى `operations_policy_follow_up` بلا اختراع قيم.
- 07.5: `ADR_REVPAR` ينسب كل رسم لنوع واحد، ويترك الرسم الذي يغطي نوعين **غير منسوب** (لم يُقسَّم صامتاً)، والفيلا من غرفتين لا تضاعف الإيراد، ومقامات كل نوع منفصلة (`resource_nights_paid` / فيزيائي / تشغيلي مع استبعاد OOO)، والقسمة على صفر `null` + `DENOMINATOR_ZERO`، ومقاييس التدبير `CURRENT_STATE` طابقت جدول `resource` مباشرة بعد حالات عدائية.
- 07.6: الهجرة `guest.gender` نظيفة صعوداً وهبوطاً وإعادة صعود، والقيد يرفض قيمة ثالثة (`23514`)، وRLS/الصلاحيات سليمة؛ والفرض الخادمي يعمل في **مسودة/تأكيد/تعديل الحجز والدخول** (تحقق مستقل).
- عبر-الحزمي: idempotency (رفض بلا مفتاح 400، replay بنفس المفتاح، و409 عند اختلاف الحمولة)، والعزل يفشل مغلقاً (مستخدم منشأة أخرى 403، عضو بلا صلاحية مالية 403، عضو بلا `stay.checkin` 403)، وانحدار SET-06 الأساسي (`setup-changes` 17/17).

ما **لم يثبت** (نتائج مانعة):

1. **P0 — تجاوز فرض `FEMALE/MALE` عبر مجموعات الحجز + الاستيراد:** منتج `BED` بنطاق `FEMALE` يمكن تأكيده بلا أي ضيف (صفر نزلاء) عبر: استيراد CSV → إنشاء `group-allotment` → `pickup`، وينتهي `reservation_item` بحالة `CONFIRMED` مع التزام مخزون. مسارات البيع المباشرة (draft/confirm/modify) ترفض بالرموز المعلنة، لكن `pickupGroupAllotment` لا يستدعي `assertSharingScopeGuests`، والاستيراد ينشئ بنوداً بمنتج بلا فحص جنس. (الدخول ما زال يفشل مغلقاً، لكن البيع/التأكيد وقع.)
2. **P1 — التعريب ناقص للمقاييس الجديدة:** مفاتيح `housekeeping_{state}.{type}` و`maintenance_{state}.{type}` (ومعها `arrivals_state_*`/`departures_state_*` الأقدم) تُعرض **بالوسم الخام** في اللغات الثلاث لأن `metricLabels` تضم `housekeeping`/`maintenance`/`arrivals_state` بلا لاحقة بينما fallback يحسب الأساس قبل آخر نقطة فقط.
3. **P2 — تعارض بين اللوحة والتسكين في سلسلة أب من مستويين:** لو الأب الأعلى `DIRTY`، اللوحة تعرض الابن `eligible=true` بينما `assign` يرفض `PARENT_DIRTY` (اللوحة تفحص الأب المباشر فقط، والتسكين يفحص السلسلة كاملة).
4. **P2 — أسبقية سبب القدرات لصفوف المجموعات داخل المنشأة:** `assign`/`move`/`split` تعرض `GROUP_COMPONENT_SELECTION_REQUIRED` حتى عندما يكون المانع الفعلي `ALREADY_IN_HOUSE`.

**عبور خارج النطاق:** حكم SET-06 نفسها لا يصدر هنا؛ اكتفيت بفحص انحدار سريع لثوابتها (`setup-changes` 17/17). لا حكم على G-13 ولا على القنوات الحية.

---

## 2) جدول إعادة الإنتاج (الأمر ← النتيجة الفعلية ← المقارنة بالمعلن)

| # | الفحص | الأمر | النتيجة الفعلية الخام | المعلن | الحالة |
|---|---|---|---|---|---|
| R1 | طقم property السريع | `pnpm dev:stop && pnpm test:property:fast` | `Test Suites: 55 passed, 55 total` / `Tests: 419 passed, 419 total` / `EXIT=0` | 55 / 419 | مطابق |
| R2 | طقم التوزيع | `pnpm test:distribution:fast` | `Test Suites: 11 passed` / `Tests: 48 passed, 48 total` / `PASS: migrations applied to a new database (110 public tables) ...` | 48/48 | مطابق |
| R3 | بوابة `check` | `pnpm check` | `OpenAPI validated; ... 10 implemented Phase 7 operations ... 9 implemented Phase 11 operations ... generated types match` + `Tests: 99 passed, 99 total` / `EXIT=0` | 99/99 | مطابق |
| R4 | بصري phase6 | `node --env-file=.env scripts/phase6-visual.mjs` | محاولة أولى `ECONNREFUSED 127.0.0.1:4100`، وبعد استقرار `dev` أُعيدت: `27/27 checks passed` | 27/27 | مطابق بعد الإعادة |
| R5 | بصري phase7 | `node --env-file=.env scripts/phase7-visual.mjs` | محاولة أولى `waitForURL Timeout` أثناء إعادة تشغيل الـAPI، وبعد الاستقرار: `P07-05: 35/35 checks passed; 9 screenshots` | 35/35 | مطابق بعد الإعادة |
| R6 | بصري phase9 | `node --env-file=.env scripts/phase9-visual.mjs` | `28/28 checks passed; 9 screenshots` | 28/28 | مطابق |
| R7 | بصري phase11 | `node --env-file=.env scripts/phase11-visual.mjs` | `14/14 checks passed; 8 screenshots` | 14/14 | مطابق |
| R8 | بصري SET-01 | `node --env-file=.env scripts/set01-visual.mjs` | `SET-01 visual: 37/37 checks passed; 13 screenshots` | 37/37 | مطابق |
| R9 | هجرة `guest.gender` على قاعدة معزولة (`hotel_test_review07_property`) | `migration:up` كامل ثم `information_schema`/`pg_constraint` ثم `migration:down` ثم `up` | `COL gender varchar(6) NULL`؛ `guest_gender_check = CHECK ((gender IS NULL) OR gender = ANY('{FEMALE,MALE}'))`؛ إدخال `'OTHER'` → `23514 guest_gender_check`؛ `after-down gender_cols=0 constraint=0`؛ `re-up gender_cols=1` + آخر هجرة `Migration20260922110000_guest_gender` | up/down نظيفان + القيد فعّال | مطابق |
| R10 | RLS/منح `guest` | استعلام `pg_class`/`role_table_grants` على القاعدة المعزولة | `relrowsecurity=true, relforcerowsecurity=true, policies=1`؛ `hotel_api: SELECT/INSERT/UPDATE` و`hotel_worker: SELECT` | RLS/صلاحيات سليمة | مطابق |
| R11 | probe مستقل لـ07.1 (قدرات/رف/أب) | طقم مؤقت `zz-set07-review-probe` عبر `pnpm test:property:fast -- --filter=...` (أُزيل بعد التشغيل) | `assertCapabilityShape` نجح على 3 لقطات لوحة (INQUIRY غير معروض، CONFIRMED، IN_HOUSE مفرد/مجموعة)؛ `RV07-01 rack types` يظهر BED/TENT/CABIN/SITE و`parent_code` للابن واستبعاد GP/SUB | الثابت + الأنواع + استبعاد الآباء | مطابق |
| R12 | probe مستقل لـ07.1/07.2 (عمق سلسلة الأب) | نفس الطقم، `RV07-02` | `{"board_candidate":{"eligible":true,"reason":null},"assignment_status":400,"assignment_reason":"PARENT_DIRTY"}` | اتساق اللوحة والتسكين | **مكذّب (R07-P2-01)** |
| R13 | probe مستقل لـ07.6 (تجاوز الفرض) | نفس الطقم، `RV07-03` | الاستيراد `200 rows_accepted=1`، `allotment_status=200`، `pickup_status=200`، `item_state=CONFIRMED`، `guest_count=0` | الفرض عند البيع fail-closed | **مكذّب (R07-P0-01)** |
| R14 | probe مستقل لـ07.6 (modify) | نفس الطقم، `RV07-04` | `422 SHARING_POLICY_VIOLATION` مع `scope/product_id/item_id/guest_id/gender` | الفرض على التعديل | مطابق |
| R15 | probe مستقل لـ07.3 (سباق) | نفس الطقم، `RV07-05`/`RV07-06` | تمديدان: `[200,412]` والحصص `allocations=2, allocation_ends=1` والإسنادات `assignments=2, assignment_ends=1`؛ تمديد+خروج: `[200,412]` والحالة النهائية `IN_HOUSE` مع `active=2` | لا اتساق جزئي | مطابق |
| R16 | probe مستقل لـ07.5 (تقارير) | نفس الطقم، `RV07-07`/`RV07-08` | `journal=600000, charges=600000, unattributed=100000, unattributed_charges=1, delta=0, reconciled=true, room_revenue=500000, revpar_physical_denominator=14=SQL ROOM count`؛ فترة فارغة `null + DENOMINATOR_ZERO`؛ عدّادات `housekeeping/maintenance/not_ready` طابقت SQL لكل نوع | ADR/RevPAR + التدبير | مطابق (مع R07-P1-01 في التعريب) |
| R17 | probe مستقل للتعريب | نفس الطقم، `RV07-09` + تشغيل `createI18n` | `missing: [housekeeping_clean.BED ... maintenance_oos.TENT, arrivals_state_confirmed, arrivals_state_in_house]`؛ محاكاة `metricLabel` أعادت `RAW:housekeeping_clean.ROOM` و`RAW:maintenance_ooo.ROOM` و`RAW:arrivals_state_confirmed` | تعريب كل المقاييس | **مكذّب (R07-P1-01)** |
| R18 | probe مستقل للتكرار | نفس الطقم، `RV07-10` | `missing_key_status=400 field=idempotency_key`؛ `first=200`؛ `replay=200 replayed=true`؛ `conflict=409 idempotency_key_reused` | idempotency إلزامي/replay/409 | مطابق |
| R19 | probe مستقل للتطبيع | نفس الطقم، `RV07-11` | `female/« FEMALE »/''/OTHER → 400`؛ `MALE → 201`؛ `null → 201 (gender=null)` | لا تخمين/تطبيع | مطابق |
| R20 | probe مستقل للعزل | نفس الطقم، `RV07-12` | `foreign_board=403`، `member_financial=403`، `member_assignment=403` | fail-closed | مطابق |
| R21 | انحدار SET-06 | `pnpm test:property:fast -- --filter=setup-changes` | `Test Suites: 1 passed` / `Tests: 17 passed, 17 total` | 17/17 | مطابق |
| R22 | أطقم SET-07 الدائمة | `pnpm test:property:fast -- --filter=set07` | `set07-templates` + `set07-sharing` نجحتا (10/10)، والطقم المؤقت نجح في 11 من 12 (الفشل الوحيد في R17) | 7+3 | مطابق |

**ملاحظة بيئية (ليست نتيجة منتج):** أول تشغيلين لبصري phase6/phase7 فشلا بسبب سلسلة إعادة تشغيل watchers في `dev` بعد `pnpm check` (الـAPI يترنّح بين البناء وإعادة التشغيل). بعد استقرار البيئة أُعيد التشغيل ونجحا بالمعلن نفسه. لا يوجد دليل على عيب SET-07 في هذين الفشلين، ولم يُحسبا في الحكم.

---

## 3) النتائج

### R07-P0-01 — تجاوز فرض سياسة المشاركة عبر `group-allotment/pickup` + الاستيراد (P0)

- **الموضع:**
  - `packages/backend/src/modules/reservations/application/group-service.ts:311-433` — `pickupGroupAllotment` يستدعي `repo.confirmReservationItem` عند `:415-421` دون أي استدعاء لـ`assertSharingScopeGuests` (ولا يستورد الوحدة أصلاً؛ الاستدعاءات موجودة فقط في `reservation-service.ts:177` و`commitment-service.ts:208,614` و`front-office-service.ts:816`).
  - `packages/backend/src/modules/reservations/application/import-service.ts:268-288` — `importReservations` ينشئ `reservation_item` بـ`productId` من `product_code` بلا فحص ضيوف/جنس.
- **دليل إعادة إنتاج مستقل (HTTP + SQL):**

  ```json
  RV07-03 import {"status":200,"rows_accepted":1,"rows_rejected":0,"replayed":false}
  RV07-03 restricted group path {
    "allotment_status":200,
    "pickup_status":200,
    "item_state":"CONFIRMED",
    "guest_count":0
  }
  ```

  الخطوات: منتج `kind=BED` بنطاق `sharing_scope='FEMALE'` (يُضبط على صف المنتج كما في أطقم SET-07 نفسها) ← استيراد CSV `external_key,arrival,departure,adults,quantity,product_code` بلا أي ضيف (`APPLY`) ← `POST .../group-allotment` ← `POST .../group-allotment/pickup` بعرض سعر مُنشأ قبل الحجز. النتيجة: `200` و`CONFIRMED` و`reservation_guest=0`.
- **المقارنة بالمسار المباشر (نفس المنتج):** مسودة الحجز بلا ضيف تعيد `422 GUEST_GENDER_REQUIRED/no_guest_declared` (أكده طقم `set07-sharing` في إعادة تشغيلي).
- **الأثر:** وعد المنتج في 07.6 («وعد المنتج مفروض لا معلَّق» + الفرض على مسارات البيع) **مكذّب** عبر مسار مدعوم في المرحلة 6. الأثر العملي: التزام مخزون وتأكيد إقامة لسرير مقيّد بلا نزيل مطابق. بوابة الدخول تبقى محروسة بحسب قراءة `checkInStay` (`front-office-service.ts:816`: صفر مرشحين ⇒ `GUEST_GENDER_REQUIRED`)، أي أن الخرق في البيع/التأكيد لا في التسكين (لم أُعد إنتاج check-in للبند المُلتزم لأنه مستقبلي التاريخ؛ التصنيف: فحص كود لا إعادة إنتاج).
- **الإصلاح المقترح (R07-F1):** استدعاء `assertSharingScopeGuests` في `pickupGroupAllotment` (وفضّلاً في `createGroupAllotment` أيضاً للحجز المسبق المقيد) بضيوف الحجز و`itemId` و`sharing_scope` للمنتج، وإخضاع صفوف الاستيراد لنفس الحارس (رفض الصف برمز معلن أو منع البند المقيد بلا ضيف). يلزم حارس واحد مشترك لا نسخ منطق.

### R07-P1-01 — مقاييس التدبير والوصول/المغادرة تُعرض بمفاتيح خام في اللغات الثلاث (P1)

- **الموضع:**
  - `packages/backend/src/modules/reporting/application/reporting-service.ts:251,261` — المفاتيح `housekeeping_${state}.${type}` و`maintenance_${state}.${type}`؛ و`:493` (`${prefix}_state_${key}`) لمقاييس ARRIVALS/DEPARTURES.
  - `apps/web/src/reports/ReportsPage.tsx:75-95` — `metricLabel` يبحث عن المفتاح الدقيق ثم أساس «قبل آخر نقطة» فقط.
  - `packages/i18n/src/locales/{ar,en-US,id-ID}.json` — `metricLabels` تضم `housekeeping` و`maintenance` و`arrivals_state` كأساسات، ولا تضم `housekeeping_clean`/`maintenance_ooo`/… .
- **دليل إعادة إنتاج مستقل:**

  ```text
  # إعادة محاكاة metricLabel عبر createI18n (ar)
  housekeeping_clean.ROOM => RAW:housekeeping_clean.ROOM
  housekeeping_dirty.BED => RAW:housekeeping_dirty.BED
  maintenance_ooo.ROOM   => RAW:maintenance_ooo.ROOM
  arrivals_state_confirmed => RAW:arrivals_state_confirmed
  adr.ROOM => متوسط سعر الوحدة (ADR) · ROOM
  resources_not_ready_current.ROOM => وحدات غير جاهزة الآن · ROOM
  ```

  ومن الطقم: `RV07-09 i18n coverage {"missing":[37 مفتاحًا: 35 لـhousekeeping_*/maintenance_* لكل الأنواع + arrivals_state_confirmed, arrivals_state_in_house]}`
- **الأثر:** تقرير حالة التدبير الجديد (07.5) وتقريرا الوصول/المغادرة يعرضان مفاتيح تقنية خام للمستخدم في العربية والإنجليزية والإندونيسية؛ الأرقام لا تُفقد (المقاييس صحيحة ومقارنة بـSQL)، لكن ادعاء «تعريب تسميات المقاييس المعروضة» لا يصدق على هذه العائلة، فالـfallback المعلن يُظهر الوسم الخام (`metric.label`).
- **الإصلاح المقترح (R07-F2):** إضافة مفاتيح `housekeeping_<state>`/`maintenance_<state>` لكل حالة ×3 لغات أو تعديل `metricLabel` ليجرّب `metricLabels.housekeeping` + `reportStates.<state>` + النوع، وتغطية `arrivals_state_*`/`departures_state_*` بالمنطق نفسه (يمكن استخراج الحالة بعد `_state_`).

### R07-P2-01 — عدم اتساق جاهزية الأب بين اللوحة والتسكين في سلسلة من مستويين (P2)

- **الموضع:**
  - `packages/backend/src/modules/front-office/persistence/room-assignment-repository.ts:395-417` — `listBoardResources` يربط الأب المباشر فقط (`left join resource p on p.id = r.parent_resource_id`).
  - `packages/backend/src/modules/front-office/application/front-office-service.ts:136-167` — `candidateReason` يفحص `parent_*` المباشر فقط.
  - `packages/backend/src/modules/property/persistence/resource-repository.ts:133-161` + `front-office-service.ts:196-209` — `authorizeRoom` يفحص **كل** الأسلاف بـ`with recursive` ويرمي `PARENT_*`.
- **دليل إعادة إنتاج مستقل:** `RV07-02`: شجرة `GP(ROOM) ← SUB(ROOM) ← BX(BED)`، `GP.housekeeping_state='DIRTY'`، `SUB` نظيف، منتج BED على `BX`:

  ```json
  {"board_candidate":{"code":"RV07-BX-…","eligible":true,"reason":null},
   "assignment_status":400,"assignment_reason":"PARENT_DIRTY"}
  ```

- **الأثر:** اللوحة تعرض الابن مؤهلاً/خضراء بينما التسكين يفشل برفض صريح. اليوم معالج الإعداد لا ينتج أعمق من ROOM→BED، لكن مخطط الاحتواء (`resource_containment`) يسمح بالسلسلة، وأي مسار مستقبلي/بيانات منقولة بعمق أكبر يعيد العيب. يمس شرط البطاقة: «تراجع الجاهزية للأب مطبق في التسكين واللوحة».
- **الإصلاح المقترح (R07-F3):** إشراك سلسلة الأسلاف في `candidateReason`/`allocation_readiness` (استعلام أسلاف واحد لمجموعة المرشحين)، أو إعادة استخدام `listAncestorResources` عند تجميع اللوحة.

### R07-P2-02 — أسبقية سبب القدرات لصفوف المجموعة داخل المنشأة (P2)

- **الموضع:** `packages/backend/src/modules/front-office/application/front-office-service.ts:240-296` — في `stayCapabilities` يُقدَّم `groupReason` على سبب الحالة في `assign`/`move`/`split`.
- **دليل إعادة إنتاج مستقل:** `RV07-01 in-house group capabilities`:

  ```json
  {"assign":{"supported":false,"reason":"GROUP_COMPONENT_SELECTION_REQUIRED"},
   "check_in":{"supported":false,"reason":"ALREADY_IN_HOUSE"},
   "move":{"supported":false,"reason":"GROUP_COMPONENT_SELECTION_REQUIRED"},
   "split":{"supported":false,"reason":"GROUP_COMPONENT_SELECTION_REQUIRED"}}
  ```

  بينما صف مفرد في `IN_HOUSE` يعرض `assign.reason=ALREADY_IN_HOUSE`.
- **الأثر:** تلميح مضلل في الواجهة (يبدو أن الحل اختيار مكوّن، والحقيقة أن الضيف مسجَّل دخول). لا يخفي الزر ولا يغيّر سلوكاً، لكنه يخالف «سبب واضح».
- **الإصلاح المقترح (R07-F4):** إعادة ترتيب الأسباب: سبب الحالة/الإسناد أولاً ثم سبب المجموعة، أو تعريف أسبقية صريحة موثقة ومختبرة.

---

## 4) ادعاءات البطاقة بنداً بنداً

| ادعاء SET-07 | التصنيف | الأساس |
|---|---|---|
| 07.1 الرف يعرض ROOM/BED/SITE/TENT/CABIN بنوعها وأبها ويستبعد الآباء المركّبين | **متحقق** | R11 + طقم `set07-templates` |
| 07.1 `product_kind` + `allocation_readiness` + `capabilities` الثماني مع سبب ثابت، و`supported=true ⇒ reason=null` | **متحقق** | R11 (3 لقطات لوحة) |
| 07.1 `GROUP_COMPONENT_SELECTION_REQUIRED` بدل الإخفاء + مسار معالجة في API | **متحقق جزئياً** | متحقق في الرفض/القدرات؛ لكن أسبقية السبب معطوبة داخل المنشأة (R07-P2-02) |
| 07.2 `authorizeRoom` لكل الموارد النشطة غير الأب + توريث جاهزية الأب المباشر | **متحقق** | R11/R12 + `set07-templates`؛ العمق ≥2 استثناء موثق (R07-P2-01) |
| 07.2 `RESOURCE_HAS_CHILDREN` لتعيين الأب المركّب | **متحقق** | `set07-templates` (أُعيد تشغيله) |
| 07.2 DIRTY عند الخروج لكل الأنواع | **متحقق** | `set07-templates` (كل الأنواع) + قراءة الكود `markRoomHousekeepingDirty` بلا فلتر نوع |
| 07.2 أحداث الدخول/الخروج/التمديد/المغادرة تحمل `assignment_ids`/`resource_ids` | **متحقق** (كود + أطقم) | `stay-checkout.pg.test.mjs` (`dbEvents`) ومسار `stay-movement-service` |
| 07.3 تمديد/مغادرة مبكرة يعالجان كل الإسنادات والحصص | **متحقق** | R15 + `set07-templates` |
| 07.3 نقل/تجزئة مجموعة 422 برمز + `components` + `treatment` وبلا كتابة جزئية | **متحقق** | `set07-templates` (مقارنة قبل/بعد) |
| 07.4 تطبيق `inspection_required` من المعالج | **متحقق** | `set07-templates` 07.4 + قراءة `setup-service.ts:997-1023` |
| 07.4 غياب الأوقات يبقى مؤجلاً بلا اختراع | **متحقق** | `follow_up_tasks=operations_policy_follow_up` في نفس الاختبار |
| 07.5 `ADR_REVPAR` بلا جمع أنواع وبلا تقسيم صامت وبلا مضاعفة الفيلا | **متحقق** | R16 (500000 = 300000+200000، و100000 غير منسوب) |
| 07.5 مطابقة `journal/charges/delta/reconciled` | **متحقق جزئياً** | حالة التساوي (delta=0) متحققة مستقلة؛ حالة delta≠0 لم أُعد إنتاجها بنفسي (تغطيها أطقم المنفذ، أُعيد تشغيلها فقط) |
| 07.5 قسمة/صفر `null`+`DENOMINATOR_ZERO` | **متحقق** | R16 (فترة فارغة) |
| 07.5 مفاتيح `adr/revpar` منفصلة ومقامات صحيحة وOOO مستبعد | **متحقق** | R16؛ استبعاد OOO في `revpar_operational` كود + طقم D-08 أُعيد تشغيله |
| 07.5 مقاييس التدبير `CURRENT_STATE` تطابق جدول `resource` | **متحقق** | R16/`RV07-08` (مطابقة SQL حقلياً) |
| 07.5 تعريب المقاييس وfallback للوسم الخام | **مكذّب** | R17/R07-P1-01 |
| 07.6 هجرة `guest.gender` + القيد + RLS/صلاحيات | **متحقق** | R9/R10 |
| 07.6 حقل الجنس + رفض قيمة غير صالحة/تطبيع | **متحقق** | R19 + `set07-sharing` |
| 07.6 الفرض عند مسودة/تأكيد/تعديل/دخول | **متحقق** | R14 + `set07-sharing` |
| 07.6 الفرض على «مسارات البيع» (شاملًا مجموعات الحجز) | **مكذّب** | R13/R07-P0-01 |
| 07.6 `MIXED/null` بلا تغيير، ورفع الحجب من بحث التوفر، والمعالج يعرض الأنماط الثلاثة | **متحقق** | `set07-sharing` (MIXED يعمل)، `availability-service.ts:121`، وطقم `setup-compositions` ضمن الطقم الكامل 419/419 |
| عبر-الحزمي: idempotency على الكتابات المستحدثة/الموسّعة | **متحقق** | R18 (assign)؛ وبقية المسارات تستدعي `requireIdempotencyKey` (كود + أطقم) |
| عبر-الحزمي: عزل tenant/property وصلاحيات fail-closed | **متحقق** | R20 + أطقم التقارير/الهوية |
| انحدار SET-06 (بلا حكم عليها) | **متحقق** | R21 (`setup-changes` 17/17) |

**غير مُتحقق (مسجل صراحةً):** حالة `delta≠0` عند تصحيح يومية بلا رسوم، وعدم خلط `MIXED` بين عملتين (سوى بإعادة تشغيل أطقم المنفذ)، وسلوك مسار قنوات حي (لا قنوات حية أصلاً؛ `revision-service` ينشئ بنوداً `INQUIRY` بلا `product_id` فتتطلب تأكيداً يمر بالحارس)، وحالات الاستخدام البصري العدائي للقدرات (اكتُفي بـphase7-visual + قراءة الكود). هذه لا تغيّر الحكم لكنها ليست «متحققة» بمعنى هذا البروتوكول.

---

## 5) الحدود والملاحظات المعلنة

- **حدود 07.6 المعلنة** (ربط الضيف بالبند `reservation_guest.item_id` غير مستخدم في الواجهات، فيُعامَل ضيف مستوى الحجز كمرشح لكل بند مقيّد) مقبولة كتحفّظ fail-closed، لكنها **لا تفسر** R07-P0-01: الخرق هناك غياب حارس كامل مع صفر ضيوف، لا توسيع نطاق مرشحين.
- **غياب واجهة تعديل جنس النزيل** (لا `UpdateGuest` في عقد phase6): بعد التأكيد لا يمكن تصحيح جنس نزيل من داخل التطبيق (الطقم يعدّله بـSQL). ليس خرقاً للفرض لكنه ثغرة تشغيلية للمستخدم؛ يحتاج قراراً/حزمة لاحقة.
- **`group-allotment/pickup` بلا idempotency مطلوب** (العمليتان لا تستدعيان `checkIdempotency`): إعادة `pickup` تفشل مغلقاً بـ`INVALID_STATE_TRANSITION` بدل replay، وهذا سلوك آمن لكنه خارج نمط «idempotency الموجود يبقى إلزامياً»؛ أفضل توثيقه أو إخضاعه للمفتاح.
- **الاتساق البصري:** لم أشغّل مسار UI عدائياً مستقلاً (تنظيف/صيانة/حجب)؛ اعتمدت phase7-visual + قراءة مسار التعطيل والسبب في `FrontDeskPage.tsx:219-297`. لا دليل على إخفاء صامت.
- **إصلاحات المنفذ للأدوات** (locator phase7 وانتظارات phase11) صحيحة وضرورية لإعادة البصريات كما أُعلن.

---

## 6) التوصية

- **الحكم الحالي `NEEDS_FIXES`** بسبب R07-P0-01 أساساً. لا يكفي حكم `GO_WITH_NOTES` لأن الفرض المعلن قابل للتجاوز عبر مسار منتج مدعوم.
- **أصغر حزمة إصلاح قابلة للتحقق (R07):**
  1. `assertSharingScopeGuests` في `pickupGroupAllotment` (ويفضَّل `createGroupAllotment`) + حارس مشترك لصفوف الاستيراد → اختبارات: سياق RV07-03 نفسه يجب أن يعيد `422 GUEST_GENDER_REQUIRED` (أو رفض الصف في `rows_rejected`) مع بقاء `MIXED` يعمل.
  2. مفاتيح التعريب الناقصة ×3 لغات أو تصحيح `metricLabel` → اختبار وحدة يمر على كل `metric.key` القادم من OCCUPANCY/ADR_REVPAR/ARRIVALS/DEPARTURES ولا يقبل `RAW:`.
  3. جاهزية الأسلاف في اللوحة → سياق RV07-02 يجب أن يعرض `eligible=false, reason='PARENT_DIRTY'` ويطابق رفض التسكين.
  4. (اختياري P2) أسبقية سبب القدرات للمجموعة داخل المنشأة.
- **التحقق بعد الإصلاح:** إعادة تشغيل أطقم SET-07 (`set07`، `reporting-*`، `front-office-board`، `stay-*`) + `test:property:fast` + `test:distribution:fast` + `check` + بصري phase7/9/11 وSET-01، **مع إعادة إنتاج مستقلة لثلاثة سيناريوهات على الأقل بنفس البروتوكول** (استيراد+مجموعة، تقرير تدبير بالعربية، لوحة بأب أعلى DIRTY). ثم يلزم مراجعة مستقلة ثانية مختصرة (ليست كاملة) تُبطل P0/P1 قبل إغلاق SET-07 أو تحويلها إلى `GO_WITH_NOTES` بقرار المستخدم.
- **تبقى**: SET-06 وحكمها المستقل خارج هذا التقرير، وG-13 كما هي، وSET-AT كلها NOT_TESTED، ولا قبول إنتاجي.
