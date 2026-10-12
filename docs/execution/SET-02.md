# SET-02 — عقود المسودة والتحقق والمعاينة والجاهزية والدفعات والعزل

الحالة: **VERIFIED_LOCAL (عقد تصميمي؛ لا عملية منفذة بعد)**.
التاريخ: 21 سبتمبر 2026.
التبعية: SET-01 VERIFIED_LOCAL.

## نطاق التفويض والحدود

- ضمن تفويض الجلسة: تصميم العقود وخطة البيانات وقائمة الأثر. لا كود خادمي ولا هجرة ولا عملية معلنة كمنفذة.
- لا تغيير لقرارات D أو ترتيب المراحل أو العزل أو النموذج المالي.

## المهام المنفذة

- 02.1 عقود المسودة: `GetSetupDraft` / `SaveSetupDraft` / `DiscardSetupDraft` + `If-Match` وإصدارات.
- 02.2 معاينة/تنفيذ: `PreviewSetupApply` / `ApplySetupDraft` بذرية وإعادة تحقق وحدود دفعات.
- 02.3 جاهزية: `GetSetupReadiness` (نواقص فقط، ليست تفعيلاً) و`ListSetupTemplates`.
- 02.4 أمن/نسخ/تكرار: مفاتيح `x-permission` و`x-csrf` و`Idempotency-Key`، ورموز الأخطاء، ومحاكاة قراءة فقط `SimulateSetupSale`.
- 02.5 ADR وترحيل: [docs/97](../97_set_setup_contract_adr.md) بقرارات S1..S12 وخطة جدول/أعمدة SET-03/05/06 وأسئلة مفتوحة.

## الملفات والعقود

- جديد: `docs/contracts/set.openapi.json` 0.1.0 (8 عمليات تصميمية).
- جديد: `packages/contracts/src/set.generated.ts` (مولّد، لا يعدل يدوياً).
- جديد: `docs/97_set_setup_contract_adr.md`.
- معدل: `scripts/contracts.mjs` (تحقق + توليد + عدّاد تصميمي)، `package.json` (`contracts:generate`).

## معايير النجاح/الرفض/الفشل

- نجاح: العقد يمر SwaggerParser؛ المولّد مطابق؛ `contracts:check` يذكر 8 عمليات تصميمية؛ ADR يغطي القرارات والترحيل والأسئلة المفتوحة.
- رفض: كل عملية كتابة تعلن `x-csrf` وصلاحية؛ الواجهة لا تعتمد على منطق جاهزية/صلاحية وحدها (يُختبر عند التنفيذ).
- فشل: أي عملية تُعلن منفذة دون تنفيذ واختبار — ممنوع؛ تبقى التسمية «design» حتى بطاقة الحزمة.

## التحقق

- `pnpm contracts:generate` → نجاح وتوليد `set.generated.ts` (`.local/verification/SET-02-generate.log`).
- `pnpm contracts:check` → **PASS**: «43 planned V1 ... و25 Phase 12 و8 design SET setup operations؛ generated types match» (exit 0).
- `pnpm check` → **99/99** بعد التصحيحات (`.local/verification/SET-03-check.log`).
- اختبار SET-03 الفرعي يثبت أن 4 عمليات منفذة مجموعة فرعية مطابقة للعقد التصميمي (`.local/verification/SET-03-test.log`).

## تصحيحات المراجعة (21 سبتمبر 2026)

كانت ثلاث فجوات في المسودة الأولى، أصبحت محددة:

1. **`preview_version` كان عدّاداً** لا يثبت أن المعاينة تعكس المدخل الحالي → صار **بصمة sha256** لـ(رقم المسودة + المدخل المطبع + `inventory_version`)؛ أي حفظ مادي أو تغير مخزون يبطلها، والتنفيذ يعيد الحساب ويرفض `PREVIEW_STALE`. (العقد + S5)
2. **حدود الدفعة كانت منقولة من `max_items_per_request`** الخاص ببنود الحجز → أُلغي النقل، وأُعلن عمود `max_setup_units_inline` مستقل بقيمة مبدئية 20 وأساس معلن (ذرية + مراجعة)، ورفض صريح `SETUP_BATCH_TASK_REQUIRED` فوقه حتى مهمة خلفية مختبرة في SET-04. (العقد + S7)
3. **الجاهزية كانت «ليست تفعيلاً» فقط** بلا مواضع فرض → حُدد الفرض الخادمي: `ApplySetupDraft` و`UpdateProperty` (SETUP→ACTIVE عند وجود مسودة غير مكتملة) يرفضان `SETUP_READINESS_BLOCKED`، مع بقاء تشغيل المنشآت القائمة وفتح البيع والقنوات كما هي. (العقد + S10)

## خطوة الاستئناف

SET-03.1: هجرة `property_setup_draft` + خدمات القراءة/الحفظ/الحذف بعملية `SaveSetupDraft` idempotent وIf-Match، ثم ربط معالج الواجهة بالمسودة الخادمية، ثم اختبارات النجاح/الرفض/التزامن و`pnpm test:property` المركزة.
