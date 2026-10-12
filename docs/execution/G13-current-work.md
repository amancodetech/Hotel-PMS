# G-13 — إعادة تقييم النطاق المحلي الحالي

12 أكتوبر 2026 — الإغلاق والفتح التلقائيان في Channex من الحجز المباشر **NOT IMPLEMENTED / NOT TESTED**؛ منع تعارض الغرفة/الفيلا محلياً مثبت، وSTOP_SELL الصريح دليل منفصل. المرجع [NP-channex-auto-sync](NP-channex-auto-sync.md). check-final-4 نجح 221/221 في 31 حزمة والخدمات أُعيدت ببنائه دون تغير أعمال؛ فرق الهوية المحدود مدقق ومعلن في [سجل الاستئناف](NP-trial-progress.md). G-13 NOT ACCEPTED / FUNCTIONAL_BLOCKED.

11 أكتوبر2026 — التجربة المفوضة تشمل نسخةتشغيلمعزولة واتصالChannex staging فعلياً مغلقاً. المرجع الجاري [NP-trial-progress](NP-trial-progress.md) و[المراجعة المستقلة](NP-channex-staging-independent-review.md). أُثبتSTOP_SELL عبرoutbox والعامل،وكتالوج25TESTproperties،وتركيبBooking CRS واحد معنشاطUNVERIFIED. استقبالالحجز/Webhook/HTTPS/OTA والسحبالمثبتإلىcutoff متبقية؛G-13 **NOT ACCEPTED / FUNCTIONAL_BLOCKED**. التفاصيل والنتائج المؤرخة4..8أكتوبر أدناه تاريخية ضمن نطاقها؛لا تعد محاكياتها إثباتاً للاتصالالحالي ولا تنقل أرقامcheck القديمة للنسخةالجديدة.

4 أكتوبر 2026؛ **IN_PROGRESS / analysis**. تنفيذ GPT-6.1 Sol وفق طلب المستخدم إكمال G-13 محلياً. هذه بطاقة عمل وتحقق، وليست تغييراً لبوابة G-13 أو قبولاً إنتاجياً. المنسق يدير الخدمات والبناء وPostgreSQL والمتصفح. الوكلاء لا يشغلون أطقم متنافسة ولا تصعيداً معلقاً.

## الحدود

لا قناة حية أو نشر أو إنفاق أو تواصل خارجي، ولا تغيير D-20 أو تحرير UNKNOWN أو السحب غير المثبت. تنظيف البيانات وخطة منتجع new pratama من Excel نطاق لاحق؛ أسئلة نطاق الحذف والتفويض الخارجي معلقة، ولا حذف الآن. docs/86 والهجرة المطبقة محميان، وتعديلات الآخرين محفوظة.

المراجع: AGENTS وREADME وdocs/01 و17 و18، و[برومبت المراجعة87](../87_phase13_review_prompt.md)، و[دليل الأثر95](../95_set_ai_implementation_playbook.md)، و[P13-01](P13-01.md)..[P13-07](P13-07.md) و[G-13](G-13.md). المراجعة المستقلة منفصلة؛ لم يوجد `docs/88_phase13_independent_review.md` عند الجرد. لا يكتب المنفذ تقرير المراجع.

## الحقيقة الحالية والأدلة

P13-01..06 تصف تنفيذ17 سبتمبر المحلي: سجل EX5/5، إعداد10/10، استعادة محلية، conformance6/6 وPG3/3، cutover3/3، وقوالب تأهيل القنوات ومراقبة. P13-07 READY؛ G-13 NOT ACCEPTED. EX-01/02/03/05 BLOCKED_EXTERNAL وEX-04 IN_PROGRESS_LOCAL. جميع AT-C01..10 الحية لكل قناة NOT_TESTED؛ لا يملؤها محاكي.

