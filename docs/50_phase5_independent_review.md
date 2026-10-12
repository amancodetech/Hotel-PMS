# مراجعة مستقلة للمرحلة 5 (G-05) — تقرير

التاريخ: 14 سبتمبر 2026. المراجع: جلسة مستقلة جديدة (opencode / deepseek-flash) لم تستخدم سياق
جلسة المنفّذ ولم تعتمد نتائج [docs/48](48_phase5_adversarial_review.md).

الحكم: **PASS WITH FINDINGS** — التحقق الشامل والعدائي أُعيد بنجاح، لكن تبقى ثلاثة findings
متوسطة مفتوحة (ADV5-F1 مؤكد وADV5-R1 وADV5-R2 جديدان) وfindings منخفضة. **G-05 لا يُقبل**
بهذه الحالة، ويبقى `REVIEW_PENDING` حتى إصلاح المتوسطات وإعادة فحص عدائي على البرومبت نفسه.
قبول البوابة قرار المستخدم، وهذا التقرير توصية.

## بيان الاستقلال

- الجلسة بدأت بقراءة AGENTS.md وREADME وdocs/01 و17 و18 ثم بطاقات P05 وdocs/46 و48 والعقد
  `docs/contracts/phase5.openapi.json`. docs/48 قُرئ للسياق والنطاق فقط.
- لم تُعدّل أي مهاجرة مطبقة ولا كود تطبيق ولا بصمة ولا `dev DB`. كل ما أُضيف هو سكربتات
  تشغيلية وأدلة في `.local/verification/review-g05-2/` (لا تعديل في المستودع غير تقرير هذا
  الملف). لم أُنفّذ أي إصلاح؛ الإصلاحات مقترحة فقط.
- أوقفت `pnpm dev` قبل الأطقم وأعدته بعدها، ولم ألمس `review-g05` الخاص بالمنفّذ كدليل.

## البيئة المنفذة

Node 22.23.2، pnpm 10.34.5، PostgreSQL 17.11 (55432)، Redis (56379)، Keycloak (58080).
كل الأطقم نفذت على قواعد اختبار تُبنى من الصفر بـ`migration:up` ثم تُحذف، وبيانات اصطناعية
بادئة RV5-. لم تُطبع أي أسرار.

## 1) الفحص الشامل — إعادة إنتاج كل الأرقام من الصفر

| الادعاء (G-05/P05/docs/48) | المخرجات الخام المرصودة | الملف |
|---|---|---|
| `pnpm check` 79/79 | 79/79 في 10 حزم (بناء+contracts+typecheck+lint+format) | `check.txt` |
| `pnpm test:identity` 48/48 | 48/48 في 7 حزم | `identity.txt` |
| `pnpm test:distribution` 48/48 | 48/48 في 11 حزمة | `distribution.txt` |
| `pnpm test:property` 101/101 في 17 حزمة | 101/101 في 17 حزمة | `property.txt` |
| `pnpm visual:phase5` 19/19 | 19/19 (10 صور، `.local/verification/P05-06/report.json`) | `visual-phase5.txt` |
| `pnpm visual:phase4` 17/17 | 17/17 | `visual-phase4.txt` |
| `pnpm visual:phase3` 23/23 | 23/23 | `visual-phase3.txt` |
| `pnpm visual:check` 38/38 | 38/38 | `visual-check.txt` |
| 387 بصمة | 387 OK قبل التوليد وبعده (`sha_exit=0`) | `sha256sum.txt`, `checksums.txt` |
| `pnpm db:check` ناجح | اتصال ناجح | `db-check.txt` |
| `contracts:check` 21 عملية Phase 5 | 43/30/36/21 + الأنواع المولدة مطابقة | `contracts-check.txt` |
| المهاجرات تُعيد بناء المخطط من الصفر | `review_g05_2_fresh` بُنيت بـmigration:up من صفر | `fresh-migrate.mjs`, `schema-audit-fresh.txt` |
| PERF-01: 500 مورد = 90ms | القياس المستقل: **23ms** (تحت سقف 500ms) | `scale-evidence.json` |

