# المراجعة المستقلة لـG-08 (المرحلة 8: المالية التشغيلية): برومبت جلسة منفصلة

التاريخ: 15 سبتمبر 2026. الغرض: مراجعة مستقلة لـP08-01..P08-06 (35 عملية) قبل أي قبول لـG-08.
كتلة اللصق الجاهزة في نهاية الملف.

## كيف تُدار الجلسة

1. تُشغَّل في جلسة جديدة تماماً بلصق الكتلة في نهاية الملف فقط (لا يُشارك سياق المنفذ).
2. أي findings متوسطة/عالية تُفتح لها جلسة إصلاح بتفويض المستخدم قبل أي قبول.
3. لا يُعلن قبول G-08 إلا بقرار المستخدم صراحةً، ويفتح القبول P09 (إن وُجد) فقط.

## ما يجب أن يعرفه المراجع قبل الانطلاق

- السياق الحاكم: [docs/65](65_phase8_execution_prompt.md) (برومبت التنفيذ)،
  [docs/32](32_execution_work_packages.md) قسم P08، وبطاقات
  [P08-01](execution/P08-01.md)..[P08-06](execution/P08-06.md) وسجل
  [G-08](execution/G-08.md). القرارات D-11/D-13/D-14 محسومة بالتفويض في
  [docs/17](17_decisions_readiness.md) و[docs/23](23_v1_decisions.md) — لا تُعاد فتحها،
  ويُراجع فقط إنفاذها كما كُتبت.
- التصميم المالي: [docs/08](08_finance_business_date.md) (F-05..F-10 والحالات)،
  [docs/25](25_logical_model_contract.md) (Folio/Charge/PayerAllocation/Journal)،
  [docs/26](26_api_events_contracts.md) (CheckOut والرصيد/الذمة)،
  [docs/21](21_indonesia_launch.md) (LOC-003/005 وفصل العملات بلا FX مباشر).
- الصلاحيات والمخاطر: `folio.read`/`folio.charge`/`payment.record`/`payment.refund.request`/
  `folio.adjust`/`invoice.issue` (MFA)/`cashier.operate`/`business_day.close` (MFA) وفق
  [docs/09](09_identity_security.md) و[docs/26](26_api_events_contracts.md).
- العمليات الـ35 في `docs/contracts/phase8.openapi.json` (v0.25.0):
  - P08-01 (2): `GetBusinessDay`, `RunNightAudit`.
  - P08-02 (12): `OpenFolio`, `ListFolios`, `GetFolio`, `PostCharge`, `RouteCharge`,
    `CreateChargeSchedule`, `PostSchedulePeriod`, `CreatePackageEntitlement`,
    `ConsumePackage`, `CollectDeposit`, `ApplyDeposit`, `ReleaseDeposit`.
  - P08-03 (4): `ListPayments`, `GetPayment`, `RecordPayment`, `ReconcilePayment`.
  - P08-04 (7): `RequestRefund`, `ResolveRefund`, `ReverseCharge`, `PostAdjustment`,
    `RequestFxSnapshotApproval`, `RecordFxSnapshot`, `ListFxSnapshots`.
  - P08-05 (7): `IssueInvoice`, `IssueCreditNote`, `ListInvoices`, `OpenCashierSession`,
    `CountCashierSession`, `CloseCashierSession`, `ListCashierSessions`.
  - P08-06 (3): `GetReservationClearance`, `SettleClearance`, `ListExternalSettlements`.
- الحزم: P08-01 Money/Journal/BusinessDay؛ P08-02 Folio/Charges/Payers/الطويل؛
  P08-03 Payments/OTA/Unknown؛ P08-04 Refund/Reversal/Adjustment/FX؛ P08-05 Invoice/
  CreditNote/Cashier + واجهة `/properties/:id/finance`؛ P08-06 clearance/الذمة/المغادرة +
  التسويات الخارجية + تبويب «الذمة والتسويات» + بصريات phase8 (34/34).
