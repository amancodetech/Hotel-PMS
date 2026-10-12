# PSR-02 — عقد الانتقال إلى v2

23 سبتمبر 2026. **حفظ/قراءة/حذف مسودةv2 منفذة؛ إنشاء المخزون وشجرة المكان في مراحلهما التالية.**
المراجع: [المواصفة](../100_psr_implementation_spec.md)، [الجرد](PSR-00-audit.md)، [البطاقة](PSR-02.md).

## ما تغير فعلاً

أضيفت schemas V2 إلى set.openapi.json وأعيد توليد الأنواع. SaveSetupDraft يقبل union صريحاً: v1 بلا schema_version وv2 بالقيمة2. GetSetupDraft يعيد الإصدار المحفوظ دون ترقية تلقائية. DiscardSetupDraft يستخدم نفس الجيل والنسخة. Preview/Apply/Readiness وتفعيل المنشأة ترفض v2 بـSETUP_MODE_UNSUPPORTED حتىPSR-04؛ لا إنشاء مخزون من عقد التخزين. لا عمليةHTTP إضافية في هذه الدفعة.

المترجم `domain/setup-upgrade.ts` دالة نقية تتلقى مدخلاً v1 سبق التحقق منه مع حالة الاكتمال الخادمية. لا يستدعي قاعدة البيانات ولا يعدّل المسودة أو ينشئ موارد. النتيجة PROPOSED أو REVIEW_REQUIRED أو READ_ONLY؛ PROPOSED لا تعني جاهزية التنفيذ. يحتفظ بنسخة أصلية مستقلة، ويحجب candidate بالكامل عند أي التباس؛ لا ترقية جزئية لمجموعات سليمة مع إسقاط الأخرى.

## حدود البيانات المثبتة

- schema_version=2 إلزامي؛ draft_id/revision/completed حقول خادمية غير مسموحة داخل input.
- property/operations/pricing تحفظ معاني الحقول الحالية؛ غياب الحقل ليس null، وnull ليس قيمة افتراضية. pricing تقبل null مثل DTO الحالي. PUT استبدال كامل، وليس PATCH ضمنياً.
- 20 مجموعة، 200 عقدة مكان، 2000 وحدة صريحة لكل مجموعة: حدود parsing فقط؛ التنفيذ يخضع للحدود التجارية الفعلية ولعدد الموارد بعد توسيع الأجزاء والأسرة. نمط الأرقام الحالي يحتفظ بحده الحالي، ويُفحص إجمالي الخطة قبل التنفيذ.
- client_ref/group_ref/unit_ref/part_ref/bed_ref: من1 إلى64 حرف ASCII آمن؛ IDs القائمة UUID وتحتاج إعادة قراءة داخل النطاق.
- code داخلي1..40 حرفاً/رقماً/شرطة؛ code الجزء/السرير حتى16. يجب فحص طول الكود النهائي بعد تركيب بادئة الأب قبل أي كتابة. display_label من1 إلى120 ويمكن تكراره إذا اختلف مسار المكان.
- سعة البيع1..100 أو null/omitted لمسودة ناقصة؛ السرير سعة1 في المحرك. تفاصيل bedrooms_count/bathrooms_count أعداد0..100، notes حتى1000؛ لا إنشاء مخزون منها. هذه حدود إدخال جديدة وليست حدود سعة تجارية.
- تفاصيل الوحدات اختيارية؛ لا توليد غرفة نوم أو حمام عند غيابها. شجرة المكان kind صريحة أو null للموروث، display_order غير سالب. parent_ref المفقود في PATCH المستقبلي يبقي السابق، null يفصل الأب.
- units وpattern لا يجتمعان؛ beds وbeds_per_unit لا يجتمعان حتى لو كانت القيم null. المجموعة الناقصة تحفظ، لكن الجاهزية تمنع التنفيذ.
- الأسرّة حتى50، الأجزاء/موارد الجناح حتى20؛ حارس max_leaves الفعلي قد يكون أقل. FEMALE/MALE غير معروضتين في v2 حتى فرض الأهلية فعلياً.
- HOUSE قالب مستقل يقابل resource_type HOUSE لاحقاً. SUITE_STANDALONE يقابل ROOM، وSUITE_CONNECTED يحتاج IDs قائمة وإقرار اتصال وفترة مؤرخة. لا يعاد تفسير SUITE القديم.

