# إصلاح عيب نافذة التقارير الزمنية (P11) — جلسة إصلاح

الحالة: **IMPLEMENTED / VERIFIED محلياً**. التاريخ: 17 سبتمبر 2026.
التفويض: المستخدم طلب إكمال إصلاح العيب «بالشكل الاحترافي والصحيح» بعد تسجيله في
[P13-07](execution/P13-07.md). النطاق محلي فقط؛ لا تغيير عقد ولا مهاجرة.

## 1. العيب (F-P13-03)

أطقم `reporting-exports/financial/operational` تفشل في نافذة 00:00–07:00 Jakarta (17:00–24:00 UTC):
الاختبار يبني `addDays(n)` من ساعة العملية بتقويم UTC بينما `openDay` هو تاريخ عمل المنشأة
(Asia/Jakarta). عند النافذة يتساوى `addDays(1)` مع `openDay` فيصبح `date_from == date_to`،
و`validatePeriod` يرفضه (شرط ليالٍ موجبة) — وتظهر الأعراض لاحقاً كفشل تقارير و`export FAILED`.

## 2. البحث والمراجع (لماذا هذا الحل)

- **Temporal.PlainDate** (TC39، [PlainDate docs](https://tc39.es/proposal-temporal/docs/plaindate.html)):
  النوع الصحيح لـ«تاريخ تقويمي مستقل عن المنطقة الزمنية» مع `add({days})` دلالي، لكنه غير متاح
  أصلياً في Node 22؛ إدخال polyfill قرار اعتمادية خارج نطاق الإصلاح.
- **MDN Date.UTC** ([docs](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/UTC)):
  `Date` كائن لحظة زمنية؛ أي اشتقاق تاريخ من `toISOString()` هو تاريخ UTC لا تاريخ المنشأة.
  الخلط بين الأساسين هو جذر العيب.
- **الممارسة القياسية للطوابير**: التحقق من مدخلات المهمة عند حدود الـAPI بنفس دالة المولّد،
  ورفض 400 فوراً بدل إدخال مهمة لا يمكن أن تنجح ثم فشلها في العامل.

**القرار المناسب لهذا النظام**: (أ) إبقاء التواريخ التقويمية نصوص `YYYY-MM-DD` وحساب الإزاحات
بمرساة منتصف النهار UTC (`addBusinessDays`)؛ (ب) اشتقاق تواريخ الاختبار من تاريخ عمل المنشأة
(Asia/Jakarta) لا من ساعة UTC؛ (ج) تحقق فوري عند إنشاء التصدير بنفس `validatePeriod`/
`requireCurrency` المستخدمة في القراءة. لا تغيير دلالة: الفترة `[date_from, date_to)` بليالٍ
موجبة تبقى القاعدة.

## 3. ما نُفذ

- `packages/backend/src/modules/reporting/application/reporting-service.ts`: تصدير
  `validatePeriod` و`requireCurrency` (نفس الدوال المستخدمة في `ReadReport`/`ReadTenantReport`).
- `packages/backend/src/modules/reporting/application/report-export-service.ts`: استدعاؤهما في
  `createReportExport` قبل مفتاح الـidempotency والمعاملة — الطلب غير الصالح يفشل `400
  INVALID_REQUEST` ولا يُدرج في الطابور (يبقى مسار العامل حماية دفاعية لسجلات قديمة).
- `tests/property/support/business-dates.mjs`: `addBusinessDays` (مرساة 12:00Z على نص ISO) و
  `todayInTimeZone` (Intl).
- أطقم التقارير الثلاثة: `addDays` صار مشتقاً من `todayInTimeZone('Asia/Jakarta')` مرة واحدة لكل
  تشغيل، والفترات المرتبطة بـ`openDay` تستخدم `addBusinessDays(openDay, n)` صراحة.
- اختبار انحدار جديد `tests/property/reporting-period-validation.pg.test.mjs` (3/3): فترة صفرية
  400 بلا إدراج، فترة معكوسة 400 بلا إدراج، وفترة ليلة واحدة 202 تُدرج مرة واحدة.

## 4. الأدلة والأرقام

| الدليل | النتيجة |
|---|---|
| `.local/verification/P13-07/reporting-after-fix.log` | أطقم التقارير **31/31 في 4 حزم** في نفس النافذة الحرجة |
| `.local/verification/P13-07/test-property-full-after-fix.log` | property الكامل **323/323 في 46 حزمة** |
| `.local/verification/P13-07/check-final.log` | `pnpm check` **99/99 في 14 حزمة** |
| `.local/verification/P13-07/test-identity.log` | **48/48** |
| `.local/verification/P13-07/test-distribution.log` | **48/48** |
| `.local/verification/P13-07/visual-phase11-after-fix.log` | phase11 **14/14 و8 لقطات** |
| `.local/verification/P13-07/visual-check-after-fix.log` | `visual:check` **38/38** |

## 5. الحدود

- لم يُغيَّر أي عقد OpenAPI ولا مهاجرة ولا صلاحية؛ كود الخطأ `INVALID_REQUEST` ووثائقه كما هي.
- الفترات الصفرية تبقى مرفوضة عمداً (لا ليالٍ)؛ الاختبارات صارت تعبر عن «ليلة واحدة» فعلياً.
- لا بيانات حية ولا اتصال خارجي في هذا الإصلاح.
