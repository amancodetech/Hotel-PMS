# SET-08 — المراجعة المستقلة (08.5)

- **التاريخ:** 22 سبتمبر 2026.
- **النطاق:** إعادة إنتاج أدلة 08.1 (جاهزية خادمية وبوابة SET-AT14)، 08.2 (لغات/إتاحة)، 08.3 (أداء)، 08.4 (تكامل وبصري)، والتحقق من البصمة/التشيكسوم؛ لا SET-09 ولا قبول إنتاجي ولا تغيير G-13/D/N/EX-04، وSET-AT12..17 تبقى NOT_TESTED.
- **المراجع الحاكمة:** [بطاقة SET-08](SET-08.md)، [برومبت المراجعة](SET-08-review-prompt.md)، ADR [`97_set_setup_contract_adr`](../97_set_setup_contract_adr.md) (S10)، عقد [`set.openapi.json`](../contracts/set.openapi.json) (`x-readiness-enforced-by`)، [سجل التقدم](SET-progress.md)، وملاحظات إعادة التحقق المستقلة لـSET-06/07.
- **الحكم:** **NEEDS_FIXES** — لا P0، لكن ثلاثة P1 قابلة لإعادة الإنتاج (التفاف على بوابة SET-AT14 في حالة تحرير بعد التنفيذ، عدّاد الأداء «423/423» غير قابل لإعادة الإنتاج، وتبرير قرار 500ms مبني على ادعاء خاطئ). التفاصيل وشرط إعادة القبول في §8 و§11.
- **تحديث (إعادة تحقق ما بعد الإصلاح، 22 سبتمبر 2026):** زالت P1-01..03 بلا انحدار — الحكم النهائي **GO_WITH_NOTES** (قبول محلي فقط). التفاصيل والقياسات في §12.

## 0) بيان الاستقلال

- جولة في جلسة جديدة عن جلسة 08.1..08.4؛ قُرئت البطاقة والبرومبت والعقد وADR، ولم تُستخدم سجلات المنفذ بديلاً عن التشغيل: كل الأرقام أدناه من تشغيل هذه الجولة على الشجرة الحالية.
- لم تُعدَّل ملفات مصدرية أو اختبارات بشكل دائم. أُجريت ثلاثة تعديلات مؤقتة فقط (مُطفِرتان وإعادة 4 أسطر تتبع زمن) ثم أُعيد كل ملف من نسخته الاحتياطية، وتحقّق `sha256sum -c` بعده. أُعيدت ملفات أدلة `.local` التي يكتبها التشغيل (scale/journey/report البصري) إلى نسخها الأصلية بعد المقارنة.
- سبر المراجعة المؤقت (`zz-set08-rv-probe`) أُنشئ تحت `tests/property/` ثم حُذف بعد التشغيل، ونسخته في `/tmp/opencode/set08-review/zz-set08-rv-probe.pg.test.mjs`؛ البصمة النهائية مطابقة لِبصمة 08.4 (أدناه).

---

## 1) البصمة والتشيكسوم — مطابقان

**البصمة (الأمر المعتمد نفسه المستخدم في SET-00/SET-07):**

```text
find apps packages scripts tests docs/contracts -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mjs' -o -name '*.json' \) \
  ! -path '*/dist/*' ! -path '*/node_modules/*' -print0 | sort -z | xargs -0 sha256sum | sha256sum
```

النتيجة: `42773919d3a8ff00acd0e7d46ba545645514905d03cc75e8d44741a6739637a2` — **مطابقة** لبصمة 08.4 الموثقة في البطاقة والبرومبت.

**التشيكسوم:** `sha256sum -c CHECKSUMS.sha256 --quiet` خرج بـ`EXIT=0` بلا أي سطر فاشل. عدد الصفوف الفعلي وقت التحقق **783** (فحص مسار/مسار أيضاً: لا ملف ناقص من القائمة ولا صف زائد عن الشجرة). ملاحظة P2: البرومبت يقول «782 صفاً»؛ سبب الفرق أن ملف البرومبت نفسه أُضيف ثم أُعيد توليد التشيكسوم بعده (18:39:59 مقابل 18:40:14 بتوقيت البيئة)، فصار العدد 783 — كلها OK.
**بعد إصدار هذا التقرير وتحديث البطاقتين** أُعيد توليد التشيكسوم بـ`pnpm checksums` → **784 صفاً** جديدة (منها هذا التقرير) و`sha256sum -c` = `EXIT=0`.

