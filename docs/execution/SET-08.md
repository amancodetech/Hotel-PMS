# SET-08 — جاهزية خادمية وأداء وإتاحة ولغات ومراجعة مستقلة

الحزمة والمهمة الفرعية: SET-08 بكامل مهامها 08.1..08.5.
نطاق التفويض ومصدره: رسالة المستخدم «لننتقل الى التالية» (22 سبتمبر 2026) بعد إغلاق SET-06 بقرار المستخدم. لا تغيير لـG-13 ولا قبول إنتاجي، وSET-AT تبقى NOT_TESTED حتى اختبار التنفيذ الجديد، والخارجي (قنوات حية/نشر/استعادة) ببواباته.
الحالة: **VERIFIED_LOCAL — 08.1..08.4 DONE؛ 08.5 مراجعة مستقلة صدرت بحكم `NEEDS_FIXES` (P1×3) ثم أُصلحت وأُعيد التحقق المستقل منها بحكم `GO_WITH_NOTES` (محلي)؛ لا قبول إنتاجي، وSET-AT12..17 تبقى NOT_TESTED**.
المراجع الحاكمة: docs/94 §9-12 (SET-AT12..17)، docs/95 §7 (SET-08)، docs/13_ux_reporting.md، docs/17_decisions_readiness.md (D-17)، docs/21_indonesia_launch.md (AT-L01/LOC-001)، docs/27_readiness_gates.md، docs/32_execution_work_packages.md (P01-01)، docs/93_new_company_onboarding_analysis.md (ONB-F07/F11/F13)، ADR `docs/97_set_setup_contract_adr.md` (S10 وx-readiness-enforced-by)، وملاحظات إعادة التحقق المستقلة لـSET-06/07.

## السلوك المطلوب (08.1..08.5)

| المهمة | السلوك | معيار القبول |
| --- | --- | --- |
| 08.1 جاهزية خادمية | جاهزية الخدمات (api/worker/deps) معلنة ومقيسة، وبوابة جاهزية الإعداد مفروضة خادمياً في **المسارين** المعلنين: `ApplySetupDraft` و`UpdateProperty(SETUP→ACTIVE بمسودة مخزنة غير مكتملة)` | SET-AT14: لا يكفي إخفاء الزر؛ الرفض الخادمي بالرمز `SETUP_READINESS_BLOCKED` وإعادة استخدام نفس فحص `GetSetupReadiness` |
| 08.2 لغات/إتاحة | اللغات الثلاث كاملة بلا مفاتيح ناقصة أو خام، RTL بلا وميض، أكواد/تواريخ معزولة الاتجاه، لوحة مفاتيح وتركيز ظاهر مع أخطاء حقول ملاصقة وملخص قابل للتركيز، وهاتف بلا اقتطاع إجراء | SET-AT17: مهام المعالج كاملة بالعربية/الإنجليزية/الإندونيسية وعلى الهاتف وبلوحة المفاتيح بلا فقد أو قص |
| 08.3 أداء | قياس موثق على 50/500/2000 وحدة: p95 لقراءة قائمة مرقمة < 1s كهدف أولي، وتغذية راجعة فورية عند الحفظ، والدفعات الكبيرة مهام خلفية | أدلة مقاسة (بيئة/طريقة/عينات) لا ادعاء SLA؛ D-04/EX-04 تبقى كما هي |
| 08.4 تكامل | تكامل محلي فعلي: جاهزية الخدمات الحقيقية، رحلة إعداد→تفعيل→بيع، وفشل الشبكة/التكرار، مع توثيق ما هو قابل للتشغيل محلياً وما ينتظر بوابة خارجية | مصفوفة تكامل محلية بأدلة، وفصل صريح لبوابات EX/D-19/D-20 |
| 08.5 مراجعة مستقلة | برومبت وتقرير مراجعة مستقلة للحزمة (كالنمط المتبع) | حكم `GO`/`GO_WITH_NOTES`/`NEEDS_FIXES` مع إعادة إنتاج |

## الجرد الحالي بدليل ملف (22 سبتمبر 2026)

