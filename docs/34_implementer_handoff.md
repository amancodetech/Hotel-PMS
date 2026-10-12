# تعليمات النموذج المنفذ وسجل التسليم

التاريخ: 13 سبتمبر 2026. تستخدم عند تفويض التنفيذ، وتضبط حجم المهمة وأدلتها لنموذج أقل تكلفة. هذا الملف لا يفوض البرمجة أو الاتصال الخارجي بذاته. الخطة الحالية وثائق فقط.

## طريقة الاستخدام

للبداية الحالية دون ملء خانات، استخدم [رسالة الانتقال للنموذج الجديد](36_next_model_start.md). القالب العام أدناه يبقى مناسباً للحزم والمراحل اللاحقة.

اختر حزمة واحدة من [قائمة التنفيذ](32_execution_work_packages.md). في الجلسة التالية أعط النموذج معرفها وحدود التفويض الفعلية ثم النص أدناه؛ لا تطلب «أنهِ النظام كله» في دورة واحدة. يبقى تعريف الحزمة في القائمة هو المرجع ولا يحتاج نسخ تاريخ المحادثة كاملاً.

يمكن أن يشمل التفويض مرحلة كاملة، وعندئذ ينفذ النموذج حزمها بالتتابع مع تسليم داخلي لكل حزمة ولا يكرر طلب التفويض بينها. لا يتوقف طلب موافقة محادثة على تغيير روتيني قابل للعكس داخل نطاق مصرح. البوابة غير المكتملة لا تصبح مغلقة لمجرد استمرار العمل، ولا يبدأ مرحلة جديدة خارج التفويض.

## برومبت التنفيذ

املأ حقلي الحزمة ونطاق التفويض فقط بحسب الطلب الفعلي. أسماء المسارات المقترحة في الخطة تتحقق من المستودع قبل استخدامها.