- جولة الإغلاق: `.local/verification/P08-07/` (واجهة + بصريات + أطقم كاملة). عيب حقيقي
  اكتُشف في P08-06 وأُصلح فيها: `planTransfer` كان يفترض `posted_at` كـ`Date` بينما صفوف
  الاستعلام الخام تعيده نصاً، فكان التحويل يفشل 500 عند وجود رسمين أو أكثر (اختبارات
  P08-06 أحادية الرسم لم تُفعّل المقارن)؛ أُصلح التطبيع وأُقوّي اختبار التحويل برسمين
  وتخصيص FIFO. كما صُحح انحراف fixture في اختبارات الهوية (AUDITOR اكتسب `folio.read` في
  P08). هذه نقاط تستحق إعادة إنتاج مستقلة.

## ما يجب إعادة إنتاجه مستقلاً (لا تثق بأرقام المنفّذ)

1. **توازن الدفتر وجمود المنشور**: قيد PostgreSQL وtrigger التوازن المؤجل يرفضان قيداً
   غير متوازن؛ لا UPDATE/DELETE للقيود من دور التشغيل بعد الترحيل؛ ترحيل UNKNOWN لا يحرر
   حجزاً، والمطابقة مرة واحدة؛ `journal` لكل عملة على حدة.
2. **Decimal/HALF_UP وRLS**: تجميع وسيط 6 منازل وترحيل منزلتين HALF_UP لكل بند مع سطر
   `ROUNDING_DIFFERENCE` معلن عند اللزوم؛ FORCE RLS على جداول المالية كلها؛ دور API لا
   يعبر المنشآت (owner-b → 404/403 بلا تسريب) ولا يرى قيوداً غير مصرح بها.
3. **Folio/الرسوم/الودائع/الدفع/الاسترداد**: لقطة ضريبة ومصدر فريد (SOURCE_ALREADY_POSTED
   عند التكرار)؛ الرسوم المنشورة immutable والتصحيحات تنزل في `adjustments_total`؛ توجيه
   `payer_allocation` لا يضاعف الإيراد؛ الوديعة التزام لا إيراد ولا تطبيق مزدوج؛ الاسترداد
   ≤ المحصل وحسم SUCCEEDED باعتماد مستقل مستخدم آخر (AT-S02) وFAILED يحرر الحجز بلا
   تحصيل مزدوج.
4. **الفاتورة/التسلسل/EX-03/الإشعار الدائن**: أرقام متسلسلة لا تتكرر ولا تُستهلك عند فشل
   الإصدار؛ `PRODUCTION` بلا ملف EX-03 معتمد يُرفض `422 EX03_NOT_APPROVED` ويبقى
   `SYNTHETIC` ممكناً؛ إشعار دائن مرتبط لا يتجاوز الفاتورة ويُرحّل قيد تصحيح واحد.
5. **الصندوق والفرق السالب**: جلسة واحدة لكل عملة؛ العدّ يسجّل المتوقع/الفعلي/الفرق بما فيه
   الفرق السالب؛ الإغلاق يحفظ الفرق ولا يمحوه.
6. **clearance «غادر لا تعني سدد» وTRANSFER_TO_PAYER/D-13**: عند Check-Out تبقى
   `financial_clearance_state='PENDING'`؛ `SETTLED` يُقبل فقط بكل الحسابات صفراً من الدفتر،
   وإلا `422 CLEARANCE_OUTSTANDING`، والدائن `422 CLEARANCE_CREDIT`؛ `TRANSFER_TO_PAYER`
   يشترط دافع `COMPANY` مستقلاً (city ledger غير مرتبط بالحجز) و`collection_plan_ref`
   إلزامياً، ويُرحّل `AR_GUEST` مدين/`FOLIO_GUEST` دائن بلا إيراد جديد وبلا FX؛ أي حركة
   مالية لاحقة تعيد CLEARED إلى PENDING مع audit؛ سباق حسم متزامن بفائز واحد وaudit واحد.
   **أعد اختبار التحويل مع رسمين أو أكثر على الحساب** (فخ P08-06 المُصلح) وتحقق من FIFO
   وسلامة القيد والنص المتوقع `posted_at`.