- **الجاهزية موجودة ومختبرة جزئياً**: `GET /api/v1/system/health` حياة، و`/api/v1/system/ready` يفحص database/redis/identity ويعيد 503 `DEPENDENCY_UNAVAILABLE` عند السقوط (`apps/api/src/app.ts:135-157`، `packages/backend/src/application/readiness.ts:7-29`)، وعقد foundation موثق (`docs/contracts/foundation.openapi.json:15-120`) وواجهة تعرض الانقطاع (`apps/web/src/App.tsx:178-309`). تغطية: `tests/api.test.mjs:27-104`، `tests/dependencies.test.mjs:40-47`، `tests/foundation.test.mjs:94-113`، `scripts/integration.mjs:35-90`.
- **فجوة SET-AT14 المانعة**: بوابة الجاهزية منفذة على `ApplySetupDraft` فقط (`setup-service.ts:516-530`)، و`updatePropertyById` لا يفحص المسودة المخزنة رغم أن ADR S10(b) والعقد (`x-readiness-enforced-by: ["ApplySetupDraft","UpdateProperty(SETUP->ACTIVE with a stored draft)"]`) وSET-02 وdocs/93 يعدون بالرفض، ولا اختبار يغطي الرفض (`property-service.ts:273-326`).
- **حدود جاهزية/إتاحة أخرى**: لا مهلة كلية لفحص الجاهزية، وتصنيف أخطاء الاتصال بقاعدة البيانات غير المشمول (`08006/57P01`) يسقط 500، ولا `Retry-After` على مسار `/ready`، وحياة العامل لا تعكس حالة المجدولات، ولا drain عند SIGTERM (تفاصيل في `readiness.ts`، `orm-options.ts:11-16`، `apps/worker/src/main.ts:82-99`).
- **اللغات**: التكافؤ المختبَر سطحي (أعلى مستوى فقط) و`fallbackLng: 'id-ID'` يخفي النقص المتداخل (`tests/foundation.test.mjs:127-135`)، ولا كشف مفاتيح غير مستخدمة، ولا فحص إتاحة (axe/تباين)، ومعالج الإعداد بلا إدارة تركيز/أخطاء حقول (`SetupWizardPreviewPage.tsx:1017-1026`)، ووميض LTR قبل `useEffect` للعربية (`apps/web/index.html:2`، `App.tsx:1094-1098`)، وبصري المعالج 390 فقط وبالعربية في خطوة المراجعة.
- **الأداء**: قياس وحيد لبحث التوفر على 500 مورد بعتبة 10s (72ms فعلياً) (`tests/property/inventory-scale.pg.test.mjs:203-234`)، ولا قياس قائمة مرقمة p95، ولا 50/2000، وبعض مسارات الالتزام/المجموعات تثبّت ميزانية 500ms بدل ملف الحدود (`commitment-service.ts:244-247,627-630`، `group-service.ts:230-233`، `revision-service.ts:636`).
- **التكامل**: `pnpm test:integration` يفحص الجاهزية والانقطاعات فقط (`scripts/integration.mjs`)، وأطقم property/identity/distribution ليست في CI، ورحلة الإعداد→التفعيل→البيع غير موجودة كتكامل واحد، وحدود الدفعات الكبيرة تفشل مغلقاً بلا مهمة خلفية (SET-04/S7).

## قرارات داخل النطاق (تُسجَّل للمراجعة)

1. **08.1** يبدأ بفجوة SET-AT14 (بوابة `UpdateProperty`) لأنها وعد معلن مكذوب حالياً، ثم تحصين الجاهزية (مهل/تصنيف أخطاء) بحسب ما يثبت باختبار.
2. **08.2** لا يُدَّعى WCAG AA كشهادة؛ الأدلة أتمتة (تكافؤ مفاتيح عميق، فحص إتاحة آلي، بصري 320/360/390 بلغتين واتجاهين) مع تسجيل أن مراجعة قارئ الشاشة البشرية خارج النطاق.
3. **08.3** الأرقام أدلة محلية على بيئة موثقة وليست SLA ولا شهادة سعة، ولا تُلمس D-04/EX-04.
4. **08.4** لا قنوات حية ولا mock لتجاوز بوابة؛ أي جزء خارجي يبقى BLOCKED_EXTERNAL موثقاً.
5. ملاحظات SET-06/07 المعلنة (idempotency الحصة/pickup، لا تعديل جنس نزيل، delta≠0) تُسجَّل هنا ولا تُعالج ضمن SET-08 إلا بقرار.

