# مراجعة مستقلة ثانية للمرحلة 5 (G-05) — تقرير

التاريخ: 14 سبتمبر 2026. المراجع: جلسة مستقلة جديدة (opencode / deepseek-flash) لم تستخدم
سياق جلسة المنفّذ ولم تعتمد نتائج [docs/48](48_phase5_adversarial_review.md) ولا الجولة الأولى
[docs/50](50_phase5_independent_review.md) ولا أدلتهما. قُرئت تقارير المنفّذ للسياق والنطاق فقط.

الحكم: **PASS WITH FINDINGS**. المتوسطات الثلاثة (ADV5-F1/R1/R2) أُصلحت وتحققت مستقلة، ولم
يظهر finding متوسط أو عالٍ جديد. تبقى منخفضات موثقة ومفتوحة (F2/F3/R5/R9/R10/R11) وسجلت
ملاحظات جديدة منخفضة/معلوماتية (R12/O1..O4). لا شيء منها يمس العزل أو المال أو الالتزام،
والقبول النهائي وبدء P06 قرار المستخدم.

## 1) بيان الاستقلال

- بدأت الجلسة بقراءة AGENTS.md وREADME وdocs/01 و17 و18 ثم بطاقات P05-01..07 وdocs/46
  وdocs/47 و48 و50 و51 والعقد `docs/contracts/phase5.openapi.json`.
- لم يُعدّل أي كود تطبيق ولا مهاجرة مطبقة ولا بصمة ولا `dev DB` أثناء الأطقم. كل ما أُضيف هو
  سكربتات تشغيلية وأدلة في `.local/verification/review-g05-3/` وتقرير هذا الملف. لم أُنفّذ أي
  إصلاح؛ الإصلاحات المقترحة في الجدول فقط.
- أُوقف `pnpm dev` قبل كل طقم (وقبل فحص الحاضنة) وأُعيد تشغيله للفحوص البصرية فقط، ثم أُوقف
  مجدداً. لم تُلمس أدلة المنفّذ في `review-g05` ولا أدلة الجولة الأولى في `review-g05-2`
  إلا للاطلاع. لم تُطبع أي أسرار؛ كل البيانات الاصطناعية بادئة RV5B-.

## 2) المنهج

1. **إعادة إنتاج من الصفر**: كل الأرقام أُعيد تشغيلها على قواعد اختبار تُبنى بـ`migration:up`
   ثم تُحذف، وسجلت المخرجات الخام في `review-g05-3`.
2. **تدقيق بنية**: قاعدة `review_g05_3_fresh` بُنيت من الصفر، وقارن `schema-audit.mjs` الجداول
   والقيود والفهارس وFORCE RLS والمنح والصلاحيات بالبطاقات.
3. **تدقيق عقد ومعالجات**: `handlers-audit.mjs` قابل العمليات الـ21 بمعالجات NestJS والصلاحية
   `x-permission`، وقرئت DTOs يدوياً.
4. **عدائي مستقل**: 44 اختباراً في `rv5b.attacks.test.mjs` على قاعدة وAPI مستقلين
   (`rv5b-run.mjs`)، عائلات أسعار/التزام/D-20/عزل/إدخال/DoS، مع قراءات DB مباشرة.
5. **سبر كسر الثوابت**: `break-probes.mjs` على قاعدة `review_g05_3_probe` مستقلة مع إعادة
   الحالة.
6. **فحص الحاضنة والمنفّذ**: `tests/property/adversarial-p05.pg.test.mjs` أُعيد تشغيله كاملاً
   (23/23) وقُرئ منطقه سطراً سطراً، مع تحليل هل تفشل اختبارات FIX-\* على السلوك القديم.

## 3) إعادة إنتاج كل الأرقام المعلنة