## مصفوفة العمليات

الجذر P = `/tenants/{tenantId}/properties/{propertyId}`. كلها تستخدم النطاق الحالي؛ لا مسار عالمي للمواقع أو الوحدات.

| operationId              | الطريقة/المسار                                      | الصلاحية الفعلية الحالية | عمل v2 والتحقق التالي                                                                                            |
| ------------------------ | --------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| ListSetupTemplates       | GET /tenants/{tenantId}/setup-templates             | property.read            | توسيع معلن بالقدرات المنفذة فقط؛ PSR-04                                                                          |
| GetSetupDraft            | GET P/setup-draft                                   | property.read            | قراءة v1/v2 دون حفظ تلقائي؛ T10/T14                                                                              |
| SaveSetupDraft           | PUT P/setup-draft                                   | property.manage          | DTO مميز بالإصدار، CSRF، Idempotency-Key وIf-Match بجيل المسودة؛ T14/T15                                         |
| DiscardSetupDraft        | DELETE P/setup-draft                                | property.manage          | CSRF وIf-Match الحالي؛ حماية الجيل/المكتمل؛ T15                                                                  |
| PreviewSetupApply        | POST P/setup-draft/preview                          | property.read            | قراءة مع CSRF؛ بصمة الشجرة والسياسات والحدود؛ PSR-04                                                             |
| ApplySetupDraft          | POST P/setup-draft/apply                            | property.resource.manage | v2 يضيف composition.manage عند إنشاء تركيبات؛ اتحاد الصلاحيات قبل replay؛ CSRF/Idempotency-Key/If-Match؛ T10/T11 |
| GetSetupReadiness        | GET P/setup-readiness                               | property.read            | field_path/group_ref؛ لا جاهزية بيع من صلاحية schema فقط                                                         |
| SimulateSetupSale        | GET P/setup-simulation                              | property.read            | محرك الحصرية القائم؛ لا كتابة حجز                                                                                |
| ImportSetupUnits         | POST P/setup-unit-imports                           | property.resource.manage | CSV القديم محفوظ، لا تحويل رموز مركبة ضمنياً؛ CSRF/Idempotency-Key                                               |
| GetSetupSettings         | GET P/setup-settings                                | property.read            | قراءة التفاصيل/المكان لاحقاً؛ PSR-05                                                                             |
| ListSetupChanges         | GET P/setup-changes                                 | property.read            | سجل مرقم قائم، دون تغيير                                                                                         |
| GetSetupReconciliation   | GET P/setup-reconciliation                          | property.read            | انحدار التركيبات والأوراق؛ PSR-07                                                                                |
| PreviewCompositionChange | POST P/compositions/{compositionId}/change-previews | property.read            | CSRF؛ لا تعديل وعد قائم؛ PSR-06                                                                                  |
| ApplyCompositionChange   | POST P/compositions/{compositionId}/changes         | composition.manage       | CSRF/Idempotency-Key والبصمة القائمة؛ PSR-06                                                                     |
| PreviewSetupMigration    | POST P/setup-migration-previews                     | property.read            | CSRF؛ حدود الترحيل القائمة فقط                                                                                   |
| ApplySetupMigration      | POST P/setup-migrations                             | composition.manage       | CSRF/Idempotency-Key؛ لا تحويل كامل↔أجزاء مستخدمة                                                                |
| ListLocations            | GET P/locations                                     | property.read            | توسيع phase4 في PSR-03: parent_id/cursor/limit ومسار الأسلاف                                                     |
| CreateLocation           | POST P/locations                                    | property.resource.manage | توسيع phase4 في PSR-03: parent_id/kind/display_order؛ فحص الدورات/النطاق                                         |
| UpdateLocation           | PATCH P/locations/{locationId}                      | property.resource.manage | نسخة المورد الحالية، منع دورة/نقل خارج المنشأة؛ PSR-03                                                           |