الفرق الوحيد في الأرقام هو زمن PERF-01 (23ms مقابل 90ms) لصالح الادعاء، وهو قياس بيئي لا خطأ.

### المهاجرات والمخطط (fresh rebuild)

- 13 جدولاً جديداً (وليس 14 كما في docs/48 — finding ADV5-R7):
  rate_plan, rate_policy_version, nightly_price, price_quote, commitment, plan_allocation,
  inventory_block, inventory_block_resource, inventory_disruption, exposure,
  exposure_allocation, sale_restriction, exposure_preview.
- كلها `rls=true force=true` وسياسة `tenant_isolation` واحدة، وtrigger
  `prevent_tenant_id_change` (42 trigger تراكمياً)، و`btree_gist` مثبتة.
- قيدا الاستبعاد GiST موجودان و`convalidated=true`:
  `plan_allocation_no_overlap` (state=ACTIVE) و`exposure_allocation_no_overlap`
  (state=RESERVED). وFK المركب `exposure_connection_fk (connection_id, property_id,
  tenant_id)` موجود؛ وكذلك FK التركيب/المنتج للأسعار.
- المنح: `hotel_api` على `distribution_outbox_event` = INSERT,SELECT فقط (لا UPDATE/DELETE/
  TRUNCATE)؛ `hotel_worker` = SELECT على جداول المخزون؛ `rate_policy_version` و
  `exposure_preview` بلا UPDATE لـhotel_api. ملاحظة hardening: UPDATE غير مستخدم على
  price_quote/inventory_block_resource/inventory_disruption (ADV5-R8).
- الصلاحيات السبع الجديدة موجودة في الكتالوج؛ TENANT_OWNER/TENANT_ADMIN يملكانها كلها،
  AUDITOR اكتسب `reservation.read` فقط، MEMBER بلا جديد (تحقق مباشر من قاعدة القاعدة ومن
  `permissions.ts`). `rate.manage` و`maintenance.emergency` و`channel.sale.manage`
  `mfaRequired=true` واختبارات MFA أثبتت الفرض.

### العقد والمعالجات

- سكربت مستقل (`handlers-audit.mjs`) قارن العمليات الـ21 في العقد بمعالجات NestJS فعلياً:
  21/21 لها معالج مطابق في method/path، والصلاحية `x-permission` مطابقة، وعمليات التغيير
  كلها CSRF، ولا معالج Phase 5 خارج العقد. `contracts:check` يثبت الأنواع المولدة.
- DTO جميع المسارات الجديدة `.strict()`؛ الاختبارات (RV5-E02) أثبتت رفض الحقول الزائدة في
  كل عائلات الإدخال، وRV5-E04 أثبت أن الأخطاء تعيد فقط
  `{code,message,correlation_id,details}` بلا SQL/stack، وسجل `unhandled_error` لا يطبع
  إلا `error_name`/`error_code` (لا PII ولا أسرار؛ فحص `independent-api.log`: صفر مادة سرية).

### الواجهة وi18n

- صفحة rates بخمسة ألسنة، وحالات تحميل/فراغ/خطأ لكل لسان (`RatesInventoryPage.tsx`)،
  وPlaywright أثبت RTL عربية و390x844 بلا overflow وبلا أخطاء console/page.
- تطابق مفاتيح i18n: 525 في ar/id-ID/en-US بلا مفقود/زائد (`i18n-audit.json`).
- `ReasonChips` يترجم `reason.<CODE>` ويسقط إلى الكود عند غياب المفتاح. مفقودان:
  `reason.RESOURCE_UNAVAILABLE` و`reason.WITHDRAWAL_PENDING` في اللغات الثلاث (ADV5-R6).
- الشبكة: لا إخراج `secret_ref` في أي DTO؛ إدخاله فقط في نموذج الاتصال. لا أسرار في
  console أو الشبكة أثناء الفحص البصري.

## 2) الفحص العدائي المستقل — 45 اختباراً في `rv5.attacks.test.mjs`