| الادعاء (G-05/P05/docs/48/51) | المخرجات الخام المرصودة | الملف |
|---|---|---|
| `pnpm check` 79/79 | 79/79 في 10 حزم (build+contracts+typecheck+lint+format+jest) | `check.txt` |
| `pnpm test:identity` 48/48 | 48/48 في 7 حزم | `identity.txt` |
| `pnpm test:distribution` 48/48 | 48/48 في 11 حزمة | `distribution.txt` |
| `pnpm test:property` 108/108 في 17 حزمة (23 عدائية) | 108/108 في 17 حزمة؛ ملف `adversarial-p05` وحده 23/23 | `property.txt`, `adversarial-p05-rerun.txt` |
| `pnpm visual:phase5` 19/19 | 19/19 (10 صور، خمسة ألسنة، RTL، 390) | `visual-phase5.txt` |
| `pnpm visual:phase4` 17/17 | 17/17 | `visual-phase4.txt` |
| `pnpm visual:phase3` 23/23 | 23/23 | `visual-phase3.txt` |
| `pnpm visual:check` 38/38 | 38/38 | `visual-check.txt` |
| `contracts:check` 43/30/36/21 | 43 V1، 30 Phase3، 36 Phase4، 21 Phase5 والأنواع مطابقة | `contracts-check.txt` |
| `db:check` ناجح | اتصال ناجح (dev) | `db-check.txt` |
| المهاجرات تعيد البناء من الصفر | `review_g05_3_fresh` بُنيت من صفر بـ`migration:up` | `fresh-migrate.txt` |
| PERF-01 500 مورد = 90ms | القياس المستقل: **26ms** (تحت سقف 500ms؛ ليس SLA) | `inventory-scale-rerun.txt`, `scale-evidence.json` |
| 387 بصمة | الملف الحالي 390 مدخلاً و`sha256sum -c` فشل في `docs/47` قبل إعادة التوليد (ADV5-R12)، ثم 390/390 OK بعد `pnpm checksums` | `sha256sum-before.txt`, `checksums-before-report.txt`, `sha256sum-before-report.txt` |

كل الأرقام طابقت ما عدا بصمات CHECKSUMS: العدد الفعلي 390 لا 387، وملف واحد (`docs/47`) كان
مخالفاً لبصمته قبل إعادة التوليد (تفصيل في ADV5-R12).

### 3.1 المخطط الفعلي (fresh rebuild)

- 13 جدولاً جديداً: rate_plan, rate_policy_version, nightly_price, price_quote, commitment,
  plan_allocation, inventory_block, inventory_block_resource, inventory_disruption, exposure,
  exposure_allocation, sale_restriction, exposure_preview — مطابق للبطاقات ولتصحيح docs/48.
- كلها `rls=true force=true` بسياسة `tenant_isolation` واحدة، و42 trigger
  `prevent_tenant_id_change` تراكمياً، و`btree_gist 1.7` مثبتة.
- قيدا الاستبعاد GiST موجودان و`convalidated=true`:
  `plan_allocation_no_overlap (state=ACTIVE)` و`exposure_allocation_no_overlap (state=RESERVED)`.
- 25 FK مركباً على جداول Phase 5 بما فيها
  `exposure_connection_fk (connection_id, property_id, tenant_id)`.
- المنح: `hotel_api` على `distribution_outbox_event` = INSERT,SELECT فقط (لا UPDATE/DELETE/
  TRUNCATE)؛ و`rate_policy_version`/`price_quote`/`exposure_preview`/`inventory_block_resource`/
  `inventory_disruption` بلا UPDATE بعد مهاجرة 15040000. مطابق لـFIX-R8.
- الأدلة: `schema-audit-fresh.txt` (184 سطراً).

### 3.2 الصلاحيات السبع وMFA

- الكتالوج يحتوي السبع: rate.manage, reservation.read, reservation.create, inventory.block,
  maintenance.emergency, channel.sale.manage, channel.reconcile — مطابقة لـdocs/26 وpermissions.ts.
- على قاعدة dev (ترقية فعلية لمهاجرة backfill): TENANT_OWNER/TENANT_ADMIN يملكان السبع،
  AUDITOR اكتسب `reservation.read` فقط، MEMBER بلا جديد (شوهد لكل عميلين لأن الأدوار لكل
  Tenant). ملاحظة: قاعدة fresh لا تحتوي صفوف أدوار لأن الكتالوج يُنشأ عند تهيئة العميل
  (`provisionTenant` من permissions.ts)، ولهذا تم التحقق من الربط في dev وفي مسار التهيئة
  الذي تستخدمه الاختبارات.
