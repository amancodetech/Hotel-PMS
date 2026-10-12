# برومبت إعادة التحقق المختصرة لـSET-08 (بعد إصلاح P1-01..03)

أنت المراجع المستقل نفسه لجولة `docs/execution/SET-08-independent-review.md` (حكم **NEEDS_FIXES**). المطلوب جولة مركزة تثبت زوال P1 الثلاثة وتؤكد عدم كسر ما كان سليماً، ثم إغلاق أو تثبيت الحكم. لا تعدّل ملفات المشروع؛ أي تعديل مؤقت يكون في `/tmp/opencode` أو يُرجَع فوراً مع إعادة التحقق من التشيكسوم.

## حالة الإصلاح المعلنة (تحقق منها ولا تفترضها)

- **P1-01:** البوابة صارت تفحص `setupReadinessIssues(draft.input)` لأي مسودة مخزنة بلا شرط `!draft.completed` (`property-service.ts`)، و`updateSetupDraft` تعيد `completed=false` عند التعديل (`setup-repository.ts`). اختبار انحدار جديد: `property-api.pg.test.mjs` → **12/12**.
- **P1-02:** اختبار الأداء صار يسجّل محاولات التسخين (`warmup_attempts`, `cold_undetermined`) ويسمح fail-closed عند 2000 مع احتسابه، ويشترط `AVAILABLE` صراحة عند 50/500. ثلاثة تشغيلات معزولة خضراء + تشغيلان كاملان **425/425**.
- **P1-03:** `searchBudgetForProperty` في `availability-service.ts` تحل محل المواضع الأربعة المثبتة في `commitment-service` (×2) و`group-service` و`revision-service`؛ لا وجود لـ`Date.now() + 500` في `packages/backend`.
- البصمة الجديدة بعد الإصلاح مسجلة في بطاقة SET-08؛ التشيكسوم يُعاد توليده ويجب أن يكون كل صفوفه OK.

## المطلوب إعادة إنتاجه

1. **P1-01:** شغّل `pnpm dev:stop` ثم `pnpm test:property:fast -- --filter=property-api` (يجب 12/12). ثم أعد سبرك المستقل (`/tmp/opencode/set08-review/zz-set08-rv-probe.pg.test.mjs` أو بنسخة `/tmp` جديدة) وتأكد: بعد apply ثم تحرير المسودة إلى ناقصة → `completed=false`، `GetSetupReadiness.ready=false`، و`PATCH ACTIVE` = **422** (لا 200).
2. **P1-02:** شغّل `--filter=inventory-scale` **مرتين متتاليتين** (يجب 5/5 في كل مرة) وافحص `scale-evidence-final.json`: صحة `available_samples`/`undetermined`/`cold_undetermined`/`warmup_attempts`، وأن `search_p95_ms` عند 2000 إمّا رقم على عينات AVAILABLE أو `null` مع UNDETERMINED مسجَّل بصراحة. ثم شغّل `pnpm test:property:fast` كاملاً مرة واحدة (يجب 425/425).
3. **P1-03:** افحص بـ`rg` عدم بقاء `Date.now() + 500`، وتأكد أن `searchBudgetForProperty` مستدعاة في المواضع الأربعة، وأن نص البطاقة/التقدم لم يعد يزعم غياب العمود.
4. **عدم الانحدار:** `pnpm test:distribution:fast` (48/48) و`pnpm test:integration` (PASS) و`pnpm check` (110/110) — حسب الوقت المتاح، الأولوية للطقم الكامل ثم check.
5. **البصمة/التشيكسوم:** أعد حساب البصمة بالطريقة المعتمدة وقارنها بالمسجلة، و`sha256sum -c CHECKSUMS.sha256`.

## المخرجات

- ألحق/أضف قسماً في `docs/execution/SET-08-independent-review.md` بعنوان «إعادة تحقق ما بعد الإصلاح»: ما أُعيد إنتاجه بالأوامر، نتيجة كل P1 (زالت/جزئية/قائمة)، أي ملاحظة جديدة (P2 فما فوق)، ثم الحكم النهائي: `GO`/`GO_WITH_NOTES`/`NEEDS_FIXES`.
- عند `GO`/`GO_WITH_NOTES`: حدّث `SET-progress.md` وبطاقة SET-08 إلى `VERIFIED_LOCAL` مع الإبقاء على SET-AT12..17 `NOT_TESTED` وبلا أي قبول إنتاجي أو تغيير لـD/G-13/EX-04.
