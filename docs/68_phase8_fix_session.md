# جلسة إصلاح findings المراجعة المستقلة للمرحلة 8 (G-08)

التاريخ: 15 سبتمبر 2026. المراجع الحاكم: [docs/67](67_phase8_independent_review.md) و[docs/66](66_phase8_review_prompt.md)
و[docs/25](25_logical_model_contract.md) و[docs/08](08_finance_business_date.md) و[docs/32](32_execution_work_packages.md)
قسم P08 و[docs/65](65_phase8_execution_prompt.md). النطاق: إغلاق F-RVW8-01 (عالٍ)، F-RVW8-02 وF-RVW8-03
(متوسطان)، مسح تحصين العملات على كل كائنات `money`، وتحصين كامن واحد — محلياً فقط، بلا commit وبلا
مهاجرة جديدة (لا تغيير مخطط)، وبلا مساس بحدود P09 أو D-01..D-14.

**الحالة: G-08 = REMEDIATED / REVIEW_PENDING.** هذا السجل لا يمنح قبولاً؛ يلزم فحص مركّز
(بنمط [docs/64](64_g07_focused_review.md)) والقبول قرار المستخدم، ولا تُفتح P09.

## جدول الإغلاق

| Finding | الخطورة | الحالة | الدليل الأساسي |
|---|---|---|---|
| F-RVW8-01 — العكس/التسوية بعد CLEARED لا يعيدان PENDING | عالٍ | **مغلق** | `reopenClearanceForFolios` في `reverseCharge`/`postAdjustment`؛ اختبارا finance-integration؛ harness **48/48** |
| F-RVW8-02 — `money.currency` مُهملة في RecordPayment | متوسط | **مغلق** | `assertMoneyCurrency` على money/gross/commission ومسح كل العمليات؛ اختبار العملات؛ harness |
| F-RVW8-03 — إشعار دائن يرحّل GL credit بلا أثر في الذمة | متوسط | **مغلق** | `sumFolioAdjustments` يقرأ قيود CN المرتبطة بفواتير الحساب + إعادة فتح عند الإصدار؛ probe الفجوة=0 |
| تحصين كامن — `updateReservationCheckoutState` يضبط PENDING دون تصفير أدلة الحسم | منخفض/تحصين | **مغلق** | تصفير `cleared_at`/`basis`/`reference`/`payer_folio_id` في نفس التحديث |
| حد معلن — تحويل رصيد ناتج تسوية موجبة يفشل مغلقاً | حد | **أُبقي موثقاً** | `probes2` 4/4: `422 TRANSFER_NOT_SUPPORTED` بلا أي تغيير في مخطط التخصيص |

## F-RVW8-01 (عالٍ) — إعادة فتح الذمة عند كل حركة مالية مصححة

- أُضيف استدعاء `reopenClearanceForFolios(em, context, propertyId, [charge.folio_id])` بعد
  ترحيل القيد وكتابة الـaudit في:
  - `reverseCharge` — `packages/backend/src/modules/finance/application/refund-service.ts`.
  - `postAdjustment` — الملف نفسه.
  إلى جانب المسارات القائمة (Charge/Payment/Reconcile/Refund/Routing/Schedule/Package/Deposit
  Application). النتيجة: أي حركة مالية لاحقة على حساب حجز CLEARED تعيده PENDING مع
  `finance.clearance_reopened` وترصيد `cleared_at/basis/reference/payer_folio_id` — التزاماً
  بعبارة docs/25 «وأي حركة مالية لاحقة تعيده PENDING» وسؤال docs/66 (6).
- اختبارات: `tests/property/finance-integration.pg.test.mjs` —
  «a reversal after CLEARED reopens the reservation and keeps the ledger balance»،
  و«an adjustment after CLEARED reopens the reservation and changes the balance»
  (PENDING + تصفير الأدلة + audit واحد + رصيد `-120000`/`50000` في GetFolio وclearance).
- المسح المستقل: الفحصان (e)/(e2) في harness المراجعة كانا FAIL في docs/67 وصارا PASS.

## F-RVW8-02 (متوسط) — فرض العملة المعلنة على كل كائنات money

- دالة مشتركة جديدة في `packages/backend/src/modules/finance/domain/money.ts`:
  `assertMoneyCurrency(provided, expected, field)` — تجاهل الغياب (استنتاج العملة من المستند كما
  كان)، ورفض الاختلاف بـ`400 INVALID_REQUEST` و`details.reason='currency_mismatch'` و`field`
  كامل (`money.currency`، `gross_money.currency`، `commission_money.currency`،
  `tax_money.currency`، `unit_money.currency`، `unit_tax_money.currency`،
  `allocations[i].money.currency`). **لا تحويل عملة** (D-11/D-14): مستند واحد = عملة واحدة.
- طُبّق على كل عملية تستقبل `money` مع عملة مُعلنة، عبر تمرير الحقل من الـcontroller إلى الخدمة:
  RecordPayment (money/gross/commission معاً)، RequestRefund، PostAdjustment، ReverseCharge
  (بلا كائن money)، IssueInvoice (net/tax)، IssueCreditNote، PostCharge (tax)، RouteCharge
  (لكل تخصيص)، CreateChargeSchedule وCreatePackageEntitlement (net/tax)، CollectDeposit،
  ApplyDeposit، ReleaseDeposit.
- اختبارات: «declared money currency must match the ledger currency on every money field» في
  finance-integration (تسع محاولات mismatch + رصيد نهائي سليم)، و«money.currency mismatch on
  the folio is refused» في harness المراجعة صار PASS بعد أن كان FAIL.