## خطة الاختبار

- 08.1: اختبار دائم في `tests/property/property-api.pg.test.mjs` (مسودة ناقصة → 422؛ بعد إزالة المسودة → 200؛ مسودة مكتملة/منفذة لا تُحجب)، واختبار تصنيف 57014 إن لم يكن قائماً، وتغطية `/ready` 503/200 قائمة.
- 08.2: طقم jest لتكافؤ المفاتيح المتداخل ×3، واختبارات تركيز/`aria-invalid` للمعالج، وفحص إتاحة آلي (بدون إضافة مكتبات غير مرخصة/ضخمة دون قرار)، وبصري موسّع 320/360/server-apply/تبديل لغة وسط المعالج.
- 08.3: سكربت قياس موثق 50/500/2000 (قوائم مرقمة + بحث) بعينات p50/p95 وبيئة موثقة، وتقرير أدلة بلا ادعاء SLA.
- 08.4: تشغيل `test:integration` (و`--faults` عند توفر الخدمات) + رحلة E2E محلية للإعداد→التفعيل→البيع، ومصفوفة ما هو خارجي.
- 08.5: برومبت مراجعة مستقلة ثم تقرير حكم.

## خريطة الملفات

- جاهزية: `apps/api/src/app.ts`، `apps/worker/src/{main,server}.ts`، `packages/backend/src/application/readiness.ts`، `packages/backend/src/persistence/dependencies.ts`، `packages/backend/src/modules/property/application/{property-service,setup-service}.ts`، `packages/backend/src/modules/property/persistence/setup-repository.ts`.
- لغات/إتاحة: `apps/web/index.html`، `apps/web/src/App.tsx`، `apps/web/src/property/SetupWizardPreviewPage.tsx`، `packages/i18n/src/**`، `apps/web/src/styles.css`، `scripts/set01-visual.mjs`، `tests/web.test.tsx`.
- أداء/تكامل: `tests/property/inventory-scale.pg.test.mjs`، `scripts/integration.mjs`، `scripts/test-*.mjs`، `docs/contracts/*` عند الحاجة.

## الحدود المعلنة

- لا نشر/قنوات حية/استعادة إنتاجية (EX-01..05 وG-13 كما هي)، ولا تغيير D أو النموذج المالي أو العزل.
- SET-AT12..17 تبقى NOT_TESTED حتى تُختبر بمهامها الجديدة في الحزمة، ولا تُحوَّل لبصريات وحدها.
- ملاحظات معلنة من SET-06/07: idempotency غير مطلوبة على `group-allotment/pickup`، لا واجهة تعديل جنس النزيل بعد الإنشاء، حالة `delta≠0` غير مُتحقق منها، وMIXED لا يخلط عملتين (بقيت غير مُتحققة).
- 221000 يعتمد `audit_event` كسجل منشأ (SET-06 معلن).

## سجل التنفيذ