**بعد كل التعديلات المؤقتة وأعمال البناء/Build:** أُعيد التحقق من البصمة فبقيت `42773919…`، والتشيكسوم بقي `EXIT=0`.

---

## 2) 08.1 — بوابة SET-AT14

### 2.1 القراءة الساكنة

- `ApplySetupDraft` (`setup-service.ts:462-536`) و`updatePropertyById` (`property-service.ts:275-339`) يستخدمان **نفس** الفحص `setupReadinessIssues(input)` المستورد من `domain/setup.js:698`، ونفس الملف `findSetupDraft`. مسار الرفض في التفعيل هو `PropertyError('SETUP_READINESS_BLOCKED', { issues })` وبلا أي كتابة (الفحص قبل `updateProperty`).
- `updatePropertyById` يشترط `draft && !draft.completed` قبل الفحص، فالمنشأة بلا مسودة تُفعَّل كما هو معلن، والمسودة المنفَّذة (`completed=true` بعد `ApplySetupDraft` في `setup-service.ts:1024`) لا تُحجب.
- **تفصيل دلالي (P2):** إن كان العيب الوحيد `mode_not_supported` فمسار Apply يعيد `SETUP_MODE_UNSUPPORTED` بينما مسار Update يعيد `SETUP_READINESS_BLOCKED` (لأن الأخير لا يفصل هذه الفئة). كلاهما يرفض؛ لا ثغرة، فرق رمز فقط.

### 2.2 المسارات البديلة SETUP→ACTIVE

- كاتب حالة `property.status` الوحيد هو `updateProperty` (`property-repository.ts:94-126`) ولا يُستدعى إلا من `updatePropertyById`؛ `insertProperty` لا يقبل حالة (الافتراضي `SETUP` في `Migration20260914270000_property_core.ts:58`)، و`updatePropertyCoreFromSetup`/`bumpPropertyInventoryVersion` لا يمسان الحالة، ولا SQL مباشر في الخدمات، و`propertyPatch` `.strict()` محصور بالحقول المعلنة.
- إذن المسار المعلن `UpdateProperty(SETUP->ACTIVE with a stored draft)` هو الوحيد، لكن **يوجد التفاف** في حالة «تحرير مسودة منفَّذة» (§8، P1-01).

### 2.3 التشغيل

```
pnpm dev:stop
pnpm test:property:fast -- --filter=property-api
→ Test Suites: 1 passed, 1 total — Tests: 11 passed, 11 total (5.0s)
```

يشمل اختبار البوابة الجديد `property-api.pg.test.mjs:223-314`: مسودة ناقصة (`units_required`) → `422 SETUP_READINESS_BLOCKED` مع بقاء الحالة `SETUP` والنسخة كما هي، ثم إزالة المسودة بـIf-Match → تفعيل `200`، فضلاً عن رفض `ACTIVE→SETUP` بـ`409 INVALID_STATE_TRANSITION`.

---

## 3) تصنيف أخطاء قاعدة البيانات

- الوحدة `apps/api/src/database-errors.ts` تصنّف 55P03→409 `CONFLICT/LOCK_TIMEOUT`، 57014→503 `DEPENDENCY_UNAVAILABLE/STATEMENT_TIMEOUT`، ومجموعة فقد الاتصال (08000/08001/08003/08006/08007/57P01/57P02/57P03/53300 + أكواد السائق) →503 `CONNECTION_LOST`، وتُستهلك في `SafeErrors` (`app.ts:64-121`) قبل أي 500، مع تجاوز تسجيل `unhandled_error` للأخطاء المصنفة، و`Retry-After: 1` على كل 503 (API عامل 4100 و`/ready` في العامل).
- التشغيل: `npx jest tests/database-errors.test.tsx tests/api.test.mjs` → **7/7 في حزمتين** (يشمل `retry-after` على 503 من العمليتين).
- **تقييم SQLSTATE غير المصنفة (P2):** `40001` (serialization) و`40P01` (deadlock) وغيرها تسقط 500 `INTERNAL_ERROR` مع `unhandled_error`؛ لا يوجد retry تركيبي في `runScopedTransaction`. لا انحدار هنا (سلوك سابق)، والخطورة منخفضة التكرار لكن ينصح لاحقاً بمصالحة 40001/40P01 كـ409/503 قابلة للإعادة.