- `mfaRequired=true` في `permissions.ts` لـ rate.manage وmaintenance.emergency وchannel.sale.manage،
  وأثبتت الاختبارات فرضه: owner-a (بلا MFA) يُرفض 403 `MFA_REQUIRED` على الثلاثة حتى مع
  `x-approval-id`، وadmin-a (TOTP) ينجح، وmember/auditor لا يكتبان (RV5B-I04/I05).
- الأدلة: `schema-audit-fresh.txt`, `rv5b-attacks.txt` (RV5B-I04/I05).

### 3.3 العقد والمعالجات وDTO

- `handlers-audit.mjs`: 21/21 عملية Phase 5 لها معالج مطابق method/path، والصلاحية `x-permission`
  مطابقة، ولا معالج Phase 5 خارج العقد. كل DTOs الجديدة `z.object(...).strict()` بما فيها
  union الخاصة بـsale-status.
- الأكواد: `PropertyErrorCode` (24) كلها لها مفاتيح `errors.*` في اللغات الثلاث؛
  `reason.<CODE>` (22 مفتاحاً) تغطي كل الرموز التي يرميها المخزون.
- الأدلة: `handlers-audit.json`, `i18n-audit.txt`.

### 3.4 الواجهة وi18n والشبكة

- صفحة rates بخمسة ألسنة: Rate plans / Rate calendar / Availability / Holds·Blocks /
  Channel exposures مع حالات Loading/Empty/Error في كل لسان (`LoadingBlock`, `EmptyBlock`,
  `ErrorAlert`) واحترام `property.read`.
- تطابق مفاتيح i18n: **524** مفتاحاً في ar/id-ID/en-US بلا مفقود/زائد. الفرق عن رقم docs/50
  (525) مفسَّر: `+2` مفتاحا reason في FIX-R6 و`-3` أكواد أخطاء ميتة في FIX-R7 = 524.
- `ReasonChips` يترجم `reason.<CODE>`، و`reason.RESOURCE_UNAVAILABLE` و`reason.WITHDRAWAL_PENDING`
  موجودان في اللغات الثلاث.
- Playwright: RTL عربية، 390x844 و1440 بلا overflow، بلا أخطاء صفحة/console، وخمسة ألسنة.
- مسح شبكة مستقل أثناء فتح الصفحة: 9 استدعاءات API، صفر تسريب لأسرار/كلمات مرور/`secret_ref`
  بقيمة، ولا مفاتيح حساسة غير `csrf_token` المقصود للـSPA. الأدلة: `network-probe.txt`.

## 4) الفحص العدائي المستقل — 44/44 (`rv5b.attacks.test.mjs`)

كل هجوم نُفّذ من الصفر على قاعدة/API مستقلين. جميعها فشلت في الوصول لهدفها أو أثبتت السلوك
fail-closed المتوقع. العائلات:

- **أسعار (7)**: صفر بلا free_policy 422 ثم قبول بعد free_policy؛ سالب/بادئات/NaN/Infinity/دقة>6
  مرفوضة؛ عملة وإشغال غير مطابقين مرفوضان؛ دفعة مختلطة لا تكتب أي خلية (ذرية)؛ لقطة سياسة
  الاقتباس لا تتغير بعد تعديل الخطة والسعر الجديد يلتقط النسخة الجديدة؛ ماضٍ/أفق 500 مرفوضان؛
  اقتباس بخطة خارج النطاق مرفوض؛ كسور IDR محفوظة بدقة كاملة ومرفوضة عند Preview بلا تقريب؛
  `price_quote` غير قابل للتحديث بدور `hotel_api` (42501).