كل هجوم أدناه أُعيد من الصفر على قاعدة وAPI مستقلين (`run-attacks.mjs`)، وكلها فشلت في
الوصول لهدفها (أو أثبتت السلوك fail-closed المتوقع) مع تسجيل خام في
`independent-attacks.txt` (45/45 passed). أبرز العائلات:

| العائلة | الهجمات | النتيجة |
|---|---|---|
| أسعار | صفر بلا free_policy (422 ZERO_PRICE_POLICY، ثم 200 بعد free_policy)؛ سالب؛ `1e2/+1/.5/1./NaN/Infinity/19 رقماً/فواصل>6` → 400 بلا كتابة؛ عملة/إشغال/خطة خارج النطاق؛ ذرية الدفعة (خلية فاسدة لا تكتب شيئاً)؛ ماضٍ/أفق 366؛ HALF_UP عند 0.005/-0.005؛ لقطة سياسة لا تتغير؛ كسور IDR 250000.555 → `FRACTION_NOT_SUPPORTED` بلا تقريب؛ NUL في name → 500 (ADV5-R4) | فشل/سلوك متوقع |
| التزام وتزامن | 100 Hold متزامن → 201 واحد وallocation نشط واحد؛ Hold+Block → فائز واحد؛ release ثم re-hold؛ فشل جزئي متعدد الموارد لا يترك أثراً؛ stale 412؛ F1 (انتهاء كسول يتراجع مع 412 والإصدار المعلن v+1 مقابل v؛ إعادة المحاولة بـv+1 تنجح)؛ انتهاء TTL عند now() مع سباق release/search؛ حجب مخطط 409 وحجب طارئ يحفظ الالتزام وDisruption OPEN؛ دور inventory.block وحده → 403 على الحجب المخطط (ADV5-R2)؛ OOO على مورد بحصة قائمة لا يحرر الحصة (ADV5-R10) | فشل/سلوك متوقع + findings |
| D-20 وحصص | نشران متزامنان لنفس المورد → 202 واحد + 412 PREVIEW_STALE (لا EXPOSURE_CONFLICT) وحجز واحد؛ سحب بلا دليل (PENDING/DEAD_LETTER/UNKNOWN) لا يحرر، وبعد ACK يحرر؛ حذف أدلة Outbox لا يحرر (RECONCILING ويبقى RESERVED — ADV5-R1)؛ نشرة PUBLISHING→UNKNOWN لا تُعالج لاحقاً (ADV5-R1)؛ نشر ثانٍ/معاينة منتهية 412؛ OPEN مع سحب معلّق effective_open=false بأسباب STOP_SELL/EXPOSURE_RESERVED/WITHDRAWAL_PENDING؛ WHOLE فعّال وPARTIAL يرفض بـCOMPOSITION_INCOMPLETE+MODE_SWITCH_REQUIRES_WITHDRAWAL؛ عدد أحداث Outbox = 2 للنشر ولا تكرار | فشل + findings |
| عزل وهوية | تبديل tenant على كل عائلة → 403 TENANT_CONTEXT_MISMATCH؛ مراجع خارج النطاق (منتج/خطة/اتصال/منشأة عميل آخر) → 422/404؛ member/auditor للقراءة فقط (auditor search 200 وrate-plans 403)؛ CSRF مفقود/Origin دخيل 403؛ MFA لا يُتجاوز بـx-approval-id على rate/maintenance/sale؛ جلسة owner-b على بيانات A 403؛ منحة PROPERTIES تضيق النطاق فعلاً وسحبها فوري | فشل |
| إدخال/إخراج | SQL/XSS/CSV/JSON مخزنة حرفياً بلا تنفيذ؛ حقن في مصفوفات المعرفات يرفض 400؛ strict DTO؛ 413 للجسم >16KB؛ Aخطاء بلا تسريب؛ NUL → 500 (ADV5-R4) | فشل + finding |
| DoS/أداء | 100 بحث متزامن → 200 متسقة؛ 100 Hold → ضمانة واحدة؛ ميزانية البحث = 1ms → UNDETERMINED بلا تغير إصدار؛ lock_timeout 2000 → 500 INTERNAL_ERROR بعد ~2013ms (ADV5-R3)؛ hotel_api لا يعدل/يحذف/يفرغ Outbox (42501) | فشل + findings |