PSR-08 ACCEPTED_LOCAL بقرار المستخدم، ومراجعة Astra PASS_LOCAL؛ إيصال `.local/verification/PSR-08/acceptance-receipt.json` يثبت check182/182 والبصمات885/885 وحدودها. لا يمثل ذلك إعادة اختبار PostgreSQL أو توزيع P13. أدلة PSR-07 الحصة/UNKNOWN وPSR-08 البحث صالحة لنطاقاتها، وليست بديلاً عن cutover والاستعادة.

لا توجد source manifests تاريخية في أدلة P13 المفحوصة. `checksums-verify.log` يحفظ أسماء OK ولا يحفظ SHA المصدر القديم؛ لذلك لا يمكن إعلان MATCH للمصدر التاريخي. تسجل الأدلة القديمة PRIOR_UNBOUND، وتثبت النسخة الحديثة عند تشغيل المركز المطلوب. لا تعاد فحوص PSR-08 الخضراء لنفس المصدر لمجرد تغيير الوثائق.

## فحص المصدر الأولي

- `exposure-service.ts` السحب يرفع inventory_version ثم يعيد lockProperty ويستخدم النسخة الحديثة في الحدث والخلايا؛ إصلاح F-P13-01 ظاهر في المصدر الحالي. وجوده ليس إثبات تشغيل جديد.
- `channel-revision-repository.ts` يحصر external key في tenant/property/connection، ويقفل المرشحين؛ المرشح غير المرتبط الوحيد يتبنى بتحديث مشروط، والتعدد ambiguous. `revision-service.ts` يسجل تدقيق التبني؛ إصلاح F-P13-02 ظاهر. يلزم PG فعلي للاتجاهين والحصة بعد PSR.
- restore rehearsal يستخدم قاعدتين جديدتين ويدعم P13_EVIDENCE_DIR، لكن اسم الحاوية الافتراضي تاريخي؛ يفحص المنسق الحاوية قبل التشغيل.
- monitor snapshot قراءة DB فقط، لكنه يكتب مجلد P13-06 ثابتاً ويحذف log القديم. لا يشغل كما هو فوق الأدلة التاريخية؛ يلزم حفظ مخرجات جديدة مستقلة قبل تشغيله. هذه فجوة حفظ دليل، وليست عيباً مثبتاً في ضمان المخزون.

## دفعات التحقق

1. **الجرد والفحوص بلا خدمات:** سجل EX وتأهيل القنوات دون emit-docs، conformance المحلي، فشل مثالي staging/production المتوقع. تحفظ الأوامر وexit وSHA في `.local/verification/G13-current/`. قبول exit1 هنا متعلق بضبط سالب محدد، لا اعتبار فشل عشوائي PASS.
2. **مصدر حديث وقواعد معزولة:** بعد build مطابق وإيقاف dev، PG conformance/cutover مركزان. سبب الإعادة: لا بصمة تاريخية ملزمة، وتغير مخزون PSR/تركيباته والهجرة التشغيلية؛ لا نقل3/3 القديمة للنسخة الجديدة.
3. **الاستعادة والمراقبة:** rehearsal مع P13_EVIDENCE_DIR جديد والحاوية الحالية، للتحقق من أحدث schema وتعليق البيع وعدد البيانات ومنع الزيادات. أرقام RPO/RTO جديدة محلية فقط، لا SLA أو staging. snapshot مستقل لا يستبدل التاريخ ولا يطبع أسراراً.
4. **تقييم الأثر:** يحدد المراجع/المنسق أطقم الانحدار المتأثرة بعد قراءة نتائج المركز، ومنها المالية والإغلاق والهوية والتوزيع؛ لا إعادة عمياء للبصريات الخضراء. أي عيب مثبت له معرف وخطورة وإصلاح ومراجعة منفصلة.
5. **التسليم:** حكم محلي وحدود EX صريحة، تقرير مستقل فعلي، ثم تحديث البطاقات/السجل عند ثبوت النتائج. فحص نهائي مناسب، آخر وثائق وبصمات، وإعادة الخدمات وHTTP readiness. لا قبول G-13 ذاتي.

