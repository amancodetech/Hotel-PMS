# الربط الرسمي: أدلة وقرار التنفيذ

تاريخ التحقق: 12 سبتمبر 2026. بحث في مصادر القنوات والمزودين العامة، دون حسابات أو طلبات اعتماد أو تجارب حية. D-19 يعتمد مسار مزود اتصال قائم وChannex كهدف التكامل الأول، بشرط اجتياز بوابات الاتصال أدناه. هذا اختيار هندسي مفوض، وليس عقد شراء أو إثبات اعتماد نظامنا.

## نتيجة القنوات الخمس

| القناة | الدليل الرسمي المتاح | مسار الربط في V1 | ما لم يثبت بعد |
|---|---|---|---|
| Booking.com | بوابة الاتصال تعلن تعليق انضمام مزودين جدد ولا تقبل ربط المنشأة الفردية مباشرة [C01] | Channex عبر تفويض المنشأة ثم Mapping؛ دليل الربط موثق [C06] | أهلية حساباتنا وصلاحيات المنشأة واختبار القناة ونموذج الأسعار |
| tiket.com | إدارة الأسعار والتوفر وإرسال الحجوزات للـChannel Manager وإعادة إرسال الحجوزات الفاشلة موثقة [C02] | Channex ضمن اتصالات المنشأة؛ دليل المزود [C07] | تفاصيل modify/cancel وStop Sell والقيود والاسترجاع لكل حساب، واختبارات الأعطال |
| Agoda | YCS Supply API واعتماد GetProduct وSetAriV2 وGetBookingList وGetBookingDetails، ثم pilot [C03] | Channex مذكور في دليل التهيئة عبر YCS [C08] | أهلية الاتصال، نموذج الإشغال، الضرائب والعمولة والعملة وحالات الإقرار |
| Traveloka | Connectivity API بمعيار OTA 2017B، ARI وclose-out وتسجيل وNDA واختبارات واتفاق قبل الإنتاج [C04] | Channex موثق مع Mapping ومعرف اتصال قد يختلف عن المعرف العام [C09] | إصدار Adapter المزود، نمط الوجبات/الإشغال والقيود والرسائل المعدلة/الملغاة |
| Trip.com | بوابة Connectivity توثق ARI وتأكيد/تعديل/إلغاء واستعلام حجز، مع مراجعة واختبار قبل التفعيل [C05] | Channex عبر اتصال Ctrip/Trip.com الموثق [C10] | Mapping حساب المنشأة، نموذج الضرائب والسعر، صلاحيات وتغطية قناة Trip.com الفعلية |

هذه مصادر Supply/Connectivity لإدارة منشآت مصرح بها. APIs البحث وإعادة بيع الفنادق أو Affiliate لا تحل مكانها. دعم المزود العام لا يثبت أن جميع أنواع مواردنا أو عملاتنا متاحة في كل قناة.

## مقارنة المسارات

| المسار | الملاءمة | القيود | القرار |
|---|---|---|---|
| خمسة Adapters مباشرة | تحكم تفصيلي بعقود كل قناة | خمس دورات اعتماد وتشغيل، وتعليق قبول Booking.com يمنع افتراض اكتمال المسار الآن | توسعة لاحقة عند قبول الشراكة، دون تغيير Domain |
| Channex White-label API | واجهة تكامل PMS، أدلة ربط القنوات الخمس، Feed وARI وMapping [C06..C14] | عقد واعتماد PMS، تكاليف وتبعية مزود؛ تفاصيل كل قناة تحتاج اختباراً | هدف V1 المختار في D-19 |
| SiteMinder pmsXchange | يدعم ARI والحجوزات وتعديلاتها وإلغائها، بشراكة واختبارات [C15] | يحتاج اتفاق شراكة؛ لم يتحقق هذا البحث من تغطية حسابات القنوات الخمس أو تسعير SaaS مضمّن | بديل احتياطي عند تعذر Channex؛ SMX ليس بديلاً مطابقاً لـpmsXchange |