### سبر كسر الثوابت (قاعدة سبر منفصلة `review_g05_2_probe`)

| الثابت | قبل الكسر | بعد الكسر | بعد الاستعادة | الدليل |
|---|---|---|---|---|
| RLS على commitment | 0 صف لعميل أجنبي | 1 صف (`break_detected=true`) | 0 و`rls=true/force=true` | `break-probes.txt` |
| GiST plan_allocation | إدراج متراكب 23P01 | قُبل (`break_detected=true`) | 23P01 | `break-probes.txt` |
| FK نطاق مركب | 23503 | قُبل بعد الإسقاط (`break_detected=true`) | 23503 | `break-probes.txt` |

## 3) الحكم على فحص المنفّذ `tests/property/adversarial-p05.pg.test.mjs`

راجعت المنطق وأعدت تشغيله ضمن 101/101. العائلات ADV5-01..16 **غير تافهة عموماً** وتقارن
الDB وليس الإنتاج بنفسه (مثال: ADV5-03 يقرأ `price_quote` من القاعدة؛ ADV5-07 يفحص الحالة
النهائية في القاعدة؛ AT-I02/10 يقارن مرجع brute-force مستقلاً). تحفظات على المنطق:

- ADV5-01 يستخدم `?? '250000'` فيسقط الادعاء إذا كانت القائمة فارغة بدل أن يفشل صراحة.
- ADV5-06 يقبل `INVALID_REQUEST` كسبب فشل الخاسر، وهو فضفاض.
- ADV5-09 يتوقع `[409,412]` فيخفف F4 بدل تثبيته، وADV5-12 يتوقع `[200,404]` فيوثّق F2 ضمناً.
- لا تغطية لـRECONCILING/UNKNOWN (أصل ADV5-R1)، ولا لدور بلا maintenance.emergency
  (أصل ADV5-R2)، ولا لانتهاء مهل الأقفال.

خلاصة: الفحص إضافة مفيدة لكنه ليس بديلاً عن هذه المراجعة، وfindings الأربعة المعلنة صحيحة
في الاتجاه مع اختلاف درجات موضح أدناه.

## 4) Findings (تأكيد/رفض/تعديل + جديدة)