- **التزام وتزامن (14)**: 100 Hold متزامن → 201 واحد وتخصيص ACTIVE واحد؛ منع تجاوز النسخة
  المستقبلية (412)؛ تحرير أحادي الاتجاه وإعادة Hold بعد التحرير؛ انتهاء TTL بلا عامل يحرر
  ويقفل الإصدار ويعيد 409 `HOLD_EXPIRED`؛ فشل جزئي متعدد البنود لا يترك أثراً؛ Hold+Block
  متزامنان → فائز واحد وحالة نهائية متسقة؛ حجب مخطط متعارض 409؛ طارئ يحفظ الالتزام وينشئ
  Disruption OPEN؛ صيانة مورد متقاعد مرفوضة؛ OOO على مورد بحصة قائمة لا يحررها (R10)؛
  F1: الإصدار الصحيح قبل الانتهاء الكسول يُقبل وخطأ النسخة يعلن إصدار القرص الحقيقي؛
  R2: دور بـ`inventory.block` وحدها ينشئ حجباً مخططاً (201) ويُرفض له الطارئ (403).
- **D-20 وحصص (8)**: نشران متزامنان لنفس المورد → 202 واحد و412 للآخر وحجز واحد؛ النشر ثانياً
  ومعاينة منتهية مرفوضان؛ حصة على كل المرشحين تمنع البيع المحلي والعرض المنافس
  (`EXPOSURE_PROTECTED`)؛ السحب لا يحرر مع PENDING/UNKNOWN/DEAD_LETTER ويحرر بعد ACK؛
  `reconcile` لا يغير ACTIVE، ويعالج RECONCILING→RELEASED وUNKNOWN→ACTIVE بدليل لاحق؛ لا
  تكرار events (حدث واحد بعدد الليالي)؛ OPEN مربوط بالاتصال ولا يقبل معرّفاً أجنبياً؛ سحب ثم
  نشر لنفس المنتج يبقى مرفوضاً.
- **عزل وهوية (7)**: تبديل tenant على كل عائلة جديدة 403 `TENANT_CONTEXT_MISMATCH`؛ منشأة
  أجنبية/غير موجودة لا تسرّب؛ `internal_rate_ref` خارج النطاق مرفوض؛ owner-b لا يقرأ بيانات A؛
  member/auditor للقراءة فقط؛ MFA لا يُتجاوز بـ`x-approval-id`؛ CSRF/Origin مفقود/دخيل 403 على
  كل POSTs؛ منح PROPERTIES يضيّق فعلاً (200 بالمنشأة الممنوحة، 403 بغيرها، و403 بلا رأس المورد)
  ويُبطل فوراً بالسحب.
- **إدخال/إخراج (5)**: strict DTO يرفض الحقول الزائدة في 8 عائلات؛ حقن SQL/XSS محفوظ حرفياً أو
  مرفوض بلا تنفيذ؛ محارف التحكم (C0 + DEL) مرفوضة 400 في الاسم وسبب الحجب/السحب؛ 413 بلا
  تسريب وأغلفة أخطاء بلا SQL/stack/PII؛ قوائم المعرّفات لا تهرّب عناصر إضافية والحقن في
  `any(string_to_array(...))` محجوب بـuuid validation.
- **DoS/أداء (5)**: `lock_timeout=2000` → 409 `CONFLICT`/`LOCK_TIMEOUT` داخل المخزون؛
  `statement_timeout=1500` خارج المخزون → 503 `DEPENDENCY_UNAVAILABLE`/`STATEMENT_TIMEOUT` مع
  `Retry-After: 1`؛ ميزانية بحث 1ms → `UNDETERMINED/BUDGET_EXCEEDED` بلا فساد نسخة؛ 100 بحث
  متزامن 200 ومتسق؛ `x-approval-id` عشوائي لا يوسّع وصولاً.

الدليل الكامل: `rv5b-attacks.txt` (44/44) وسكربتات `rv5b.attacks.test.mjs` و`rv5b-run.mjs`.
ملاحظة بيئية: في تشغيل واحد فقط تعرّض طلب واحد من أصل 100 لـ`ECONNRESET` على مستوى النقل
(Playwright) دون أي 5xx من API، وأُعيد بنجاح؛ سُجل في ADV5-O3.