## أوامر مقترحة للمنسق — لم تنفذ بواسطة هذه البطاقة

```bash
node scripts/p13-ex-registry.mjs
node scripts/p13-channel-readiness.mjs
node scripts/p13-conformance.mjs
node scripts/production-config-check.mjs --profile=staging --env-file=infra/environments/staging.env.example
node scripts/production-config-check.mjs --profile=production --env-file=infra/environments/production.env.example
pnpm build
pnpm dev:stop
pnpm test:property:fast -- --filter='p13-conformance|p13-cutover' --bail
P13_EVIDENCE_DIR=.local/verification/G13-current/restore P13_PG_CONTAINER=<actual-container> node --env-file=.env scripts/p13-restore-rehearsal.mjs
```

## خريطة الأثر الحالية وفق95

التغيير الحالي توثيق وجرد فقط؛ API/DTO/ترجمة/schema/هجرة/معاملة/صلاحيات/events/workers **N/A**، لا تغيير سلوكي. حفظ المصدر والأدلة **DONE أولي**؛ مقارنة التاريخ **PRIOR_UNBOUND**؛ الاختبارات **PENDING المنسق**. السلوك المحمي: D-20 وحصرية الحصة وعدم ازدواج الحجز وعزل tenant/property والمال والتاريخ. إذا ثبت عيب تطبيقي تستكمل خريطة الطبقات الثماني عشرة قبل الإصلاح، ولا تعلن DONE من وجود الكود وحده.

نقطة الاستئناف: نتائج الدفعة الأولى من المنسق، ثم تحديد النسخة المطابقة وPG المركز والاستعادة. لا تعديل README أو G-13 أو بطاقات P13 في هذه الدفعة، ولا بدء تنظيف البيانات.

## Findings مثبتة — الدفعة الحالية

- **G13-R01 / P2 بوابة جاهزية:** probe مستقل أثبت قبول evidence truthy لمحاكي أو قناة أخرى. إصلاح التنفيذ يطلب manifest JSON موجوداً وعقد provenance أدناه؛ الحاليات NOT_TESTED محفوظة. ليس CLOSED قبل إعادة probe وحكم Astra.
- **G13-R02 / P2 كشف قيم إعداد:** probe مستقل أثبت عرض حقول PROVIDER_API_TOKEN/AWS_SECRET_ACCESS_KEY غير المعروفة. أصلح profile بعرض checkedFields فقط وحجب كل قيمة خارج allowlist تشغيلية، بما فيها جميع URLs ومراجع التفويض؛ المدخل غير الصالح يحجب أيضاً. ليست CLOSED قبل تحقق مستقل.
- **G13-R03 / P1 تحرير مخزون بلا proof:** المصدر reconcileConnection يحرر بعد accepted>0، والعداد يضم SENT/ACKNOWLEDGED، دون إثبات القناة أو cutoff inbox. جارٍ تحليل آلية proof القائمة؛ لا تعديل exposure قبل baseline مستقل، ولا تعديل migration أو D-20.

ملفات الدفعة R01/R02: deployment/profile.ts واختباراه production-profile/channel-evidence؛ scripts/support/p13-evidence.mjs وp13-channel-readiness/p13-conformance/p13-monitor-snapshot. الأدوات الثلاث تدعم P13_EVIDENCE_DIR اختيارياً، دون استبدال الدليل القديم. Prettier وESLint على الملفات exit0؛ بناء واختبارات التطبيق بيد المنسق ولم تعتمد بعد.

## عقد ملف دليل الجاهزية المحلي — schema1

