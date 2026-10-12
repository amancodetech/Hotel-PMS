# جولة المراجعة المركزة لـG-07 بعد إصلاح F-RVW7-01..04

التاريخ: 15 سبتمبر 2026. المرجع: [docs/62](62_phase7_independent_review.md) (الحكم FAIL
والfindings) و[docs/63](63_g07_fix_session.md) (جلسة الإصلاح والأدلة). النطاق: التحقق
المستقل من إغلاق F-RVW7-01/F02/F03/F04 وملاحظة GiST، وعدم ارتداد P07، وحدود P07 المعلنة
فقط. القبول قرار المستخدم، وP08 تبقى محجوبة حتى ذلك.

## أسئلة الحكم

1. **F-RVW7-01 (عالٍ):** بعد `AssignRoom` ثم `POST .../reservation-items/{itemId}/cancel`
   (وإلغاء القناة عبر revision وNo-show) هل يبقى صفر تخصيص `PLANNED/ACTIVE` للبند، ويُعاد
   تخصيص الغرفة لحجز آخر 200، وتعرض اللوحة المرشح `eligible=true`؟ وهل لم تُمس
   `commitment`/`plan_allocation` (تبقى RELEASED كما في P06)؟
2. **F-RVW7-02 (متوسط):** هل يمنع `AssignRoom` و`CheckInStay` و`MoveStay` الغرفة ذات
   `inventory_block` النشط (PLANNED وEMERGENCY) بـ400 `INVALID_REQUEST`
   `details.reason='BLOCKED'` بلا أثر، وتعرض اللوحة `eligible=false reason=BLOCKED`،
   ويعيد `ReleaseBlock` الإتاحة؟ وهل بقي تمييز DIRTY/OOO/OOS/OCCUPIED سليماً؟
3. **F-RVW7-03 (منخفض):** هل اللوحة بلا `date` تعيد تاريخ اليوم المحلي للمنشأة و`timezone`،
   وهل Check-In يقبل وصول اليوم المحلي بينما UTC في اليوم السابق (نافذة 17:00–24:00 UTC
   إن أمكنت ديناميكياً)؟ وهل واجهة FrontDeskPage تتأرخ افتراضياً من الاستجابة لا من UTC؟
4. **F-RVW7-04 (منخفض):** هل نفس المفتاح/العملية على منشأتين لا يعيد استجابة منشأة أخرى
   (سجل مستقل أو 409)، وهل إعادة الاستخدام بمحتوى مختلف على المنشأة نفسها 409 fail-closed؟
   وثّق حد غياب حساب بمنحة منشأة واحدة إن بقي.
5. **GiST/المهاجرة:** هل `room_assignment_no_overlap` أصبح بأبعاد (tenant, property, resource)
   بلا تغيير سلوك منع التراكب، وهل قيد idempotency الجديد مطبق مع `down` نظير؟ وهل لم تُمس
   مهاجرة `≤ 20260915140000`؟
6. **عدم الارتداد:** إعادة الأطقم الرسمية المطلوبة (property كاملاً إن أمكن، وإلا الملفات
   المعدلة على الأقل) + `check` + `contracts:check` + `db:check`.

## إعادة إنتاج الأدوات الأصلية (مطلوبة إن شُغّل dev)

- `tools/s9-cross-module-cancel.mjs` و`tools/s2-readiness.mjs` في
  `.local/verification/review-g07/tools/` بنمط docs/62 نفسه (Keycloak + API 4100).
  المتوقع بعد الإصلاح: s9 **5/5** (إلغاء البند يغلق التخصيص الحي، إعادة تخصيص الغرفة 200،
  اللوحة `eligible=true`) وs2 **14/14** (Block PLANNED/EMERGENCY يمنع التخصيص والدخول واللوحة
  `BLOCKED` مع بقاء Dirty/OOO/OOS مرفوضة وOOO مانعاً للدخول).
- عند تعذر dev تُقبل إعادة إنتاج السيناريوهات عبر الاختبارات المشار إليها في docs/63، مع
  تسجيل الاستثناء صراحة.