| ID | الخطورة | الوصف | إعادة الإنتاج | الأثر | يفتح G-05/G-06؟ | إصلاح مقترح | الحالة |
|---|---|---|---|---|---|---|---|
| ADV5-F1 | **متوسط (مؤكد)** | انتهاء Hold الكسول داخل معاملة الكاتب يتراجع إذا فشلت المعاملة بعده؛ الخطأ يعلن `current=v+1` بينما القاعدة على v؛ سلاسل 412 زائفة | RV5-B05: `stateAfterFailure=ACTIVE`, `staleVersion=25`, `versionAfterFailure=25`, `errorCurrent=26`، وإعادة المحاولة بالإصدار المعلن تنجح (201) | التزام/إتاحة: إرباك عملاء و412 متكررة؛ لا فساد بيانات؛ قابلة للاسترداد بالعميل | لا يفتح (fail-closed) لكنه شرط قبول | تنفيذ الانتهاء قبل فحص النسخة في مسار مستقل مُعتمد (أو تسامح الفحص عند `expired>0`)، وإضافة regression يثبت ثبات الإصدار | مفتوح |
| ADV5-F2 | منخفض (مؤكد) | قوائم منشأة غير موجودة تعيد 200 فارغة بدل 404 (rate-plans/holds) | RV5-A10: `{"status":200,"items":0}` لكل منهما | اتساق واجهة فقط، لا تسريب | لا | التحقق من وجود المنشأة/النطاق في القراءات كما في الكتابات | مفتوح |
| ADV5-F3 | منخفض (مؤكد) | حد الجسم 16KB يرفض ~130 خلية بينما DTO يسمح 1000 بعمومية PAYLOAD_TOO_LARGE | RV5-E03: 200 خلية → 413 | تجربة عميل؛ لا كتابة جزئية | لا | مواءمة الحد/رسالة أوضح أو endpoint مجزأ موثق | مفتوح |
| ADV5-F4 | منخفض/وثائقي (مؤكد) | تنازع النشر الفعلي 412 `PREVIEW_STALE` لا 409 `EXPOSURE_CONFLICT`؛ وEXPOSURE_CONFLICT/EVIDENCE_REQUIRED/CAPABILITY_MISSING أكواد معرّفة لا تُرمى | RV5-C01: `[412,"PREVIEW_STALE",202]`؛ grep بلا مستخدمين | ثابت محفوظ fail-closed، فرق توثيقي | لا | تحديث G-05/P05-05 وحذف/توظيف الأكواد غير المستخدمة | موثق |
| ADV5-R1 | **متوسط (جديد)** | `reconcileConnection` لا يعالج حالتي RECONCILING/UNKNOWN: دليل ACK لاحق لا يفعّل ولا يحرر، والحصة تبقى RESERVED بلا مسار API للخروج | RV5-C02: بعد ACK → `{activated:0,released:0}` و`state=RECONCILING` وallocation RESERVED؛ RV5-C03 (لا أدلة → RECONCILING)؛ RV5-C07: بعد ACK → `finalState=UNKNOWN` | حصة قناة عالقة تمنع البيع المحلي حتى تدخل يدوي؛ لا overbooking | **نعم — يمنع القبول حتى الإصلاح** | إضافة معالجة RECONCILING/UNKNOWN في حلقة reconcile بنفس قواعد الدليل (accepted>0 وفشل/UNKNOWN=0) واختبار تراجع/دليل لاحق | مفتوح |
| ADV5-R2 | **متوسط (جديد)** | `createBlock` يفرض `maintenance.emergency` على الحجب المخطط أيضاً (authorize خارج الشرط ونداء timeouts مكرر) فيخالف P05-04 ويحرم أدواراً مخصصة من inventory.block | RV5-B09: دور active بصلاحية inventory.block وحدها → 403 PERMISSION_DENIED للحجب PLANNED؛ الكود block-service.ts:75-76 | تفويض/أقل صلاحية: وظيفة مقيّدة خطأً؛ fail-closed لا ثغرة صعود | **نعم** | نقل `authorize(maintenance.emergency)` داخل `if (mode==='EMERGENCY')` وإزالة النداء المكرر + regression بدور مخصص | مفتوح |
| ADV5-R3 | منخفض | انتهاء `lock_timeout=2000` يظهر 500 INTERNAL_ERROR بلا رمز آمن | RV5-F02: `{"lockWaitStatus":500,"elapsed":2012}`، وسجل `DriverException 55P03` | تشغيل/UX: 500 غامضة تحت التنافس | لا | تحويل 55P03/57014 إلى 409/503 برمز آمن وRetry-After | مفتوح |
| ADV5-R4 | منخفض | حرف NUL في نص حر (name/reason) يسبب DriverException 08P01/22021 → 500 | RV5-E05: `{"nulStatus":500}`؛ `independent-api.log` error_code 08P01 | متانة إدخال لا أكثر | لا | رفض محارف التحكم في `assertName` وreason/note بـ400 | مفتوح |
| ADV5-R5 | منخفض | أهلية FRACTIONAL_IDR تبحث `status='VERIFIED'` غير المسموح في قيد الجدول (DOCUMENTED/TESTED/UNSUPPORTED/UNKNOWN) → المسار ميت | RV5-A08: TESTED+AUTHORIZED لا يقبل؛ update إلى VERIFIED → 23514 | مسار مؤجل fail-closed؛ خطر كامن عند توثيق القدرة | لا (بند مؤجل) | مواءمة enum القدرة/الاعتماد مع بوابة الأهلية | مفتوح |
| ADV5-R6 | منخفض | نقص مفاتيح `reason.RESOURCE_UNAVAILABLE` و`reason.WITHDRAWAL_PENDING` في اللغات الثلاث فتظهر الأكواد الخام | `i18n-audit.json` | تجربة/توطين | لا | إضافة المفتاحين | مفتوح |
| ADV5-R7 | منخفض/وثائقي | docs/48 يقول 14 جدولاً جديداً والواقع 13؛ أكواد أخطاء غير قابلة للرمي | `schema-audit-fresh.txt` | دقة وثائق | لا | تصحيح الرقم وتنظيف الأكواد | مفتوح |
| ADV5-R8 | منخفض/تقوية | `hotel_api` يملك UPDATE على price_quote وinventory_block_resource وinventory_disruption بلا مسار كتابة | `schema-audit-fresh.txt` (grants) | سطح هجوم إضافي بلا استخدام | لا | سحب UPDATE غير المستخدم (سابقة ADV-F2) | مفتوح |
| ADV5-R9 | منخفض (سلامة تحقق) | حاضنة `startApi` قد تقبل API غريباً على 4100 إذا كان dev يعمل (سباق مع فحص خروج الطفل)؛ لوحظ توجيه الأطقم إلى dev DB | تشغيل `run-attacks.mjs` وdev قائم: 22 إخفاقاً على بيانات dev بلا خطأ حاضنة | سلامة أدلة لا منتج؛ ADV-F3 لم يُغلق كاملاً | لا (البروتوكول يوجب dev:stop) | فحص ملكية المنفذ قبل الإقلاع (PID/مقبس) لا الاعتماد على فشل الطفل اللاحق | مفتوح |
| ADV5-R10 | منخفض/تشغيلي | SetResourceMaintenance OOO على مورد بحصة RESERVED لا يلغي/يعلّق العرض ولا ينشئ Disruption | RV5-B08: `maintenanceStatus=200` وallocation `RESERVED` | خطر بيع قناة لغرفة OOO حتى سحب يدوي | لا | ربط الصيانة بمسار حجب/سحب معلن أو تحذير إلزامي | موثق كحد |
| ADV5-R11 | منخفض | حراس التاريخ يستخدمون `current_date`/UTC لا `property.timezone`؛ بين 17:00–24:00 UTC يقبل تاريخ ماضٍ في Asia/Jakarta | فحص A09 لم يُظهر فرقاً وقت التشغيل (التواريخ متساوية)؛ الاستنتاج من الكود | حدود يوم محلية؛ لا overbooking | لا | اشتقاق تاريخ العمل من توقيت المنشأة (D-17) | موثق كحد |