التكلفة المنشورة لدى Channex وقت القراءة: رسم منصة يبدأ من 130 USD شهرياً، و7 USD للفندق المتصل أو 0.50 USD لوحدة Vacation Rental، دون VAT، والمراسلات إضافة منفصلة [C11]. مثال حسابي أولي لعشرة فنادق بالسعر القياسي: 200 USD شهرياً قبل الضرائب والبنية السحابية. لا نفترض تصنيف الفيلا المركبة أو الحد الأدنى النهائي؛ يلزم عرض محدد لنوع المنشآت. لا اشتراك أو إنفاق تم في هذه المهمة.

## مصفوفة القدرات اللازمة

لكل Connection نحفظ evidence_url وchecked_at وadapter_version وحالة لكل قدرة: DOCUMENTED / TESTED / UNSUPPORTED / UNKNOWN؛ وبصورة مستقلة authorization_status. الاتصال الفعلي بجميع القنوات الخمس حالياً NOT_TESTED وNOT_AUTHORIZED في مشروعنا. المطلوب: new/modify/cancel inbound، absolute availability، أسعار، Stop Sell/Open، Mapping، recovery. الاختياري: CTA/CTD وmin/max stay وOBP وreadback وحجز سابق ومرفقات ومراسلات.

كل خلية تحتاج اختباراً يثبت أثرها لدى القناة؛ لا نستخدم Boolean واحداً لكلمة «مدعوم». unknown في قدرة أساسية يمنع تفعيل الاتصال. unknown في قدرة اختيارية يخفيها ويمنع إرسالها. القدرة المتاحة في API الأصلي لـTraveloka مثلاً لا تنتقل تلقائياً إلى Adapter Channex الأقدم؛ اختلاف الدليلين مسجل كبند تحقق وليس سبباً لافتراض التغطية.

## آثار التكامل على العقود

- يستخدم PMS Booking Revision Feed ثم ACK بعد حفظ revision ونتيجة التطبيق أو استثناء قابل للاستئناف في PostgreSQL. Webhook تنبيه لتسريع السحب وليس بديلاً وحيداً عن Feed [C12]. يظل ACK منفصلاً عن إثبات إيواء الضيف.
- ARI يحتوي availability للنوع وrestrictions لخطة السعر؛ HTTP 200 قد يحتوي warnings ولا يثبت تطبيق كل الخلايا أو وصولها إلى OTA [C13]. سجل task والخلية والقناة والنسخة؛ حالة قبول Channex منفصلة عن تحقق OTA.
- حجز جديد: auto decrease لدى المزود عند دعمه؛ تعديل/إلغاء: لا automatic increase يعيد فتح المخزون قبل PMS. دليل المزود يوصي بضبط modified/cancelled على OFF عند اتصال PMS [C14]. يختبر الإعداد مع سياسة العرض المحافظة D-20 ولا يعتبر حل تركيب الفيلا.
- استيراد حجوزات Booking.com المستقبلية ممكن وفق دليل المزود، لكنه لا يغير توفر Channex وقد تكون التفاصيل ناقصة [C06]. PMS يستورد الالتزامات ويطابق الأرصدة أولاً، ثم يرسل snapshot واحدة مشتقة. للقنوات الأخرى يلزم دليل استرجاع أو ملف معتمد من المنشأة مع تقرير اكتمال؛ لا افتراض أن Feed يحتوي كل الحجوزات القديمة.
- PMS لا يستطيع عموماً تعديل التواريخ أو إلغاء حجز OTA عبر Channex [C16]. الطلب الخارجي يبقى PendingExternal ويعرض رابط متابعة؛ لا يحرر المخزون حتى تأكيد القناة. النقل الداخلي لا يغير الاتفاق الخارجي.

## حزمة بدء الاتصال

قبل الإنشاء: تعريف الشركة والمنتج، الحساب المفوض، أرقام منشآت اختبار، أنواع الغرف وخطط السعر والعملات، سياسة بيانات الضيف والاحتفاظ، متطلبات white-label، توقيع الطلبات وحدود المعدل، إمكانية استرجاع التاريخ، وسائل الدعم، ودليل فصل مفاتيح كل Tenant. لا نسخ مفاتيح أو بيانات ضيوف في الوثائق.