7. **التسويات الخارجية**: `ListExternalSettlements` يفصل gross/net/commission ويربط
   بالحجز الخارجي عند وجوده، ولا يجمع IDR مع USD ولا يطبّق أي تحويل عملة؛ مرفوض mismatch
   عملة الحساب.
8. **الإقامات الطويلة بلا مضاعفة**: جدول دوري وباقة كمية ينشران مرة واحدة؛ replay بمفتاح
   idempotency يعيد بلا أثر، وإعادة نشر فترة سابقة تُرفض؛ العرض يجمع
   posted_periods/next_period_start/consumed بجانب الرصيد.
9. **سباقات/Unknown/عدم تسريب**: سباقات الدفع/الحسم/الإغلاق بفائز واحد؛ Unknown لا يحرر؛
   DTO صارم يرفض pan/cvv (zod strict) ولا يعيد حقولاً ممنوعة أو حمولات خام؛
   Idempotency-Key وCSRF على كل كتابة؛ لا PAN/CVV ولا مزود دفع حي ولا FX.
10. **الفحص العدائي وعموم المرحلة**: أعد `pnpm test:property -- --filter=adversarial`
    (سويتان، 36 اختباراً) وافحص أي كتابة بلا idempotency/audit، أي حدث مضاعف، وأي ادعاء
    AT/قناة حية/جاهزية إنتاج بلا دليل، وإعادة تشغيل مسارات P05/P06/P07 (تواريخ العمل،
    التراكب، إغلاق التخصيصات، منع OOO/Block) فوق المالية.

المطلوب كتابة الحكم في `docs/67_phase8_independent_review.md` (لا تعدّل كود إنتاج أو اختبارات
أو مهاجرات): PASS / PASS WITH FINDINGS / FAIL، وبند مغلق/غير مغلق لكل سؤال، وfindings
مصنفة بالخطورة مع أدلة إعادة إنتاج خام ومساراتها. **لا تمنح قبول G-08؛ القرار للمستخدم.**

## كتلة جاهزة للصق في جلسة مستقلة