ملاحظات ليست findings: لا rate limiting على مسارات الأعمال (AuthRateLimitGuard على المصادقة
فقط) — شرط نشر معلن؛ `x-approval-id` لا يفتح شيئاً في Phase 5 (PublishExposure لا يفرض
اعتماداً خاصاً كما هو موثق)؛ تأجيل ConfirmReservation/P06 وSplitStay وP13 وقدرة
FRACTIONAL_IDR غير الموثقة لم يتسرب أي منها إلى سلوك مطبّق.

## 5) ما لم يُختبر / الحدود

- قناة حية أو مزود خارجي (P13)، عمال Outbox الفعليون (SENT/PARTIAL/DEAD_LETTER عبر
  dispatcher حقيقي)، ConfirmReservation وP06-04، SplitStay.
- انقطاع اتصال فعلي وسط `SetRates` (الذرية مثبتة بنيوياً برفض كلي واختبارات قاعدة، لا بقتل
  عملية أثناء الدفعة).
- انحراف ساعة فعلي بين API وDB (الاعتماد على `now()` داخل القاعدة مثبت؛ مهلة Hold مولدة
  بساعة Node — يبقى خطر انحراف موثقاً).
- حد المعدل، استنزاف pool تحت 100+ طلب خارج أطقم P05، تسريبات ذاكرة طويلة.
- timezone boundary لم يظهر فروقاً وقت التشغيل (A09).

## 6) أوامر إعادة التشغيل