### 4.1 سبر كسر الثوابت (`review_g05_3_probe`)

| الثابت | قبل الكسر | بعد الكسر | بعد الاستعادة | break_detected |
|---|---|---|---|---|
| RLS على commitment | 0 صف لعميل أجنبي | 2 صف | 0 و`rls=true/force=true` | true |
| GiST plan_allocation | 23P01 | قُبل | 23P01 | true |
| FK نطاق مركب | 23503 | قُبل بعد الإسقاط | 23503 | true |

الدليل: `break-probes.txt` و`break-probes-run.txt`.

### 4.2 إعادة إنتاج PERF-01 وحدود الزمن

- 500 مورد: بحث 26ms (هدف تصميمي 500ms بعد القفل، ليس SLA). أعاد تشغيله `inventory-scale`
  من فئة property: 4/4.
- `timeouts.ts`: `statement_timeout=3000` و`lock_timeout=2000` داخل معاملات المخزون، والافتراضي
  1500 لبقية المسارات (`orm-options.ts`)؛ أُثبت الفرق سلوكياً (409 داخل المخزون مقابل 503 خارج).

## 5) التحقق الخاص من إصلاحات FIX-\* وهل تفشل على السلوك القديم

| الإصلاح | ما تحقق مستقلاً | لماذا كان سيفشل على السلوك القديم |
|---|---|---|
| **FIX-F1** (انتهاء كسول) | `RV5B-F1` + `FIX-F1` (23/23): الإصدار قبل الانتهاء يُقبل 201، العقد EXPIRED وصفر تخصيصات، وخطأ النسخة الحقيقي يعلن `details.current` = إصدار القرص | سلوك الجولة الأولى (docs/50 RV5-B05) كان يعيد 412 على نفس المدخل لأنه يعلن `disk+1`؛ إصلاح الإعلان وحده لا يكفي، والقبول المزدوج (disk أو disk+1) هو ما ينجح الآن |
| **FIX-R1** (RECONCILING/UNKNOWN) | `RV5B-E04/E05` + `FIX-R1`: سحب→RECONCILING→(ACK)→RELEASED، ونشرة UNKNOWN→(ACK)→ACTIVE | حلقة reconcile القديمة كانت تقف عند PUBLISHING/WITHDRAWING فقط (docs/50 RV5-C02/C03/C07): لا تحرير ولا تنشيط، والحصة تبقى معلقة |
| **FIX-R2** (نطاق الحجب المخطط) | `RV5B-F3` + `FIX-R2`: دور بـ`inventory.block` وحدها → PLANNED 201 وEMERGENCY 403 | الكود القديم كان يفرض `maintenance.emergency` خارج الشرط (docs/50 RV5-B09: 403 على PLANNED) |
| **FIX-R3** (رموز القفل/المهلة) | `RV5B-D01/D05` + `FIX-R3`: 55P03→409 CONFLICT/LOCK_TIMEOUT، 57014→503 DEPENDENCY_UNAVAILABLE/STATEMENT_TIMEOUT مع Retry-After، ولا تسجيل unhandled لهما | القديم كان يسقط إلى 500 `INTERNAL_ERROR` (docs/50 RV5-F02) |
| **FIX-R4** (محارف التحكم) | `RV5B-X03` + `FIX-R4`: NUL/C0/DEL → 400 `INVALID_REQUEST` بلا 500 | القديم كان يعيد 500 عبر DriverException (docs/50 RV5-E05) |
| **FIX-R6** (مفاتيح i18n) | تدقيق i18n + `FIX-R6`: المفتاحان موجودان في ar/id-ID/en-US وكل رموز reason الـ22 مغطاة | اللغات القديمة كانت تفتقدهما فيظهر الرمز الخام |
| **FIX-R8** (سحب منح UPDATE) | مخطط fresh + `FIX-R8` + `RV5B-P07/E04`: بلا UPDATE على الجداول الثلاثة، وhotel_api يُرفض 42501 على Outbox | قبل مهاجرة 15040000 كان `hotel_api` يملك UPDATE على الجداول الثلاثة |

