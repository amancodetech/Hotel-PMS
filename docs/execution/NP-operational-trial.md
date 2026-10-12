# تجربة تشغيل new pratama المعزولة — 9 أكتوبر2026

الحالة **PASS_API_TRIAL / REVIEW_PENDING / BROWSER_SOURCE_READY**. شغّل root التجربة `trial-apply-3` بنجاح exit0 بعد readiness4؛ سجل `journal-source3.json` مكتمل بتاريخ الأعمال 2026-10-10. هذا نجاح تجربة API، ولا يعلن قبولاً مستقلاً قبل مراجعة Astra أو نجاح متصفح قبل تشغيله. فوّض المستخدم تجربة كاملة داخل نسخة معزولة قبل Channex التجريبي، ووجّه root معالجة عائق التفعيل المثبت ضمن النطاق المحدود. التنفيذ GPT-6.1 Sol، مراجعة Astra مستقلة، وroot وحده مسؤول النسخ الاحتياطي والاستعادة والخدمات والبناء والتشغيل والتحقق المستقل. لا تعديل hotel ولا إعادة بناء المخزون ولا هجرة ولا توسعة G-13؛ Channex خارج نطاق هذه البطاقة. لم يشغل منفذ المصدر اختباراً أو خدمة أو اتصال قاعدة بيانات.

جولتا readiness من root توقفتا قبل أي API/business writes: الأولى لأن دور hotel_test لا يرى property دون scope، والثانية لاسم payment غير الموجود. حفظت الأدلة والسجل السابق STOPPED؛ لا ادعاء نجاح لهما. القراءة تستخدم اتصال owner للنسخة مع `default_transaction_read_only=on`، وأدوار API وWorker لا تتغير. صُحح المصدر إلى folio_payment، وطُوبقت جداول وأعمدة SQL كلها مع `backup-raw.json: source_schema` ومسارات API/DTO الحالية؛ هذه مراجعة مصدر، وليست نتيجة تنفيذ ناجحة. المحاولة التالية لتلك الجولة استعملت NP_TRIAL_RUN_ID=source2، ويظل سجلها محفوظاً بجانب السجل السابق.

المصدر [new-pratama-operational-trial.mjs](../../scripts/new-pratama-operational-trial.mjs) يستخدم loginAs/apiRequest القائمة دون startApi/stopApi. قاعدة وحيدة مسموحة `hotel_np_operational_trial_20261009`؛ يتأكد من URL المالك وAPI وWorker ومن `/proc` للعملية الفعلية، ومعرف الشركة والمنشأة الفعليين. يتطابق API_PORT وWorker WORKER_PORT مع منفذي طلبات المنسق، وAPI WEB_PORT مع origin؛ يجب أن تملك العمليات sockets الاستماع على127.0.0.1 فعلياً. مرجع geometry هو data-hotel.json السابق وبصمته المفوضة:97 مورداً ومنتجاً،73 ROOM،24 VILLA،44 موقعاً. المقارنة قبل كل كتابة، بما فيها replay، تحفظ المواقع والسعات والمعرفات والأبوة والمنتجات والتركيبات. قناة أو exposure موجودة توقف التجربة.

المتطلبات البيئية، **أسماء فقط دون قيم أسرار**: TEST_DATABASE_URL،DATABASE_URL،API_DATABASE_URL،WORKER_DATABASE_URL،IDENTITY_TEST_DB،API_PORT،WEB_PORT،NP_TRIAL_WORKER_PORT،NP_TRIAL_API_PID،NP_TRIAL_WORKER_PID،NP_TRIAL_BASELINE،NP_TRIAL_BASELINE_SHA256،NP_TRIAL_LOGIN=admin-a،وNP_TRIAL_RUN_ID الاختياري. WEB_PORT يحدد origin والدخول في harness الفعلي (افتراض5173؛ يضبطه المنسق حسب Web). الدخول يستعمل KEYCLOAK_TEST_USER_PASSWORD وKEYCLOAK_ADMIN_TOTP_KEY وKEYCLOAK_ISSUER القائمة للحساب، دون نسخ قيمها إلى سجل أو وثيقة.