---

## 4) 08.2 — لغات/إتاحة، مع مُطفِرات

### 4.1 التشغيل

```
NODE_OPTIONS=--experimental-vm-modules npx jest --runInBand tests/i18n-parity.test.tsx tests/web-a11y.test.tsx
→ Test Suites: 2 passed — Tests: 6 passed (4 تكافؤ + 2 إتاحة)
```

### 4.2 اختبار الفعالية بمُطفِرة (قابلية التكذيب)

| المُطفِرة | ما حُذف مؤقتاً | النتيجة | الإرجاع |
| --- | --- | --- | --- |
| i18n | مفتاح متداخل واحد `setupWizard.validation.units_required` من `ar.json` (سطر 1433) | **3 من 4 فشلت** (شجرة التكافؤ، القيم/placeholders، أكواد الخادم) | أُعيد الملف؛ `sha256sum -c` للملف = OK، ثم 4/4 خضراء |
| a11y | `tabIndex={-1}` من ملخص الأخطاء في `SetupWizardPreviewPage.tsx:1055` | **فشل** اختبار `toHaveFocus()` (بقي الملخص ظاهراً بلا تركيز) | أُعيد الملف؛ `sha256sum -c` = OK، ثم 2/2 خضراء |

استنتاج: الادعاءات قابلة للتكذيب فعلاً وليست «وجود اختبارات» فقط.

### 4.3 فحص العناصر الموعودة

- **التركيز حقيقي:** `tabIndex={-1}` + `useEffect` يعتمد على `errors` ويستدعي `errorsRef.current?.focus()` (`SetupWizardPreviewPage.tsx:526-529`)، والملخص حيّ عبر `shownErrors` فيزول عند الإصلاح.
- **`aria-invalid` مربوط بالحقول** عبر خصائص MUI (`inputProps`/slotProps) في خطوات متعددة، ويختبره الطقم على الاسم/الكود/النمط مع `helperText` خطأ ملاصق.
- **سكربت `index.html` قبل mount** (`index.html:7-22`) يقرأ `hotel.preferences.v1` ويضبط `lang/dir`، ويُنفَّذ في الاختبار بـ`new Function(script)()` لحالات ar/en-US/JSON تالف.
- **عزل الاتجاه:** 12 موضع `dir:'ltr'` لأكواد/أنماط/سعات/روابط/أوقات/أسعار في المعالج، والبصري يتحقق من RTL بلا فيض أفقي وبلا قص إجراءات.
- **حياة (P2):** `fallbackLng: 'id-ID'` ما زال قائماً؛ لم يعد يخفي نقصاً لأن طقم التكافؤ العميق يحرس الحزم الثلاث كاملة، لكنه يبقى قادراً على إخفاء انحرافات مستقبلية خارج نطاق الاختبار.

---

## 5) 08.3 — أداء

### 5.1 القياس والأحجام

- الاختبار `tests/property/inventory-scale.pg.test.mjs:262-353` يقيس **50/500/2000** وحدة، تسخين + 5 عينات، قائمة `limit=100` مع إثبات ثبات الترتيب، وبحث توفر بأفق ليلة، ويكتب `.local/verification/SET-08-3/scale-evidence.json` مع `target_p95_ms: 1000` و`published_sla: false` ونص صريح أن 2000 فوق سقف PERF-01 (500).
- تشغيلي الناجح (مرة واحدة من ست) كتب: قائمة p95 = 12/13/13ms، بحث p95 = 22/76/45ms — متسق مع دليل المنفذ (12/12/12 و20/76/48). فالقياس **حقيقي وليس تجميلاً**، والفجوات المعلنة (لا SLA، 2000 فوق السقف، الدفعات الكبيرة fail-closed بلا مهمة خلفية) **صريحة** في البطاقة والدليل.

### 5.2 لكن عدّاد «423/423» غير قابل لإعادة الإنتاج — P1