```text
أنت مهندس التنفيذ لمشروع HOTEL PMS SAAS داخل /home/omar/Desktop/Hotel.
الحزمة المطلوبة: <PACKAGE_ID>.
نطاق التفويض: <الحزمة أو المرحلة المصرح بها فعلاً؛ محلي أو بيئة خارجية محددة>.

الهدف تنفيذ الحزمة كاملة مع أدلة قابلة للمراجعة. اقرأ AGENTS.md ثم README.md،
docs/01_baseline.md وdocs/17_decisions_readiness.md، وحالة التنفيذ في docs/34_implementer_handoff.md.
اقرأ صف الحزمة ومقدمة مرحلتها في docs/32_execution_work_packages.md ومراجعها فقط،
ثم العقود والكود والاختبارات التي تعتمد عليها. docs/31_execution_master_plan.md يحدد المسار،
وdocs/33_channel_extension_contract.md يحكم عمل القنوات، وdocs/35_live_channels_runbook.md للمرحلة 13.

افحص الموجود فعلياً وgit status وأي تعليمات فرعية قبل التعديل. احفظ تغييرات المستخدم.
README وسجل الأدلة يوضحان تنفيذ الأساس؛ النصوص التاريخية لا تعيد فتح قرارات D المحسومة.
لا تنشئ مشروعاً موازياً أو تغير Stack أو ترتيب المراحل. لا تبدأ حزمة تابعة لبوابة فاشلة
وكأنها ناجحة؛ سجل العائق المحدد وأنجز العمل المستقل المصرح به إن وجد.

قبل الكود اكتب تحديثاً قصيراً: السلوك المطلوب، الملفات التي ستملك تعديلها، التبعيات،
اختبار النجاح والرفض والفشل. أكمل عقود النقل/الصلاحيات/الأحداث اللازمة للحزمة أولاً.
أنشئ بطاقة تنفيذ في سجل الحزمة بها أسماء الملفات الفعلية، حالات Given/When/Then،
أوامر الاختبار المتاحة، والتبعيات المؤجلة وحزمة إكمالها. أكملها بنفسك من المصادر المحددة؛
لا تحول تفاصيل التنفيذ الروتينية إلى أسئلة متكررة للمستخدم.
قسّم الحزمة الكبيرة إلى خطوات قابلة للفحص، مع إبقاء القبول الكامل مفتوحاً حتى اكتمالها.
لا تفترض أن endpoint في OpenAPI القديم منفذ، ولا تغير operationId بلا عقد موثق.

طبق Frontend -> API -> Application -> Domain -> Persistence.
Controller لا يحمل منطق الأعمال؛ الواجهة لا تستورد ORM؛ Worker لا يتجاوز التفويض أو المالك.
PostgreSQL هو ضمان المخزون؛ جميع كتاب المورد والحصة والتعديل يمرون بقفل Property نفسه.
لا Redis lock كضمان، لا عدادات يومية بدل مورد مستمر، لا تخصيص جديد قبل سحب Exposure مجهولة.
الحجز والclaims وinventory_version وAudit وOutbox تكتب معاً ضمن منسق معاملة واضح.
العلاقات تحمل Tenant/Property وتختبر RLS بدور التشغيل، لا دور migration.
أثر Idempotency يتحقق بعد إعادة التحقق من صلاحية صاحب الطلب الحالية.

في القنوات: العقد مستقل عن المزود، Channex Adapter أول، وملف قدرات لكل قناة.
لا أسماء OTA داخل منطق المخزون أو المالية؛ لا scraping أو affiliate بدل Supply API.
احفظ revision الآمنة ونتيجتها أو استثناءها القابل للاستئناف قبل ACK.
UNKNOWN وpartial ليست نجاحاً؛ provider accepted ليست channel verified.
احفظ EXTERNAL_CONFLICT ولا تختلق غرفة أو تسقط حجزاً خارجياً.
استعمل fixtures اصطناعية وخادم محاكاة؛ لا توصل حساباً حقيقياً خارج التفويض.
لا PAN/CVV/أسرار/raw ضيوف في الكود أو السجلات أو DLQ أو screenshots.

في المال: Decimal وIDR/USD وقواعد D-14؛ سجل posted immutable وتوازن لكل عملة.
لا تعتبر طلب Refund نجاحاً خارجياً؛ لا تعيد تحصيل Unknown؛ لا تجمع عملتين بلا FX موثق.
المراسلات للمرحلة 14، لا تنفذها ضمن القنوات الخمس للإطلاق.

اجعل الشاشة تجربة تشغيل حقيقية مربوطة بخدمة منفذة، مع scope ظاهر وحالات فارغة/تحميل/خطأ/منع
واتصال منقطع حيث تنطبق. استخدم نظام MUI الموجود وترجمات ar/id-ID/en-US وRTL/LTR.
لا مؤشرات وهمية أو أزرار نجاح على وظائف مستقبلية. الكتابة الحساسة تنتظر حقيقة الخادم.
اختبر الواجهة عبر Computer Use الفعلي: نقر وكتابة وتمرير وkeyboard وتغيير viewport وreload.
وثق المتصفح والأحجام واللغات والحالات والصور، أصلح ثم أعد الفحص.
لا تستخدم Playwright بديلاً لهذا الشرط دون موافقة المستخدم. إن غابت الأداة سجل العائق
وأكمل الفحوص الأخرى ولا تدعِ القبول البصري أو اختبار جهاز جوال حقيقي.

اكتب اختبارات المخاطر المطلوبة في صف الحزمة، بما فيها الفشل والتكرار والعزل عند انطباقها.
استخدم PostgreSQL فعلياً للتزامن/RLS والمعاملات وfixtures synthetic مع clock/seed قابل للإعادة.
أثبت الحالة النهائية للبيانات والأحداث، لا مجرد HTTP status أو snapshot للواجهة.
نفذ الفحوص المركزة ثم pnpm check، واختبارات التكامل المعنية.
لا تنشئ أمراً موثقاً باسم test جديد قبل إضافته فعلياً؛ سجل الأمر الدقيق ونتيجته.
لا تستبدل اختباراً فاشلاً بـmock أو skip أو تخفيف assertion لتبدو النتيجة ناجحة.

استخدم apply_patch للتعديلات اليدوية. لا تعرض .env ولا تغير secrets بلا حاجة.
التزم بموافقات البيئة التقنية، ولا تعالج حظر sandbox بالتحايل.
لا publish/شراء/مراسلة/حجز إنتاجي أو حذف بيانات دون التفويض الملائم الموجود.

قبل إنهاء الجلسة: راجع diff والتغيرات غير المتوقعة، حدث عقد/وثائق الوحدة والتتبع وسجل الحزمة،
نفذ pnpm checksums ثم sha256sum -c CHECKSUMS.sha256.
شغل التطبيق المحلي عند عمل الواجهة واترك رابطاً وطريقة إيقافه وفق دليل التشغيل.
لا تعد تشغيل خدمة مستخدمة أو تختبر أعطالها دون مراعاة سياق استخدامها.
سلم المنفذ، الفحوص ونتائجها، غير المنفذ وسببه، الأدلة، والحزمة التالية داخل التفويض.
لا تعلن مرحلة PASS أو إنتاجاً جاهزاً إذا بقي اختبار أو بوابة خارجية مطلوبة غير مكتملة.
```