واجهة التشغيل المحددة: API_PORT=4100،WEB_PORT=3000،NP_TRIAL_WORKER_PORT=4101؛ داخل عمليةWorker يكون WORKER_PORT=4101، وداخل العمليتين API_HOST=127.0.0.1. IDENTITY_TEST_DB اسم النسخة نفسه؛ الأربعURLs تتجه إلى النسخة نفسها والـhost/port نفسه. NP_TRIAL_BASELINE يشير إلى `.local/verification/new-pratama-location-completion-20261009/data-hotel.json`، وNP_TRIAL_BASELINE_SHA256 بصمته الموثقة. PID هو PID عمليةNode المستمعة الفعلية وليس shell أومشغل الخدمة. root يوفر إعدادات runtime/auth القائمة، ولا يحفظ أسرارها في الأدلة.

أوامر المنسق بعد fresh build والتحقق من ربط الخدمات بالنسخة الموجودة، مع NP_TRIAL_RUN_ID=source3 للجولة التالية بعد استيفاء الشروط المذكورة أدناه:

```sh
node --env-file=.env scripts/new-pratama-operational-trial.mjs --readiness
node --env-file=.env scripts/new-pratama-operational-trial.mjs --apply
```

يجب أن تطغى بيئة المنسق على أي قيم .env تخص hotel. readiness يقرأ geometry والجاهزية ويتأكد من فراغ الحجوزات والنزلاء والأسعار والمالية قبل السماح بالكتابة. apply يفعل **النسخة فقط**، ينشئ خطتي أسعار IDR اصطناعيتين للغرفة V04-R01 والفيلا الكاملة المؤرخة الحالية، وأسعار إشغال2 لسبعة أيام من business-day، ونزيلاً باسم اصطناعي وبريد example.invalid. التاريخ يثبت في journal؛ تغير business-day يوقف الاستئناف بدل تحريك السيناريو.

المحاولة الفعلية `trial-apply-1` توقفت عند أول PATCH للتفعيل برد HTTP422 / SETUP_MODE_UNSUPPORTED. سجل `journal-source2.json` يحتفظ بـactivate INTENT والرفض كما حدثا؛ لا تعديل له ولا ادعاء نجاح. سجلات الهوية والجلسات الخاصة بالدخول قد تغيّرت داخل clone، ويثبت root بقراءة owner أن property ما زالت SETUP بإصدارها السابق وأن المسودة والمخزون والأسعار والحجوزات والدفتر لم تتغير قبل اعتماد تشغيل source3.

الإصلاح المحدود في [property-service.ts](../../packages/backend/src/modules/property/application/property-service.ts) يستبدل رفض v2 العام بنفس فرع `isSetupV2 ? readinessV2 : setupReadinessIssues` المستخدم في GetSetupReadiness، تحت المعاملة وقفل property والتفويض القائم. لا شرط يتجاهل فجوات المسودة بسبب completed، ولا حذف أو تعديل مسودة أو إعادة apply. المسودة الجاهزة تسمح SETUP→ACTIVE؛ النواقص تظل HTTP422 / SETUP_READINESS_BLOCKED مع قائمة الفجوات نفسها، وv1 وعدم وجود مسودة يحتفظان بالسلوك القائم. هذا إصلاح تنفيذ لعقد الجاهزية الموجود، مرتبط بحماية completed في PSR-T14، دون تغيير قرار D أو invariant مالي أو فتح قناة.