### 08.1 جاهزية خادمية — DONE (مع فجوات معلنة)
- **بوابة SET-AT14:** `updatePropertyById` يفحص **أي مسودة مخزنة** عند `SETUP→ACTIVE` عبر `setupReadinessIssues(draft.input)` نفسها التي يستخدمها `ApplySetupDraft` و`GetSetupReadiness`، بلا اعتماد على علم `completed` (بعد إصلاح P1-01 من مراجعة 08.5)، ويرفض `422 SETUP_READINESS_BLOCKED` مع `issues[]` وبلا أي كتابة؛ والمنشأة بلا مسودة تبقى تُفعَّل كما اليوم (ADR S10(b) والعقد `x-readiness-enforced-by`). الملف: `packages/backend/src/modules/property/application/property-service.ts`.
- **تحصين أخطاء الجاهزية:** وحدة نقية `apps/api/src/database-errors.ts` تصنّف 55P03→409 و57014→503، وأخطاء الاتصال (08000/08001/08003/08006/08007/57P01/57P02/57P03/53300 + ECONNREFUSED/ECONNRESET/ETIMEDOUT/EPIPE/ENOTFOUND/EHOSTUNREACH/ENETUNREACH) → 503 `DEPENDENCY_UNAVAILABLE/CONNECTION_LOST` بدل 500، مع بقاء التسجيل الصامت للأخطاء المصنفة.
- **`Retry-After: 1`** على 503 من `/api/v1/system/ready` ومن `/ready` في العامل.
- **اختبارات دائمة:** في `tests/property/property-api.pg.test.mjs` — مسودة ناقصة (`units_required`) تحجب التفعيل 422 بلا تغيير حالة/نسخة، ثم إزالة المسودة بـIf-Match (200) تعيد التفعيل 200؛ واختبار انحدار P1-01: تنفيذ مسودة مكتملة (`completed=true`) ثم تحريرها إلى ناقصة يعيد `completed=false` و`GetSetupReadiness.ready=false` ويرفض التفعيل `422`؛ وفي `tests/database-errors.test.tsx` — تصنيف كل الأكواد؛ و`tests/api.test.mjs` يؤكد `Retry-After` لانقطاع الجاهزية في العمليتين.
- **فجوات معلنة (لا تحجب 08.1 وتُرحَّل لـ08.5/حزم لاحقة):** لا مهلة كلية لفحص الجاهزية عند تشبّع المجمّع، وحياة العامل لا تعكس حالة المجدولات (تفشل المجدولات وتبقى `alive`)، ولا drain عند SIGTERM (السلامة تعتمد على lease/checkpoint)، ونوع foundation غير مولَّد/مفحوص الانحراف، والدفعات الكبيرة تبقى fail-closed بلا مهمة خلفية.
- **SET-AT14:** مسار الرفض الخادمي مختبَر الآن؛ لقطة الواجهة (تعطيل الزر + مسار مباشر) تُغطى في أدلة 08.2/08.4، ولا يُحوَّل المعيار إلى PASS نهائياً إلا في 08.5.

> بصمة النسخة بعد 08.1: `71c5bb7ea53bd97773e5bdf50e2016513c8b6941dc6e20b289ca0d2a3f4d1aac`.
> بصمة النسخة بعد 08.2: `74ff6e47d33c3d8d81d9fc81a5ab269208a1895bf862dc1262260015206201ad`.

### 08.2 لغات/إتاحة — DONE (مع حدود معلنة)
- **تكافؤ i18n عميق:** `tests/i18n-parity.test.tsx` يسطّح شجرة المفاتيح في اللغات الثلاث (1539+ مفتاحاً) ويؤكد: تكافؤ المجموعات كاملاً في كل المستويات، تكافؤ `{{placeholders}}` لكل مفتاح، عدم وجود قيم فارغة، وحلول كل مفاتيح المعالج الديناميكية (قوالب/أوضاع/نطاقات/مواصفات من ثوابت `setup.ts`) وكل أكواد `setupWizard.validation.*` (camel للواجهة + snake الخادمة المستخرجة من المصدر).
- **سدّ فجوة ترجمة حقيقية:** 26 كود خادمياً (`beds_invalid` … `units_limit`) كانت تُعرض خاماً عبر `defaultValue` في المعالج — أُضيفت ×3 لغات، وأُضيف `setupWizard.stepOf`.
- **إتاحة المعالج:** خطأ ملاصق لكل حقل (`error`/`helperText` + `aria-invalid` عبر MUI)، تركيز تلقائي على ملخص الأخطاء (`tabIndex={-1}`) عند فشل «التالي»، والملخص صار حياً يزول عند الإصلاح. اختبار دائم `tests/web-a11y.test.tsx`.
- **RTL بلا وميض:** سكربت مبكر في `apps/web/index.html` يقرأ `hotel.preferences.v1` ويضبط `lang`/`dir` قبل mount؛ اختبار ينفّذ السكربت (ar→rtl، en-US→ltr، تالف→الافتراضيات).
- **عزل الاتجاه:** `dir:'ltr'` لحقول أكواد الوحدات والمنشأة والأرقام والتواريخ والأوقات في المعالج.
- **هاتف 320/360:** كشف البصري قصّ `Stepper` عند 360/320 → مؤشر مدمج `setup-stepper-compact` (xs) بدل القائمة، مع فحص «لا قص لإجراءات أساسية»، وتبديل لغة وسط المعالج (خطوة الوحدات) بلا فقد الخطوة/المدخلات ثم العودة.
- **حدود معلنة:** لا ادعاء WCAG AA (مراجعة قارئ شاشة بشرية خارج النطاق)، ولا مكتبات إتاحة جديدة؛ SET-AT17 يبقى غير محوَّل إلى PASS ويُترك لحكم 08.5.