## قالب نتيجة الحزمة

ينشأ عند التنفيذ `docs/execution/<PACKAGE_ID>.md`؛ هذا المسار مقترح للأدلة النصية وليس موجوداً تلقائياً. الصور/logs الخام synthetic تحت `.local/verification/<PACKAGE_ID>/` المستبعدة من الحزمة؛ السجل يحتفظ بالنتيجة واسم الأثر وبصمته. إن أريد نقل الأدلة ينشأ تصدير منقى صريح دون ملفات الجلسات أو الأسرار.

```text
الحزمة / التاريخ / المنفذ:
النسخة: commit إن وجد، وإلا بصمات الملفات ذات الصلة؛ لا commit مختلق.
الحالة: PLANNED | IN_PROGRESS | BLOCKED | IMPLEMENTED | VERIFIED | ACCEPTED
السلوك المنفذ وحدوده:
المراجع: CAP / BR أو INV أو DIST / AT / D / G ذات الصلة
الاعتمادات والبوابات السابقة:
الملفات المعدلة وسبب كل مجموعة:
تغيير API / schema / permission / event والمستهلكون المتأثرون:
Migration: كيفية الترقية، البيانات السابقة، فحص القيود، خطة forward fix/restore:
الاختبارات: الأمر، البيئة/الإصدارات، fixture/seed، النتيجة، الأثر النهائي:
Computer Use: المتصفح، viewport، اللغة، الحالات، مسار الأثر/البصمة أو العائق:
الأمان: النطاق والبيانات المنقاة وأثر الإبطال حيث ينطبق:
العيوب المتبقية ومعرفاتها:
المراجعة: اسم/جلسة المراجع، النتيجة والملاحظات المغلقة:
نتيجة البوابة وما لم يثبت:
الحزمة التالية المحددة ونطاق التفويض المتبقي:
```

IMPLEMENTED تعني وجود الكود، VERIFIED تعني اجتياز أدلة الحزمة المطلوبة، ACCEPTED تعني مراجعة التسليم وإغلاق ما يلزم. غياب Computer Use يمنع VERIFIED لشاشة يلزم قبولها بصرياً؛ يسجل نجاح الاختبارات الآلية منفصلاً. حالة BLOCKED تحتاج سبباً وحزمة مستقلة ممكنة وخطوة إزالة العائق، ولا تستخدم لإخفاء فشل يمكن إصلاحه.

## فحص نقطة البداية والاستئناف

قبل أول تعديل شغل فحوص القراءة المتاحة: `git status --short`، تحقق البصمات إن كانت موجودة، واقرأ manifests ودليل التشغيل وسجل آخر حزمة. لا تعتبر اختباراً موثقاً سابقاً اختباراً ناجحاً للنسخة الحالية. شغل الفحص المناسب قبل التغيير لتسجيل baseline، وبعده لإثبات السلوك الجديد؛ عطل البيئة يسجل منفصلاً عن عطل الكود.

عند إعداد هذه الخطة كانت ملفات المشروع untracked في Git؛ لذلك `git diff` وحده قد يكون فارغاً رغم وجود تغييرات. احفظ قائمة الملفات وبصماتها قبل العمل في `.local`، وقارن ملفاتك عند التسليم، إلى جانب `git status` و`git diff` حين ينطبقان. لا تنشئ commit أو remote لمجرد الحصول على diff، ولا تعتبر تغير بصمة موجوداً قبل عملك تعديلاً تملكه. لا تحدث CHECKSUMS قبل تسجيل الفروق التي وجدتها.

اختبارات المرحلة 1 وعبارات أدواتها قد تصف أن مسارات الأعمال غير منفذة. عند تنفيذ endpoint حقيقي عدل التوقع أو النص الذي أصبح قديماً مع اختبار السلوك الجديد؛ احتفظ باختبارات الصحة والأمان والمسارات غير المنفذة فعلاً. لا تغير اختبار رفض إلى قبول قبل تنفيذ العملية، ولا تحذف فحوص الأساس جماعياً.

