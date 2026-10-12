# نتائج انحدار PostgreSQL ضمن مراجعة G-13

تنبيه8 أكتوبر: ظهر لاحقاً عيب مستقل **F-G13-R04/P2** في اكتشاف حزم Jest للهوية: `identity-current-1` هوexit1 مع24 حالة ناجحة في4 مجموعات و3 مجموعات فشلت قبل الاختبارات بسبب نسخة حزمة في`.local/backups`. لا يغير ذلك إيصالproperty-regression-2 الناجح، ولا يعد نتيجة هوية ناجحة. نفذ المنفذ الآخر تجاهل`.local` في إعدادَي الهوية والتوزيع؛إعاداتidentity-current-2 **PASS48/48؛7/7؛exit0** وdistribution-current-1 **PASS48/48؛11/11؛exit0** وcheck-final-1 **PASS184/184؛26/26؛exit0**. الحالةF-G13-R04 **CLOSED_LOCAL** بموافقة المراجع المستقلAstra؛إيصالاتcommand/source/log/exit مستقلة تحت`.local/verification/G13-current` بأسماء التشغيل المذكورة. لا يمحىidentity-current-1 الفاشل ولا تتحول النتيجة إلى قبولG13 خارجي. يتتبع [سجل العمل](G13-current-work.md) صف الأثر والإيصالات المطلوبة.

8 أكتوبر 2026 — **COVERED_REPAIR_PASS / FULL_REGRESSION_PASS_LOCAL**. هذه بطاقة لفشلين في اختبارات الانحدار؛ لا تعني اكتمال G-13 أو قبول اتصال حي. نطاق التعديل: ملفا اختبار فقط وهذه البطاقة؛ لا تغيير في كود التطبيق أو البيانات الفعلية.

الدليل الأول: `.local/verification/G13-current/postgres-property-regression-1.log`، exit 1؛ 561 اختباراً ناجحاً من563، و74 مجموعة ناجحة من76. زمن Jest المسجل207.886 ثانية. النتائج تخص هذا التشغيل ولا تستبدلها إصلاحات غير معاد اختبارها.

## G13-REG-01 — تعداد SET قديم

الفشل في `tests/property/setup-draft.pg.test.mjs`: اختبار `implemented SET routes are an exact subset of the design contract` احتفظ بقائمة قديمة، بينما سجل التشغيل أصبح يضم ست عمليات إضافية. تحقق المصدر من `apps/api/src/property/set-operations.ts` ومن التنفيذ الفعلي في `apps/api/src/property/setup.controller.ts` ومن عقد `docs/contracts/set.openapi.json`.

أضيفت العمليات الست إلى قائمة المتوقع الصريحة المرتبة: `AdvanceSetupBatch` و`ApplySetupUnitAddition` و`GetSetupBatch` و`PreviewSetupUnitAddition` و`SimulateSetupProduct` و`StartSetupBatch`. بقي التطابق التام للقائمة، وبقي فحص method/path/permission/CSRF لكل عملية مقابل العقد. لم يتحول الاختبار إلى subset مرن ولم تزال حماية عقد.

## G13-REG-02 — تداخل اشتراك fixture

الفشل في `tests/property/platform-support.pg.test.mjs`: توقع الخطة `P12SUPPLAN_20260919`، لكن tenant A المشترك يحمل خطة `P12PLAN_20260917` أنشأتها مجموعة P12 SaaS. `ensureSubscription` يستعمل `ON CONFLICT(tenant_id) DO NOTHING`، ولذلك لا يستبدل الاشتراك السابق ثم يفترض الاختبار خطته الخاصة. استعلام المنتج في `platform-repository.ts` يقرأ اشتراك tenant الفعلي؛ لا دليل هنا على خطأ في query التطبيق.

صار اختبار support يملك tenant A وtenant B اصطناعيين ومعرفين وslugs خاصين بكل تشغيل، وخطة ومفاتيح طلب مرتبطة بـrunId فريد. ينشئ صفّي tenant فقط تحت withOwner داخل قاعدة اختبار property المؤقتة، ثم يبني اشتراكاتهما. بوابة أول beforeAll ترفض التشغيل إذا لم يطابق IDENTITY_TEST_DB نمط `hotel_test_<run>_property` الذي ينشئه runner. لا حذف أو تعديل لاشتراكات مجموعات أخرى. يحتفظ runner وحده بمسؤولية التخلص من قاعدة الاختبار المؤقتة.

اختبارات المنح والخصوصية وRLS تستعمل tenant support الخاص. اختبار ملكية report export يستعمل tenant الأصلي لعضوية admin، لأنه يختبر مستخدم التشغيل المسجل فعلاً؛ لا ينقل عضويته إلى tenant support. عُزل عد audit قبل/بعد بالـtenant الخاص أيضاً. بقيت assertions الأصلية للخطة والحالة وحد الاستخدام والمنح والعزل والملكية.

## التحقق وإعادة الاختبار

التحقق المنفذ هنا: `node --check` للملفين نجح، وPrettier للملفين نجح. لم يشغّل معد الإصلاح PostgreSQL أو الخدمات أو seed أو إعادة اختبار تطبيق. نتائج PG بعد التعديل ما زالت PENDING.