- `pnpm test:property:fast` الكامل: **ثلاث تشغيلات متتالية = 423/424** (حوالي 124-128s)، والفشل دائماً في `inventory-scale` عند تأكيد التسخين `AVAILABLE` بينما النتيجة `UNDETERMINED`.
- تشغيل معزول بـ`--filter=inventory-scale`: نجح 5/5 مرة واحدة، ثم **فشل في جلستين معزولتين أخريين** بالخطأ نفسه.
- إعادة تشغيل بأربعة أسطر تتبع مؤقتة أظهرت السبب بدقة:

```text
S8RV_PERF_WARMUP {"size":50,  "status":200,"result":"AVAILABLE",   "ms":21}
S8RV_PERF_WARMUP {"size":500, "status":200,"result":"AVAILABLE",   "ms":76}
S8RV_PERF_WARMUP {"size":2000,"status":200,"result":"UNDETERMINED","ms":849}
```

- أي أن **أول بحث بارد عند 2000** (فوق سقف الملف المعلن) يتجاوز ميزانية الفشل المغلق 500ms فيرجع `UNDETERMINED`، والتسخين يؤكده تأكيداً صارماً بلا تسامح — بينما حلقة العينات تتسامح (`undetermined < samples`، سطر 331). فالتسخين المذكور كإصلاح للعابر هو نفسه نقطة الفشل، ودليل «لا UNDETERMINED في التشغيل الكامل الأخير» غير قابل لإعادة الإنتاج في هذه البيئة.
- **ملاحظة:** الشجرة سليمة والمنتج يتصرف كما هو معلن (fail-closed فوق السقف)؛ العيب في ثبات الاختبار/الدليل لا في سلوك الخدمة. الدليل الأصلي لم يُمَس (تحقّق `cmp` بعد كل جولة فاشلة، لأن الاختبار يفشل قبل كتابة الملف).

### 5.3 قرار 500ms مقابل `search_budget_ms` — P1 توثيقي

- البطاقة (سطر 83) تبرر إبقاء `500ms` المثبتة في `commitment-service` (موضعان: 244 و627) و`group-service` (230) و`revision-service` (636) بأنها «ليست `search_budget_ms` (`property_limits_profile` لا يحوي عموداً لها)».
- **الادعاء خاطئ:** العمود موجود في `property_limits_profile` (`Migration20260914270000_property_core.ts:15`) ويُقرأ فعلاً لمسارات البحث/العرض/الحجز (`rate-repository.ts:222-234`، `availability-service.ts:346`، `quote-service.ts:82`، `hold-service.ts:121`).
- قد يكون القرار السلوكي (إبقاء الأرقام) سليماً بذاته، لكن تبريره الحالي مبني على مقدمة غير صحيحة، فيلزم تصحيح البطاقة وتثبيت القرار (توحيد/عمود مخصص/تأجيل بقرار موثق) قبل اعتماده كتوثيق كافٍ.

---

## 6) 08.4 — تكامل ورحلة E2E

### 6.1 الجاهزية الحقيقية

```
pnpm test:integration → PASS: API and Worker readiness against real PostgreSQL, Redis and Keycloak.
```

### 6.2 الرحلة — إعداد→تفعيل→بيع فعلاً

- `pnpm test:property:fast -- --filter=set08-journey` → **1/1**، وأُعيد إنتاج `journey-evidence.json` بخطواته نفسها: `property_created → activation_blocked (SETUP_READINESS_BLOCKED) → setup_applied (4 وحدات + خطة سعر) → property_activated → rate_plan_activated_after_setup → quote_created → reservation_confirmed → checked_in (101)`.
- الرحلة **لا تتوقف قبل البيع**: تُنشئ عرض سعر، وتؤكد حجزاً، وتسجّل وصولاً فعلياً.
- الملاحظتان موثقتان: (1) خطة السعر تُنشأ `DRAFT` وهذا **مؤكَّد باختبار** (`journal test:212`)؛ (2) تسعير الإشغال 1 هو `observation` في الدليل وليس تأكيداً اختبارياً (الاختبار يستخدم `adults:1`)، لكن الكود يدعمه: `ApplySetupDraft` ينشئ الخطة/الأسعار بـ`occupancyBasis:1` وأسعار `occupancy:1` فقط (`setup-service.ts:961-990`). لذا الوصف صادق لكن بدرجة «ملاحظة موثقة معززة بالكود» لا «اختبار». (P2)
- أُعيدت نسخة الدليل الأصلية كما كانت (`cmp` مطابق).

