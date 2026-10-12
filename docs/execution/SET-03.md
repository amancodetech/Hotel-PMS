# SET-03 — رحلة إنشاء المنشأة الأساسية وحفظ/استئناف المسودة

الحالة: **VERIFIED_LOCAL (جولة R2)** — شملتها إصلاحات [مراجعة SET-03/04](../98_set03_set04_review.md) وأُعيد التحقق منها في [تقرير R2](SET-R-reverification-report.md) (استقلال محدود: نُفذت بطلب المستخدم).
التاريخ: 21 سبتمبر 2026.
التبعية: SET-02 VERIFIED_LOCAL (تصميم) + تصحيحات المراجعة.

## نطاق التفويض

- تنفيذ محلي: هجرة + خدمات + صلاحيات + معاملات + API + ربط المعالج + اختبارات PostgreSQL ومتصفح.
- لا نشر ولا قنوات حية ولا حذف بيانات؛ الترحيل المطبق **إضافي** على قاعدة تطوير محلية ببيانات اصطناعية.

## السلوك المطلوب

- مسودة إعداد واحدة لكل منشأة، تُحفظ جزئيةً وتُستأنف، بلا اختراع قيم.
- حفظ idempotent: نفس المفتاح ونفس المحتوى يعيد النتيجة، ونفس المفتاح بمحتوى مختلف `409 CONFLICT`.
- فحص إصدار `If-Match`: الكتابة القديمة تفشل `412 SETUP_DRAFT_STALE` ولا تكتب فوق الأحدث.
- حذف المسودة يمنع كتابة قديمة أو إعادة تشغيل idempotent وهمية، ويعيد الإنشاء النظيف.
- عزل الشركة/المنشأة والصلاحية قبل أي إعادة تشغيل؛ منشأة ARCHIVED لا تحمل مسودة.

## الملفات والعقود والهجرة

- هجرة: `packages/backend/src/persistence/migrations/Migration20260921120000_setup_draft.ts` — جدول `property_setup_draft` (unique `tenant,property`, FK مركب، RLS + منع تغيير tenant، منح api/test، فهرس) + عمود `property_limits_profile.max_setup_units_inline` بقيمة 20 (الأثر: إضافة فقط؛ الرجوع عبر `down()` يحذف الجدول والعمود، ولا بيانات مستخدم).
- مجال: `packages/backend/src/modules/property/domain/setup.ts` (قوالب، تحقق بنيوي للمسودات الجزئية، توسيع النطاقات، تطبيع المدخل).
- بيانات: `persistence/setup-repository.ts` + `persistence/types.ts`.
- تطبيق: `application/setup-service.ts` (تخويل، قفل Property، idempotency عبر `api_idempotency` عملية `SaveSetupDraft`، CAS، تدقيق `setup_draft.saved/discarded`).
- API: `apps/api/src/property/setup.controller.ts` + `set-operations.ts` + تسجيل في الوحدة؛ 4 عمليات منفذة من أصل 8 تصميمية.
- عميل وواجهة: `apps/web/src/api/setup.ts` ووضع خادمي في `SetupWizardPreviewPage` عند `/setup-preview?propertyId=<id>` (تحميل/حفظ/تعارض/استئناف).
- مفاتيح `errors.SETUP_*` و`setupWizard.serverTitle/serverBanner` باللغات الثلاث.

## التحقق (أدلة)

| الفحص | الأمر | النتيجة | الدليل |
| --- | --- | --- | --- |
| هجرة/قاعدة فارغة | `pnpm db:check` | PASS | `.local/verification/SET-03-dbcheck.log` |
| هجرة قاعدة التطوير المحلية | `pnpm db:migrate` | PASS (إضافي) | `.local/verification/SET-03-migrate-dev.log` |
| عقد SET | `pnpm contracts:check` | PASS (8 تصميمية) | `.local/verification/SET-03-generate.log` |
| اختبار SET-03 مركّز | `pnpm test:property:fast -- --filter=setup-draft --bail` | **12/12** | `.local/verification/SET-03-test.log` |
| طقم Property كامل | `pnpm test:property:fast` | **336/336 في 47 حزمة** | `.local/verification/SET-03-property-full.log` |
| فحوص شاملة | `pnpm check` | **99/99** + عقود/lint/format/typecheck | `.local/verification/SET-03-check.log` |
| بصري (نموذج + خادمي) | `node --env-file=.env scripts/set01-visual.mjs` | **27/27** و9 لقطات | `.local/verification/SET-01/visual-run2.log` |

سيناريوهات الاختبار المغطاة: إنشاء أول، حفظ وإعادة طلب، تعارض مفتاح، تعارض نسخة، حفظ جزئي بلا قيم مخترعة، مدخلات غير صالحة (422/400)، عزل شركة/منشأة وصلاحية (بلا MFA/بلا manage)، فقد الصلاحية قبل إعادة الطلب، حفظ/حذف متزامنان، حذف ثم إعادة إنشاء بطلب قديم وبإعادة idempotent وهمية، ومنشأة مؤرشفة.

## قيود معلنة

- المعاينة/الجاهزية/التنفيذ/المحاكاة **غير منفذة** (SET-04/05)؛ لذلك `SETUP_BATCH_TASK_REQUIRED` و`SETUP_READINESS_BLOCKED` و`preview_version` معرفة في العقد لا في الكود بعد، والعمود `max_setup_units_inline` لا يُفرض بعد.
- رسائل 422 من الخادم تُعرض كملخص خطأ عام (بدون تعيين حقل/مجموعة لكل code)؛ يتحسن في SET-04 عند ربط المعاينة.
- وضع الخادم يتطلب `propertyId` صريحاً في الرابط؛ لا اختيار منشأة داخل المعالج بعد.

## خطوة الاستئناف

SET-04: معاينة الدفعات وتنفيذها (`PreviewSetupApply`/`ApplySetupDraft`) مع `preview_version` كبصمة، وفرض `max_setup_units_inline`/`max_resources`، ورفض `SETUP_BATCH_TASK_REQUIRED` فوق الحد، ثم قوالب/دفعات في الواجهة واختبارات التزامن.
