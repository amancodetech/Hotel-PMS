# SET-04 — قوالب الوحدات والمعاينة والتنفيذ والدفعات

الحالة: **VERIFIED_LOCAL (جولة R2)** — نُفذت إصلاحات [مراجعة SET-03/04](../98_set03_set04_review.md) وأُعيد التحقق في [تقرير R2](SET-R-reverification-report.md): 50/50 مركّز، 374/374 طقم كامل، 99/99 check، 29/29 بصري. اكتُشف عيب R03 متبقٍ (SET-R2-01) وأُصلح داخلالجولة مع توحيد عقد SET (nullable) وإعادة توليد الأنواع. الاستقلال محدود: الجولة نُفذت بطلب المستخدم.
التاريخ: 21 سبتمبر 2026.
التبعية: SET-03 VERIFIED_LOCAL ثم إصلاحات المراجعة.

## إصلاحات المراجعة (SET-R01..R07)

| Finding | الإصلاح | اختبار regression |
| --- | --- | --- |
| R01 حذف قديم | `DiscardSetupDraft` يقرأ `If-Match` ويقارن هوية الجيل والنسخة داخل القفل؛ عدم التطابق `412 SETUP_DRAFT_STALE` بلا حذف؛ غياب المسودة حذف idempotent `removed:false` | `SET-R01` |
| R02 جيل قديم | ETag صار `"<draft_id>:<revision>"`؛ يُفحص في الحفظ والحذف والمعاينة والتنفيذ؛ إعادة مفتاح من جيل سابق `409 draft_generation_changed` أو `draft_discarded`، ولا تُعرض بيانات الجيل السابق | `SET-R02` |
| R03 null/omitted | DTO يقبل `null` صراحةً لـ`name/timezone/base_currency/rental_mode/pricing`، والتطبيع يخزّن قيماً مطبعة؛ دورة قراءة→حفظ للمسودة الجزئية تعمل | `SET-R03` |
| R04 وعود غير مطبقة | التنفيذ يطبّق اسم المنشأة وتوقيتها وعملتها (بشرط `status=SETUP`)، وينشئ خطة سعر بإصدار سياسة وأسعار ليلية للفترة عند عدم التأجيل، ويعيد `created_rate_plan`؛ أوقات التشغيل/الفحص والتجهيز المضمون تُسجل كمهام متابعة صريحة بدل ادعاء التطبيق | `SET-R04` |
| R05 منشأة مؤرشفة | `assertPropertyConfigurable` + رفض أي حالة غير `SETUP` بـ`INVALID_STATE_TRANSITION` قبل أي كتابة | `SET-R05` |
| R06 معاينة تخترع 3 غرف | أُزيل الافتراض؛ غرف الفيلا/الشقة غير معلنة = 0 مع تحذير `parts_not_defined` حتى يحددها المستخدم (SET-05) | `SET-R06` |
| R07 استيراد DORM | قوالب الاستيراد المنفذة محددة صراحةً (ROOM/CABIN/TENT/VILLA/APARTMENT/SITE)؛ DORM وSUITE يُرفضان `TEMPLATE_UNSUPPORTED` في dry-run/apply بلا موارد | `SET-R07` |

ملاحظات المصدر الأخرى: وُضّح أن ذرية الاستيراد تخص الصفوف المقبولة (المرفوضة تُستثنى بالتصميم)، وأن DRY_RUN لا يكتب موارد لكنه يخزّن سجل idempotency، وأُضيف `preflight` (تعارض أكواد/حد مباشر/سعة موارد) للوضعين، وأُزيل `expires_at` غير المفروض من عقد المعاينة، وصار replay للتنفيذ يعيد النتيجة الأصلية قبل فحص النسخة. واجهة استيراد الملفات ما زالت غير منفذة (حد معلن).

## ما نُفذ

- **04.1–04.3 (معاينة/تنفيذ/دفعات داخل الحدود)**: `PreviewSetupApply` و`ApplySetupDraft` منفذتان.
  - معاينة قراءة فقط: أعداد لكل قالب، أول 50 كوداً، المستثنى، النواقص المانعة، حدود `max_units_inline` و`max_resources`.
  - `preview_version` **بصمة sha256** لـ(رقم المسودة + المدخل المطبع + `inventory_version`)؛ أي حفظ مادي أو تغيير مخزون يُبطلها والتنفيذ يرفض `412 PREVIEW_STALE`.
  - تنفيذ ذري داخل معاملة واحدة + قفل Property: إنشاء الموارد + منتج ACTIVE لكل مجموعة + مرشحين، ترقية `inventory_version` مرة واحدة، وسم المسودة `completed`.
  - الحدود: تجاوز `max_setup_units_inline` → `422 SETUP_BATCH_TASK_REQUIRED`؛ تجاوز `max_resources` → `422 LIMIT_EXCEEDED`؛ تعارض أكواد موارد/منتجات موجودة → `409 CONFLICT` قبل أي كتابة (لا إنشاء جزئي)؛ موقع غير موجود → `422 CROSS_SCOPE_REFERENCE`.
  - الجاهزية: نواقص الاكتمال → `422 SETUP_READINESS_BLOCKED`؛ طرق غير منفذة (أجزاء/أسرة) → `422 SETUP_MODE_UNSUPPORTED` صراحةً بدل دعم شكلي.
  - تكرار: مفتاح `ApplySetupDraft` يعيد النتيجة المخزنة بلا مضاعفة؛ التزامن: تطبيقان متزامنان ينتج أحدهما النجاح والآخر يفشل مغلقاً.
