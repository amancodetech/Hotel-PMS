# PSR-08 — مصفوفة التتبع والأدلة

4 أكتوبر 2026 — **PSR-08 ACCEPTED_LOCAL بقرار المستخدم الصريح «اقبل وما التالي»**، ضمن النطاق والحدود الموثقة والمراجعة المستقلة PASS_LOCAL. هذا القرار يخص08 وحدها؛ PSR-01..04 تبقى REVIEW_PENDING، و06/07 VERIFIED_LOCAL، وUX01..08 NOT_TESTED، وG-13 NOT ACCEPTED. لا قبول إنتاجي أو نشر أو اتصال حي.

إغلاق التحقق السابق: البصمات885/885، وfinal-http-2 أعاد HTTP200 للخدمات الثلاث، وفق `.local/verification/PSR-08/final-receipt.json`. هذا إيصال تاريخي قبل قرار القبول؛ إيصال تغييرات توثيق القبول سيكون `.local/verification/PSR-08/acceptance-receipt.json` بعد تجديد البصمات والتحقق منها.

التالي المقترح فقط: حسم فجوات مراجعات PSR-01..04 لكل بطاقة، وإجراء UX بمشاركين مستقلين؛ ثم مراجعة جاهزية P13 الحالية وEX دون اتصال حي. لم يبدأ هذا العمل.

4 أكتوبر2026؛ **VERIFIED_LOCAL / PASS_LOCAL مستقل**. المراجع [حالات القبول](../101_psr_acceptance_cases.md) و[بطاقة08](PSR-08.md). الحالة أدناه تحقق محلي محدد، وليست ACCEPTED_LOCAL أو قبولاً إنتاجياً. PSR-01..04 تبقى REVIEW_PENDING في السجل.

كل معرف مرتبط بنسخة مصدره في `.local/verification/PSR-08/case-source-map.json`؛ ملفات `.source.json` بجانب أوامر التشغيل هي بصمات النسخة المختبرة. `source-before-tests.json` جرد البداية فقط. مقارنة19 manifest تاريخية في `historical-source-comparison.json` تميز MATCH عن التغيير. لا تعميم182/182 أو870/870 من07 على الحالات الأخرى.

## دليل المصادر

كل مسار أدلة أدناه نسبة إلى `.local/verification/`. A/L/I نتائج منفصلة وليست جولة70/70.