### 6.3 `--faults BLOCKED_ENV` — صحيح

- `docker compose version` بنفسي → `docker: unknown command: docker compose` (exit 1)، ولا وجود لـ`docker-compose` المنفصل، بينما منفّذ Docker يعمل والحاويات الحقيقية حية (postgres/redis/keycloak). فالتشغيل `--faults` فعلاً غير ممكن في هذه البيئة، وقد أعدت إنتاجه:
  - `pnpm test:integration -- --faults` → فشل `compose` بـ`status 125` (`docker compose ... up -d --wait postgres`)، أي الفشل عند أول أمر compose، بلا إيقاف فعلي لأي خدمة.
- مصفوفة القيود صادقة: لا جزء خارجي (قنوات حية/OTP/EX/D-19/D-20) ادُّعي أنه مُختبر؛ الجاهزية والرحلة والبصري محلية فقط.

---

## 7) البصري — 50/50 معاد إنتاجه

- `pnpm dev:start` ثم `pnpm visual:set01` → **50/50**، بنفس أسماء الفحوص وترتيبها في `report.json` الأصلي، ونفس `console_errors` المتوقعة (422 من رفض AT14).
- الفحوص فعلية في الكود (`scripts/set01-visual.mjs`): 320/360/390 بلا فيض أفقي وبلا قص إجراءات مع تبديل الـStepper بمؤشر مدمج (459-485)، تبديل لغة وسط المعالج يحفظ الخطوة والمدخلات و`dir=rtl` (350-364)، رفض التفعيل من الواجهة بمسودة ناقصة وبقاء الحالة `Setup` (494-547)، ثم إكمال/تنفيذ الإعداد وتفعيل المنشأة من الواجهة (792-816)، وتركيز الملخص عند فشل «التالي» (229-242).
- بعد المقارنة أُعيد مجلد أدلة SET-01 إلى نسخته الأصلية.

---

## 8) النتائج مصنفة

### P0
- لا يوجد.

### P1

| # | النتيجة | الدليل |
| --- | --- | --- |
| P1-01 | **التفاف على بوابة SET-AT14:** مسودة منفَّذة (`completed=true`) ثم تحريرها إلى إدخال ناقص عبر `PUT setup-draft` لا تعيد `completed` إلى false (لا يوجد أي `markSetupDraftCompleted(false)` في الشجرة)، فيتجاوز شرط `!draft.completed` ويُقبل `SETUP→ACTIVE` بـ`200` رغم أن `GetSetupReadiness` يقرأ نفس المسودة ويعلن `ready=false`. يخالف نص العقد/ADR S10(b) («مسودة مخزنة وغير مكتملة → رفض بالرمز نفسه»). | سبر مستقل: `S8RV_PROBE {"edited_status":200,"edited_completed":true,"activation_status":200,"activation_code":null,"property_status":"ACTIVE"}`؛ الكود: `property-service.ts:298-304`، `setup-repository.ts:51-70` |
| P1-02 | **دليل أداء غير ثابت:** `SET-08 PERF` يفشل عند تأكيد تسخين 2000 (`UNDETERMINED` بعد 849ms > ميزانية 500ms)، فـ`pnpm test:property:fast` الكامل = **423/424** في 3 تشغيلات متتالية، ومعزولاً فشل 2/3. ادعاء البطاقة «لا UNDETERMINED» و«423/423» غير قابل لإعادة الإنتاج. | `/tmp/opencode/set08-review/property-full-review*.log` و`inventory-scale-*.log`؛ الموضع `inventory-scale.pg.test.mjs:304-306` |
| P1-03 | **توثيق قرار 500ms مبني على ادعاء خاطئ:** «`property_limits_profile` لا يحوي عمود `search_budget_ms`» غير صحيح؛ العمود موجود ومستعمل. | `Migration20260914270000_property_core.ts:15`، `rate-repository.ts:222-234` مقابل `SET-08.md:83` |

### P2

