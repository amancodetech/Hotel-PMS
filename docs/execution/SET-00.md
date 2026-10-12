# SET-00 — جرد وتخطيط وخط أساس

الحالة: **IMPLEMENTED / VERIFIED_LOCAL** (جرد وخط أساس فقط؛ لا تغيير سلوك).
التاريخ: 21 سبتمبر 2026.
نطاق التفويض: رسالة المستخدم في هذه الجلسة: تنفيذ حزم SET المحلية بالتتابع، مع إنجاز الأجزاء المحلية من SET-09 وترك الأفعال الخارجية ببواباتها.

## 1) السلوك المطلوب

- جرد فعلي للكود والعقود والهجرات والاختبارات والتعديلات المحلية.
- مصفوفة موجود/جزئي/مفقود لكل قالب SET مع دليل ملف.
- تتبع سيناريوهات SET-AT01..18 مقابل القدرات الحالية بلا ادعاء دعم.
- خط أساس قابل للإعادة (أوامر ونتائج وبصمة نسخة).

## 2) السلوك الحالي (دليل)

- المستودع Git بلا commits؛ كل الملفات untracked (`git status`). لا حذف ولا reset.
- آخر حالة موثقة في README: المراحل 0..13 منفذة محلياً؛ G-13 NOT ACCEPTED وقنوات حية غير موجودة.
- واجهة الإعداد الحالية: `apps/web/src/property/PropertiesPage.tsx` (CRUD منشآت) و`apps/web/src/property/PropertySetupPage.tsx` (5 تبويبات: مواقع/موارد/منتجات/تركيبات/قنوات).
- الباك إند: `apps/api/src/property/*` + `packages/backend/src/modules/property/` (36 عملية Phase 4 + SetResourceMaintenance في Phase 5).
- لا وجود لأي من مفاهيم SET الجديدة: مسودة معالج، دفعات، قوالب، معاينة إنشاء، جاهزية إعداد، rental_mode، أجنحة متصلة، ترقيم وحدات.

## 3) مصفوفة موجود/جزئي/مفقود

| مفهوم SET | الحالة | الدليل |
| --- | --- | --- |
| CRUD منشآت/مواقع/موارد/منتجات/مرشحين/تركيبات | موجود | `apps/api/src/property/*.controller.ts`، `docs/contracts/phase4.openapi.json` (36 عملية، 0.12.0) |
| فئات مرشحين (CandidateGroup) | موجود كصفوف | `product_resource_candidate` في `Migration20260914290000_product_core.ts:98-116` |
| تركيبات مؤرخة وتسطيح ذري وقيد جمود | موجود | `Migration20260914300000_composition_core.ts:21-134`، `composition-service.ts:207-278` |
| ضمان المخزون/التعارض/الحصص | موجود | `Migration20260915020000_inventory_guarantee.ts`، اختبارات `inventory-*`, `adversarial-p05` |
| مسودة إعداد/معالج مع حفظ واستئناف | **مفقود** | لا جدول/نوع `draft/setup/wizard`؛ PropertyStatus=SETUP فقط lifecycle |
| مفتاح تكرار لعملية إنشاء | **مفقود** | لا Idempotency-Key في Phase 4/5؛ `api_idempotency` يبدأ P06 |
| دفعات إنشاء وحدات/استيراد إعداد dry-run/apply | **مفقود** | لا endpoint جماعي للموارد؛ `import_run` للحجوزات فقط (`Migration20260915110000`) |
| معاينة إنشاء/أثر مخزون | **مفقود** | `exposure_preview` للحصص فقط؛ لا معاينة إعداد |
| جاهزية تهيئة خادمية | **مفقود** | لا عملية readiness في Phase 4/5 |
| قوالب وحدات (قالب→افتراضيات) | **مفقود** | فقط catalog `resource_type` بثمانية أنواع (`Migration20260914270000:25-31`) |
| ترقيم/دفعة أرقام واستثناءات | **مفقود** | `code` يدوي + `resource_property_code_unique` |
| طريقة تأجير (حصري/أجزاء/أسرة) | **مفقود** (تقنياً: BED + exposure WHOLE/PARTS + تركيبات) | `ResourceKind=BED`، `inventory_guarantee:165-174` |
| جناح متصل | **مفقود** (تقنياً: تركيبة متداخلة) | `composition_edge.child_kind=COMPOSITION` |
| واجهة متعددة الخطوات/RTL/موبايل | **مفقود** للمعالج؛ متاح للتبويبات | `PropertySetupPage.tsx` |
| تقارير مقامات منفصلة (فيلا/غرفة/سرير) | موجود | `reporting-operational.pg.test.mjs` (AT-22/23) |
| عزل RLS/صلاحيات/MFA/CSRF | موجود | `Migration20260914280000`، `guards.ts`، `adversarial.pg.test.mjs` |

## 4) تتبع SET-AT01..18 (وضع الجرد)