| الرمز       | الاختبار الفعلي ونسخة المصدر                                                                                    | السجل الخام والنتيجة                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| A           | psr08-acceptance/psr-draft-v2/psr-apply-v2/psr04-review/set08-journey؛ PSR-08/postgres-acceptance-1.source.json | PSR-08/postgres-acceptance-1.log/.exit: خمس حزم المنفذ ناجحة ضمن51/55؛ الجولةexit1 بسبب أربع fixtures مستقلة فاشلة،15.045s.                    |
| L           | psr-location-tree منفرداً؛ PSR-08/postgres-location-search-2.source.json                                        | PSR-08/postgres-location-search-2.log/.exit:14/14،exit0،10.477s بعد إصلاح البحث؛ الجولة القديمة14/14 محفوظة منفصلة.                            |
| I           | psr08-independent؛ PSR-08/postgres-independent-3.source.json                                                    | PSR-08/postgres-independent-3.log/.exit:5/5،exit0،3.384s. الجولة2 كانت4/5 بسبب توقعnullable بعد تطبيعv1؛ محفوظة.                               |
| C61         | psr06-1-independent؛ manifest وتقييم أثرAstra                                                                   | PSR-06.1-independent/postgres-final.log؛ وتقرير PSR-06-1-independent-review.md.                                                                |
| C62         | psr-addition-v2 +psr06-2-independent؛ manifest تاريخية وتقييم أثر                                               | PSR-06.2/implementation-addition-final.log وPSR-06.2-independent/postgres-final.log؛ مراجعة06.2.                                               |
| C63         | psr-archive +psr06-3-independent؛ المصدر المعني محفوظ                                                           | PSR-06.3/postgres-run-1.log وPSR-06.3-independent/postgres-final.log؛ مراجعة06.3.                                                              |
| O7          | psr07-operational؛ PSR-07-final/source-manifest.json                                                            | PSR-07.1/postgres-operational-final.log:20/20.                                                                                                 |
| I7          | psr07-1-independent +set07-sharing                                                                              | PSR-07.1-independent/postgres.log:8/8،exit0؛ مراجعة07.1.                                                                                       |
| Q7          | psr07-channel-quota +psr07-2-independent                                                                        | PSR-07.2/postgres-fix.log:9/9 في حزمتين،exit0؛ مراجعة07.2.                                                                                     |
| B1 partial  | scripts/psr08-visual.mjs محفوظ في مجلد البروفة؛ browser-1.source.json                                           | PSR-08/browser-1.log/.exit:exit1؛ PSR-08/browser-1791019643952/result.json يحتوي13 نجاحاً قبلE03. لا PASS للجولة كلها.                         |
| B3          | source.mjs +browser-3.source.json                                                                               | PSR-08/browser-3.log/.exit:23/23،exit0؛ browser-1791019903385/browser.json. تشغيل منE02 بعد تصحيحselector، لا إعادةE01 بلا سبب.                |
| B4          | source.mjs +browser-locales-4.source.json                                                                       | PSR-08/browser-locales-4.log/.exit:14/14،exit0؛ browser-1791065330997/browser.json وقياسعرض390 الحقيقي.                                        |
| S           | psr08-search-independent/performance/property-api؛ postgres-search-1.source.json                                | postgres-search-1.log/.exit:17/17،exit0؛ search-performance-1791091294864/result.json:42 عينة،صفر فشل.                                         |
| BS2 partial | browser-search-2.source.json                                                                                    | search-browser-1791091497931/result.json: أربع assertions ناجحة لبحث المورد وترتيب السعة والتصفية، ثم timeout لمحدد موقع fixture؛ exit1 محفوظ. |
| BS          | scripts/psr08-search-visual.mjs؛ browser-search-3.source.json                                                   | search-browser-1791091615800:26/26،exit0،errors=[]؛ القيود المرئية R03 أصلحت لاحقاً.                                                           |
| BL          | scripts/psr08-search-labels-visual.mjs؛ browser-search-labels-4.source.json                                     | search-labels-1791091898962:109/109،exit0،25.58s؛3 لغات،390 وتكبير200،errors=[].                                                               |
| P1          | source.mjs +postgres-performance-1.source.json                                                                  | PSR-08/postgres-performance-1.log/.exit:1/1،exit0،8.229s؛ performance-1791000466325/performance.json.                                          |
| P2          | source.mjs +postgres-performance-mutation-1.source.json                                                         | PSR-08/postgres-performance-mutation-1.log/.exit:2/2،exit0،7.79s؛ performance-1791019542695/performance.json:117عينة.                          |

## الحالات37

الاختبارات نسبة إلى `tests/property/` ما لم يذكر المتصفح. حالة prior تعني دليل سابق صالح لنطاقه مع مطابقة الملفات المعنية أو تقييم أثر موثق، ولا ترفع الحزمة السابقة إلى قبول.