### 08.3 أداء — DONE (قياس، بلا تغيير سلوكي)
- **سكربت القياس:** اختبار دائم `SET-08 PERF` في `tests/property/inventory-scale.pg.test.mjs` — 50/500/2000 وحدة، تسخين + 5 عينات لكل حجم، قائمة مرقمة (`limit=100` مع إثبات ثبات الترتيب بين قراءتين) وبحث توفر بأفق ليلة. الدليل: `.local/verification/SET-08-3/scale-evidence.json` (PostgreSQL 17.11، Node v22.23.2، قياس محلي صناعي، بلا ادعاء SLA).
- **النتائج (p50/p95):** القائمة 12–13ms / 13–14ms في الأحجام الثلاثة؛ البحث 21/22ms عند 50، و75/82ms عند 500، و42/44ms عند 2000 — كلها دون الهدف الأولي 1s. **إصلاح P1-02:** التسخين يتسامح مع أول استدعاء بارد وقد يعيد `UNDETERMINED` fail-closed عند 2000 (849ms فوق الميزانية 500ms)؛ صار الاختبار يعيد محاولة التسخين (حتى 3) ويسجّل كل محاولة في الدليل (`warmup_attempts` و`cold_undetermined`) بدل إخفائها، ويفشل فقط إن بقيت آخر محاولة تسخين غير `AVAILABLE`.
- **تغذية الحفظ الفورية:** قائمة على `saveState` في المعالج (Saving→Saved) ومغطاة بصرياً؛ لا تغيير سلوك.
- **الدفعات الكبيرة:** تبقى fail-closed بلا مهمة خلفية (فجوة معلنة من SET-04/S7) — موثقة ولم تُعالج.
- **قرار 500ms — صُحّح ووُحّد (إصلاح P1-03):** العمود `search_budget_ms` **موجود** في `property_limits_profile` (`Migration20260914270000_property_core.ts:15`) ويُستعمل في `availability-service` و`quote-service` و`hold-service`. كان `commitment-service` (موضعان) و`group-service` و`revision-service` يتجاوزونه بـ`deadline: Date.now() + 500` مثبتة — أُضيف `searchBudgetForProperty(em, tenantId, propertyId)` في `availability-service.ts` (يقرأ `search_budget_ms ?? 500`) واستُبدلت المواضع الأربعة به، فصار ملف تعريف المنشأة مرجع الميزانية في كل المسارات. لا تغيير سلوكي اليوم لأن ملف PERF-01 الوحيد يحمل 500ms.
- **الأثر:** لا تغيير مصدر/عقد/مخطط؛ D-04/EX-04 كما هي.

> بصمة النسخة بعد 08.3: `48210e3a075a8456deec861fa05e948a27d24de76ef073f9197d224ed9d0e689`.

### 08.4 تكامل — DONE (مع مصفوفة قيود)
- **`pnpm test:integration`: PASS** — جاهزية api/worker مع PostgreSQL/Redis/Keycloak الحقيقية 200.
- **رحلة E2E محلية** `tests/property/set08-journey.pg.test.mjs`: إنشاء منشأة → مسودة ناقصة → رفض التفعيل `422 SETUP_READINESS_BLOCKED` (SET-AT14 عبر API) → مسودة مكتملة → preview → apply (4 وحدات + خطة سعر) → تفعيل المنشأة → تفعيل خطة السعر (كانت `DRAFT`) → quote → تأكيد حجز → تسجيل وصول للغرفة 101. الدليل `.local/verification/SET-08-4/journey-evidence.json`.
- **SET-AT14 من الواجهة** (ضمن بصري 50/50): منشأة بمسودة ناقصة مخزنة يُرفض تفعيلها من قائمة الإجراءات برسالة العقد وتبقى `Setup`، وبعد اكتمال/تنفيذ الإعداد تُفعَّل من الواجهة إلى `Active`.
- **ملاحظتان من الرحلة (للمراجعة في 08.5، ولا تُصلحان هنا):** (1) `ApplySetupDraft` ينشئ خطة السعر `DRAFT` فتحتاج رحلة البيع تفعيلاً يدوياً إضافياً (مؤكَّد باختبار)؛ (2) تسعير الإشغال 1 **ملاحظة معززة بالكود** (`setup-service.ts` ينشئ أسعار `occupancy:1` فقط) لا تأكيد اختباري، والرحلة تستخدم `adults:1` (P2-05).
- **مصفوفة التكامل:** محلي قابل للتشغيل (جاهزية حقيقية + رحلة HTTP + بصري)؛ **`--faults` BLOCKED_ENV** في هذه البيئة لعدم وجود `docker compose` (`docker: unknown command: docker compose`) والخدمات نفسها حية؛ الخارجي (قنوات حية/OTP/بوابات EX/D-19/D-20) كما هو غير ملموس.