الخلاصة: اختبارات FIX-\* غير تافهة (تقرأ DB أو تعقد قفلاً حقيقياً أو تفحص منحاً فعلية)، ولا
تقارن الإنتاج بنفسه، وكان السلوك القديم الموثق في الجولة الأولى سيفشلها فعلاً.

## 6) حكمي على ملف المنفّذ `tests/property/adversarial-p05.pg.test.mjs`

أُعيد تشغيله 23/23 (وسجل ضمن 108/108). العائلات ADV5-01..16 عدائية فعلياً وتقارن DB/الحالة
النهائية لا الإنتاج بنفسه. تحفظات لا تُسقط النتيجة:

- ADV5-01 يستخدم `?? '250000'` فيسقط إن كانت القائمة فارغة (تغطيته في RV5B-P01 بفحص صريح).
- ADV5-05/06/10 تقبل بدائل `[404,422]`/`[400,409,412]`؛ ADv5-06 تقبل `INVALID_REQUEST` كسبب خسارة.
- ADV5-12 تقبل `[200,404]` وتوثق F2 ضمناً، وADV5-14 حد أعلى مرن `<=3` للخطط.
- لا تغطية مباشرة في الملف الأصلي لـRECONCILING/UNKNOWN قبل الإصلاح، لكن FIX-R1 أضافها.

## 7) Findings وحكمي

| ID | الخطورة | الوصف | إعادة الإنتاج | الأثر | يفتح G-05/G-06؟ | إصلاح مقترح | الحالة / حكمي |
|---|---|---|---|---|---|---|---|
| ADV5-F1 | متوسط | انتهاء كسول يُلغى مع فشل المعاملة ويعلن إصداراً وهمياً | docs/50 RV5-B05 | التزام/إتاحة | كان يمنع | فُصل الإصدار عن الانتهاء وقُبل الإصداران | **مُعالج — تحقق مستقل (RV5B-F1)** |
| ADV5-R1 | متوسط | reconcile لا يعالج RECONCILING/UNKNOWN | docs/50 RV5-C02/C03/C07 | حصة معلقة | كان يمنع | أُضيفت المعالجة بنفس قواعد الدليل | **مُعالج — تحقق مستقل (RV5B-E04/E05)** |
| ADV5-R2 | متوسط | maintenance.emergency مفروض على الحجب المخطط | docs/50 RV5-B09 | تفويض | كان يمنع | نُقل داخل شرط EMERGENCY | **مُعالج — تحقق مستقل (RV5B-F3)** |
| ADV5-F2 | منخفض | قوائم منشأة غير موجودة 200 فارغة بدل 404 | RV5B-I01: `200` مع قائمة فارغة | اتساق فقط | لا | تحقق وجود المنشأة في القراءات | مفتوح — منخفض، يؤجل بقرار المستخدم |
| ADV5-F3 | منخفض | حد الجسم ~16KB يرفض مئات الخلايا بينما DTO يسمح 1000 | RV5B-X04: 200 خلية → 413 `PAYLOAD_TOO_LARGE` | تجربة عميل | لا | مواءمة الحدين/رسالة أوضح | مفتوح — منخفض |
| ADV5-R5 | منخفض | أهلية FRACTIONAL_IDR تبحث `VERIFIED` غير المسموح في قيد القدرة → مسار ميت | قراءة قيد `distribution_capability_status_check` + RV5B-P06 | قدرة مؤجلة | لا | مواءمة enum القدرة عند التفعيل | مفتوح — مؤجل معلن |
| ADV5-R9 | منخفض | سباق حاضنة الاختبارات إن احتُل المنفذ 4100 | تحليل `startApi` (فحص الخروج والاستطلاع في حلقة واحدة)؛ لم يُعد الاختبار حياً تفادياً لكتابة dev DB | سلامة أدلة | لا | فحص ملكية المنفذ قبل الإقلاع | مفتوح — منخفض |
| ADV5-R10 | منخفض/تشغيلي | OOO على مورد بحصة قائمة لا يلغي العرض | RV5B-C10: الحصة تبقى RESERVED | خطر بيع قناة لغرفة OOO | لا | ربط الصيانة بسحب معلن/تحذير | مفتوح — موثق كحد |
| ADV5-R11 | منخفض | حراس التاريخ `current_date`/UTC لا توقيت المنشأة | قراءة `rate-service`/`availability` (لا فرق وقت التشغيل) | حدود يوم محلية | لا | اشتقاق تاريخ العمل من توقيت المنشأة | مفتوح — موثق كحد |
| ADV5-R12 | منخفض/وثائقي | CHECKSUMS: 390 مدخلاً لا 387، و`docs/47` مخالف لبصمته قبل إعادة التوليد | `sha256sum -c` فشل على docs/47؛ بعد `pnpm checksums`: 390/390 OK | دقة وثائق/عملية | لا | تحديث docs/50 إلى العدد الصحيح وتوليد البصمات بعد تثبيت docs/47 | مُعالج جزئياً في جلستي (أُعيد التوليد والتحقق) — يحتاج تصحيح نص docs/50 |
| ADV5-O1 | معلوماتي | PayloadTooLargeError (413) يُسجَّل `unhandled_error` بـ`error_name` فقط | `rv5b-api.log` | لا تسريب | لا | استثناء 413 من سجل unhandled | موثق |
| ADV5-O2 | معلوماتي | حالة Outbox `SENT` تُحسب دليلاً مقبولاً للتحرير ولا كاتب حالي ينتجها | قراءة `exposure-repository`/`sync-repository` | لا خطر عملي حالياً | لا | توثيق أو تضييق الدليل عند بناء العامل | موثق |
| ADV5-O3 | معلوماتي | ECONNRESET نقلية واحدة في دفعة 100 طلب دون 5xx، والنجاح بعد الإعادة | `rv5b-attacks.txt` | بيئة اختبار | لا | إعادة محاولة/تجميع اتصالات في الحاضنة | موثق |
| ADV5-O4 | منخفض | `SetResourceMaintenance` يكتب بمهلة 1500 الافتراضية لا ميزانية المخزون 2000/3000 | قراءة `resource-service` مقابل `timeouts.ts` | تشغيل/زمن استجابة تحت التنافس | لا | تطبيق `applyInventoryTimeouts` على كتابة الصيانة | موثق — منخفض |