`evidence_ref` مسار JSON حقيقي داخل المستودع، ليس مجرد رابط أو وصف. الملف يصرح evidence_version=1 وkind=official-channel-test وprovider_key=channex وchannel_key مطابقاً، وenvironment وprofile متطابقين staging/production، وconnection_id UUID وtest_run_id. synthetic=false وlive_tested=true وauthorization_status=AUTHORIZED؛ authorization_ref ملف موجود، adapter_version غير فارغ وchecked_at صالح غير مستقبلي. at_codes يسرد الاختبارات المثبتة، وresources يحدد الأنواع المراد DECLARED_AND_TESTED.

provenance.kind=official-provider مع evidence_url HTTPS تحت channex.io دون userinfo، وartifact_ref ملف موجود داخل المستودع وsha256 مطابق لمحتواه. الخلية تربط test_run_id وAT-C المعين بالقناة والاتصال والبيئة نفسها. NOT_TESTED لا يحمل evidence أوrun؛ الحالة المتحققة لا تقبل تفويضاً مجهولاً. ملفات التحكم الاصطناعي في الاختبارات تختبر بنية العقد فقط، ولا تحفظ في سجل القنوات أو تعلن اتصالاً حياً. صحة مضمون الدليل الرسمي وتفويضه تستلزم المراجعة المستقلة؛ validator لا يتصل بالمزود ولا يخلق شهادة أو صلاحية خارجية.

## استئناف 5 أكتوبر — R03 وخطة الأثر

المنسق يستخدم pnpm الحالي `/home/omar/.npm-global/bin/pnpm`؛ `/tmp/hotel-pnpm10` لم يعد موجوداً. محاولة build-pre-r03-1 لم تبدأ بسبب هذا المسار التاريخي؛ ليست فشل المنتج أو بناءً ناجحاً. R01/R02 مجمدان بعد تصحيح test_run_id المفقود في الخلية وربط undefined، مع اختبار رفض؛ ESLint وPrettier exit0.

تحليل R03: ليس في المصدر القائم أثر معتمد لإتمام مطابقة revisions حتى cutoff عقد المزود. CHANNEL_VERIFIED وحده لا يثبت تلك المطابقة. الإصلاح المحلي الأصغر المقترح يمنع RELEASED تلقائياً ويبقي RECONCILING، حتى يوجد مسار proof كامل مفوض ومختبر؛ لا اختراع manual workflow أو حقول DB، ولا انتظار مهلة عمياء. لذلك التسليم الوظيفي للقناة الأخرى وفتح الأجزاء بعد السحب يصبحان BLOCKED_CAPABILITY، ولا يعلن cutoverhandover PASS كاملاً.

الاختبارات المتأثرة فعلياً: p13-conformance، p13-cutover-rehearsal، exposure-api، adversarial-p05، psr07-channel-quota، وتوقع تاريخي في psr07-2-independent. يحفظ الاختبار المستقل التاريخي وتوثق تغير دلالته، ولا يعدله المنفذ دون التنسيق. اختبار Astra الحالي g13-withdrawal-independent مستقل ومجمد. يلزم baseline قبل تعديل exposure.

بعد الإصلاح: رفض التحرير في SENT/ACKNOWLEDGED/UNKNOWN/PARTIAL وحتى CHANNEL_VERIFIED دون cutoff proof؛ إعادة reconcile وفقد الرد لا يحرران allocation أو يفتحان قناة أخرى. حصة PUBLISHING التي تصير ACTIVE تبقى محجوزة، فلا تغير دلالتها ضمن هذا العيب. العقد phase5 وواجهة counts يوضحان حدود release بدون شكل رد جديد إذا كفى ذلك. ما يزال التنفيذ/التحقق/الحكم المستقل PENDING، ولا حذف بيانات.

## تنفيذ R03 — 7 أكتوبر 2026

فوض المنسق التنفيذ بعد baseline مستقل `independent-withdrawal-baseline-1` exit1: released=1 بدلاً من0؛ قراءة JSON قبل assertion أثبتت provider acceptance وchannel_verified_version=null مع allocation=RELEASED وpreview قناةB allowed. الدليل الخام والأمر وبصمة المصدر تحت `.local/verification/G13-current/`. هذا فشل منتج مثبت قبل التعديل، لا فشل بيئي.