| المعرف  | الحالة                                          | الاختبار الفعلي                                                            | المصدر والدليل            | الحدود والفجوات                                                                                                        |
| ------- | ----------------------------------------------- | -------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| PSR-T01 | VERIFIED_LOCAL                                  | psr04-review: nineteen rooms batch; browser E01                            | A + B1 partial            | 19 EXACT، باستثناء113، مع خطوات ذرية قابلة للاستئناف؛ ليست معاملة واحدة فوق الحد.                                      |
| PSR-T02 | VERIFIED_LOCAL                                  | psr08-acceptance: nineteen CATEGORY                                        | A                         | 19 مورداً و19 مرشحاً وفئة واحدة وصفر تركيبات؛ hold واحد يستهلك مورداً واحداً.                                          |
| PSR-T03 | VERIFIED_LOCAL                                  | psr-apply-v2: whole villa                                                  | A                         | مورد واحد، أربع غرف نوم وصفية، بلا أبناء مخزون؛ دورة التشغيل السابقة في07 محدودة بمصدرها.                              |
| PSR-T04 | VERIFIED_LOCAL / prior scope                    | psr-apply-v2 connected suite; psr07-operational standalone; browser suites | A + O7 + B3/B4            | المستقل ROOM؛ المتصل يستخدم موارد موجودة دون إنشاء ذرات. تمييز الواجهة باللغات الثلاث.                                 |
| PSR-T05 | VERIFIED_LOCAL                                  | psr08-acceptance: three PARTS_ONLY                                         | A                         | الأجزاء A/B/C ذرية، الحاوية غير مباعة وصفر منتج كامل.                                                                  |
| PSR-T06 | VERIFIED_LOCAL                                  | psr08-acceptance siblings; psr-apply-v2 hold race                          | A                         | الثلاثة مستقلة، الكامل مرفوض بعد الجزء؛ سباق كامل/جزء في fixture بورقتين.                                              |
| PSR-T07 | VERIFIED_LOCAL                                  | psr08-acceptance: six beds each mode                                       | A                         | fixture مستقلة لكل نمط؛6 BED، خاص/سرير متنافيان؛ معالجv2 MIXED فقط.                                                    |
| PSR-T08 | PRIOR_SCOPED                                    | psr07-operational; set07-sharing; psr07-1-independent                      | O7 + I7                   | رفض مباشر واستيراد ومجموعة وconsumer فعلي محلي؛ FEMALE سياسة تاريخية اصطناعية، لا اختيار مثبت بالمعالج.                |
| PSR-T09 | VERIFIED_LOCAL                                  | psr-location-tree inverse moves/cycles                                     | L                         | منع الدورة تحت السباق وقيد DB؛ أعيد منفرداً بعد تعديل قراءة الشجرة ونجح.                                               |
| PSR-T10 | VERIFIED_LOCAL                                  | psr-draft-v2 + psr-location-tree scope/RLS                                 | A + L + S                 | reader/foreign tenant/property؛ S يثبت اختلاف المنشأة داخل الشركة؛ A/L وproperty-api يثبتون tenant/RLS.                |
| PSR-T11 | VERIFIED_LOCAL                                  | psr-apply-v2 replay; psr04-review batch replay                             | A                         | النتيجة والمعرفات ثابتة، مع حماية اختلاف الطلب؛ رحلة فقد الرد E04 منفصلة.                                              |
| PSR-T12 | VERIFIED_LOCAL                                  | psr04-review block; psr-apply-v2 location/limit revisions                  | A                         | قدم البصمة412، دون كتابة جزئية بعد تغير الحجب أو الموقع أو الحد.                                                       |
| PSR-T13 | VERIFIED_LOCAL                                  | psr-apply-v2 last product; psr04-review injected failures                  | A                         | تراجع المواقع والمخزون والأسعار والتدقيق والتكرار في قاعدة معزولة.                                                     |
| PSR-T14 | VERIFIED_LOCAL (independent scoped)             | psr-draft-v2; psr08-independent v1→v2                                      | A + I                     | null/omitted/zero والتطبيع العقدي محفوظة؛ المكتمل محمي. توافق BEDS متعدد الغرف غير حتمي ولذلك يبقىv1.                  |
| PSR-T15 | VERIFIED_LOCAL                                  | psr-draft-v2 two writers + discard/recreate                                | A                         | جيل قديم مرفوض، وكاتب واحد يفوز؛ لا last-write-wins.                                                                   |
| PSR-T16 | PRIOR_SCOPED + impact reviewed                  | psr-addition-v2; psr06-2-independent                                       | C62                       | VILLA/APARTMENT/HOUSE واتجاها التحويل مرفوضان؛ لا تنفيذ تحويل مخزون ضمن هذه الدفعة.                                    |
| PSR-T17 | PRIOR_SCOPED + impact reviewed / new regression | psr06-1-independent; psr-location-tree rename/move                         | C61 + L                   | Astra حصر تعديل الأرشفة في patch.state؛ rename/move لا يمر به. المصدر06.1 ليس MATCH كاملاً.                            |
| PSR-T18 | PRIOR_SCOPED                                    | psr-archive; psr06-3-independent                                           | C63                       | الأرشفة تحمي الأطفال والالتزامات والحصة UNKNOWN وتحفظ التاريخ؛ لا DELETE cascade.                                      |
| PSR-T19 | PRIOR_SCOPED                                    | psr-addition-v2 + independent batches                                      | C62                       | إضافة مستقلة إلى SETUP/ACTIVE، بلا إعادة فتح المسودة المكتملة.                                                         |
| PSR-T20 | VERIFIED_LOCAL                                  | psr-location-tree additive upgrade                                         | L                         | ترقية schema اصطناعية تحفظ IDs والحالات والمراجع والقيم؛ ليست restore لقاعدة مستخدم.                                   |
| PSR-T21 | VERIFIED_LOCAL                                  | psr-location-tree safe/unsafe downgrade + real migrator                    | L                         | قبلv2 رجوع مثبت، وبعد الاستخدام رفض صريح مع بقاء سجل الهجرة؛ تشغيل منفرد.                                              |
| PSR-T22 | PRIOR_SCOPED                                    | psr07-operational category continuity                                      | O7                        | ليالٍ متاحة في غرف مختلفة لا تحقق إقامة متصلة في مورد واحد.                                                            |
| PSR-T23 | PRIOR_SCOPED                                    | psr07-channel-quota + psr07-2-independent                                  | Q7                        | WHOLE1/PARTS2، UNKNOWN والسحب والسباق؛ المحاكي ليس قناة حية.                                                           |
| PSR-T24 | VERIFIED_LOCAL + prior operational scope        | psr-location-tree labels; psr07-operational exact assignment               | L + O7                    | تكرار الاسم101 ممكن مع المسار، code فريد؛ التخصيص يحفظ ID.                                                             |
| PSR-T25 | VERIFIED_LOCAL (independent API)                | psr08-independent unsupported SITE/hour/composite-category                 | I                         | طلباتHTTP مباشرة ترفض بلا أثر؛ اختبار الدالة القديم وحده لم يكن كافياً.                                                |
| PSR-T26 | VERIFIED_LOCAL                                  | psr-location-tree CSV cases                                                | L                         | dry-run بلا أثر، ثم accepted subset ذري وفق سياسة الاستيراد المعلنة؛ لا ادعاء all-file atomic.                         |
| PSR-T27 | PRIOR_SCOPED + impact reviewed                  | psr06-2-independent calendar/property midnight/version                     | C62                       | تقويم حقيقي وسنة كبيسة وحدود اليوم والنسخة؛ لا normalization صامت لتاريخ مستحيل.                                       |
| PSR-T28 | VERIFIED_LOCAL                                  | psr08-acceptance descriptive cot/shared pool                               | A                         | لا BED أو تركيب جديد، وحجز فيلا لا يحجب الفيلا الشقيقة؛ المرفق وصف فقط.                                                |
| PSR-E01 | VERIFIED_LOCAL (scoped partial run)             | psr08-visual hotel Tab/Enter +19 batch                                     | B1 partial                | 13 assertions نجحت قبل فشلE03 بالسكريبت؛ E01 ليست نتيجة جولة مستقلةexit0.                                              |
| PSR-E02 | VERIFIED_LOCAL                                  | psr08-visual villa4 bedrooms + mixed apply                                 | B3                        | ثلاث وحدات بأنماط مستقلة، حفظ فعلي؛ ليس preview وحده.                                                                  |
| PSR-E03 | VERIFIED_LOCAL                                  | psr08-visual cancel/confirm removal                                        | B3                        | الإلغاء يحفظ الأجزاء، والتأكيد يحذف المطلوب فقط. فشل selector السابق محفوظ.                                            |
| PSR-E04 | VERIFIED_LOCAL (batch response-loss scope)      | psr08-visual committed advance lost response/reload                        | B1 partial                | استعادة تقدم الخادم وretry وإكمال19 دون تكرار؛ لا محاكاة نجاح وهمي.                                                    |
| PSR-E05 | VERIFIED_LOCAL (scoped partial run)             | psr08-visual held PA draft then SPA PA2                                    | B1 partial                | ردPA المتأخر لا يكتب في محررPA2؛ تبديل فعلي للمسار.                                                                    |
| PSR-E06 | VERIFIED_LOCAL (measured scope)                 | psr08-visual keyboard/native200 + actual390 locales                        | B1 partial + B4 + BL      | لوحة مفاتيح وتكبير200 للفندق، RTL/390 للغات؛ لا ثلاث رحلات كاملةkeyboard/200 أو قارئ شاشة.                             |
| PSR-E07 | VERIFIED_LOCAL                                  | psr08-visual suites and key checks in3 locales                             | B4 + BS + BL              | ar/en-US/id-ID واتجاهها؛ المصطلحات مستقلة/متصلة واضحة. نصوص البحث والعناوين الجديدة اختبرت بعد الإصلاح.                |
| PSR-P01 | VERIFIED_LOCAL (default + filtered pages)       | psr08-performance pages25/order/no-loss + stale cursor                     | P1 + P2 + S               | 50/250/500 ضمنprofile؛ default paging مثبت، وفرع البحث والفرز ثبت بالصفحات والتغيير الفعلي.                            |
| PSR-P02 | VERIFIED_LOCAL (independent PASS scope)         | psr08-search independent/performance/browser                               | S + BS2 partial + BS + BL | البحث والفرز الفعليان والصفات القائمة فقط، مع مؤشرات مرتبطة وتغيير بيانات حقيقي؛ لا نظام سمات ديناميكي أو SLA إنتاجية. |