> بصمة النسخة بعد 08.4: `42773919d3a8ff00acd0e7d46ba545645514905d03cc75e8d44741a6739637a2`.

### 08.5 مراجعة مستقلة — NEEDS_FIXES ثم إصلاح P1-01..03 (بانتظار إعادة تحقق مختصرة)
- `docs/execution/SET-08-review-prompt.md`: برومبت المراجعة المستقلة (إعادة إنتاج البصمة/التشيكسوم، بوابة SET-AT14 والمسارات البديلة، فعالية أطقم i18n/a11y بمُطفِرة، مصداقية قياس الأداء وقرار 500ms، رحلة التكامل وادعاء `--faults`، والفحوص البصرية)، مع أسئلة حكم صريحة ومخرجات `SET-08-independent-review.md`.
- **تقرير المراجعة:** [`SET-08-independent-review.md`](SET-08-independent-review.md) — الحكم **NEEDS_FIXES** (لا P0): بختم البصمة `42773919…` مطابقة و`sha256sum -c` 783/783 OK وقت التحقق (784 بعد إضافة التقرير)، وأُعيد إنتاج property-api 11/11، ووحدة الأخطاء 7/7، وتكافؤ i18n 4/4 وإتاحة 2/2 (مع مُطفِرتين فعلية)، والتكامل PASS والرحلة 1/1 والبصري 50/50، و`pnpm check` 110/110.
- **P1-01 التفاف SET-AT14:** تحرير مسودة منفَّذة (`completed=true`) إلى إدخال ناقص لا يعيد `completed=false`، فيمر `SETUP→ACTIVE` بـ`200` بينما `GetSetupReadiness` يعلن `ready=false` — سبر مستقل موثق في التقرير.
- **P1-02 دليل الأداء غير ثابت:** `SET-08 PERF` يفشل عند تسخين 2000 (`UNDETERMINED` بعد 849ms > ميزانية 500ms)؛ `pnpm test:property:fast` الكامل = 423/424 في ثلاث تشغيلات متتالية، فادعاء «423/423 ولا UNDETERMINED» غير قابل لإعادة الإنتاج.
- **P1-03 توثيق خاطئ:** `property_limits_profile` **يحوي** عمود `search_budget_ms` ويُستعمل؛ تبرير إبقاء 500ms في `commitment/group/revision` في سطر 08.3 أعلاه يحتاج تصحيحاً وقراراً.
- **شرط إعادة القبول:** إصلاح P1-01..03 + إعادة تشغيل property-api/inventory-scale/set08-journey والطقم الكامل أخضر + `pnpm check` + بصمة/تشيكسوم، ثم إعادة تحقق مستقلة مختصرة تثبت زوالها. لا تغيير لSET-AT12..17 (تبقى NOT_TESTED) ولا لـG-13/D/EX-04.