أمر مركز للمنسق عبر runner الذي ينشئ قاعدة مؤقتة ويستهدفها، بعد توفير بيئته بالطريقة المعتادة:

```bash
pnpm test:property:fast '--filter=(setup-draft|platform-support|platform-saas)\.pg\.test\.mjs$'
```

إدراج platform-saas ضروري للتحقق من زوال تداخل المجموعات مع إبقاء ترتيب Jest المعتاد. لا تشغّل Jest مباشرة على قاعدة hotel ولا تعرّف IDENTITY_TEST_DB يدوياً لتجاوز الحارس. الأمر لا يبدأ من هنا؛ المنسق يختار توقيت التشغيل المعزول ويتحقق من عدم تنافس API على المنفذ ثم يحتفظ بالأمر والنسخة والـexit والنتائج. بعد النجاح المركز، يعاد نطاق الانحدار السابق نفسه إذا كان مطلوباً لإيصال G-13 النهائي؛ نجاح المركز وحده لا يثبت563/563.

| الإثبات | الحالة |
| --- | --- |
| قراءة أسباب الفشل ومراجعة المصدر | DONE |
| تحديث تعداد عقد SET دون إضعافه | PREPARED |
| عزل tenant/plan/grant fixtures | PREPARED |
| syntax وتنسيق ملفي الاختبار | PASS |
| إعادة PG مركزة مع platform-saas | PASS25/25؛3/3؛exit0 بالإيصالrepair-2 |
| إعادة نطاق PG السابق وإيصال الإغلاق | PASS563/563؛76/76؛exit0 بالإيصالproperty-regression-2 |

هذه الإصلاحات مستقلة عن جواب تنظيف التجارب أو إنشاء الشركة الجديدة وnew pratama. لا تستنتج منها قبول التنظيف أو التشغيل أو حسم سعة الفلل.

## محاولة إعادة مركزة 1 — فشل fixture مصحح

احتفظ المنسق بالدليل `.local/verification/G13-current/postgres-regression-repair-1.log`: exit1،21/25 ناجحاً،مجموعتان من3 ناجحتان،15.229 ثانية. نجح SET وplatform-saas؛تعطل beforeAll الخاص بـsupport لأن إنشاء الخطة أعاد400 بدلاً من201.

سبب الخطأ في fixture الجديدة:runId يحتوي hex بحروف صغيرة،بينما plan_code يقبل أحرفاً كبيرة وأرقاماً وunderscore فقط (`^[A-Z][A-Z0-9_]{2,63}$` في عقد platform). طول الرمز26 لا يتجاوز64؛المشكلة حالة الحروف. التصحيح الأدنى: `P12SUPPLAN_${runId.toUpperCase()}`. بقي توقع201 وكل assertions كما هي. إعادة PG بعد هذا التصحيح PENDING؛لا يعد نجاح syntax نجاحاً للتشغيل.

## إعادة مركزة2 — PASS ضمن النطاق المعاد فقط

إيصال المنسق: `.local/verification/G13-current/postgres-regression-repair-2.log` وملف الأمر المصاحب؛exit0،25/25 اختباراً و3/3 مجموعات ناجحة (`setup-draft` و`platform-support` و`platform-saas`). هذا يثبت إصلاحي تعداد SET وعزل fixtures مع تصحيح حالة حروف رمز الخطة في النطاق المركز المعاد. تبقى الجولتان الفاشلتان محفوظتين.

نجاح هذه الجولة المركزية وحده لم يثبت النطاق السابق563 اختباراً. أعاد المنسق ذلك النطاق لاحقاً في الجولة2 أدناه؛ نتيجة561/563 السابقة تبقى نتيجة الجولة1 الفاشلة، ولا يغلق أي منهماG-13 الخارجي.


## إعادة الانحدار الكامل2 — 8 أكتوبر2026

الإيصال `.local/verification/G13-current/postgres-property-regression-2.{command.json,source.json,log,exit}` يسجل **exit0؛563/563 اختباراً؛76/76 مجموعة** بعد إصلاحي fixtures. هذا تشغيل جديد ناجح للنطاق المعاد؛ لا تعديل أو محو لدليل الجولة1 الفاشلة561/563 أو محاولة repair-1 الفاشلة21/25.

تحقق المنسق المنفصل `postgres-location-tree-1` نجح14/14، و`check-current-1` نجح184/184 في26 مجموعة؛ كلاهماexit0 ولهما ملفات الأمر والمصدر والسجل والـexit تحت المجلد نفسه. تحقق الواجهة `withdrawal-ui-1` انتهىexit0 و45/45،failures0؛ التقرير `.local/verification/G13-current/withdrawal-ui-1/report.json` يوثق اللغات الثلاث وعرضي390/1440 وRTL وwarning الصحيح معreleased0/reconciling1 والاحتفاظ بالتخصيصات. نتيجة الواجهة محلية ببيانات اختبار اصطناعية ولا تثبت قناة رسمية. تبقى قدرة release بلا cutoff proof **BLOCKED_CAPABILITY**، ولا تمثل هذه نتائج اتصال رسمي أو قبولG-13 النهائي.