سجل الحزمة يحتوي نقطة استئناف واحدة دقيقة: آخر خطوة مثبتة، الخطوة التالية، الملفات المتغيرة، أوامر فشلت وسببها، العمليات المحلية اللازمة وطريقة إيقافها. عند طلب المستخدم «أكمل» اقرأ هذا السجل وتحقق من الملفات قبل إعادة العمل؛ لا تعيد اختيار Stack أو بناء المرحلة المقبولة.

المراجعة المستقلة تعني جلسة مراجع لم تنفذ الحزمة تقرأ العقود والتغييرات والأدلة. لا يكتب المنفذ اسم مراجع مختلقاً أو يعتبر مراجعة نفسه استقلالاً. عند غياب هذه المراجعة تسجل REVIEW_PENDING وتبقى البوابة الحساسة غير مقبولة؛ يمكنه إصلاح العيوب والتحضير المستقل ضمن تفويضه دون تقديم المرحلة التابعة. لا يتطلب ذلك تشغيل وكلاء فرعيين تلقائياً.

## مراجعة مستقلة للحزم الحساسة

يستخدم هذا الطلب في جلسة مراجعة بعد التنفيذ، ولا يفوض spawning تلقائياً:

```text
راجع الحزمة <PACKAGE_ID> وفق docs/32_execution_work_packages.md وسجل أدلتها.
ابدأ بالعيوب حسب الخطورة مع file:line، واذكر مثال فشل قابل للتكرار وأثره.
افحص العقد وسياق Tenant/Property والمعاملة والنسخ والتكرار والفشل الجزئي.
في المخزون افحص كل الكتّاب وwhole/parts واستمرار الموارد وExposure UNKNOWN.
في القنوات افحص crash windows قبل/بعد commit/ACK وأقدم revisions والكاتب العالق.
في المالية افحص التوازن والقيود المنشورة وUnknown/refund والعملة وحاجز اليوم.
راجع أن الاختبار قد يفشل فعلاً عند كسر الثابت؛ نجاح mock أو البناء ليس دليلاً للمجال.
لا تعدل النطاق لتسهيل القبول. إن لم تجد عيوباً اذكر حدود المراجعة والاختبارات غير المنفذة.
قدم ACCEPT / CHANGES_REQUIRED / BLOCKED_EVIDENCE مع السبب؛ لا اعتماد بلا أدلة.
```

المراجعة المستقلة إلزامية قبل G-03 وG-05 وG-06 وG-08 وG-10 وG-13. لا يلزم تشغيل نموذج أغلى لكل ترجمة أو نموذج إدخال. العيوب التي تمس العزل أو ازدواج المورد أو فقد revision أو تكرار المال أو فتح بيع مجهول تمنع البوابة؛ لا تؤجل بدعوى أن المرحلة التالية ستصلحها.

## سجل التقدم الحالي