التعديل: reconcile يحتفظ برد counts نفسه، released=0؛ WITHDRAWING/RECONCILING بلا pending تصبح RECONCILING وتحتفظ بالتخصيص، حتى لو كل الأحداث CHANNEL_VERIFIED. pending يبقي الحالة القائمة المحمية. تفعيل PUBLISHING/UNKNOWN المقبول يبقى ACTIVE ويحفظ الحصة. يسجل audit `releaseCapability=RELEASE_PROOF_NOT_IMPLEMENTED` عند reconciling>0. لا workflow يدوي أو proof مختلق؛ مسار release محجوب وظيفياً. repository لم يحتج تعديلاً؛ دالة تحرير التخصيص لم تعد مستدعاة من reconcile.

العقد phase5 يصرح BLOCKED_CAPABILITY، والواجهة تعرض بيان حدود السحب بلغاتها الثلاث وتعرض warning عند reconciling>0. الاختبارات التابعة للمنفذ p13-conformance/p13-cutover-rehearsal/exposure-api/adversarial-p05/psr07-channel-quota تحافظ على المورد ورفض handover بعد النقل؛ توقعات accepted-only التاريخية SUPERSEDED وليست دليلاً لقبول جديد. g13-withdrawal-independent وpsr07-2-independent بملكية Astra ولم يعدلهما المنفذ. النص التاريخي17 سبتمبر محفوظ مع ملحق حاكم في P13-03/P13-05/G-13.

### خريطة الأثر18 — مصدر منفذ؛ التحقق التشغيلي PENDING

| الطبقة | النتيجة والسبب |
|---|---|
| السلوك | DONE: منع release بلا proof كاملاً؛ حماية D-20 وAT-C07/08؛ handover BLOCKED_CAPABILITY |
| المدخلات | N/A: لا تغيير reason أو DTO أو required/defaults |
| الهوية | N/A: سياق tenant/property/actor القائم محفوظ |
| التفويض | N/A: channel.reconcile القائم لا يتيح proof أو bypass |
| البيانات | N/A: لا schema/FK/RLS/grants أو مهاجرة |
| المعاملة | DONE: انتقال RECONCILING وتدقيق داخل المعاملة القائمة دون release جزئي |
| التزامن | DONE مصدر: قفل property القائم وعدم تحرير أي allocation؛ اختبار مستقل مع التكرار مقرر |
| التكرار | DONE مصدر: إعادة reconcile تحافظ على حصة RECONCILING؛ اختبار مستقل مقرر |
| الإصدار | N/A: لا inventory bump لتحرير وهمي؛ التفعيل المقبول يحفظ bump القائم |
| التوافق | DONE: counts دون تغيير shape؛ توقعات اختبارات release التابعة للمنفذ محدثة وموثقة superseded |
| العقود | DONE مصدر: وصف phase5 محدث؛ لا تعديل generated؛ توليد/فحص بيد المنسق |
| الأحداث | DONE: تدقيق releaseCapability آمن؛ أحداث Stop Sell/workers كما هي ولا تعد دليلاً على cutoff |
| القراءة | N/A: استعلامات scope/filter/order محفوظة |
| الواجهة | DONE مصدر: بيان حدود السحب وwarning؛ تحقق متصفح بيد المنسق |
| الترجمة | DONE مصدر: المفتاح withdrawalReleaseBlocked في ar/id-ID/en-US؛ RTL القائم محفوظ |
| العمليات | DONE جرد: availability وquota وcutover تبقى محمية؛ فتح أجزاء الفيلا محجوب، بلا أثر مالي |
| الرصد | DONE مصدر: releaseCapability في afterSafe بلا أسرار، correlation قائم |
| التوثيق | DONE: بطاقة العمل وملحق حاكم يحفظ التاريخ في P13-03/P13-05/G-13؛ لا قبول |
| 19 — إعدادات اكتشاف Jest / F-G13-R04 | VERIFIED_LOCAL / CLOSED_LOCAL: تجاهل`.local` فيidentity/distribution وفق إعدادproperty؛عزل نسخ الأدلة دون حذفها؛identity-current-2 48/48 وdistribution-current-1 48/48 وcheck-final-1 184/184 جميعهاexit0 |