- **واجهة**: في وضع الخادم داخل خطوة المراجعة: زر «معاينة التنفيذ»، عرض الوحدات والنواقص والحدود، ثم «تنفيذ الآن» ورسالة النتيجة (وحدات/منتجات + مهمة تسعير عند التأجيل).

- **04.4 استيراد الوحدات dry-run/apply**: منفذ.
  - CSV بأعمدة `code,template,capacity,location`؛ حد 256KiB و500 صف؛ رفض المحتوى الخبيث (صيغ/محارف تحكم) والعناوين غير المطابقة.
  - `DRY_RUN`: تقرير لكل سطر (ACCEPTED/REJECTED) بأكواد أخطاء (`CODE_INVALID`, `TEMPLATE_UNKNOWN`, `CAPACITY_INVALID`, `DUPLICATE_IN_FILE`, `UNSAFE_CONTENT`, `LOCATION_UNKNOWN`) بلا أي كتابة.
  - `APPLY`: إعادة تحقق كامل داخل معاملة واحدة وقفل Property؛ يفرض حد التنفيذ المباشر وسقف الموارد ويرفض أكواداً موجودة (`409 CONFLICT`) أو ملفاً بلا صف صالح (`422 SETUP_IMPORT_INVALID/NO_VALID_ROWS`) دون إنشاء جزئي؛ ينشئ الموارد ويرقّي `inventory_version` ويسجل تدقيق `setup_units.imported`.
  - تكرار: نفس الملف بمفتاح جديد يوقفه فحص تعارض الأكواد؛ نفس المفتاح يعيد التقرير المخزّن عبر `api_idempotency` (عملية `ImportSetupUnits`).
  - العملية السابعة منفذة في عقد SET (9 تصميمية). لا واجهة استيراد بعد (تُدار عبر API) — حد معلن.

## ما لم ينفذ بعد

- **واجهة استيراد الملفات** في الشاشة (تقرير الأسطر معروض عبر API فقط).
- طرق `WHOLE_OR_PARTS` و`BEDS` مرفوضة بالتصميم حتى SET-05 (جناح/أجزاء/أسرة)، والأجنحة المتصلة كذلك.
- تحصين `ApplySetupDraft` بـ`SETUP_APPLY_IN_PROGRESS` غير لازم حالياً لأن قفل Property يفرض التسلسل.

## الملفات

- مجال: `packages/backend/src/modules/property/domain/setup.ts` (جاهزية، توسيع موحد، قالب).
- بيانات: `persistence/setup-repository.ts` (`findLocationByCode`, `listExisting*Codes`)، وحدة أخطاء `SETUP_MODE_UNSUPPORTED`.
- تطبيق: `application/setup-service.ts` (`previewSetupDraft`, `applySetupDraft`).
- API: `setup.controller.ts` بعمليتين جديدتين + `set-operations.ts` (6 عمليات منفذة)؛ `@HttpCode(200)`.
- واجهة: `apps/web/src/api/setup.ts` + `SetupWizardPreviewPage.tsx` + مفاتيح `setupWizard.apply.*` و`validation.*` و`errors.SETUP_MODE_UNSUPPORTED` باللغات الثلاث.
- عقد: `docs/contracts/set.openapi.json` (وصف 422 لـ`SETUP_MODE_UNSUPPORTED`) + ADR.

## التحقق

| الفحص | النتيجة | الدليل |
| --- | --- | --- |
| `pnpm test:property:fast -- --filter='setup-draft\|setup-apply\|setup-import\|set-r01-r07'` | **37/37** (يشمل 7 regression) | `.local/verification/SET-R-test.log` |
| `pnpm test:property:fast` كامل | **361/361 في 50 حزمة** | `.local/verification/SET-R-property-full.log` |
| `pnpm check` | **99/99** + عقود/lint/format/typecheck | `.local/verification/SET-R-check.log` |
| `scripts/set01-visual.mjs` | **29/29** و10 لقطات (ETag الجديد في الواجهة) | `.local/verification/SET-01/visual-run4.log` |
| `pnpm db:check` + الهجرة على dev | PASS (SET-03) | `.local/verification/SET-03-*` |
| جولة R2: مركّز 50/50، كامل 374/374، check 99/99، بصري 29/29 | PASS | `.local/verification/SET-R2/` |

تغطية اختبارات التنفيذ: معاينة بلا مسودة، إبطال البصمة بحفظ مادي، نواقص تمنع التنفيذ، تجاوز الحد المباشر، تعارض أكواد بلا إنشاء جزئي، رفض الأجزاء/الأسرة، موقع غير موجود، تطبيق مطابق للمعاينة (وحدات/منتج ACTIVE/مرشحون/completed)، إعادة idempotent، وتزامن تطبيقين.
تغطية اختبارات الاستيراد: تقرير dry-run كامل بلا كتابة، ملف بعنوان خاطئ، apply ينشئ المقبول فقط بالسعة والموقع، منع إعادة الملف، إعادة المفتاح idempotent، تجاوز الحد، مواقع مجهولة، ومنع العضو.

## خطوة الاستئناف

SET-05: فك `SETUP_MODE_UNSUPPORTED` للكامل/الأجزاء والأسرة والجناح المتصل عبر موارد أجزاء + تركيبة مؤرخة + منتجات، مع محاكاة حصرية واختبارات تداخل/تزامن، ثم ربط واجهة الأجزاء/الأسرة.