ثبت عقد الإضافة في `x-psr-v2.planned_operations` داخلSET: PreviewSetupUnitAddition عبر POST P/setup-unit-additions/preview ثم ApplySetupUnitAddition عبر POST P/setup-unit-additions. هما DESIGN_ONLY حتىPSR-04؛ لا routes منشورة أو نجاح وهمي. المدخل مواقع ومجموعات فقط، دون تغيير عملة/توقيت/سياسة أو تسعير. التطبيق يتطلب CSRF/Idempotency-Key وIf-Match `property:<id>:<version>:<inventory_version>` وبصمة تربط النطاق والمدخل والمخزون والشجرة والسياسات والحدود. صلاحيةresource.manage واتحادcomposition.manage عند الحاجة، حالةSETUP/ACTIVE فقط، والمسودة المكتملة لا تلمس.

توسعات المواقع محفوظة تصميمياً في phase4 باسمLocationTreeNode/Input/Update/PageV2 وبوابةtree=true للقراءة؛ الطلب القديم يبقى متوافقاً. مسار الأسلاف وترقيم children مضبوط بالموقع الأب والنسخة، حدعمق32 وعددنتائج1..200. تغييرparent محكوم بقفلproperty ونسخةlocation؛ null يفصل وomitted يبقي السابق. التنفيذ والهجرة فيPSR-03، ولا تعلن الصفحات الحالية شجرة منفذة.

## قواعد التوافق وأسباب توقف الاقتراح

| v1                                                  | الاقتراح أو سبب المراجعة                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| EXCLUSIVE بقالب كامل وسعة صريحة                     | WHOLE_ONLY + CATEGORY؛ منتج الفئة الحالي لا يصبح منتجات EXACT لكل وحدة                 |
| WHOLE_OR_PARTS لفيلا/شقة بأجزاء وسعات صريحة         | WHOLE_AND_PARTS + EXACT، الأجزاء نفسها؛ لا مورد جديد للكامل                            |
| DORM/BEDS لغرفة واحدة وسعة معلنة مساوية لعدد الأسرة | BEDS_AND_PRIVATE + CATEGORY؛ يحافظ على بيع الغرفة الخاصة وفئة الأسرة                   |
| BEDS لعدة غرف                                       | LEGACY_CROSS_ROOM_BED_POOL؛ تقسيم الفئة القديمة يغير معناها، فلا يحدث تلقائياً         |
| SUITE                                               | CONNECTED_RESOURCE_RESOLUTION_REQUIRED؛ لا اختلاق UUID من الكود ولا تحويله لجناح مستقل |
| location_code                                       | LOCATION_RESOLUTION_REQUIRED؛ يحتاج lookup محكوماً بالعميل والمنشأة                    |
| capacity=null/omitted قد تعتمد على default قديم     | LEGACY_CAPACITY_REVIEW_REQUIRED مع حفظ الأصل؛ لا نقل default ضمني إلىv2                |
| FEMALE/MALE أو بيانات غير مستخدمة في النمط          | REVIEW_REQUIRED مع الأصل؛ لا إسقاطها أو تحويلها إلىMIXED                               |
| completed=true                                      | READ_ONLY ولا candidate، حتى لو كانت المدخلات ناقصة                                    |

المترجم ليس حارس API ولا يمنح صلاحية. completed يجب أن يأتي من صف خادمي مقفول عند الربط، لا من العميل. حفظv2 وقراءته وفحص مراجعUUID للموقع/الجناح داخل نطاقtenant/property منفذة الآن. المترجم لا يحوّل codes الموروثة إلىUUID تلقائياً؛ يتوقف للمراجعة. مقارنة آثار إنشاءv1/v2 الفعلية تبقىPSR-04 حيث ينفذ محركv2. لا تحويل لكيانات موجودة هنا.