التالي: format/lint خفيف، freeze ببصمات الملفات، ثم build وcontracts generation/check وPG focused مستقل + تابع بواسطة المنسق. لا تشغيل خدمات أو حذف بيانات بواسطة المنفذ.

التحقق الخفيف للمنفذ7 أكتوبر: Prettier على ملفات المصدر/العقد/اللغات/الاختبارات المعدلة exit0؛ ملفات docs مستثناة من إعداد formatter القائم. ESLint على exposure-service وRatesInventoryPage والاختبارات الخمسة exit0. لم يشغل build أو PG أو المتصفح. freeze المصدر محفوظ في `.local/verification/G13-current/r03-source-freeze.sha256`؛ تقرير القيم الآلي `.local/verification/G13-current/r03-light-verification.json`.

## تحقق المنسق ومتابعة الواجهة — 7 أكتوبر

`postgres-r03-focused-1` انتهى14:10:28UTC exit0: **48/48 في7 أطقم** على مصدر freeze مطابق، يشمل مستقل Astra واختبارات المنفذ المرتبطة. الأمر والمصدر والدليل الخام: `.local/verification/G13-current/postgres-r03-focused-1.{command.json,source.json,log}`. هذا يثبت سلامة حجز السحب محلياً، ولا يثبت القدرة على handover أو قناة حية. الانحدار الكامل بيد المنسق IN_PROGRESS؛ لا نقل نتيجته قبل الانتهاء. G13-R01/R02 مصنفانP2 وفق المراجعة المستقلة، وR03P1؛ الحكم النهائي للمراجع.

الأداة الخاصة `.local/verification/G13-current/withdrawal-ui-smoke.mjs` جاهزة غير مشغلة. `node --check` exit0 يثبت صياغتها فقط. تستخدم loginAs admin-a وwithOwner من harness دون بدء/إيقاف خدمات، وتتطلب IDENTITY_TEST_DB منفصلاً وG13_UI_ISOLATED_DB_CONFIRMED مطابقاً لاسمها وتأكيد المنسق توجيه API إليها. تنشئ fixture اصطناعياً فقط في الخادم المعزول، ثم تحقق counts0 وبعد السحب transport SENT تحقق reconciling1 وreserved allocations عبر UI فعلي، دون API stub.

المسار الصحيح للبيان الجديد `/properties/:propertyId/rates` في RatesInventoryPage/ChannelPanel؛ ليس PropertySetupPage. المصدر يحدد tab باسم exposuresSection وbutton reconcile وdialog reasonLabel. 3لغات×1440/390 وRTL العربية، keyboard إلى reconcile/submit ولقطات مستقلة بأسماء اصطناعية. الأداة تتطلب outdir جديداً داخلG13-current ولا تكتب الأدلة التاريخية. تحقق المتصفح PENDING المنسق.

خريطة الأثر18: السلوك/المعاملة/التكرار/التوافق/العمليات أصبحت VERIFIED_LOCAL بالنطاق المركز48/48؛ اختبار concurrency كامل وأثر الواجهة النهائي pending. العقد build/contracts:check بيد المنسق (لا تدعي البطاقة نتيجته دون إيصال). لا تسليم وظيفي للحصة المسحوبة؛ BLOCKED_CAPABILITY باقٍ.


## إعادة الانحدار الكامل — 8 أكتوبر2026