## الأداء والحدود

PostgreSQL17.11 وNode22.23.2،profilePERF-01: max_resources500،search_budget_ms500،max_leaves32،depth4،inline20. لا رفع حدود. صفحات25 بأحجام50/250/500؛ عدد صفحات الموارد3/11/21 بسبب الحاوية غير المباعة، والشجرة2/10/20.

| الحجم | موارد p50/p95 ms | شجرة p50/p95 ms | بحث خطة التوفر p50/p95 ms |
| ----- | ---------------- | --------------- | ------------------------- |
| 50    | 14.72 /20.63     | 17.95 /20.46    | 24.52 /35.47              |
| 250   | 13.91 /16.81     | 16.45 /19.66    | 35.93 /37.83              |
| 500   | 13.34 /15.58     | 15.83 /18.91    | 71.52 /76.25              |

هذه summary الجولة الأولى تجمعcold/warm/pagination. `performance-phase-summary.json` مشتقة من جميع العينات دون قياس جديد، و`performance-1791000466325/phase-summary.json` مشتقة بسكربت محفوظ وبصمتَي الخام والمصدر. cold هنا أول طلب لكلfixture جديدة؛ لاcacheflush أو عمليةAPI جديدة. SQL companion10–11 للصفحات و18 لبحث التوفر، بمؤشراتservice مستقلة وبدور التشغيل؛ ليست instrumentation لكلHTTP request، وليست دائماً first-page. صحح الوصف في المشتق فقط؛ الخام محفوظ.