| # | النتيجة |
| --- | --- |
| P2-01 | عدد صفوف `CHECKSUMS.sha256` = 783 وليس 782 كما في البرومبت (سبب مقبول: توليد لاحق لإضافة ملف البرومبت)؛ الكل OK. |
| P2-02 | `40001/40P01` وغيرها غير مصنفة → 500 بلا retry؛ لا انحدار، يوصى بمصالحة لاحقة. |
| P2-03 | `fallbackLng:'id-ID'` باقٍ؛ لا يخفي النقص الحالي (طقم التكافؤ العميق)، لكنه يظل قادراً على إخفاء انحرافات مستقبلية. |
| P2-04 | `mode_not_supported` وحده: Update يعيد `SETUP_READINESS_BLOCKED` وApply يعيد `SETUP_MODE_UNSUPPORTED`؛ كلاهما يرفض (فرق رمز). |
| P2-05 | ملاحظة الإشغال 1 في الرحلة «observation» غير مؤكدة اختبارياً (الاختبار على `adults:1`) لكن مدعومة بكود `setup-service.ts:961-990`. |
| P2-06 | `--faults` معطّل لغياب إضافة compose (`COMPOSE_BIN` موجود كمنفذ تعديل)؛ الادعاء صحيح لكنه سقف بيئة لا أكثر. |

---

## 9) ما تعذّر التحقق منه وحدوده

- **قارئ الشاشة البشري/شهادة WCAG:** خارج النطاق بإعلان البطاقة نفسه؛ ما تحقق هو أتمتة (تكافؤ عميق، إتاحة، بصري). لا يُستنتج من هذه المراجعة أكثر من ذلك.
- **أطقم identity/distribution:** لم تُعد تشغيلاً (خارج قائمة إعادة الإنتاج المطلوبة؛ آخر خط أساس معلن 48/48 لكل منهما).
- **القنوات الحية/OTP/NAS/EX-01..05 وD-19/D-20:** غير ملموسة كما هي معلنة؛ لا قبول إنتاجي ولا SLA من هذه الجولة.
- **`pnpm test:property:fast` «424/424»:** تعذّر إعادة إنتاجه (P1-02)؛ `pnpm check` 110/110 أُعيد إنتاجه بنجاح.

---

## 10) أجوبة أسئلة الحكم

- **هل وعد SET-AT14 صادق في المسارين بلا التفاف؟** لا بالكامل. المساران يستخدمان الفحص نفسه فعلاً، لكن حالة «تحرير مسودة منفَّذة ثم تفعيل» تمر بلا فحص (P1-01) وتناقض تقرير `GetSetupReadiness` نفسه.
- **هل ادعاءات i18n/a11y قابلة للتكذيب؟** نعم؛ مُطفِرتان ناجحتان (3/4 فشل i18n، وفشل التركيز a11y) مع إرجاع سليم.
- **هل قياس الأداء حقيقي أم تجميل؟** القياس حقيقي على 50/500/2000 والفجوات معلنة صراحة، لكن ثبات الأدلة و«423/423» لا يصمدان (P1-02)، وتبرير 500ms خاطئ (P1-03).
- **هل الرحلة تُثبت إعداد→تفعيل→بيع؟** نعم، حتى تأكيد الحجز وتسجيل الوصول، وأُعيد إنتاجها. الملاحظتان موثقتان؛ DRAFT مؤكدة اختبارياً، والإشغال 1 ملاحظة مدعومة بالكود.
- **هل حُوِّل أي من SET-AT12..17 إلى PASS؟** لا؛ البطاقة والسجل يبقيانها NOT_TESTED، ولم يُلمس D/G-13/EX-04 (البصمة مطابقة، وD-04/D-17/G-13/EX-04 في ملفات القرارات كما هي).

---

## 11) الحكم وشرط إعادة القبول

**NEEDS_FIXES** (لا P0؛ ثلاث P1). لا تغيير لـG-13/D/النموذج المالي/العزل، وتبقى SET-AT12..17 NOT_TESTED.

**شرط إعادة القبول (جولة مركزة):**