ملاحظات ليست findings: لا rate limiting على مسارات الأعمال (AuthRateLimitGuard على المصادقة
وحدها) — شرط نشر معلن؛ `x-approval-id` لا يفتح شيئاً في Phase 5؛ المؤجل المعلن
(ConfirmReservation/P06، SplitStay، P13، الاعتماد المستقل للنشر، `distribution_connection_property_fk`
not valid، قدرة FRACTIONAL_IDR) لم يتسرب إلى سلوك مطبّق في ما اختُبر.

## 8) الأمانة الوثائقية

- كل أرقام G-05/P05/docs/48 قابلة لإعادة الإنتاج (القسم 3) عدا رقم البصمات (ADV5-R12).
- docs/48 صُحح إلى 13 جدولاً وهو مطابق للواقع.
- docs/50 ذكر 387 بصمة و525 مفتاح i18n؛ الواقع الآن 390 مدخلاً بصمة و524 مفتاحاً. تفسير 524
  أُوردناه (FIX-R6 +2 / FIX-R7 -3) وليس انحداراً؛ أما 387 فتحتاج تحديثاً نصياً.
- لا ادعاءات قنوات حية أو قبول إنتاجي في الوثائق المفحوصة.

## 9) ما لم يُختبر والحدود

- قناة حية أو مزود خارجي (P13)، العامل الحقيقي SENT/PARTIAL/DEAD_LETTER عبر dispatcher فعلي،
  ConfirmReservation وP06-04، SplitStay.