الجولةP2 تحفظ117عينة، وكلfailures/UNDETERMINED=0 في نطاقها. تغيربحث التوفرAVAILABLE→UNAVAILABLE بعدownerSQL block وinventory_version bump بينطلبين، وليس سباقاً داخلsearch. كان المقصود تشغيل الامتداد فقط، لكنflag skip لم يصل لصيغة الاختبار، فأعيد القياس الكامل أيضاً؛ حفظ الانحراف ثمصححflag دونإعادة إضافية. بحثخطةالتوفر لا يغلق R01.

## المراجعة والفجوات

- F-PSR08-R01: P1 لاكتمال بحث الوحدات/المواقع، غير مؤجل فيdocs/100. الإصلاح الحالي: q بالكود/اسم العرض/الملاحظات، صفات type/min_capacity/bedrooms_count/bathrooms_count، وترتيبcode/label/capacity؛ الشجرةq بالكود/الاسم وkind وترتيبdisplay_order/code/name. مؤشراتHMAC مرتبطة بالنطاق والمدخل والترتيب ونسخة البيانات؛ المخالف400 والقديم412. PG17/17 وlocation14/14، ومتصفح البحث26/26 والعناوين109/109؛ أغلق Astra R01.
- F-PSR08-R02: لقطات390 الأولى كانتعرض1440 بعد nativezoom. الخام الخاطئ محفوظ؛ B4 يقيسعرض390 فعلياً. أغلق Astra R02 بعد فحص الدليل المصحح.
- F-PSR08-R03: P2 قص عناوين حقول البحث؛ إصلاح عرض الحقول والتفافها في الواجهة فقط، وBL109/109. أغلق Astra R03؛ صور native200-form ذات إحداثيات خاطئة ليست دليلاً بصرياً، لكن zoom/DOM/keyboard مثبتة.
- PSR-UX01..08: **NOT_TESTED لكل حالة** لعدم توفر مشاركين بشريين مستقلين. الآلي لا يثبت الفهم أو تجربة الإنسان.
- E06 لا ادعاء قارئ شاشة أو إتاحة شاملة أو ثلاثرحلات كاملة بلوحةالمفاتيح/تكبير200 قبل استكمال دليلها.
- قناةحية/ترقيةمتدرجة تتعايش فيها نسخة قديمة: NOT_TESTED. التوسعات المحددة فيdocs/100 تبقى DEFERRED، وG-13=NOT ACCEPTED وD-20 محفوظ.