أعاد المنسق النطاق الكامل بعد إصلاحي fixtures: `postgres-property-regression-2` **exit0؛563/563 اختباراً؛76/76 مجموعة**. ملفات `.local/verification/G13-current/postgres-property-regression-2.{command.json,source.json,log,exit}` تربط الأمر والنسخة والنتيجة. الجولة1 التاريخيةexit1 و561/563 تبقى محفوظة؛ التفصيل في [نتائج الانحدار](G13-regression-findings.md). لا تنسب نتيجتها الناقصة إلى الجولة2 ولا تحذفها.

`postgres-location-tree-1` تحقق منفصل **14/14؛exit0**؛ `check-current-1` **184/184؛26/26؛exit0**، بإيصالاتها المستقلة تحتG13-current. تحديث خريطة الأثر18: السلوك/المعاملة/التكرار/التوافق/العمليات مدعومة الآن أيضاً بنطاق الانحدار المحلي المعاد؛ الواجهة/RTL/keyboard أصبحت **VERIFIED_LOCAL** بإيصال `withdrawal-ui-1` أدناه على قاعدة الاختبار المعزولة المحتفظ بها. لا تشغّل هذه البطاقة خدمات ولا تغير بياناتhotel.

هذه النتائج تثبت النطاق المحلي المسجل فقط. حجزR03 آمن محلياً، لكن release وحركة handover ما زالا **BLOCKED_CAPABILITY / RELEASE_PROOF_NOT_IMPLEMENTED**؛ لا قبولG-13 النهائي أو إثبات قناة حية.

## F-G13-R04 / P2 — تداخل حزم Jest مع النسخ المحلية

تشغيل المنسق `identity-current-1` انتهى **exit1**: نجحت24 حالة في4 مجموعات، وفشلت3 مجموعات قبل تشغيل اختباراتها. السبب المثبت هو تعارض اكتشاف اسم الحزمة بين `packages/contracts/package.json` ونسخة مصدر محفوظة داخل `.local/backups/PSR-05-closed.../source/packages/contracts/package.json`. لا تعد الحالات التي لم تبدأ ناجحة، ولا تسجل هذه الجولة48/48. تحفظ الجولة الفاشلة ودليلها الخام كما هما.

الإصلاح المنفذ الذي راجعه المراجع المستقل يستعمل `modulePathIgnorePatterns` في إعدادَي Jest للهوية والتوزيع لإبعاد `.local` عن اكتشاف الحزم، وفق إعداد property القائم. ملكية تنفيذ الإعدادين انتقلت إلى منفذ آخر؛ لا حذف للنسخ أو تغيير لبيانات التطبيق. الحالة **CLOSED_LOCAL** بعد نجاح الإعادات الفعلية التالية وموافقةAstra على الإغلاق المحلي.

| الإثبات المطلوب | الحالة |
|---|---|
| `identity-current-1` التاريخي | FAIL؛exit1؛24 حالة ناجحة؛3 مجموعات فشلت قبل الاختبارات |
| `identity-current-2` بعد تعديل الإعداد | PASS؛48/48؛7/7؛exit0 |
| `distribution-current-1` بعد تعديل الإعداد | PASS؛48/48؛11/11؛exit0؛يتضمن اختبارات ترقية المهاجرات |
| `check-final-1` بعد تعديل الإعداد | PASS؛184/184؛26/26؛exit0؛إيصال جديد مستقل عنcheck-current-1 |

صف أثر إضافي مرتبط بمنهج خريطة الأثر18/وثيقة95: **العمليات/التحقق** — تغير نطاق اكتشاف Jest فقط ليعزل نسخ الأدلة المحلية؛ لا تغير في السلوك أو واجهة المستخدم أو العقود أو الهوية أو التفويض أو البيانات أو المعاملات. نجحت إعادة الهوية والتوزيع والفحص النهائي وأثبتت سلامة عزل اكتشاف الحزم محلياً. أثر **التوثيق** — تحفظ نتيجة الفشل منفصلة عن الإيصالات اللاحقة، ويبقى قبولG13 الخارجي محجوباً.