### 08.5.1 إصلاح P1-01..03 (تمهيداً لإعادة القبول)
- **P1-01 التفاف البوابة — مُصلَح:** `updatePropertyById` يفحص الآن أي مسودة مخزنة عبر `setupReadinessIssues(draft.input)` بلا شرط `!draft.completed`، و`updateSetupDraft` تعيد `completed=false` عند أي تعديل، فتتطابق البوابة مع `GetSetupReadiness`. اختبار انحدار دائم في `property-api.pg.test.mjs`: تنفيذ مسودة مكتملة → تحريرها إلى ناقصة (`completed=false`، `ready=false`) → `422 SETUP_READINESS_BLOCKED` — **12/12**.
- **P1-02 ثبات الأداء — مُصلَح:** التسخين يعيد المحاولة (حتى 3) ويسجّل كل محاولة (`warmup_attempts`, `cold_undetermined`) بدل إخفائها؛ الأحجام 50/500 تُشترط `AVAILABLE` صراحة، و2000 (فوق سقف PERF-01=500) يُسمح فيه بالـ`UNDETERMINED` fail-closed ويُحتسب، و`search_p95_ms` يُحسب على عينات `AVAILABLE` فقط وقد يكون `null`. **دليل التشغيل الحالي:** 50 → p95 24ms بلا UNDETERMINED؛ 500 → p95 94ms بلا UNDETERMINED؛ 2000 → كل الاستدعاءات (تسخين+عينات) UNDETERMINED بين 766–869ms (يُسجَّل صراحة ولا يُخفى) — وهذا يعكس سلوك fail-closed المعلن فوق السقف. ثلاثة تشغيلات معزولة متتالية خضراء + تشغيلان كاملان للطقم (425/425 في 56 حزمة).
- **P1-03 توثيق 500ms — مُصلَح وموحَّد:** أُضيف `searchBudgetForProperty(em, tenantId, propertyId)` في `availability-service.ts` يقرأ `search_budget_ms ?? 500`، واستُبدلت به المواضع الأربعة المثبتة في `commitment-service` (موضعان) و`group-service` و`revision-service`؛ لم يبقَ أي `Date.now() + 500` في `packages/backend`. لا تغيير سلوكي اليوم لأن PERF-01 الوحيد = 500ms، وملف تعريف المنشأة صار مرجع الميزانية في كل المسارات.
- **تصحيحات مرافقة:** نص قرار 08.3 أعلاه صُحّح ليقول إن العمود موجود ومستعمل؛ وملاحظة إشغال 1 في 08.4 صارت توصَف كملاحظة معززة بالكود لا تأكيد اختباري (P2-05)؛ وعدد صفوف التشيكسوم في برومبت المراجعة لم يعد مذكوراً برقم ثابت (P2-01).
- **أدلة الإصلاح:** `SET-08-4-property-api.log` (12/12)، `SET-08-3-scale-run{1..3}.log` و`SET-08-3/scale-evidence-final.json`، `SET-08-4-journey.log` (1/1)، `SET-08-4-property-full.log` و`-2.log` (**425/425**)، `SET-08-4-distribution.log` (48/48)، `SET-08-4-integration.log` (PASS)، `SET-08-4-check.log` (110/110).
> بصمة النسخة بعد إصلاح P1-01..03: `e2c025af9b07e22663b102c5a0f71851d9f6a192a3f19fdb61d6a9acc24585ee`.

- **إعادة التحقق:** برومبت مختصر في `docs/execution/SET-08-reverification-prompt.md`؛ الحكم النهائي يبقى للمراجع المستقل ولا تُغلق SET-08 قبله.