- أدلة المنفّذ الخام لهذه الجولة في `.local/verification/P07-07/`: `test-property.log`
  (179/179 في 27 حزمة)، `visual-phase7.log` (**35/35** ومنها 5 فحوص Block/date-timezone)،
  `check-final.log` (79/79)، `test-distribution.log` و`test-identity.log` (48/48 لكل) و
  `contracts-check.log` و`sha256sum-check.log` (473/473 OK).

## كتلة اللصق لجلسة المراجعة المركزة المستقلة

> انسخ الكتلة التالية إلى جلسة مستقلة منفصلة. اكتب حكمك داخل هذا الملف
> (`docs/64_g07_focused_review.md`) في قسم «الحكم» أدناه، ولا تنشئ وثيقة جديدة ولا تعدل كود
> الإنتاج أو الاختبارات أو المهاجرات.

```
أنت مراجع مستقل مركّز على إغلاق F-RVW7-01..04 في /home/omar/Desktop/Hotel.
اقرأ: docs/62_phase7_independent_review.md (الحكم FAIL والأسئلة العشرة)،
docs/63_g07_fix_session.md (الإصلاحات والأرقام النهائية P07-07)، docs/64 (هذه الوثيقة)،
docs/execution/G-07.md وdocs/60_phase7_design_freeze.md.
لا تثق بأدلة المنفّذ: أعد إنتاج كل finding بنفسك بأدوات مستقلة (أو tools/s2 وtools/s9
الأصلية في .local/verification/review-g07/tools/) تحت .local/verification/review-g07-focused/
ببيانات اصطناعية فقط (بادئة RVW7F-) وبلا أسرار، وبلا أي تعديل على الكود/الاختبارات/المهاجرات.
البيئة: من .env المؤقتة؛ شغّل dev (api 4100 + Keycloak 58080 + web 5173) لسيناريوهات API،
وأوقف dev قبل أطقم property/identity لتجنب تنازع 4100. لا commit/remote.

المطلوب إثباته أو نقضه:
1) F-RVW7-01 (عالٍ): بعد AssignRoom ثم CancelItem (وكذلك إلغاء قناة عبر revision وNo-show):
   صفر تخصيص PLANNED/ACTIVE للبند، إعادة تخصيص الغرفة لحجز آخر 200، اللوحة eligible=true،
   وcommitment/plan_allocation يبقيان RELEASED كما في P06 بلا مساس.
2) F-RVW7-02 (متوسط): Block PLANNED وEMERGENCY نشطان يمنعان AssignRoom/CheckInStay/MoveStay
   بـ400 INVALID_REQUEST details.reason=BLOCKED بلا أثر، واللوحة eligible=false reason=BLOCKED،
   وReleaseBlock يعيد الإتاحة، مع بقاء DIRTY/OOO/OOS/OCCUPIED مميزة وسليمة.
3) F-RVW7-03 (منخفض): اللوحة بلا date تعيد تاريخ اليوم المحلي للمنشأة وtimezone، وCheck-In
   يقبل وصول اليوم المحلي عندما يختلف عن UTC (نافذة 17:00–24:00 UTC ديناميكياً إن أمكنت،
   وإلا فسّر السبب وسجّل النتيجة)، وFrontDeskPage تؤرخ افتراضياً من الاستجابة لا من UTC.
4) F-RVW7-04 (منخفض): نفس المفتاح/العملية على منشأتين لا يعيد استجابة منشأة أخرى، ونفس
   المفتاح بمحتوى مختلف على المنشأة نفسها 409 fail-closed؛ وثّق حد غياب حساب بمنحة منشأة واحدة.
5) GiST/المهاجرة: room_assignment_no_overlap بأبعاد (tenant, property, resource) بلا تغيير
   منع التراكب، وقيد idempotency (tenant, operation, key, property_id) مطبق، وdown نظير،
   ولم تُمس أي مهاجرة ≤ 20260915140000.
6) إعادة إغلاق سؤالَي docs/62 غير المغلقين: السؤال 2 (الجاهزية/Block عبر s2 → المتوقع 14/14)
   والسؤال 10 (الفحص العدائي بعد P07 مع إعادة تشغيل s8 → 8/8 بلا تراكب/تكرار).

عدم الارتداد: أعد تشغيل pnpm check (المتوقع 79/79 في 10 حزم)، pnpm test:property
(المتوقع 179/179 في 27 حزمة)، pnpm test:distribution (48/48 في 11)، pnpm test:identity
(48/48 في 7، نظيف بعد dev:stop)، pnpm contracts:check (43/30/36/21/15/10)، pnpm db:check،
والبصريات visual:phase7 (المتوقع 35/35) وphase6 (24/24) وphase5 (19/19) وvisual:check (38/38).
checksums اختيارية إن لم يطلبها المستخدم في هذه الجولة.

اكتب الحكم في قسم «الحكم» داخل docs/64 نفسها: PASS أو FAIL مع بند لكل finding
(مغلق/غير مغلق) وأدلتك الخام تحت .local/verification/review-g07-focused/، وأي finding جديد
بخطورته ودليله، ولا تمنح قبول G-07 (القرار للمستخدم) ولا تفتح P08.
```

