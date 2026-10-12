# خطة الأنواع والقنوات للتفعيل الحي

الحالة: **PLAN ONLY — كل الأنواع NOT_DECLARED وكل القنوات NOT_TESTED**. التاريخ: 17 سبتمبر 2026.
المرجع: [docs/22](../../22_connectivity_evidence.md) و[docs/24](../../24_inventory_design.md)
و[docs/35](../../35_live_channels_runbook.md).

## 1. مصفوفة الأنواع × القنوات

مسموح فقط بـ`DECLARED_AND_TESTED` (بدليل قناة) أو `NOT_DECLARED` أو `BLOCKED`.
لا يمنع `NOT_DECLARED` إعلان قناة كاملة لازمة لوعد الخمس؛ بل يمنع إعلان النوع نفسه قبل دليله.

| النوع | tiket | Booking | Agoda | Traveloka | Trip | ملاحظة القيد |
|---|---|---|---|---|---|---|
| room | NOT_DECLARED | NOT_DECLARED | NOT_DECLARED | NOT_DECLARED | NOT_DECLARED | الأساس المتوقع؛ يحتاج Mapping خطط/إشغال/وجبات لكل قناة |
| villa (WHOLE) | NOT_DECLARED | NOT_DECLARED | NOT_DECLARED | NOT_DECLARED | NOT_DECLARED | يحتاج تمثيل استمرار مورد + قيود؛ لا نشر مع أجزائه |
| villa parts (PARTS) | BLOCKED | BLOCKED | BLOCKED | BLOCKED | BLOCKED | يمنع النشر المتداخل مع WHOLE قبل سحب ومطابقة (D-20) |
| apartment | NOT_DECLARED | NOT_DECLARED | NOT_DECLARED | NOT_DECLARED | NOT_DECLARED | نفس شروط room |
| bed | NOT_DECLARED | NOT_DECLARED | NOT_DECLARED | NOT_DECLARED | NOT_DECLARED | حصة/إشغال مختلفان؛ يحتاج سعر إشغال صريح |
| site | NOT_DECLARED | NOT_DECLARED | NOT_DECLARED | NOT_DECLARED | NOT_DECLARED | قد لا تمثله بعض القنوات؛ يُسجل UNSUPPORTED عندها |
| tent | NOT_DECLARED | NOT_DECLARED | NOT_DECLARED | NOT_DECLARED | NOT_DECLARED | كما site |
| cabin | NOT_DECLARED | NOT_DECLARED | NOT_DECLARED | NOT_DECLARED | NOT_DECLARED | كما site |
| house | NOT_DECLARED | NOT_DECLARED | NOT_DECLARED | NOT_DECLARED | NOT_DECLARED | كما villa |
| composite (A+B) | BLOCKED | BLOCKED | BLOCKED | BLOCKED | BLOCKED | لا مورد ثالث؛ يلزم تركيب مثبت وهوية مورد مستمرة |

**قاعدة الفتح**: خلية واحدة تنتقل إلى `DECLARED_AND_TESTED` فقط بمرجع test_run وقناة وبيئة
وconnection ومصفوفة موارد وفق [docs/35](../../35_live_channels_runbook.md). محاكي أو قناة أخرى
لا يملأ الخلية.

## 2. خطة القنوات (مراحل الـpilot)

الترتيب المبدئي للـpilot يُحسم عند تفويض EX-01/EX-02 وفق جاهزية التفويض والمزود، وليس هنا كقرار.
لا تُمنح قناة تأخيراً إلى ما بعد إعلان V1 بسبب ترتيب pilot.

| القناة | التركيز قبل التفعيل | فحوص خاصة إلزامية | الحالة |
|---|---|---|---|
| tiket-com | طلب الاتصال عبر دعم tiket ثم اختبار Property وربط الغرف/الخطط | modify/cancel/recovery وStop Sell فعلي | NOT_TESTED / BLOCKED_EXTERNAL |
| booking-com | اختيار Channex في extranet، mapping وخطط مشتقة وإشغال | تغطية الخطط، استيراد الالتزامات قبل snapshot، التفاصيل الناقصة | NOT_TESTED / BLOCKED_EXTERNAL |
| agoda | تفعيل channel manager في YCS واختيار Channex | دلالة سعر الإشغال وIDs والعملة/العمولة | NOT_TESTED / BLOCKED_EXTERNAL |
| traveloka | Property connection ID قد يختلف؛ mapping متعدد الإشغال والوجبات | عدم مضاعفة الحصة بعروض وجبات، gross/net وpartial ARI | NOT_TESTED / BLOCKED_EXTERNAL |
| trip-com | مسار Ctrip/Trip.com وربط الغرف/الخطط | هوية الحساب والتغطية والعملة والقيود الفعلية | NOT_TESTED / BLOCKED_EXTERNAL |

## 3. متطلبات لكل قناة قبل إعلان نوع

1. Mapping: Property/Room Type/Rate Plan/Meal Plan/Occupancy بإصدار وتاريخ تحقق.
2. عملة صريحة (IDR/USD) ودقة منزلتين مع رفض الكسور غير المدعومة (`FRACTIONAL_IDR`) عند غياب قدرة مثبتة.
3. تمثيل الاستمرار: ليالٍ متصلة على مورد واحد (AT-C08) وهوية مورد ثابتة أو رفض التركيب.
4. WHOLE/PARTS: لا نشر متداخل لنفس المورد/الفترة، وتبديل الوضع بعد سحب ومطابقة فقط.
5. سعر ووجبة وإشغال: لا نسخ صامت لسعر واحد عبر الإشغالات؛ يُثبت كل variation.
6. دليل إغلاق: readback أو إجراء تحقق بشري موثق؛ HTTP 200/قبول المزود ليس دليل قناة.

## 4. إدارة الحصة (D-20)

- حصة خارجية واحدة لكل مورد ذري/فترة؛ يمكن توزيع موارد مختلفة على الخمس في آن واحد.
- فيلا WHOLE تنشر وتغلق الأجزاء؛ PARTS تنشر الأجزاء وتغلق الكل؛ لا تبديل بلا سحب ومطابقة.
- فتح/إغلاق مؤرخان حسب الاتصال والعرض؛ `Open` يزيل سبباً محدداً ولا يتجاوز صيانة/التزام/سحباً مجهولاً.
- أي `UNKNOWN` في قدرة أساسية يمنع التفعيل؛ `UNKNOWN` في اختيارية يخفيها ويمنع إرسالها.