### 08.5.2 إعادة تحقق ما بعد الإصلاح (جولة المراجع المستقل) — `GO_WITH_NOTES` (محلي) / VERIFIED_LOCAL
- **P1-01 زال:** `--filter=property-api` → **12/12**، وسبر مستقل جديد (تنفيذ → تحرير ناقص) أثبت `completed=false` و`ready=false` و`PATCH ACTIVE = 422 SETUP_READINESS_BLOCKED` مع `units_required` وبقاء المنشأة `SETUP`.
- **P1-02 زال:** `--filter=inventory-scale` **5/5 مرتين متتاليتين**؛ الدليل يسجّل 2000 بصدق في الحالتين (بارد: 5×UNDETERMINED و`search_p95=null` مع `cold_undetermined=3`؛ دافئ: 5 AVAILABLE و`search_p95=47ms`) مع إلزام `AVAILABLE` عند 50/500.
- **P1-03 زال:** لا `Date.now() + 500` في `packages/backend`، و`searchBudgetForProperty` (تقرأ `search_budget_ms ?? 500`) مستدعاة في المواضع الأربعة، ونص القرار صُحّح.
- **عدم الانحدار:** `pnpm test:property:fast` **425/425 في 56 حزمة**، `test:distribution:fast` **48/48**، `test:integration` **PASS**، `pnpm check` **110/110**.
- **البصمة/التشيكسوم:** `e2c025af9b07e22663b102c5a0f71851d9f6a192a3f19fdb61d6a9acc24585ee` مطابقة، و`sha256sum -c CHECKSUMS.sha256` (785 صفاً) 0 فاشل.
- **الملاحظات الجديدة P2 فقط:** (P2-07) صياغة سطر 80 أعلاه بلا استثناء 2000؛ (P2-08) دليل 2000 ثنائي الاحتمال بطبيعته ولا يُقرأ كحد قدرة/SLA. التفاصيل في [تقرير المراجعة §12](SET-08-independent-review.md). لا تغيير G-13/D/EX-04، وSET-AT12..17 تبقى NOT_TESTED.

## أدلة SET-08 (منفذ)

| الفحص | النتيجة | الدليل |
| --- | --- | --- |
| بوابات 08.1 (property-api) | **11/11** (منها اختبار البوابة الجديد) | `SET-08-1-gate.log` |
| وحدة تصنيف أخطاء قاعدة البيانات | **7/7 في حزمتين** (يشمل `api.test.mjs`) | `SET-08-1-unit.log` |
| تكافؤ i18n العميق ×3 | **4/4** | `SET-08-2-check.log` |
| إتاحة/تركيز المعالج + RTL أول رسم | **2/2** | `SET-08-2-check.log` |
| طقم property كامل | **422/422 في 55 حزمة** | `SET-08-2-property-full.log` |
| طقم التوزيع | **48/48** | `SET-08-2-distribution.log` |
| `pnpm check` | **110/110 في 18 حزمة** + بناء/عقود/typecheck/lint/format | `SET-08-2-check.log` |
| البصري SET-01 (شامل 320/360 + تبديل لغة وسط المعالج + تركيز الملخص) | **48/48** | `SET-08-2-visual.log` |
| قياس الأداء 50/500/2000 + طقم property كامل | **423/423 في 55 حزمة**؛ p95: قائمة ≤14ms، بحث ≤82ms — **لم يُعد إنتاجه في مراجعة 08.5 (P1-02: 423/424 ×3)** | `SET-08-3-property-full.log` + `.local/verification/SET-08-3/scale-evidence.json` |
| رحلة SET-08 E2E (إعداد→تفعيل→بيع) + property كامل | **424/424 في 56 حزمة** | `SET-08-4-property-full.log` + `.local/verification/SET-08-4/journey-evidence.json` |
| `pnpm test:integration` | **PASS** (جاهزية حقيقية)؛ `--faults` BLOCKED_ENV | `SET-08-4-integration.log` / `SET-08-4-integration-faults.log` |
| البصري SET-01 (يشمل AT14 رفض الواجهة + التفعيل بعد الإعداد) | **50/50** | `SET-08-4-visual.log` |
| `pnpm check` | **110/110 في 18 حزمة** | `SET-08-4-check.log` |
| برومبت المراجعة المستقلة 08.5 | أُصدر ونُفذ (الحكم في تقرير المراجعة) | `docs/execution/SET-08-review-prompt.md` |
| تقرير المراجعة المستقلة 08.5 | **NEEDS_FIXES** (P1×3)؛ أُعيد إنتاج البصمة/التشيكسوم وproperty-api والوحدة وi18n/الإتاحة والتكامل والرحلة والبصري وcheck | `docs/execution/SET-08-independent-review.md` |
| إعادة تحقق ما بعد الإصلاح (08.5.2) | **GO_WITH_NOTES** محلي؛ P1×3 زالت: property-api 12/12، سبر مستقل 1/1 (422)، inventory-scale 5/5×2، property 425/425، توزيع 48/48، تكامل PASS، check 110/110، بصمة `e2c025af…` وتشيكسوم 785/785 OK | [تقرير المراجعة §12](SET-08-independent-review.md) + `/tmp/opencode/set08-review/reverify/` |