## تحقق الاستعادة والرصد والاتصال — 8 أكتوبر2026

`restore-1` **exit0** بإيصال الأمر `.local/verification/G13-current/restore-1.command.json` والتقرير `restore-1/restore-rehearsal.json`: **RPO مثبت0.417 ثانية؛RTO مقاس3.352 ثانية** على قاعدتي اختبار محليتين. counts قبل/بعد متطابقة: property/product/connection/exposure/platform_stop واحد لكل منها؛pending_increases0 وopened_restrictions0. العلامة المضافة بعد dump غير موجودة بعد restore (`post_dump_marker_present_after_restore=0`). التقرير يصرحlocal_only وnot_staging_measurement وnot_production_authorization؛هذه تجربة استعادة اصطناعية محلية ولا تعني قياساً إنتاجياً أو إثبات استعادة بياناتnew pratama الفعلية.

`monitor-1` **exit0** بإيصال الأمر `monitor-1.command.json` والتقرير `monitor-1/monitor-snapshot.json` تحتG13-current؛لقطة قاعدةhotel الحالية بعد إنشاء الشركة تسجلconnections=[] وactive_platform_stops0. خلو القنوات لا يثبت تكاملاً خارجياً أو اجتياز اختبار قناة.

`db-check-1` **exit0** بإيصال `db-check-1.command.json`؛السجل يثبت العثور على إعدادORM ونجاح اتصال قاعدة البيانات. لا يستنتج من اتصالDB اكتمال قدراتG13. إعادات الهوية والتوزيع والفحص النهائي بعد تعديل إعدادَيJest نجحت بإيصالاتها المستقلة المسجلة أعلاه.


## تحقق واجهة السحب — 8 أكتوبر2026

`withdrawal-ui-1` **exit0؛45/45 تحققاً؛failures0**. التقرير الفعلي `.local/verification/G13-current/withdrawal-ui-1/report.json` واللقطات السبعة في المجلد نفسه؛ أمر التشغيل وبصمة المصدر والسجل والـexit تحتG13-current. جرى التحقق على المسار الفعلي `/properties/:propertyId/rates` بلغاتen-US/id-ID/ar وعرضي1440 و390، مع اتجاهRTL للعربية والتنقل بلوحة المفاتيح إلى reconcile/submit. لا overflow أو page errors مسجلة.

حقق reconcile الفعليHTTP200 وreleased0/reconciling0 قبل السحب، ثمreleased0/reconciling1 مع warning مترجم وشدة صحيحة بعدSENT؛ تكرار الواجهة احتفظ بجميع allocations فيRESERVED. البيانات اصطناعية في قاعدة اختبار معزولة أكدها المنسق؛ لاAPI stub ولا اتصال مزود رسمي. هذه نتيجة **CLOSED_LOCAL_SAFE_HOLD** لحمايةR03 والواجهة فقط، تخضع لحكم المراجع المستقل. تبقى **FUNCTIONAL_BLOCKED / RELEASE_PROOF_NOT_IMPLEMENTED** للتسليم الخارجي؛لاG13PASS نهائي.


إيصالات إغلاقF-G13-R04: `.local/verification/G13-current/identity-current-2.{command.json,source.json,log,exit}` و`distribution-current-1.{command.json,source.json,log,exit}` و`check-final-1.{command.json,source.json,log,exit}`؛قراءة السجلات وملفاتexit تؤكد الأعداد أعلاه. اكتمل بناء الفحص النهائي لدى المنسق8 أكتوبر08:53:29UTC. هذه الإيصالات الجديدة لا تستبدلidentity-current-1 الفاشل ولا تمنح قبول تكامل خارجي. الوثيقة مجمدة بعد إضافة هذه الإيصالات.