فحص روابط الوثائق النهائي195/195 فيdocument-links.json. المنسق وحده يدير build/check/PostgreSQL/الخدمات والمتصفح، ويحفظ command/exit/source لكلrun؛ نتائج سلامة نسخة التسليم والبصمات بعد آخر وثائق وHTTP readiness في `.local/verification/PSR-08/final-receipt.json`. لا ACCEPTED_LOCAL ذاتي.

## نتائج إصلاح R01 الخادمية — 4 أكتوبر2026

build-search-3.log/.exit نجحاexit0 مع توليدphase4 من المصدر. `postgres-search-1.log/.exit/.source.json` **17/17 في3حزم،exit0،10.94s**: أربع حالاتAstra مستقلة، وpsr08-search-performance، وproperty-api لتوافق القراءة القديمة. `postgres-location-search-2.log/.exit/.source.json` **14/14 منفردة،exit0،10.477s** بعد تغيير مؤشر الشجرة، دون إضعافdowngrade.

أداء البحث الحقيقي للموارد والمواقع في `search-performance-1791091294864/result.json` معsource.mjs:42عينة،failures=0،أحجام50/500 وprofile محفوظ. ترتيب وقيد الصفات ثابتان على صفحات25، ومؤشرquery/filter/sort مختلف مرفوض، والنسخة القديمة412 بعدrename عبرAPI؛ قراءة جديدة تحذف الاسم القديم من نتائجالبحث. SQL11–12 منservice companion منفصلة، وليس عددSQL لكلHTTP request.

| البيانات500 | أول طلب p50/p95 ms   | warm p50/p95 ms  | pagination p50/p95 ms |
| ----------- | -------------------- | ---------------- | --------------------- |
| الموارد     | 18.53 /18.53 (عينة1) | 16.03 /20.14 (5) | 15.36 /20.91 (9)      |
| الشجرة      | 15.83 /15.83 (عينة1) | 14.01 /16.32 (5) | 16.67 /18.00 (9)      |

cold تعريفها أول طلب لfixture جديدة، وليستprocess/OS cache cold؛ لا رفعحدود أوSLAإنتاجية. جميعالعينات والخطأ إنحدث يحتفظ بهما؛ لم تستبعد نتائج فاشلة لتمريرالقياس. البحث والفرز ضمنالصفات المنفذة فقط، لا تأجيلذاتيللمطلب. المتصفح الفعلي الجديد26/26 وقياس العناوين109/109 ناجحان. check نجح182/182 في25 حزمة، exit0؛ HTTP readiness تحقق200 للخدمات الثلاث؛ البصمات بعد آخر الوثائق باقية.

جاهزية التسليم المحلي 4 أكتوبر: `dev-start-final-4` و`final-http` exit0؛ API4100 وWorker4101 وWeb3000 أعادت HTTP200 بالمصدر المغلق. لم يتغير التطبيق بعد check النهائي. البصمات تجدد وتتحقق بعد تجميد آخر الوثائق.