## F-RVW8-03 (متوسط) — الذمة الفرعية تقرأ قيود الإشعار الدائن

- `sumFolioAdjustments` في `packages/backend/src/modules/finance/persistence/clearance-repository.ts`
  صار يجمع أثر `FOLIO_GUEST` لفرعين: قيود العكس/التسوية المرتبطة برسوم الحساب (كما كان)، **وقيود
  الإشعارات الدائنة** المنشورة لصالح فواتير الحساب (`folio_credit_note.journal_id` → `folio_invoice.folio_id`).
  بهذا تُشتق `balance_due` من الوقائع المرحّلة، فلا تتباعد الذمة الفرعية عن الدفتر:
  الفجوة المرصودة في docs/67 (رصيد 111000 مقابل GL 100000) صارت `adjustments_total='-11000'`
  و`balance_due='100000'` وGL=100000.
- `issueCreditNote` صار يستدعي `reopenClearanceForFolios` بعد الترحيل، لأن الإشعار حركة مالية
  تخفض الذمة: إذا أنتج رصيداً دائناً يرفض `SettleClearance` بـ`422 CLEARANCE_CREDIT`
  (`refund_pending`) حتى ينجح استرداد فعلي — سلوك قائم غير معدّل.
- **قرار النموذج**: لا تغيير في النموذج المالي ولا قرار D جديد. docs/08 يبقي «Credit Note تصحيح
  فاتورة وليس Refund»؛ الإصلاح يطبّق مبدأ docs/25 نفسه (الذمة من القيود المنشورة) فيصبح أثر
  الإشعار ظاهراً في `adjustments_total` بدل أن يوجد في GL وحده. لا مهاجرة ولا تغيير مخطط.
- اختبارات/أدلة: «a credit note corrects the folio balance, reopens clearance and blocks clearing
  as credit» في finance-integration؛ `probes.mjs` — الفجوة بين الدفتر والذمة الفرعية صفر؛ وتحديث توقعات
  بصريات phase8 من 266500 إلى 255500 بعد أن بات الإشعار 11000 يخفض الرصيد فعلاً (تغيير متوقع
  وليس إضعافاً للفحص؛ الباقي 34/34).

## تحصينات مصاحبة

- `updateReservationCheckoutState` (reservations/persistence): عند إرجاع الحجز PENDING تُصفَّر
  أيضاً `financial_cleared_at/basis/reference/payer_folio_id` في نفس التحديث، فلا يصطدم قيد
  `CLEARED ⇔ cleared_at` بانتقال checkout لاحق (كان فخاً كامناً في قراءة docs/67 المنخفضة).
- **لم أغيّر** فحوص حالة الفوليو `OPEN` في Apply/ReleaseDeposit: الإفراج عن تأمين أو تطبيق وديعة
  على حساب بعد المغادرة سلوك أعمال مشروع، وتقييده بغير دليل يخاطر بوظيفة قائمة.
- حد تحويل التسوية الموجبة بقي كما هو (fail-closed). إثبات مستقل: `probes2` 4/4.

## الأدلة (جولة الإصلاح، كلها بعد `dev:stop` حيث يلزم)

- `pnpm db:check` نجاح؛ `pnpm check` **85/85 في 11 حزمة**؛
  `pnpm contracts:check` 43/30/36/21/15/10/**35** ومطابقة الأنواع (بلا تغيير عقد: الإصلاحات
  سلوكية/تحقق داخلي).
- `pnpm test:property` **237/237 في 33 حزمة** (كان 233؛ +4 اختبارات إصلاح)، والعدائي صراحةً
  **36/36 في سويتين**؛ `pnpm test:identity` **48/48**؛ `pnpm test:distribution` **48/48**.
- البصريات: phase8 **34/34** (14 لقطة)، phase7 **35/35**، phase6 **24/24**، phase5 **19/19**،
  `pnpm visual:check` **38/38**.
- المراجعة المستقلة المعادة: `run.mjs` **48/48** (كان 45/48)، `probes.mjs` **4/4**،
  `probes2.mjs` **4/4**؛ السجلات الخام في `.local/verification/review-g08/p08fix-*.log`
  واللقطات/التقارير المحدّثة في `.local/verification/P08-0*/`.
- `pnpm format` ثم `pnpm checksums` ثم `sha256sum -c CHECKSUMS.sha256` — العدد النهائي في
  سجل الجولة `.local/verification/review-g08/p08fix-checksums.log`.

## حدود ما زالت معلنة

- لا AT منفذة ولا مزود دفع/FX حي ولا قناة حية ولا جاهزية إنتاج؛ لا تحويل عملة (D-11/D-14) ولا
  جمع IDR مع USD، وEX-03 الإنتاجي ما زال مرفوضاً حتى ملف معتمد.
- لا مهاجرة جديدة: أثر CN يقرأ من الجداول القائمة، وإعادة الفتح تستخدم الأعمدة القائمة.
- تحويل ذمة لرصيد ناتج عن تسوية موجبة يبقى `TRANSFER_NOT_SUPPORTED` (حد تصميم مخطط التخصيص).

## التالي

أُجري الفحص المركّز لـG-08 ([docs/69](69_phase8_focused_review.md)): **F-RVW8-01..03 مغلقة
والتحصينات قائمة ولا ارتداد منتج**، و**F-RVW8F-01 (متوسط، أطقم فقط) أُغلق بتفويض المستخدم**
بإصلاح اختباري محصور (عدّ `corrections-finance` مرتبط بـ`adjusts_journal_id` لرسمه) مع
تشغيلين كاملين **237/237**. القبول قرار المستخدم؛ لا تُفتح P09 ولا يُعلن أي جاهزية إنتاج.