## ما لا يُعاد فتحه

- لا AT منفذة ولا قناة حية ولا مزود/حساب حقيقي ولا إرسال رسائل، ولا مال/تسوية/PAN/CVV
  (P08)، ولا P08/P09 خارج الحدود المعلنة.
- لا تُقبل إعادة تشغيل checksums في هذه الجولة إن لم يطلبها المستخدم؛ لا commit/remote.

## المخرجات

- الحكم يُكتب في هذا الملف نفسه تحت «الحكم» (لا وثيقة جديدة): PASS/FAIL صريح لكل finding،
  وأي finding جديد بخطورته ودليله، ثم يقرر المستخدم G-07.

## الحكم

**نتيجة الجولة المركزة: PASS — F-RVW7-01/F02/F03/F04 مغلقة، وملاحظة GiST مغلقة، وسؤالا docs/62
رقم 2 و10 أُعيد إغلاقهما، ولا finding جديداً حاجباً.** هذا الحكم **لا يمنح قبول G-07**؛ القبول
قرار المستخدم، وP08 تبقى محجوبة.

جلسة مستقلة (بلا سياق المنفّذ) بتاريخ 15 سبتمبر 2026. كل ما يلي أُعيد إنتاجه محلياً بأدوات
جديدة في `.local/verification/review-g07-focused/tools/` (بادئة بيانات `RVW7F-`) تقود الواجهة
العامة (API/Keycloak/Playwright) مع قراءات SQL خام بدور المالك، ولم يُعدَّل أي
ملف إنتاج أو اختبار أو مهاجرة، ولا commit/remote. `sha256sum -c CHECKSUMS.sha256` قبل كتابة هذا
الحكم: **476/476 OK**، وبعد كتابته: **475/475 OK و`docs/64` وحده FAILED**
(`checksums-after-verdict.log`) — أي أن أي ملف آخر لم يتغيّر؛ والجولة لا تجدّد البصمات وفق نصّها.
`dev` أُوقف في النهاية والمنافذ 4100/4101/5173 حرة، ولا عمليات يتيمة.

### 1) F-RVW7-01 (عالٍ) — **مغلق**

- **CancelItem المباشر** (`f1.log` 24/24): بعد `AssignRoom` كان الالتزام والتخصيص ACTIVE، ثم
  `POST .../reservation-items/{itemId}/cancel` أعاد 200؛ القراءة الخام: البند `CANCELLED`،
  **صف التخصيص الوحيد CANCELLED بـ`version+1`، وصفر PLANNED/ACTIVE للبند**، والالتزام
  و`plan_allocation` بقيا `RELEASED` كما في P06 (لم تُمسّا)، وصفر `stay_event`، ثم تخصيص الغرفة
  ذاتها لحجز ثانٍ 200 واللوحة تُظهر المرشح `eligible=true reason=null`، ومسح عام: لا بند
  `CANCELLED/NO_SHOW` في المنشأة يحمل تخصيصاً حيّاً.
- **No-show** (`f1.log`): نفس السلسلة؛ البند `NO_SHOW` وصفر تخصيص حيّ والغرفة أُعيد تخصيصها
  واللوحة `eligible=true`، والالتزام/التخصيص `RELEASED`.
- **إلغاء القناة عبر revision** (`f1.log`): حجز OTA مرتبط بمفتاح خارجي + تخصيص PLANNED، ثم
  إدراج `distribution_inbox_revision.revision_type='cancelled'` ومعالجته عبر
  `POST .../inbox/{revisionId}/reprocess` → `outcome=CANCELLED`، وصفر تخصيص حيّ،
  البند CANCELLED، الالتزام والتخصيص RELEASED، وإعادة التخصيص 200 واللوحة `eligible=true`.