1. **P1-01:** منع التفاف البوابة — إما إرجاع `completed=false` عند أي `SaveSetupDraft` يغيّر المسودة، أو فحص `setupReadinessIssues(draft.input)` عند كل `SETUP→ACTIVE` بصرف النظر عن علم `completed`؛ مع اختبار دائم جديد لسيناريو «تنفيذ ثم تحرير ثم تفعيل» (يمكن استلهام السبر في `/tmp/opencode/set08-review/zz-set08-rv-probe.pg.test.mjs`).
2. **P1-02:** تثبيت اختبار الأداء (تسامح/إعادة محاولة للتسخين البارد عند 2000 أو قياسه بعد التسخين) وإصدار دليل جديد من تشغيل كامل أخضر `pnpm test:property:fast`، مع إظهار `UNDETERMINED` المكتوم في الدليل بدل ادعاء انعدامه.
3. **P1-03:** تصحيح نص قرار 500ms في البطاقة (العمود موجود) وتثبيت القرار: توحيد، أو عمود مخصص، أو تأجيل موثق بلا تبرير خاطئ.
4. إعادة تشغيل مطلوبة بعد الإصلاح: `property-api` + `inventory-scale` + `set08-journey` + الطقم الكامل أخضر + `pnpm check` + إعادة حساب البصمة/التشيكسوم، ثم إعادة تحقق مستقلة مختصرة تثبت زوال P1-01..03.

---

## 12) إعادة تحقق ما بعد الإصلاح (جولة مركزة — 22 سبتمبر 2026)

**بيان الاستقلال:** جلسة جديدة، وكل الأرقام أدناه من تشغيل هذه الجولة على الشجرة الحالية. أُدخل سبر مستقل جديد مؤقتاً في `tests/property/` ثم حُذف فور التشغيل، وأُعيدت ملفات أدلة `.local` التي يكتبها التشغيل إلى نسخها الأصلية بعد المقارنة، ثم أُعيد التحقق من البصمة والتشيكسوم. لا تعديل دائم على أي ملف مصدري أو اختباري.

### 12.1 P1-01 — **زال**

- `pnpm dev:stop` → EXIT 0.
- `pnpm test:property:fast -- --filter=property-api` → **12/12 في حزمة واحدة (4.5s)**، ومنه اختبار الانحدار الدائم `property-api.pg.test.mjs:318-464`: تنفيذ ثم تحرير إلى ناقص → `completed=false` → `ready=false` → `PATCH ACTIVE` = **422 `SETUP_READINESS_BLOCKED`** مع `units_required`.
- سبر مستقل جديد (`zz-set08-rv-probe-v2.pg.test.mjs`، نسخته في `/tmp/opencode/set08-review/reverify/`) → **1/1**، ومخرجه:
  ```text
  S8RV2_PROBE {"edited_status":200,"edited_completed":false,"readiness_status":200,
  "readiness_ready":false,"activation_status":422,
  "activation_code":"SETUP_READINESS_BLOCKED","activation_issues":["units_required"]}
  ```
  ثم `GET` نهائي أكد بقاء `property.status = SETUP` بلا أي كتابة (الرفض قبل `updateProperty`). حُذف السبر بعد التشغيل وتحققت البصمة بعده.
- ساكنياً: `property-service.ts:300-307` يفحص `setupReadinessIssues(draft.input)` لأي مسودة مخزنة بلا شرط `!draft.completed`، و`setup-repository.ts:65` يعيد `completed=false` في كل `update`. **P1-01: زال.**

### 12.2 P1-02 — **زال**

- `pnpm test:property:fast -- --filter=inventory-scale` **مرتان متتاليتان = 5/5 في كل مرة**.
- `scale-evidence.json` من تشغيلي (النسخ في `/tmp/opencode/set08-review/reverify/scale-evidence.run{1,2}.json` و`-fullrun.json`؛ والنسختان الأصليتان المستعادتان `scale-evidence.json` و`scale-evidence-final.json` لتشغيلَي المنفذ 12:21 و12:18 متفقتان دلالياً: 2000 كله UNDETERMINED مع `cold_undetermined=3` و`search_p95=null`):
  - **50:** available 5 / undetermined 0، warmup `AVAILABLE` 21–22ms، list_p95 12–14ms، search_p95 22–24ms.
  - **500:** available 5 / undetermined 0، warmup `AVAILABLE` 72–77ms، search_p95 77–94ms.
  - **2000 (التشغيل الأول):** available 0 / undetermined 5 / `cold_undetermined` 3 (محاولات التسخين الثلاث UNDETERMINED بين 735–1119ms)، و`search_p95=null` مع UNDETERMINED مسجَّل صراحة في العينات.
  - **2000 (التشغيل الثاني، بعد دفء القاعدة):** warmup `AVAILABLE` 48ms، available 5 / undetermined 0، `search_p95=47ms`.
  - أي أن الحالتين (بارد fail-closed فوق السقف / دافئ تحت الهدف 1s) تُسجَّلان بصدق والاختبار أخضر فيهما، مع إلزام `AVAILABLE` صراحة عند 50/500 وعدم كتم أي `UNDETERMINED`.