أسئلة حاسمة جاهزة للمزود: هل القنوات الخمس متاحة لعقودنا الإندونيسية؟ ما قدرات كل Adapter وإصداره؟ هل يمكن تطبيق Stop Sell مختلف لكل قناة دون إغلاق الجميع؟ كيف نسترجع revisions والتاريخ بعد انقطاع؟ كيف نثبت أن إغلاق OTA طُبق؟ ما حدود rate limits وأفق ARI ومدة الاحتفاظ؟ كيف نعطل أي auto-replenishment؟ ما تصنيف وعدد الوحدات للفوترة؟ هل يوفر العقد SLA وحماية بيانات وتصديراً عند الخروج؟ هذه أسئلة موثقة ولم تُرسل.

## المصادر

كل المصادر أدناه قرئت في تاريخ التحقق، والعناوين روابط أصلية؛ لا تدعي نتائج البحث إجراء اعتماد.

- C01: [Booking.com Connectivity Portal](https://connect.booking.com/).
- C02: [tiket.com Channel Manager](https://tix.tiket.com/en/help-center/property-details/channel-manager).
- C03: [Agoda certification](https://developer.agoda.com/supply/docs/certification).
- C04: [Traveloka Connect](https://developer.connect.traveloka.com/).
- C05: [Trip.com Connectivity](https://connect.trip.com/).
- C06: [Channex Booking.com](https://help.channex.io/en/articles/8227329-booking-com).
- C07: [Channex Tiket](https://help.channex.io/en/articles/8275297-tiket).
- C08: [Channex Agoda](https://help.channex.io/en/articles/13780884-agoda).
- C09: [Channex Traveloka](https://help.channex.io/en/articles/8275295-traveloka).
- C10: [Channex Trip.com](https://help.channex.io/en/articles/8229275-ctrip-trip-com).
- C11: [Channex pricing](https://channex.io/pricing).
- C12: [Booking Revisions](https://docs.channex.io/api-v.1-documentation/bookings-collection) و[Best practices](https://docs.channex.io/guides/best-practices-guide).
- C13: [ARI](https://docs.channex.io/api-v.1-documentation/ari.md) و[Rate limits](https://docs.channex.io/api-v.1-documentation/rate-limits.md).
- C14: [Automatic availability](https://help.channex.io/en/articles/8804791-auto-availability-settings).
- C15: [SiteMinder pmsXchange](https://developer.siteminder.com/siteminder-apis/pms-rms/introduction/pmsxchange/getting-started).
- C16: [Channex integration](https://channex.io/start-integration).
- C17: [PMS certification](https://docs.channex.io/api-v.1-documentation/pms-certification-tests).

## تحديث التنفيذ المحلي (P13، 17 سبتمبر 2026)

- حزمة الاعتماد الجاهزة للإرسال: [docs/execution/channels/provider-approval-package.md](execution/channels/provider-approval-package.md) (غير مرسلة).
- سجل EX الآلي بحالاته: [ex-registry.json](execution/channels/ex-registry.json) — EX-01/02/03/05
  BLOCKED_EXTERNAL وEX-04 IN_PROGRESS_LOCAL، بلا دليل حي.
- تأهيل القنوات الخمس: [channel-readiness.json](execution/channels/channel-readiness.json) —
  كل الخلايا NOT_TESTED وDECLARED_AND_TESTED=0؛ قوالب الأدلة في
  [docs/execution/channels/](execution/channels/).
- conformance المحلي (محاكي): [P13-03](execution/P13-03.md) — لا يرفع أي خلية حساب حقيقي إلى TESTED.
هذه الإضافات تنفيذ محلي فقط ولا تغيّر استنتاجات الأدلة العامة أعلاه ولا تثبت اعتماداً أو قدرة لدى المزود.