## المعاملات والأخطاء المطلوبة عند الربط

authorize والنطاق والحالة قبل replay؛ قفل property ثم صف draft ضمن المعاملة الحالية. مفتاح مطابق يعيد نفس النتيجة، ومختلف409. If-Match القديم أو الجيل القديم يرفض وفق SET؛ preview قديمة412 PREVIEW_STALE. ترفض المراجع العابرة بـCROSS_SCOPE_REFERENCE دون تسريب بيانات. تجاوز الحد المباشر SETUP_BATCH_TASK_REQUIRED، وسقف الموارد LIMIT_EXCEEDED. الطرق غير المدعومة SETUP_MODE_UNSUPPORTED، والتحويل الملتبس لا ينشئ كيانات. لا nested transaction أو حفظ تدريجي خارج المعاملة.

الأسباب في جدول المترجم رموز تشخيص محلية فقط، ليست أخطاء HTTP جديدة منشورة. ينبغي ربطها بعقد الأخطاء/الترجمة عند عرضها للمستخدم، وعدم عرض نص داخلي خام.

## ضمانات الربط المنفذ

- التخزين في input JSONB القائم، مع schema_version داخله؛ لا عمود أو هجرة أو backfill. تُستخدم RLS وFK والمعاملة الحالية.
- parser مشترك صارم في الباك إند وcontroller: يرفض الحقول الخادمية والنسخة المجهولة، الجمع بين units وpattern، الجمع بين beds والعدد، دورات المواقع والمراجع المحلية المفقودة والأكواد المكررة. يرفض تناقض القالب والنمط، ويسمح بمسودة لم تكتمل قراراتها.
- GET لا يرقّي v1. طلب v2 الصريح مع ETag الحالي وحده يحفظ التغيير. إعادة v2 إلى v1 تُرفض بـCONFLICT لحماية الحقول الجديدة.
- completed يمنع Save وDiscard وحتى Save replay بعد الاكتمال. Apply replay القائم يبقى idempotent، ومفتاح تنفيذ جديد لمسودة مكتملة يُرفض.
- تُفحص صلاحية property.manage، ثم يُقفل property، ثم تُقرأ المسودة وتُفحص المراجع قبل replay. القارئ والعضو من شركة أخرى يُرفضان. حفظ v2 مقصور على SETUP؛ الإضافة بعد التفعيل لها عقد مستقل.
- تحديث المسودة محمي أيضاً بشرط completed=false في SQL؛ لا إعادة فتح باستبدال JSON.
- العميل يستخدم نوع المسودة versioned، لكن المعالج القديم يرفض تفسير v2 ويعرض خطأ النمط غير المدعوم. ربط واجهة الأربع خطوات كمعالج حفظ متكامل في PSR-05؛ نموذج PSR-01 يبقى معلناً كنموذج.

قرارات D والعزل والمحاسبة والقنوات الحية لم تتغير. T11 الخاص بتنفيذ v2 النهائي يبقى لاختبارات PSR-04؛ الاختبارات الحالية تثبت Save replay ورفض Applyv2، وليس إنشاء كيانات v2.

## تعديل اختبارات SET التابعة

خمسة اختبارات قديمة كانت تعيد تحرير المسودة بعد apply. استُبدلت هذه الفرضية باختبار رفض التعديل مع إبقاء نتيجة Apply replay كما هي. اختبار جاهزية التفعيل يثبت منع التفعيل مع المسودة الناقصة أولاً، ثم جاهزيتها بعد التنفيذ ورفض إرجاعها إلى ناقصة. اختبارات الأجنحة تُجهّز الموارد والمنتجات مسبقاً عبر API؛ ربط أسرة الغرفة في fixture يستخدم withOwner داخل قاعدة الاختبار فقط، دون حذف أو فتح مسودة مكتملة. اختبار الموقع المفقود يستخدم منشأة مستقلة. بقيت تأكيدات الحصرية ومنع استخدام غرفة أم كمرشح وحجب المراجع العابرة كما هي.