- `pnpm test:property:fast` الكامل → **425/425 في 56 حزمة (142.7s)**، ويشمل `set08-journey` و`inventory-scale`. **P1-02: زال.**

### 12.3 P1-03 — **زال**

- لا وجود لـ`Date.now() + 500` في `packages/backend`؛ المتبقي هو النمط الصحيح `Date.now() + (limits?.search_budget_ms ?? 500)` في `availability/quote/hold` (سلوك قائم).
- `searchBudgetForProperty` (`availability-service.ts:61-67`) تقرأ `search_budget_ms ?? 500` من ملف حدود المنشأة، ومستدعاة في المواضع الأربعة: `commitment-service.ts:247` و`:634`، `group-service.ts:233`، `revision-service.ts:639`.
- البطاقة (`SET-08.md:83` و`:108`) صارت تنص على أن العمود **موجود** ووُحِّد مصدره، ولا زعم بغيابه في البطاقة أو سجل التقدم (تبقى الإشارة في `SET-08.md:102` كسجل تاريخي لعيب المراجعة المُصلَح). **P1-03: زال.**

### 12.4 عدم الانحدار

| الأمر | النتيجة |
| --- | --- |
| `pnpm test:property:fast` (كامل) | **425/425 في 56 حزمة** |
| `pnpm test:distribution:fast` | **48/48 في 11 حزمة** + PASS لهجرات السيناريوهات الأربعة |
| `pnpm test:integration` | **PASS** (جاهزية api/worker على PostgreSQL/Redis/Keycloak الحقيقية) |
| `pnpm check` | **110/110 في 18 حزمة** + build/عقود/typecheck/lint/format |

### 12.5 البصمة والتشيكسوم

- البصمة بعد كل التشغيلات وبعد إرجاع ملفات الأدلة: `e2c025af9b07e22663b102c5a0f71851d9f6a192a3f19fdb61d6a9acc24585ee` — **مطابقة** للمسجلة في البطاقة بعد الإصلاح.
- `sha256sum -c CHECKSUMS.sha256` (785 صفاً): **0 صف فاشل**. وبعد تحديث هذا القسم والبطاقة/السجل أُعيد توليد التشيكسوم بـ`pnpm checksums` وبقي `sha256sum -c` = 0 فاشل.

### 12.6 ملاحظات جديدة (كلها P2 وغير حاجبة)

- **P2-07:** سطر البطاقة 80 يقول إن الاختبار «يفشل فقط إن بقيت آخر محاولة تسخين غير `AVAILABLE`» دون استثناء 2000، بينما الكود (وسطر 107) يسمح صراحة بـ`UNDETERMINED` عند 2000 فوق سقف PERF-01؛ فرق صياغة توثيقي فقط.
- **P2-08:** دليل 2000 ثنائي الاحتمال بحكم الطبيعة (بارد → `null` مع UNDETERMINED؛ دافئ → رقم ~47ms)؛ الاختبار الجديد يحتمل الحالتين ويوثقهما، ولا يصح قراءة `null` منفرد كحد قدرة ولا الرقم كـSLA (وهو منصوص عليه في الدليل والبطاقة).
- P2-01..06 السابقة تبقى كما هي ولا انحدار عليها (`fallbackLng:'id-ID'`، 40001/40P01 غير مصنّفة، فرق رمز `mode_not_supported`، ملاحظة إشغال 1، `--faults` ببيئة بلا compose، عدد صفوف التشيكسوم).

### 12.7 الحكم النهائي

**GO_WITH_NOTES** — زالت P1-01 وP1-02 وP1-03 بلا انحدار، ولا P0/P1 جديد، والملاحظات المتبقية كلها P2 موثقة. هذا **قبول محلي (VERIFIED_LOCAL) لا قبول إنتاجي**: لا تغيير لـG-13/D/النموذج المالي/العزل/EX-04، وSET-AT12..17 تبقى **NOT_TESTED**.