- انقطاع فعلي وسط `SetRates` (الذرية مثبتة ببناء التحقق المسبق والمعاملة، لا بقتل عملية).
- انحراف ساعة فعلي بين API وDB (المهلة مولدة بساعة Node و`now()` في القاعدة) — يبقى موثقاً.
- حدود توقيت المنشأة (R11) لم تظهر فرقاً وقت التشغيل؛ استنتاج من الكود.
- استنزاف pool طويل الأمد، تسريبات ذاكرة/سجلات عبر تشغيل مطوّل، وأداء ما بعد 500 مورد.
- R9 لم يُختبر حياً (تفادياً لتوجيه طقم إلى dev DB).

## 10) الحكم والتوصية

1. **المتوسطات الثلاثة مغلقة** بأدلة مستقلة، ولا finding متوسط/عالٍ جديد.
2. **العزل والمال والالتزام**: كل الهجمات فشلت؛ لا overbooking داخلي، ولا تحرير حصة بلا دليل
   مقبول، ولا تجاوز MFA/CSRF/النطاق، والقيود تُكسر بالتعطيل وتعود.
3. المتبقي منخفض/وثائقي (F2/F3/R5/R9/R10/R11/O4) وR12؛ أنصح بتسوية R12 نصياً وإما إصلاح
   F2/F3/O4 أو توثيقها كحدود نشر مقبولة محلياً.
4. **G-05**: حكمي PASS WITH FINDINGS (لا مانع تقنياً)، و**القبول وبدء P06 قرار المستخدم** وفق
   docs/47/49؛ هذا التقرير توصية لا قبول.

## 11) الأدلة وأوامر إعادة التشغيل

كل المخرجات الخام في `.local/verification/review-g05-3/`: `check.txt`, `identity.txt`,
`distribution.txt`, `property.txt`, `adversarial-p05-rerun.txt`, `inventory-scale-rerun.txt`,
`visual-phase5/4/3.txt`, `visual-check.txt`, `contracts-check.txt`, `db-check.txt`,
`fresh-migrate.txt`, `schema-audit-fresh.txt`, `handlers-audit.json`, `i18n-audit.txt`,
`break-probes.txt`, `rv5b-attacks.txt`, `rv5b-api.log`, `pricing-probe.txt`,
`network-probe.txt`, `scale-evidence.json`, `checksums-before-report.txt`,
`sha256sum-before.txt`, `sha256sum-before-report.txt`، وسكربتات التشغيل
(`fresh-migrate.mjs`, `schema-audit.mjs`, `handlers-audit.mjs`, `i18n-audit.mjs`,
`break-probes.mjs`, `pricing-probe.mjs`, `network-probe.mjs`, `rv5b-run.mjs`,
`rv5b.attacks.test.mjs`, `jest.attacks.mjs`). قاعدتا الفحص `review_g05_3_fresh`
و`review_g05_3_probe` محفوظتان محلياً.

```bash
export PATH="/tmp/hotel-pnpm10/node_modules/.bin:$PATH"
pnpm dev:stop
pnpm check; pnpm test:identity; pnpm test:distribution; pnpm test:property
pnpm contracts:check; pnpm db:check
node .local/verification/review-g05-3/fresh-migrate.mjs review_g05_3_fresh
node .local/verification/review-g05-3/schema-audit.mjs review_g05_3_fresh .local/verification/review-g05-3/schema-audit-fresh.txt
node .local/verification/review-g05-3/handlers-audit.mjs
node .local/verification/review-g05-3/i18n-audit.mjs
node .local/verification/review-g05-3/pricing-probe.mjs
node --env-file=.env .local/verification/review-g05-3/break-probes.mjs review_g05_3_probe
node --env-file=.env .local/verification/review-g05-3/rv5b-run.mjs   # 44/44
pnpm dev   # ثم: pnpm visual:phase5 && pnpm visual:phase4 && pnpm visual:phase3 && pnpm visual:check
pnpm checksums && sha256sum -c CHECKSUMS.sha256   # 391/391 بعد إضافة هذا التقرير
```

## 12) بيان البصمات بعد إغلاق هذا التقرير

بعد تثبيت هذا الملف يُعاد `pnpm checksums` ثم `sha256sum -c`، وتُسجل المخرجات الخام في
`.local/verification/review-g05-3/checksums-after-report.txt` و`sha256sum-after-report.txt`.