```bash
export PATH="/tmp/hotel-pnpm10/node_modules/.bin:$PATH"
pnpm dev:stop                      # إلزامي قبل الأطقم (وإلا فقد تُخدم من dev، ADV5-R9)
pnpm check                         # 79/79
pnpm test:identity                 # 48/48
pnpm test:distribution             # 48/48
pnpm test:property                 # 101/101
pnpm contracts:check && pnpm db:check
node .local/verification/review-g05-2/fresh-migrate.mjs review_g05_2_fresh
node .local/verification/review-g05-2/schema-audit.mjs review_g05_2_fresh .local/verification/review-g05-2/schema-audit-fresh.txt
node .local/verification/review-g05-2/handlers-audit.mjs
node .local/verification/review-g05-2/i18n-audit.mjs
node .local/verification/review-g05-2/break-probes.mjs review_g05_2_probe
node --env-file=.env .local/verification/review-g05-2/run-attacks.mjs   # 45/45
pnpm dev                           # لإعادة الواجهة ثم:
pnpm visual:phase5 && pnpm visual:phase4 && pnpm visual:phase3 && pnpm visual:check
sha256sum -c CHECKSUMS.sha256 && pnpm checksums && sha256sum -c CHECKSUMS.sha256
```

## 7) الأدلة

كل المخرجات الخام في `.local/verification/review-g05-2/`: `check.txt`, `identity.txt`,
`distribution.txt`, `property.txt`, `visual-phase5/4/3.txt`, `visual-check.txt`,
`contracts-check.txt`, `db-check.txt`, `checksums.txt`, `sha256sum*.txt`,
`schema-audit-fresh.txt`, `handlers-audit.json`, `i18n-audit.json`, `break-probes.txt`,
`independent-attacks.txt`, `independent-api.log`، وسكربتات التشغيل
(`fresh-migrate.mjs`, `schema-audit.mjs`, `handlers-audit.mjs`, `i18n-audit.mjs`,
`break-probes.mjs`, `run-attacks.mjs`, `rv5.attacks.test.mjs`). قاعدتا الفحص
`review_g05_2_fresh` و`review_g05_2_probe` محفوظتان محلياً.

## 8) الحكم النهائي

**PASS WITH FINDINGS.** أُثبت أن: الضمان بPostgreSQL فعلي (RLS/GiST/FK تُكسر بالتعطيل
وتعود)، لا overbooking داخلي تحت 100 طلب، الحصة لا تُحرر بلا دليل، الأسعار لا تقرّب صامتة،
MFA/العزل/CSRF/المدخلات الصارمة تعمل، وكل الأرقام المعلنة قابلة لإعادة الإنتاج. لكن
**G-05 لا يُقبل الآن**: ADV5-F1 متوسط مؤكد، وADV5-R1 وADV5-R2 متوسطان جديدان، مع findings
منخفضة. المطلوب قبل إعادة الفحص: إصلاح المتوسطات الثلاثة (يفضل مع المنخفضة العملية
R3/R4/R6) وتحديث docs/48 بالأرقام الصحيحة، ثم إعادة تشغيل هذا البرومبت على نفس الحزمة.
تنفيذ P06 يبقى محجوباً حتى حكم PASS بلا findings مفتوحة، والقبول النهائي قرار المستخدم.

## تصحيح لاحق (14 سبتمبر 2026) — ADV5-R12

أرقام البصمات وi18n في هذا التقرير كانت صحيحة لحظة كتابته (قبل جلسة الإصلاح). الواقع الآن
بعد [docs/51](51_phase5_findings_fixes.md) و[docs/52](52_phase5_independent_review_2.md):
عدد مدخلات `CHECKSUMS.sha256` صار **391** (390 + تقرير الجولة الثانية) وكلها OK، وعدد مفاتيح
i18n صار **524** (‎+2‎ مفتاحا reason من FIX-R6 و‎-3‎ أكواد أخطاء ميتة من FIX-R7). التفاصيل في
ADV5-R12 بتقرير الجولة الثانية.