- **عدائي**: إلغاء/No-show بند `IN_HOUSE` مرفوض 409 `INVALID_STATE_TRANSITION` وتخصيصه ACTIVE
  سليم (`f1b.log` 4/4). أداة docs/62 الأصلية `s9` أُعيد تشغيلها كما هي: **5/5** (`s9.log`).

### 2) F-RVW7-02 (متوسط) — **مغلق**

- `f2.log` **22/22**: حجب `PLANNED` و`EMERGENCY` نشطان يمنعان `AssignRoom` و`CheckInStay`
  (مع/بلا تخصيص مسبق) و`MoveStay` بـ**400 `INVALID_REQUEST` و`details.reason='BLOCKED'`** بلا
  أثر (بند بلا تغيير، صفر `stay_event`، التخصيص القديم ACTIVE سليم)، واللوحة
  `eligible=false reason=BLOCKED`، و`ReleaseBlock` 200 ثم التخصيص 200، مع بقاء
  DIRTY/OOO/OOS مرفوضة بذات الأسباب وOOO يمنع الدخول و**OCCUPIED** يبقى سبباً مميزاً.
- `f2b.log` **5/5**: حجب لليلة وسطى فقط يمنع، وحجب يبدأ عند نهاية الإقامة لا يمنع
  (دلالة `daterange [)`)، واللوحة تصنّف الحالتين.
- **سؤال 2 مغلق** عبر الأداة المركزة: `s2-readiness-focused` **14/14** (`s2-focused.log`)
  بما فيها فحص الدخول المحجوب غير المشروط. الأداة الأصلية `s2` أُعيد تشغيلها حرفياً فأظهرت
  **13/13**: فحصها الرابع عشر (دخول غرفة محجوبة) داخل `if (assignBlocked.status === 200)`
  وهو فرع غير قابل للتحقق بعد الإصلاح لأن التخصيص صار مرفوضاً؛ لذا لا يُحتسب فشلاً، وتغطيته
  الكاملة في الأداة المركزة (`s2-original.log` و`s2-focused.log`).

### 3) F-RVW7-03 (منخفض) — **مغلق**

- `f3.log` **9/9**: اللوحة بلا `date` أعادت تاريخ اليوم المحلي للمنشأة و`timezone`
  (تحقق مستقل بـ`Intl`)، و`date` الصريح يُصدَّر، والعقد `docs/contracts/phase7.openapi.json`
  بمعامل `date` اختياري و`BoardResult` يوجب `{date, timezone}`، و`FrontDeskPage` تؤرخ من
  استجابة اللوحة (فحص متصفح يقرأ قيمة حقل التاريخ بعد تحميل الصفحة + فحص مصدر) وتعرض اسم
  توقيت المنشأة، و`CheckInStay` يقبل وصول اليوم المحلي.
- **الدالة المترجمة**: `businessToday` من `dist` طابقت `Intl` لأربع مناطق اختبار بما فيها
  منطقة متأخرة عن UTC (Honolulu أعادت 2026-09-14 مقابل UTC 2026-09-15) — دليل أن المنطق
  بتوقيت المنشأة لا UTC. قيد `property_timezone_check` يمنع تخزين منطقة غير إندونيسية في صف
  المنشأة، فلم يُغيَّر صف فعلي.
- **نافذة 17:00–24:00 UTC**: الساعة الحقيقية وقت الجولة 09:xx–10:xx UTC فالنافذة غير نشطة.
  أُجري اختبار ديناميكي للنافذة الأمامية عبر نسخة API مخصصة بمهاد ساعة مراجعة يزحزح تنسيق
  التواريخ +8 ساعات (`/tmp/opencode/f3-clock-shim.mjs`، خارج المستودع، بلا أي تعديل منتج):
  اللوحة أعادت **2026-09-16** (اليوم المحلي) مقابل UTC 2026-09-15، و`CheckInStay` قبل وصول
  اليوم المحلي 200، ورفض وصول الغد المحلي `not_arrival_date` (`f3b.log` **3/3**). هذا مهاد
  اختبار شفاف وليس ساعة حقيقية، ويُسجَّل كذلك.