اختبار الانحدار المصدر في [psr-draft-v2.pg.test.mjs](../../tests/property/psr-draft-v2.pg.test.mjs): تحديث توقع المسودة الناقصة إلى رفض جاهزية مطابق للقراءة، وتفعيل v2 مركبة مطبقة فعلياً دون تغيير المسودة أو IDs أو المواقع أو الموارد أو المنتجات أو التركيبات أو الأسعار المؤجلة أو القنوات المغلقة، ورفض version قديم ومستخدم شركة أخرى، ورفض فجوة عمليات أو فترة تركيب رغم completed=true. تشغيل البناء والانحدارات من اختصاص root؛ إيصالاته ومراجعة Astra هي مرجع قبول الإصلاح. source3 اكتمل فعلياً بعد إثبات root فراغ بيانات الأعمال السابقة؛ لم يعاد إنشاء clone أو تعديل سجلات المحاولات السابقة.

نتيجة source3: حجز الغرفة V04-R01 عُدّل إلى 13–15 أكتوبر ثم CANCELLED؛ حجز الفيلا الكاملة NP-V04-whole بتاريخ 10–12 أكتوبر CANCELLED؛ الإقامة الأخيرة 10–12 أكتوبر CHECKED_OUT مع الغرفة DIRTY وmaintenance مطابق للمرجع. نجحت حمايات تداخل whole/room وholds والتحرير بعد التعديل والإلغاء، وإعادة مفاتيح التأكيد والدخول والتحصيل والخروج دون أثر إضافي. الدفع CASH واحد SUCCEEDED بمبلغ 500000 IDR، مرتبط فعلياً بفوليو الإقامة النهائية؛ قيد PAYMENT واحد POSTED بمدين CASH ودائن FOLIO_GUEST متساويين. نتيجة checkout نفسها تحمل financial_clearance_state=PENDING، فلا تعني إغلاق folio أو تسوية الإيراد.

المصدر [new-pratama-operational-trial-browser.mjs](../../scripts/new-pratama-operational-trial-browser.mjs) جاهز ليشغله root قراءةً للنتائج المحفوظة. يستخدم نفس clone/URLs/PIDs/socket guards وloginAs؛ بعد الدخول يمنع كل HTTP غير GET/HEAD/OPTIONS ويحصر الطلبات في origin المحلي وscope الشركة والمنشأة. يقرأ journal-source3 فقط، ويتحقق من صفوف الحجوزات وحالاتها وفتراتها والنزيل الاصطناعي في dialogs، وصف CASH ومبلغه وعملته وتاريخه في صفحة المالية. واجهة تفاصيل الحجز الحالية لا تعرض أسماء المنتج أو المورد؛ ربط غرفة/whole هنا مثبت من استجابة GET التي أطلقتها الواجهة ومعرف المنتج في journal، ولا يدعي ظهوره كنص مرئي. اللغات ar/en-US/id-ID والعرضان390/1440 ينتجان13 صورة فقط. مقارنة count/hash لصفوف الأعمال قبل الدخول وبعد العرض تثبت عدم تغيرها؛ جداول الهوية والجلسة مستثناة لأن الدخول مفوض.

أمر root بنفس البيئة المعزولة وNP_TRIAL_BROWSER_RUN_ID جديد محدود بنفس regex، مثلاً readback1:

```sh
node --env-file=.env scripts/new-pratama-operational-trial-browser.mjs
```

الدليل الخاص في `browser-readback1/result.json` داخل مجلد التجربة مع الصور؛ المجلد حصري ولا يستبدل دليلاً سابقاً. هذه قراءة متصفح لنتائج API، وليست ادعاء تنفيذ رحلة الحجز والدفع بالنقر في UI. لا يبدأ المصدر أو يوقف خدمة، ولا يشغل migration أو reset؛ يجب أن ينفذ root القراءة قبل أي تغيير لاحق لصفوف الأعمال ضمن clone.

