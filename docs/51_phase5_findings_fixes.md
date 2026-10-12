# إصلاح findings المرحلة 5 (جلسة المنفّذ) — سجل

التاريخ: 14 سبتمبر 2026. التفويض: المستخدم وافق على إصلاح **المتوسطات الثلاثة + المنخفضة
العملية (R3/R4/R6/R7/R8)** بعد المراجعة المستقلة [docs/50](50_phase5_independent_review.md).
هذه الجلسة منفّذة وليست مراجعة؛ **G-05 يبقى `REVIEW_PENDING`** حتى جولة مراجعة مستقلة جديدة
على البرومبت نفسه [docs/47](47_phase5_review_prompt.md).

## ما أُصلح

| Finding | الإصلاح | الموضع |
|---|---|---|
| **ADV5-F1** متوسط | فصل منطق الانتهاء الكسول عن فحص النسخة: يُحسب إصدار القرص `diskVersion` قبل الانتهاء، ويُقبل إصدار العميل إذا طابق قرص ما قبل الانتهاء أو إصدار ما بعد الانتهاء المركب، ويُعلن خطأ `STALE_VERSION`/`PREVIEW_STALE` إصدارَ القرص الحقيقي بعد التراجع (لا v+1 وهمي). | `hold-service.ts` (createHold)، `exposure-service.ts` (previewExposure) |
| **ADV5-R1** متوسط | `reconcileConnection` يعالج الآن `RECONCILING` و`UNKNOWN`: دليل `accepted>0` مع `failed=0/unknown=0` ينشّط النشرة UNKNOWN→ACTIVE ويحرر حصة RECONCILING→RELEASED، والانحلال يبقى RECONCILING fail-closed. | `exposure-service.ts` (reconcileConnection) |
| **ADV5-R2** متوسط | `maintenance.emergency` لم يُعد مفروضاً على الحجب `PLANNED`؛ صار داخل شرط `EMERGENCY` فقط، وأُزيل نداء `applyInventoryTimeouts` المكرر. | `block-service.ts` (createBlock) |
| **ADV5-R3** منخفض | `55P03` (انتهاء lock_timeout) → 409 `CONFLICT` بتفاصل `reason=LOCK_TIMEOUT`، و`57014` (statement_timeout) → 503 `DEPENDENCY_UNAVAILABLE` بتفاصل `reason=STATEMENT_TIMEOUT` وترويسة `Retry-After: 1` بدل 500؛ وتوقفت كتابتهما كـ`unhandled_error`. | `apps/api/src/app.ts` (SafeErrors) |
| **ADV5-R4** منخفض | رفض محارف التحكم (C0 + DEL) برسالة 400: دالة `assertSafeText` جديدة، وتطبيقها على `assertName` وأسباب الحجب/السحب/إيقاف البيع. | `lifecycle.ts`, `block-service.ts`, `exposure-service.ts` |
| **ADV5-R6** منخفض | إضافة `reason.RESOURCE_UNAVAILABLE` و`reason.WITHDRAWAL_PENDING` في ar/id-ID/en-US (22 مفتاحاً في كل لغة). | `packages/i18n/src/locales/*.json` |
| **ADV5-R7** منخفض/وثائقي | حذف أكواد الأخطاء غير القابلة للرمي `EXPOSURE_CONFLICT`/`CAPABILITY_MISSING`/`EVIDENCE_REQUIRED` من `PropertyErrorCode` ومفاتيح `errors.*`، وتصحيح «14 جدولاً» إلى 13 في [docs/48](48_phase5_adversarial_review.md). | `errors.ts`, ملفات اللغات, docs/48 |
| **ADV5-R8** منخفض/تقوية | مهاجرة جديدة `20260915040000_revoke_unused_update_grants` تسحب `UPDATE` غير المستخدم عن `price_quote` و`inventory_block_resource` و`inventory_disruption` من `hotel_api` (مع `down` يعيده). | `persistence/migrations/` |

**F4 (وثائقي)**: أُغلق بحذف الكود الميت أعلاه وتثبيت توقّع رمز التنازع الفعلي `PREVIEW_STALE`
(بدل التخمين بين 409/412) في اختبار ADV5-09.

## خارج نطاق هذه الجلسة (تبقى مفتوحة)

- **ADV5-F2** (قوائم منشأة غير موجودة 200/فارغة بدل 404) و**ADV5-F3** (حد جسم 16KB مقابل DTO
  بـ1000 خلية) — منخفضتان ولم تُفوَّضا.
- **ADV5-R5** (أهلية FRACTIONAL_IDR الميتة)، **R9** (سباق حاضنة الاختبارات)، **R10/R11**
  (OOO على حصة قائمة، توقيت المنشأة) — موثقة كما هي.

## اختبارات الانحدار الجديدة

في `tests/property/adversarial-p05.pg.test.mjs` (7 عائلات، إجمالي 23 في الملف):

- `FIX-F1`: عقد مستحق + Hold بإصدار القرص ما قبل الانتهاء → 201 (بدل 412 الزائف)، الانتهاء
  يُعتمد (`EXPIRED` وصفر تخصيصات ACTIVE)، وخطأ نسخة قديمة حقيقي يعلن `details.current` مساوياً
  لإصدار القرص، وPreview بعد انتهاء مستحق يُقبل.
- `FIX-R1`: سحب → دليل `DEAD_LETTER` → `RECONCILING`، ثم `ACKNOWLEDGED` → `released=1` و
  `RELEASED`/`RELEASED`؛ ونشرة `UNKNOWN` ثم `ACKNOWLEDGED` → `activated=1` و`ACTIVE`.
- `FIX-R2`: دور بـ`inventory.block` وحدها ينشئ حجباً مخططاً (201) ويُرفض له الطارئ (403).
- `FIX-R3`: قفل صف Property من جلسة أخرى → 409 `CONFLICT`/`LOCK_TIMEOUT` وليس 500.
- `FIX-R4`: NUL في اسم خطة سعرية أو سبب حجب → 400 `INVALID_REQUEST`.
- `FIX-R8`: `hotel_api` بلا UPDATE على الجداول الثلاثة، ومعه INSERT/SELECT.
- `FIX-R6`: المفتاحان موجودان في اللغات الثلاث.

## النتائج المعادة (14 سبتمبر 2026)

`pnpm check` 79/79؛ `pnpm test:identity` 48/48؛ `pnpm test:distribution` 48/48؛
`pnpm test:property` **108/108** في 17 حزمة (23 منها عدائية)؛ `pnpm visual:phase5` 19/19؛
`phase4` 17/17؛ `phase3` 23/23؛ `visual:check` 38/38؛ `pnpm db:migrate` طبّق مهاجرة السحب
على dev و`db:check` و`contracts:check` ناجحان. الأدلة الخام في
`.local/verification/fixes-g05/` (`check.txt`, `property.txt`, `identity.txt`,
`distribution.txt`, `fix-regressions.txt`, `visual-*.txt`, `db-migrate.txt`, `db-check.txt`,
`contracts-check.txt`).

## الخطوة التالية

جولة مراجعة مستقلة ثانية في **جلسة منفصلة** على [docs/47](47_phase5_review_prompt.md)
(بلا سياق هذه الجلسة)، تتحقق من الإصلاحات وتعيد الفحص الشامل والعدائي، ويكون تقريرها
`docs/52_phase5_independent_review_2.md`. لا يُقبل G-05 ولا يبدأ P06 قبل خروج حكم PASS بلا
findings مفتوحة.