### 4) F-RVW7-04 (منخفض) — **مغلق**

- `f4.log` **13/13**: نفس المفتاح/العملية على منشأتين أنتج سجلين مستقلين واستجابتين 200
  مستقلتين، وكل replay يعيد استجابة منشأته فقط (`replayed=true`)، وقراءة خام: صفّا
  `api_idempotency` بمعرّفي منشأتين صحيحين.
- **الاستغلال الأصلي** (جسم مطابق حرفياً عبر منشأة أخرى): فشل مغلقاً **404 NOT_FOUND** ولم
  يُعد الاستجابة المخزنة لمنشأة A؛ أي `200 replayed` مع معرّفات A لم تحدث.
- نفس المفتاح بمحتوى مختلف على المنشأة نفسها: **409 `idempotency_key_reused`**.
- فحص كودي: **كل عمليات P07 الثماني تمرّر `propertyId`** إلى `checkIdempotency`.
- **حد معلن**: لا يوجد حساب اصطناعي بمنحة منشأة واحدة في المستودع (لا جدول منح بخصائص
  منشأة، والحسابان owner-a/admin-a على مستوى العميل)؛ الاستغلال اختُبر حسابياً عبر منشأة
  ثالثة بكائنات منشأة A وفشل مغلقاً، ويبقى فحص «مستخدم يملك منشأة واحدة» مسنداً إلى منطق
  المطابقة نفسه. مطابق لحد docs/63.

### 5) GiST/المهاجرة — **مغلق** (مع ملاحظة منخفضة)

- `f5.log` **15/15**: القيد الفعلي في القاعدة
  `EXCLUDE USING gist (tenant_id WITH =, property_id WITH =, resource_id WITH =, daterange(...) WITH &&) WHERE state in ('PLANNED','ACTIVE')`،
  وسلوك المنع سليم (صف متراكب → `23P01`، ملاصق مسموح، متراكب `CANCELLED` مسموح)، وقيد
  idempotency الفعلي `UNIQUE NULLS NOT DISTINCT (tenant_id, operation, key, property_id)`
  مع دلالة الفروق (تكرار null → `23505`، ومنشأتان → مسموح)، والمهاجرة `20260915150000` مطبقة
  ومسجلة، وهي الوحيدة بعد `20260915140000`، ولا مهاجرة ≤ `20260915140000` تغيّر وقتها.
- `down()` النظير أُثبت داخل معاملة (4 جمل up/4 down): Down يعيد القيدين القديمين وUp يعيد
  الجديدين ثم Rollback، والقيد الحي لم يتغير (`f5.log`).
- **ملاحظة منخفضة جديدة N-RVW7F-01**: إعادة بناء قيد `UNIQUE (tenant, operation, key)` في
  `down()` تفشل `23505` على قاعدة استُخدم فيها نطاق المفتاح عبر المنشآت (صفوف متكررة
  tenant/operation/key بمنشآت مختلفة)، فيلزم تنظيف بيانات قبل التراجع. الدليل الخام
  `f5b.log` (الفشل ثم Rollback). ليست ارتداداً وظيفياً؛ ملاحظة تشغيلية للتراجع.

### 6) سؤالا docs/62 غير المغلقين

- **السؤال 2 (الجاهزية/Block)**: **مغلق** — الأداة المركزة 14/14 + `f2.log` 22/22 +
  `f2b.log` 5/5، مع بقاء Dirty/OOO/OOS مرفوضة وOOO مانعاً للدخول (تكرار `s2` الأصلي 13/13
  مع تفسير الفحص الشرطي أعلاه).
- **السؤال 10 (الفحص العدائي بعد P07)**: **مغلق** — `s8.log` **8/8** على بيانات هذه الجولة
  (عمليات P07 الثماني كلها مولّدة حديثاً): صفر تكرار `stay_event`، صفر تراكب
  `room_assignment`، صفر تراكب `plan_allocation` نشط، audit بـcorrelation مطابق لاستجابة
  HTTP، والعقد عشر عمليات بصلاحيات وCSRF.

### عدم الارتداد (أُعيد بالكامل)