السيناريو: حجز غرفة يمنع whole وhold منافس؛ تعديل الفترة يحرر القديمة، ثم الإلغاء يحرر الجديدة. حجز whole يمنع الغرفة وhold منافس ثم إلغاؤه يحرر الغرفة. حجز نهائي، check-in، folio مرتبط، تحصيل CASH، check-out؛ يعاد تأكيد الحجز والدخول والدفع والخروج بالمفتاح نفسه لإثبات عدم التكرار. يتحقق المصدر من تحرير commitments بعد الإلغاء، حالة CHECKED_OUT وDIRTY، دفع واحد مرتبط فعلياً بالحجز عبر folio بمبلغ 500000 IDR، وقيد PAYMENT واحد POSTED بمدين CASH 500000 ودائن FOLIO_GUEST 500000 وتاريخ اليوم نفسه، وتوازن debit/credit لكل journal. housekeeping مطابق لـbaseline لكل الموارد؛ يسمح DIRTY فقط لغرفة V04-R01 بعد checkout INTENT/DONE مع بند CHECKED_OUT وحدث خروج واحد للغرفة. maintenance_state باقٍ مطابقاً بالكامل لأنه لا يتغير في checkout. لا يدعي تسوية folio أو إيراد ليلي أو night-audit أو ضريبة كاملة من فحص التوازن وحده.

الحفظ الافتراضي في `.local/verification/NP-operational-trial-20261009/journal.json`؛ عند NP_TRIAL_RUN_ID=source3 يكون `journal-source3.json`، وتبقى source2 السابقة محفوظة. run ID بطول 1..40، ويقبل `[a-z0-9][a-z0-9_-]{0,39}` فقط، ويدخل في مفاتيح idempotency. يحتفظ السجل بمعرف التشغيل والمصدر وبصمة baseline، وintent بالمفتاح والمسار والجسم قبل الشبكة، ونتائج API JSON والتحقق المالي دون headers/cookies/token أو URL اتصال. تغيير run ID لا يفوض إعادة trial على نسخة متغيرة: journal جديد يتطلب SETUP وفراغ بيانات الأعمال، وroot يثبت ذلك. الكتابة atomic وملفات خاصة. الأحداث والفشل تراكمية لا تُحذف؛ المنسق يحفظ أيضاً الأمر البيئي **بعد تنقيحه** وstdout/exit وإيصال التحقق المستقل. خطوة DONE يعاد استعمال نتيجتها. INTENT مجهول يسمح فقط بإعادة طلب معروف العقد idempotent (تأكيد،دخول،folio،دفع،خروج)؛ CREATE غير محمي أو PATCH مجهول يوقف التشغيل للمصالحة بالقراءة، دون إعادة عمياء أو تعديل journal دون إيصال root مستقل. تغيير المصدر أو baseline يرفض الاستئناف.

| طبقة أثر docs95 | الحالة والنطاق |
| --- | --- |
| المصدر | PASS_API_TRIAL بإيصال root؛ إصلاح تفعيل v2 محدود، ومصدر browser readback جاهز |
| API والعزل | العقود القائمة مع scope/PID/DB/geometry guards؛ نفس الجاهزية v1/v2 في GET وPATCH، لا عقد جديد |
| backend والمعاملة | تفعيل v2 نجح داخل clone؛ المراجعة المستقلة معلقة، دون تغيير RLS أو SQL أو migrations |
| DB والمالية | SQL قراءة فقط؛ الأسعار والنزلاء والحجوزات والمدفوعات عبر API داخل clone فقط |
| UI/اللغات/الهجرة | لا تغيير واجهة أو ترجمة أو migration؛ مصدر قراءة المتصفح بثلاث لغات وعرضين جاهز |
| اختبارات/API/browser | API PASS_API_TRIAL من root؛ رفض المحاولات السابقة محفوظ، browser لم يشغل بعد، وقبول Astra معلق |
| القنوات والقبول | Channex NOT_TESTED هنا؛ البيع الحقيقي مغلق وG-13 غير مقبول،ولا قبول ذاتي |

فجوات صريحة: لا قياس أداء منشآت كبيرة، لا ضيف حقيقي أو بطاقة أو مزود دفع،لا إثبات حجز OTA،ولا مراجعة بشرية UX. PASS_API_TRIAL مقصور على إيصال API داخل clone؛ قبول مستقل أو PASS_BROWSER_READBACK يحتاج إيصالاته الفعلية ومراجعة Astra.
