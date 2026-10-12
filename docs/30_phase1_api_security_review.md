# مراجعة أمن API للمرحلة 1

التاريخ: 13 سبتمبر 2026. النطاق الفعلي فقط: GET لصحة API وWorker. المراجعة على OWASP API Security Top 10 (2023)، ولا تشمل عمليات V1 المخططة غير المنفذة. ملف التشغيل الإضافي المشار إليه من مهارة المراجعة المحلية لم يكن موجوداً، لذلك أجريت المراجعة مباشرة من العقد والكود والاختبارات.

## السطح والثقة

| العملية | المصادقة | البيانات | التعرض الحالي |
|---|---|---|---|
| GET `/api/v1/system/health` | عام | اسم العملية وحياتها | loopback فقط |
| GET `/api/v1/system/ready` | عام | up/down لـDB وRedis وKeycloak | loopback فقط |
| GET Worker `/health` و`/ready` | عام | كما سبق | loopback فقط |

لا endpoints أعمال أو tenant/property IDs أو ملفات ضيوف أو webhooks أو رفع ملفات. لا CORS مفعل، وكل عملية تربط بـ127.0.0.1 لأن config يرفض production والعناوين الخارجية. عقد التنفيذ [foundation.openapi.json](contracts/foundation.openapi.json) منفصل عن عقد V1 المخطط.

## مصفوفة OWASP

| الخطر | الحالة في هذا النطاق | الدليل أو البوابة |
|---|---|---|
| API1 BOLA | غير قابل حالياً لغياب موارد وهوية عملاء | يلزم تفويض Application واختبار النطاق في المرحلة 3 قبل أول مورد |
| API2 Broken Authentication | مسارات الصحة عامة عمداً؛ OIDC غير منفذ | لا تعتبر Keycloak الجاهز مصادقة؛ AT-T03 باقٍ |
| API3 BOPA | لا body أو fields أعمال؛ query غير معروف يرفض | اختبار 400 وعدم عكس المدخل |
| API4 Resource Consumption | body JSON محدود 16 KiB ومهلات الاعتماديات محدودة؛ لا rate limiter | مقبول محلياً فقط؛ محدد معدل وبوابات edge شرط قبل أي تعرض شبكي |
| API5 BFLA | لا وظيفة إدارية | Keycloak admin منفذ محلي؛ لا يمر عبر API التطبيق |
| API6 Business Flows | لا تدفقات أعمال | يراجع مع holds والمخزون والقنوات في مراحلها |
| API7 SSRF | عنوان Keycloak وDB وRedis من env موثوق ومقيد loopback | config يرفض host خارجي؛ لا URL من الطلب |
| API8 Misconfiguration | Helmet، إخفاء x-powered-by، no-store، JSON ثابت، CORS مغلق، أخطاء آمنة | اختبارات headers وطرق و413؛ الإعداد يرفض production |
| API9 Inventory | أربعة GET فقط موثقة، ومسارات V1 غير منفذة تعيد 404 | تحقق OpenAPI وعدم endpoint وهمي |
| API10 Unsafe Consumption | استجابات Keycloak تتحقق من status، والمهلات والتنظيف موجودة؛ لا provider payload | Adapter/webhook غير منفذ؛ قواعده في docs/26 تبقى بوابة المرحلة 2/13 |

## نتائج الاختبار

اختبرت آلياً: GET ناجح، 503 عند تعطل كل اعتماد ثم التعافي، liveness مستقل، query مجهول، JSON مشوه، body أكبر من 16 KiB، POST/OPTIONS غير مسموحين، Origin غير موثوق بلا CORS، correlation ID، headers، وعدم ظهور كلمات المرور أو stack أو نص الخطأ الخام. فحص npm انتهى بلا ثغرات معروفة وقت التنفيذ بعد تحديث OpenTelemetry وmulter وuuid وRedis.

لم يتوفر OWASP ZAP أو Burp، ولم يجر فحص DAST بمتصفح أو WAF/TLS/gateway لأن لا نشر ولا exposure. لا نسمّي مراجعة الكود والاختبارات الحالية اختبار اختراق.

## المتبقي قبل التعرض أو المرحلة 3

P1 قبل أي عنوان غير loopback: مصادقة OIDC والجلسة الخادمية وCSRF للعمليات المغيرة، تفويض مركزي وRLS، فصل readiness الداخلي عن liveness العام، TLS/proxy موثوق وrate limits وحصص وقياس abuse، وحدود headers/timeouts على edge.

P1 قبل webhooks والقنوات: مصادقة service مستقلة، منع replay، allowlist سلوك لا URL وارد، حد payload ومعدل، تخزين safe payload، idempotency، وعدم تحويل webhook إلى authority. P1 قبل عمليات الأعمال: BOLA/BFLA/BOPA واختبارات tenant/property لكل API وJob.

لا P0 في السطح الحالي ضمن شرط loopback والتطوير. تحويل `NODE_ENV` أو host constraints إلى production دون تطبيق البنود السابقة غير مسموح ومراجعة جديدة واجبة.