| الأمر | النتيجة | السجل |
|---|---|---|
| `pnpm check` | **79/79 في 10 حزم** مع build/typecheck/lint/format/contracts | `check.log` |
| `pnpm test:property` | **179/179 في 27 حزمة** | `test-property.log` |
| `pnpm test:distribution` | **48/48 في 11 حزمة** | `test-distribution.log` |
| `pnpm test:identity` (بعد `dev:stop`) | **48/48 في 7 حزم** | `test-identity.log` |
| `pnpm contracts:check` | 43/30/36/21/15/**10** ومطابقة الأنواع | `contracts-check.log` |
| `pnpm db:check` | database connection successful | `db-check.log` |
| `pnpm visual:phase7` | **35/35** (بعد إعادة واحدة؛ المحاولة الأولى سقطت بمهلة تنقّل Keycloak 20s — هشاشة بيئة لا عيب منتج) | `visual-phase7-retry.log` و`visual-phase7.log` |
| `pnpm visual:phase6` | **24/24** | `visual-phase6.log` |
| `pnpm visual:phase5` | **19/19** | `visual-phase5.log` |
| `pnpm visual:check` | **38/38** | `visual-check.log` |
| `sha256sum -c CHECKSUMS.sha256` (قبل كتابة هذا الحكم / بعده) | **476/476 OK** / **475 OK و`docs/64` وحده** | `checksums-verify.log` و`checksums-after-verdict.log` |
| `pnpm dev:stop` | أوقف dev والمنافذ حرة | مخرجات الجلسة |

### Findings/ملاحظات جديدة

1. **N-RVW7F-01 (منخفض)**: `down()` للمهاجرة `20260915150000` يفشل في إعادة قيد
   idempotency القديم إذا وُجدت مفاتيح متكررة عبر منشآت (سلوك مكتسب من الإصلاح)؛ يحتاج
   تنظيف بيانات قبل التراجع. الدليل `f5b.log`. لا يمنع قبول الإصلاح.
2. **معلوماتية**: أداة `s2` الأصلية تحمل الفحص الرابع عشر داخل فرع لا يُنفَّذ بعد الإصلاح؛
   الأداة المركزة تغطيه صراحةً.
3. **معلوماتية**: محاولة `visual:phase7` الأولى فشلت بمهلة تحميل أثناء تحويل Keycloak
   (20s) ونجحت إعادة التشغيل 35/35؛ سُجّلت المحاولتان.
4. **حد أدلة**: «عدم مسّ المهاجرات ≤ 20260915140000» أُثبت بوقت تعديل الملفات (كلها أقدم من
   مهاجرة التحصين) ولسجلات checksums لجولة docs/62؛ لا توجد لقطة hash قبل الإصلاح محفوظة
   لمقارنة بايتية، وهذا مذكور في `f5.log`.
5. **حدود معلنة**: لا AT منفذة ولا قناة حية ولا مال/PAN/CVV/P08؛ مهاد الساعة مستخدم فقط
   لتوليد نافذة 17:00–24:00 UTC وهو خارج المستودع؛ لا حساب بمنحة منشأة واحدة.

### الأدلة الخام

- الأدوات: `.local/verification/review-g07-focused/tools/` (`lib.mjs`، `f1`، `f1b`، `f2`،
  `f2b`، `f3`، `f3b`، `f4`، `f5`، `f5b`، ونسخ `s1/s2*/s3/s4/s5/s8/s9`).
- السجلات: `f1.log` `f1b.log` `f2.log` `f2b.log` `f3.log` `f3b.log` `f4.log` `f5.log`
  `f5b.log` `s1.log` `s2-focused.log` `s2-original.log` `s3.log` `s4.log` `s5.log` `s8.log`
  `s9.log` وتقارير JSON المرافقة، وسجلات الأطقم والبصريات و`checksums-verify.log`
  و`checksums-after-verdict.log` أعلاه، و`f3b-api.log` لنسخة المهاد. الإجمالي المنفّذ في الجولة: **187 فحصاً مركزاً** (منها أدوات
  إضافية خارج سيناريوهات docs/62: f1b وf2b وf3b وf5 وf5b) بلا فشل منتج.
- إجمالي ما لم يُعَد فتحه وفق القيود: AT، القنوات الحية، المال، P08، checksums (اختيارية هذه
  الجولة ولم تُجدَّد بعد تعديل هذا الملف).