| النطاق | الحالة بتاريخ الخطة | الدليل / التالي |
|---|---|---|
| تصميم 0 وقرارات المجال | SATISFIED تصميمياً | docs/17 و23..27 |
| تنفيذ أساس 1 | ACCEPTED (13 سبتمبر 2026) | docs/29 وdocs/execution/P01-01.md؛ اكتمل P01-01 |
| P02-01 عقد القنوات | VERIFIED | docs/execution/P02-01.md |
| P02-02 المحاكي | VERIFIED | docs/execution/P02-02.md |
| P02-03 تخزين Inbox/Outbox | ACCEPTED محلياً ضمن G-02 | [المراجعة المستقلة وإغلاق F3-A](41_g02_review_acceptance.md)؛ يعاد اختبار العزل في P03 |
| P02-04 تشغيل/retry/DLQ | ACCEPTED محلياً ضمن G-02 | [قرار القبول وحدوده](41_g02_review_acceptance.md) |
| P02-05 Channex adapter | ACCEPTED لاختبارات المرحلة المحلية فقط | [قرار القبول](41_g02_review_acceptance.md)، لا اتصال حي أو قبول مزود |
| P02-06 conformance وG-02 | ACCEPTED محلياً، شرط دخول P03 مستوفى | [قرار المراجعة](41_g02_review_acceptance.md)، 79/79 و38/38؛ لا تبدأ P04 تلقائياً |
| P03-01 المصادقة والجلسات | REMEDIATED / REVIEW_PENDING | docs/execution/P03-01.md وG03-R1-R6.md وG03-F1-F3.md؛ 48/48 في test:identity بعد F1..F3 |
| P03-02 النموذج المؤسسي | IMPLEMENTED / VERIFIED محلياً | docs/execution/P03-02.md |
| P03-03 RLS وأدوار التشغيل | REMEDIATED / REVIEW_PENDING | [سجل G03-F3-A-B](execution/G03-F3-A-B.md)؛ سجل المخالفات مغلق على دوري التشغيل والحجر نافذ على الاتصال وتوابعه واكتشاف العمل |
| P03-04 محرك الصلاحيات والتدقيق | IMPLEMENTED / VERIFIED محلياً | docs/execution/P03-04.md |
| P03-05 الواجهة والعقود | IMPLEMENTED / VERIFIED محلياً (Playwright) | docs/execution/P03-05.md؛ visual:phase3 23/23 |
| P03-06 التحقق النهائي وG-03 | REMEDIATED / REVIEW_PENDING | [إغلاق G03-F3-A/B](execution/G03-F3-A-B.md)؛ F1/F2 مقبولتان وF3-A/F3-B مغلقتان محلياً؛ توقف قبل P04 |
| P04-01 المنشآت والموارد الأساسية | IMPLEMENTED / VERIFIED محلياً (18/18) | docs/execution/P04-01.md |
| P04-02 المنتجات والمجموعات | IMPLEMENTED / VERIFIED محلياً | docs/execution/P04-02.md |
| P04-03 التركيبات المؤرخة | IMPLEMENTED / VERIFIED محلياً | docs/execution/P04-03.md |
| P04-04 الشاشات وربط الملكية وG-04 | IMPLEMENTED / VERIFIED محلياً؛ G-04 مغلق محلياً | docs/execution/G-04.md وP04-04.md؛ P05 بقرار المستخدم ومراجعة مستقلة |
| P05-01 خطط الأسعار | IMPLEMENTED / VERIFIED محلياً | docs/execution/P05-01.md |
| P05-02 مخطط الالتزام | IMPLEMENTED / VERIFIED محلياً | docs/execution/P05-02.md |
| P05-03 البحث المحدود | IMPLEMENTED / VERIFIED محلياً | docs/execution/P05-03.md |
| P05-04 الحجز المؤقت والحجب | IMPLEMENTED / VERIFIED محلياً | docs/execution/P05-04.md |
| P05-05 الحصص والسحب | IMPLEMENTED / VERIFIED محلياً | docs/execution/P05-05.md |
| P05-06 الشاشة | IMPLEMENTED / VERIFIED محلياً | docs/execution/P05-06.md |
| P05-07 السباقات والقياس | IMPLEMENTED / VERIFIED محلياً | docs/execution/P05-07.md |
| G-05 المخزون والتوفر | VERIFIED محلياً / ACCEPTED محلياً (قرار المستخدم 14 سبتمبر 2026؛ المنخفضات F2/F3/R5/R9/R10/R11/O1..O4 موثقة كحدود؛ لا يفتح G-06/الإنتاج) | docs/52 الجولة الثانية؛ docs/51 الإصلاحات؛ P06 وفق docs/49 |
| P06-01 النموذج والقراءات | IMPLEMENTED (خلفية+واجهة) | docs/execution/P06-01.md؛ بصري 14/14 |
| P06-02 التأكيد/التعديل/الإلغاء | IMPLEMENTED (خلفية+اختبارات؛ UI في P06-06) | docs/execution/P06-02.md؛ 6/6 |
| P06-03 Group/Split/No-show | IMPLEMENTED (خلفية+اختبارات؛ UI في P06-06) | docs/execution/P06-03.md؛ 4/4 |
| P06-04 مستهلك revisions | IMPLEMENTED (خلفية+اختبارات؛ UI في P06-06) | docs/execution/P06-04.md؛ 4/4 |
| P06-05 الاستيراد | IMPLEMENTED (خلفية+اختبارات؛ UI في P06-06) | docs/execution/P06-05.md؛ 4/4 |
| P06-06 التقويم والمسار الكامل | IMPLEMENTED (محلياً؛ G-06 مقبول محلياً) | docs/execution/P06-06.md؛ بصري 23/23 |
| G-06 الحجوزات والنزلاء | ACCEPTED محلياً (قرار المستخدم 15 سبتمبر 2026؛ F7..F13 حدود موثقة) | [docs/58](../58_phase6_focused_review.md)؛ [docs/execution/G-06.md](G-06.md)؛ فتح P07 فقط |
| P07-01 Board/تخصيص/Check-In | IMPLEMENTED / VERIFIED محلياً | [docs/execution/P07-01.md](P07-01.md)؛ property 7/7 |
| P07-02 نقل/تمديد/Split/خروج مبكر/مغادرة جزئية | IMPLEMENTED / VERIFIED محلياً | [docs/execution/P07-02.md](P07-02.md)؛ property 10/10 |
| P07-03 Check-Out تشغيلي وأحداث P09 | IMPLEMENTED / VERIFIED محلياً | [docs/execution/P07-03.md](P07-03.md)؛ property 8/8 |
| P07-04 واجهة Front Desk وF7 والعملية 10 | IMPLEMENTED / VERIFIED محلياً | [docs/execution/P07-04.md](P07-04.md)؛ revision-consumer 9/9 |
| P07-05 البصريات والتحقق الكامل | IMPLEMENTED (محلياً؛ G-07 REVIEW_PENDING) | [docs/execution/P07-05.md](P07-05.md)؛ visual:phase7 30/30 وproperty 171/171 |
| P08-01 أساس المالية (Money/Journal/BusinessDay) | IMPLEMENTED / VERIFIED محلياً؛ G-08 ACCEPTED محلياً (16 سبتمبر 2026) | [docs/execution/P08-01.md](P08-01.md)؛ check 85/85 وproperty 188/188 وcontracts 2 عمليات Phase 8 |
| P08-02 Folio/Charges/Payers والباقات والدوريات والودائع | IMPLEMENTED / VERIFIED محلياً؛ G-08 ACCEPTED محلياً (16 سبتمبر 2026) | [docs/execution/P08-02.md](P08-02.md)؛ property 200/200 وcontracts 14 عملية Phase 8 |
| P08-03 التحصيل وOTA وpayment states | IMPLEMENTED / VERIFIED محلياً؛ G-08 ACCEPTED محلياً (16 سبتمبر 2026) | [docs/execution/P08-03.md](P08-03.md)؛ payments-finance 9/9 وcontracts 18 عملية Phase 8 |
| P08-04 Refund/Reversal/Adjustment/Fx | IMPLEMENTED / VERIFIED محلياً؛ G-08 ACCEPTED محلياً (16 سبتمبر 2026) | [docs/execution/P08-04.md](P08-04.md)؛ corrections-finance 9/9 وcontracts 25 عملية Phase 8 |
| P08-05 Invoice/CreditNote/Cashier + واجهة المالية والبصريات | IMPLEMENTED / VERIFIED محلياً؛ G-08 ACCEPTED محلياً (16 سبتمبر 2026) | [docs/execution/P08-05.md](P08-05.md)؛ billing-finance 5/5 وvisual:phase8 25/25 وcontracts 32 عملية Phase 8 |
| P08-06 clearance/ذمة/مغادرة + UI/بصريات + G-08 | IMPLEMENTED / VERIFIED محلياً؛ G-08 ACCEPTED محلياً (16 سبتمبر 2026) | [docs/execution/P08-06.md](P08-06.md)؛ finance-integration 10/10 وphase8 34/34 وcontracts 35 عملية Phase 8 |
| إصلاح P08 بعد المراجعة المستقلة (F-RVW8-01..03) | REMEDIATED ثم مغلق ضمن G-08 المقبولة | [docs/68](68_phase8_fix_session.md)؛ الفحص المركّز [docs/69](69_phase8_focused_review.md) (إغلاق مؤكد + F-RVW8F-01 أطقم أُغلق بإصلاح اختباري محصور بتشغيلين 237/237) |
| G-08 المالية التشغيلية | **ACCEPTED محلياً (قرار المستخدم، 16 سبتمبر 2026)**؛ يفتح P09 فقط | [docs/execution/G-08.md](execution/G-08.md)؛ [docs/69](69_phase8_focused_review.md)؛ برومبت P09 [docs/70](70_phase9_execution_prompt.md) (لا P10 ولا إنتاج) |
| P09-01 مهام التجهيز/التعيين/الفحص/الإقامة الطويلة/DND | IMPLEMENTED / VERIFIED محلياً (بلا واجهة) | [docs/execution/P09-01.md](execution/P09-01.md)؛ operations-tasks 9/9 وcontracts 11 عملية Phase 9 |
| P09-02 أوامر العمل وOOO/OOS/Disruption وإعادة الفتح | IMPLEMENTED / VERIFIED محلياً (بلا لوحة) | [docs/execution/P09-02.md](execution/P09-02.md)؛ operations-work-orders 5/5 وcontracts 17 عملية Phase 9 |
| P09-03 اللوحة/الوردية/الإشعارات/الواجهة وG-09 | IMPLEMENTED / VERIFIED محلياً (Playwright استثناء معلن) | [docs/execution/P09-03.md](execution/P09-03.md) و[G-09](execution/G-09.md)؛ operations-board 4/4 وvisual:phase9 28/28 وcontracts 22 |
| G-09 التدبير والصيانة | **ACCEPTED محلياً (قرار المستخدم، 16 سبتمبر 2026)**؛ يفتح P10 فقط؛ المراجعة المستقلة لـG-10 إلزامية | [docs/execution/G-09.md](execution/G-09.md)؛ [docs/72](72_g09_focused_review.md) PASS؛ إغلاق العيوب [docs/73](73_g09_fix_session.md)؛ برومبت P10 [docs/74](74_phase10_execution_prompt.md) ومراجعته [docs/75](75_phase10_review_prompt.md) |
| P10-01 إعداد/تحقق إغلاق اليوم | IMPLEMENTED / VERIFIED محلياً | [docs/execution/P10-01.md](execution/P10-01.md)؛ check 87/87؛ property 267/267 في 37 حزمة |
| P10-02 حاجز CLOSING ورسوم الليالي والإغلاق والاستئناف | IMPLEMENTED / VERIFIED محلياً (kill/resume عامل فعلي PASS) | [docs/execution/P10-02.md](execution/P10-02.md)؛ `.local/verification/P10-02/kill-resume-summary.json` |
| P10-03 شاشة اليوم والعقد والبصريات | IMPLEMENTED / VERIFIED محلياً (Playwright استثناء معلن) | [docs/execution/P10-03.md](execution/P10-03.md)؛ visual:phase10 19/19 وcontracts 5 عمليات |
| G-10 التدقيق الليلي وإغلاق اليوم | **ACCEPTED محلياً (قرار المستخدم، 16 سبتمبر 2026)**؛ يفتح P11 فقط | [docs/execution/G-10.md](execution/G-10.md)؛ المراجعة المستقلة [docs/76](76_phase10_independent_review.md) = PASS بعد إغلاق F-RVW10-01 [docs/77](77_phase10_fix_session.md) (267/267 داخل نافذة الفشل، check 87/87، checksums 588/588)؛ لا P11 منفذة ولا إنتاج |
| P11-01 الأرقام التشغيلية (Occupancy/ADR/RevPAR/Arrivals/Departures/Pickup) | IMPLEMENTED / VERIFIED محلياً | [docs/execution/P11-01.md](execution/P11-01.md)؛ reporting-operational 9/9 وcontracts 3 عمليات Phase 11 |
| P11-02 المال/الضريبة/الصندوق/القنوات وMulti-Property | IMPLEMENTED / VERIFIED محلياً | [docs/execution/P11-02.md](execution/P11-02.md)؛ reporting-financial 8/8 (مطابقة Journal في اللقطة نفسها) |
| P11-03 الشاشة والتصدير الخاص وإغلاق G-11 | IMPLEMENTED / VERIFIED محلياً (Playwright استثناء معلن) | [docs/execution/P11-03.md](execution/P11-03.md)؛ reporting-exports 7/7 مع عامل حقيقي، visual:phase11 14/14 و8 لقطات |
| G-11 التقارير | **ACCEPTED محلياً (قرار المستخدم، 16 سبتمبر 2026)**؛ يفتح P12 فقط عبر برومبت التنفيذ الجاهز [docs/83](83_phase12_execution_prompt.md) برسالة مستخدم صريحة (وجوده لا يمنح تفويضاً) | [docs/execution/G-11.md](execution/G-11.md)؛ المراجعة المركزة [docs/79](79_phase11_review_prompt.md)/[docs/80](80_phase11_independent_review.md) PASS WITH FINDINGS وإصلاح [docs/81](81_phase11_fix_session.md) وإعادة تحقق مستقلة [docs/82](82_phase11_fix_reverification.md) PASS (295/295 في 40 حزمة، check 87/87، checksums 617/617)؛ لا P13 ولا إنتاج |
| P12-01 خطط/استحقاقات/حدود/سياسة/فوترة إدارية | IMPLEMENTED / VERIFIED محلياً | [docs/execution/P12-01.md](execution/P12-01.md)؛ platform-saas 9/9 وcontracts 13 عملية؛ سباق حد ذري وقياس idempotent وعدم مساس الدفتر |
| P12-02 دورة العميل onboarding/suspend/reactivate/close | IMPLEMENTED / VERIFIED محلياً | [docs/execution/P12-02.md](execution/P12-02.md)؛ platform-lifecycle 6/6؛ AT-27 واستمرار استقبال القناة وإعادة التفعيل بنسخة |
| P12-03 لوحة المنصة والدعم المؤقت وقياس limits/audit | IMPLEMENTED / VERIFIED محلياً (Playwright استثناء معلن) | [docs/execution/P12-03.md](execution/P12-03.md)؛ platform-support 4/4 وvisual:phase12 19/19 و6 لقطات؛ SEC-006/AT-S05 |
| P12-04 إصلاح F-RVW12-01..03 (idempotency onboarding، تحصين الفاعل، دليل القاعدة) | IMPLEMENTED / VERIFIED محلياً | [docs/execution/P12-04.md](execution/P12-04.md)؛ idempotency عالمي للـonboarding مع 409 IDEMPOTENCY_CONFLICT وسباق مغلق، وربط `p_actor` بسياق الجلسة في 8 دوال، property 314/314 في 43 حزمة، checksums 663/663 |
| G-12 SaaS ودورة العميل | **ACCEPTED محلياً (قرار المستخدم، 17 سبتمبر 2026)**؛ يفتح P13 فقط عبر برومبت التنفيذ الجاهز [docs/86](86_phase13_execution_prompt.md) برسالة مستخدم صريحة (وجوده لا يمنح تفويضاً) | [docs/execution/G-12.md](execution/G-12.md)؛ المراجعة المركزة [docs/84](84_phase12_review_prompt.md)/[docs/85](85_phase12_independent_review.md) PASS WITH FINDINGS وإصلاح [docs/execution/P12-04.md](execution/P12-04.md) (property 314/314 في 43 حزمة، check 87/87، checksums 663/663)؛ لا قنوات حية ولا إنتاج بلا تفويض خارجي لكل فعل (EX-01..05) |
| حزم P13 | **LOCAL PACKAGES COMPLETE / NOT ACCEPTED؛ EX-01..05 بوابات خارجية** | البطاقات [P13-01](execution/P13-01.md)..[P13-07](execution/P13-07.md) وسجل [G-13](execution/G-13.md)؛ سجل EX [ex-registry.json](execution/channels/ex-registry.json)؛ المراجعة المستقلة الإلزامية [docs/87](87_phase13_review_prompt.md) والقبول قرار المستخدم |
| مراسلات/توسع P14 | DEFERRED | D-15 وdocs/19 |