| ID | الوضع | أساس/فجوة |
| --- | --- | --- |
| SET-AT01 | جزئي | تفرّد `code` يمنع التكرار لكن لا إعادة تشغيل idempotent |
| SET-AT02 | مفقود | لا مسودة إعداد ولا نسخة مسودة |
| SET-AT03 | مفقود | لا دفعة/استثناءات أرقام |
| SET-AT04 | جزئي | تركيب + اختبار فيلا كاملة (`front-office-board:855`)؛ لا rental_mode معلن |
| SET-AT05 | موجود/جزئي | قيد GiST وقفل Property؛ يلزم اختبار صريح كامل↔جزء |
| SET-AT06 | جزئي | منع التكرار داخل تركيب؛ يلزم اختبار تقاطع تركيبين |
| SET-AT07 | جزئي | Split Stay موجود؛ يلزم سيناريو شاغر متقطع صريح |
| SET-AT08 | جزئي | جمود النسخة المفعّلة؛ لا واجهة نسخة جديدة/فحص التزامات |
| SET-AT09 | موجود | BED كنوع مورد + منع مضاعفة المخزون (`product-api`, `product-constraints`) |
| SET-AT10 | موجود | OOO/OOS من أوامر العمل (`operations-work-orders`) |
| SET-AT11 | موجود | `front-office-board`, `stay-movement`, `stay-checkout` |
| SET-AT12 | موجود | `adversarial`, `rls-constraints`, `identity` |
| SET-AT13 | جزئي | مفاتيح React Query تشمل propertyId في صفحات الميزات؛ يلزم تحقق معالج جديد |
| SET-AT14 | مفقود | لا بوابة جاهزية إعداد |
| SET-AT15 | موجود محلياً | exposure state machine + `p13-conformance` |
| SET-AT16 | جزئي | أرشفة lifecycle موجودة؛ لا استيراد إعداد |
| SET-AT17 | جزئي | i18n/RTL موجودان؛ المعالج غير موجود |
| SET-AT18 | موجود | `reporting-operational` |

## 5) قالب المصفوفة (للحزم التالية)

- قالب غرفة/كوخ/خيمة: CRUD + تركيبة بسيطة موجودان؛ يحتاج معالج/قالب/ترقيم.
- فيلا/شقة: كامل/أجزاء تقنياً عبر تركيبة + exposure؛ يحتاج rental_mode وسياسة خصوصية.
- غرفة مشتركة/أسرة: BED موجود؛ يحتاج نطاق مشاركة وسعر.
- موقع تخييم/كرفان: SITE/TENT موجودان؛ يحتاج قالب وسمات.
- جناح متصل: composition متداخل؛ يحتاج تعريف جناح وفحص خصوصية.
- منطقة/منشأة كاملة: لا مفهوم عرض مركب؛ يحتاج قراراً (SET-02 ADR إن لزم).

## 6) خط الأساس (VERIFIED)

البصمة: `e93ef85ffcee92143352eec16382d0cab2c9df968ee92c97e2f17b157a42a6b5` (sha256 لملفات ts/tsx/mjs/json في apps/packages/scripts/tests/docs/contracts بعد استثناء dist/node_modules).

| الأمر | البيئة | النتيجة | السجل |
| --- | --- | --- | --- |
| `pnpm check` | dev يعمل | **PASS 99/99** في 14 حزمة؛ contracts 43/30/36/21/15/10/35/22/5/9/25 | مخرجات الجلسة |
| `pnpm test:property:fast` | dev متوقف، PG معزول | **PASS 324/324** في 46 حزمة | `.local/verification/SET-00/property-baseline.log` |
| `pnpm test:identity:fast` | dev متوقف | **PASS 48/48** في 7 حزم | `.local/verification/SET-00/identity-baseline.log` |
| `pnpm test:distribution:fast` | dev متوقف | **PASS 48/48** في 11 حزمة | `.local/verification/SET-00/distribution-baseline.log` |

ملاحظات:
- محاولة أولى لطقم property على `API_PORT=4110` فشلت بيئياً لأن Keycloak مهيأ على `http://127.0.0.1:4100` (`scripts/identity.mjs:28`)؛ لا يخص المنتج.
- أطقم identity/property تشغّل API خاصاً على 4100؛ يجب `pnpm dev:stop` قبلها.
- VF-01 (تداخل بيانات منصة) لم يظهر في تشغيل 324/324.
- الخدمات: أُوقف ثم أُعيد dev عبر `pnpm dev:stop`/`pnpm dev:start`؛ api 4100 وweb 5173 وworker 4101 تعمل بعد الاستعادة.

## 7) الفجوات والعوائق وخطة الحزم (تبعيات كما في docs/94)

- SET-01: نموذج تفاعلي (بدون API) لرحلة بسيطة/مركبة مع استئناف مسودة — بعد SET-00.
- SET-02: عقود المسودة/المعاينة/الجاهزية/الدفعات + قرارات (ADR) قبل أي هجرة.
- SET-03: حفظ/استئناف خادمي + ربط المعالج.
- SET-04/05: قوالب/دفعات وrental modes/أسرة/جنان متصلة.
- SET-06/07: إعدادات مؤرخة، ترحيل، مكتب أمامي/تقارير لكل قالب.
- SET-08: جاهزية/أداء/إتاحة/مراجعة.
- SET-09: دليل/تدريب/خطة pilot محلياً؛ النشر وأي فعل خارجي يبقى ببواباته.
- قرارات مطلوبة لاحقاً (SET-02): تجاوز نطاق V1 الحالي إن لزم (مثل عرض منطقة مركبة)، ولا تُفترض ضمنياً.

## 8) خطوة الاستئناف

SET-01.1: كتابة نصوص/مصطلحات المعالج (ar/id-ID/en-US) ثم نموذج تفاعلي محلي بلا كتابة خلفية، مع حالات تحميل/فراغ/خطأ/تعارض، ثم مراجعة مهام: إضافة فندق، فيلا خاصة، فيلا أجزاء، استئناف مسودة.