انسخ الكتلة التالية كأول رسالة في جلسة جديدة تماماً (بلا سياق المنفذ):
```text
راجع محلياً نتائج المرحلة 8 (P08: المالية التشغيلية) في /home/omar/Desktop/Hotel دون كتابة
كود إنتاج أو تعديل اختبارات أو مهاجرات. لا تقبل G-08 نيابة عن المستخدم؛ سلّم حكماً توصيفياً
(PASS/PASS WITH FINDINGS/FAIL) مع findings مصنفة بالخطورة وأدلة إعادة إنتاج.

البيئة: export PATH="/tmp/hotel-pnpm10/node_modules/.bin:$PATH"؛ PostgreSQL 17.11 على 55432،
Redis 7.4.11 على 56379، Keycloak 26.7.3 على 58080. لا تشغّل dev أثناء أطقم
property/identity/distribution (تنازع 4100)؛ أوقفه pnpm dev:stop ثم أعد تشغيله للبصريات فقط.
الأسرار من .env فقط ولا تُطبع. الحسابات الاصطناعية: owner-a (بلا MFA)، admin-a (TOTP)،
member-a، auditor-a، owner-b. بيانات جديدة ببادئة مراجعتك وبذرة/طوابع فريدة، وبلا بيانات
نزلاء حقيقية.

القراءة الإلزامية: AGENTS.md ثم README.md وdocs/01 وdocs/17 وdocs/32 (قسم P08) وdocs/65
وdocs/66 هذا الملف وdocs/execution/P08-01..06 وdocs/execution/G-08
وdocs/contracts/phase8.openapi.json وscripts/contracts.mjs وscripts/phase8-visual.mjs.
افحص الكود في packages/backend/src/modules/finance وapps/api/src/finance
وapps/web/src/finance/FinancePage.tsx وapps/web/src/api/finance.ts، ومهاجرات
20260915160000..20260915210000، وtests/property/finance-core.pg.test.mjs
وfolio-finance وpayments-finance وcorrections-finance وbilling-finance
وfinance-integration.

أعد تشغيل الأدلة بنفسك: pnpm db:check ثم pnpm check ثم pnpm contracts:check ثم
pnpm test:property (كامل؛ شامل الفحص العدائي) ثم pnpm test:property:fast --
--filter=adversarial ثم pnpm test:identity ثم pnpm test:distribution (بعد pnpm dev:stop)
ثم pnpm dev ثم pnpm visual:phase8 وpnpm visual:phase7 وpnpm visual:phase6
وpnpm visual:phase5 وpnpm visual:check ثم pnpm dev:stop ثم pnpm checksums
وsha256sum -c CHECKSUMS.sha256.

أعد إنتاج الحالات الآتية بأدواتك المستقلة تحت .local/verification/review-g08/
(بيانات اصطناعية):
1) توازن/جمود الدفتر: قيد غير متوازن يُرفض، لا UPDATE/DELETE من دور التشغيل، Decimal
   HALF_UP وسطر تقريب معلن، RLS/FORCE والمنح على جداول المالية، وعزل owner-b.
2) Folio: مصدر فريد، لقطة ضريبة، توجيه لا يضاعف الإيراد، تصحيح ينزل بالرصيد صفراً دون
   تعديل صف الرسم، وديعة لا تُطبّق مرتين.
3) الدفع/Unknown/الاسترداد: UNKNOWN لا يحرر، مطابقة واحدة، استرداد ≤ المحصل، SUCCEEDED
   باعتماد مستخدم آخر، FAILED يحرر، سباق دفع/استرداد بفائز واحد.
4) الفاتورة/الإشعار: تسلسل لا يتكرر ولا يُستهلك عند فشل، EX-03 يرفض PRODUCTION
   (422 EX03_NOT_APPROVED) ويبقي SYNTHETIC، إشعار دائن لا يتجاوز الفاتورة بقيد واحد.
5) الصندوق: جلسة لكل عملة، فرق سالب محفوظ عند الإغلاق.
6) clearance: Check-Out يبقي PENDING؛ SETTLED فقط برصيد صفري وإلا
   CLEARANCE_OUTSTANDING/CREDIT؛ TRANSFER_TO_PAYER بدافع COMPANY مستقل ومرجع خطة،
   AR_GUEST/FOLIO_GUEST بلا إيراد وبلا FX؛ أعِد اختبار التحويل مع رسمين أو أكثر (فخ
   posted_at المُصلح) وFIFO؛ أي حركة لاحقة تعيد PENDING؛ سباق حسم بفائز واحد.
7) التسويات الخارجية: gross/net/commission منفصلة، ربط الحجز الخارجي، بلا جمع عملات أو
   تحويل، ورفض mismatch العملة.
8) الإقامات الطويلة: دورية/باقة مرة واحدة وreplay آمن وعرض posted_periods/next_period_start/
   consumed بلا مضاعفة.
9) بصريات phase8 عبر الواجهة: حجز غادر برصيد يظهر PENDING، ثم SETTLED يفشل مغلقاً 422،
   ثم TRANSFER_TO_PAYER إلى COMPANY بمرجع خطة يظهر CLEARED بالأساس والمرجع، وقائمة
   التسويات الخارجية gross/net/commission؛ وRTL و390px بلا فائض أفقي؛ مع حفظ الفحوص
   القائمة (25) بلا حذف. ثم phase7/phase6/phase5/visual:check لعدم الارتداد.
10) الفحص العدائي: أي كتابة بلا idempotency/audit، أي حدث مضاعف، أي تراكب، وأي ادعاء
    AT/قناة حية/جاهزية إنتاج بلا دليل، مع إعادة مسارات P05/P06/P07.

ثم اكتب حكمك في docs/67_phase8_independent_review.md: جدول الأسئلة أعلاه مغلق/غير مغلق،
وقائمة findings بالخطورة ومسارات الأدلة الخام، وبيان الاستقلال (لماذا لا تعتمد أرقام
المنفّذ)، وحدود ما لم تختبره. لا تصلح شيئاً بنفسك؛ إن ظهر finding عالٍ متوقف عند إشعار
المستخدم.
توقف وأبلغ فوراً عند: finding عالٍ جديد، أو تعارض بين الوثائق والسلوك، أو حاجة بيانات/شبكة
حقيقية.
```