عند أول تنفيذ تضاف سطور الحزم المنجزة هنا مع رابط سجلها، ولا يعاد نسخ جدول الحزم كله إلى حالات نجاح افتراضية. حدث docs/27 وREADME عند تغير حقيقة بوابة، لا لمجرد انتهاء جلسة.

## متى يتوقف المنفذ ومتى يستمر

- خطأ محلي أو اختبار فاشل داخل التفويض: يصلحه ويعيد الفحص؛ لا يكرر سؤال التفويض.
- غياب أداة قبول لازمة: يسجل العائق ويكمل العمل المستقل الممكن، ولا يستبدل الأداة أو يغلق البوابة صامتاً.
- اختلاف وثيقة عن كود: يثبت الاثنين ويصحح التوثيق إذا كان التنفيذ مطابقاً للقرار؛ خلاف ثابت مجال يسجل قبل تغييره.
- نقص قدرة مزود لازمة لـD-20: يبقي التفعيل مغلقاً ويحدد الدليل المطلوب؛ لا يفعّل shared inventory بديلاً صامتاً.
- فعل خارج التفويض الحالي: يجهز الملفات والمقارنة وخطة الاختبار والرجوع الممكنة أولاً؛ طلب التفويض يتعلق بالفعل الخارجي المحدد فقط.
- نهاية السياق: يكتب نقطة الاستئناف والمعرفات والأوامر والعيوب في سجل الحزمة، ثم يواصل من السجل دون إعادة تصميم أو فقد عمل المستخدم.
