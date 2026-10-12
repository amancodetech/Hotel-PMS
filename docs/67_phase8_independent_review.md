# المراجعة المستقلة لـG-08 (المرحلة 8: المالية التشغيلية)

> ملاحظة لاحقة (15 سبتمبر 2026): هذا الحكم يصف المراجعة السابقة لجلسة الإصلاح؛ نُفذت جلسة
> إصلاح F-RVW8-01..03 في [docs/68](68_phase8_fix_session.md) وأُعيد مسح المراجعة المستقل
> **48/48**؛ يبقى **التحقق المركّز** شرط إغلاق ولم يُمنح أي قبول.

التاريخ: 15 سبتمبر 2026. جلسة مستقلة تماماً (بلا سياق المنفّذ). النطاق: P08-01..P08-06
(35 عملية) وقرارات D-11/D-13/D-14 كما هي محسومة بالتفويض (لا إعادة فتح).
لا يمنح هذا الملف قبول G-08؛ القرار للمستخدم.

**الحكم: FAIL** — finding عالٍ مفتوح واحد (F-RVW8-01) ومتوسطان (F-RVW8-02 وF-RVW8-03)
بانتظار جولة إصلاح يعقبها إعادة فحص. ما عدا ذلك، كل الأسئلة العشرة مغلقة بأدلة مستقلة،
والأرقام الرسمية للمنفّذ أُعيد إنتاجها كلها.

## بيان الاستقلال

- لم أعتمد أي رقم من أرقام المنفّذ: أعدت تشغيل كل الأوامر بنفسي وسجلتها خاماً في
  `.local/verification/review-g08/`، وأعدت البصريات بعد نسخ أدلة المنفّذ احتياطياً في
  `.local/verification.bak-review-g08/` (لم أحذف شيئاً).
- بنيت أدوات مراجعة خاصة: تسجيل دخول Playwright خاص، عميل API خاص مع CSRF/Idempotency،
  سباقات Promise متزامنة، وفحوص SQL مباشرة بأدوار `hotel_api`/`hotel_worker`/المالك.
- لم أستورد أي اختبار من اختبارات المنفّذ ولم أشغّل حزمه المالية للحكم عليها؛ شغّلت الأطقم
  الرسمية كسلسلة أدلة فقط. السيناريوهات الـ48 ومسبارات المتابعة كُتبت في هذه الجلسة.
- لم أثق بقراءة الكود وحدها: فرضيتان من القراءة الأولية (فراغات hash في idempotency، ومنح
  UPDATE على جداول مالية) سقطتا عند الاختبار الفعلي (409 CONFLICT عند إعادة استخدام المفتاح
  بمبلغ/مرجع مختلف، و23514 لقاعدة FSM) فلم تُدرجا كfindings.
- لا تعديل على كود إنتاج أو اختبارات أو مهاجرات؛ كل ما كُتب تحت `.local/verification/review-g08/`.

## الأدلة المعادة (خام)

| الأمر | النتيجة | السجل |
|---|---|---|
| `pnpm db:check` | نجاح | `review-g08/db-check.log` |
| `pnpm check` | **85/85 في 11 حزمة** | `review-g08/check.log` |
| `pnpm contracts:check` | 43/30/36/21/15/10/**35** ومطابقة الأنواع | `review-g08/contracts-check.log` |
| `pnpm test:property` (كامل) | **233/233 في 33 حزمة** | `review-g08/test-property.log` |
| `pnpm test:property:fast -- --filter=adversarial` | **36/36 في سويتين** | `review-g08/test-property-adversarial.log` |
| `pnpm test:identity` | **48/48 في 7 حزم** | `review-g08/test-identity.log` |
| `pnpm test:distribution` | **48/48 في 11 حزمة** | `review-g08/test-distribution.log` |
| `pnpm visual:phase8` | **34/34** و14 لقطة | `review-g08/visual-phase8.log` + `P08-07/report.json` |
| `pnpm visual:phase7/6/5` | **35/35 / 24/24 / 19/19** | `review-g08/visual-phase*.log` |
| `pnpm visual:check` | **38/38** | `review-g08/visual-check.log` |
| سيناريوهات المراجعة المستقلة | **45/48** (الفشل الثلاثة = findings) | `review-g08/results.json` و`run-output.log` |
| مسبارات المتابعة | 4/4 و4/4 | `review-g08/probes.json` و`probes2.json` |

حفظ الفحوص البصرية القائمة: كل فحوص P08-05 الـ25 محفوظة بالاسم في P08-07، وفحص التبويبات
وُسّع ليشمل التبويب الخامس (لا حذف)، وأُضيفت 9 فحوص — المقارنة في
`review-g08/visual-preservation.txt`.

## جدول الأسئلة

| # | السؤال | الحالة | الدليل |
|---|---|---|---|
| 1 | توازن/جمود الدفتر، Decimal HALF_UP وسطر تقريب، RLS/FORCE والمنح، عزل owner-b | **مغلق** | case1: قيد غير متوازن 23514، خطوط غير مطابقة 23514 عند commit، `hotel_api` 42501 على UPDATE/DELETE، 18/18 جدول FORCE RLS، RLS عبر سياق عميل آخر 0/42501؛ HALF_UP: net 1.005→1.01 وdebit 1.02؛ سطر `ROUNDING_DIFFERENCE` مُثبت في المخطط بالمتجهات النقية؛ owner-b ممنوع (case10)؛ لا UPDATE/DELETE على الوثائق (probes2) |
| 2 | Folio: مصدر فريد، لقطة ضريبة، توجيه لا يضاعف الإيراد، تصحيح لصفر، وديعة مرة واحدة | **مغلق** | case2: 409 `SOURCE_ALREADY_POSTED` وصف واحد، لقطة 0.11/11000 و42501 على تعديلها، توجيه AR_GUEST/FOLIO_GUEST بلا سطر إيراد، عكس 80000→0 مع بقاء صف الرسم، تطبيق وديعة واحد ورفض الثاني |
| 3 | الدفع/Unknown/الاسترداد: UNKNOWN لا يحرر، مطابقة واحدة، استرداد ≤ المحصل، اعتماد مستقل، FAILED يحرر، سباق | **مغلق** | case3: UNKNOWN بلا قيد ورصيد ثابت؛ مطابقة واحدة ثم 409؛ رفض التجاوز برصيد `refund_exceeds_available`؛ اعتماد الذات 403 `SELF_APPROVAL_DENIED` ثم اعتماد مستخدم آخر 201 وإذن واحد FOLIO_GUEST/CASH؛ FAILED يحرر؛ سباق دفعتين 200/409 وصف واحد |
| 4 | الفاتورة/الإشعار: تسلسل، EX-03، إشعار دائن بقيد واحد | **مغلق** (مع F-RVW8-03 أثر GL) | case4: 1 ثم 2 مع عدم استهلاك الرقم عند الفشل؛ PRODUCTION 422 `EX03_NOT_APPROVED` وSYNTHETIC يمضي ولا يبقى عدّاد؛ إشعار 11000 واحد ولا يتجاوز الفاتورة |
| 5 | الصندوق: جلسة لكل عملة وفرق سالب محفوظ | **مغلق** | case5: IDR مفتوحة، تكرار 409، USD مستقلة؛ عدّ 49000 مقابل 50000 → -1000 محفوظ عند الإغلاق ويرفض العد بعد الإغلاق |
| 6 | clearance: غادر PENDING، SETTLED/CLEARANCE_OUTSTANDING/CREDIT، تحويل COMPANY بمرجع خطة، FIFO، إعادة PENDING، سباق | **غير مغلق** | كل السلوكات نجحت (case6: 422 OUTSTANDING، 422 CREDIT، تحويل برسمين FIFO 50000+70000 وقيد AR_GUEST/FOLIO_GUEST بلا إيراد/FX، حركة لاحقة تعيد PENDING، سباق بفائز واحد) **عدا إعادة الفتح بعد العكس/التسوية → F-RVW8-01** |
| 7 | التسويات الخارجية: gross/net/commission، الربط، بلا جمع/تحويل، رفض mismatch | **غير مغلق جزئياً** | الانفصال بلا إيراد و`linked_to_external_booking=false` لحجز DIRECT: مغلق؛ mismatch العلوي 400 `folio_currency_mismatch`: مغلق؛ **mismatch في `money.currency` يُقبل 200 → F-RVW8-02**؛ لا حقول FX/تحويل في العرض |
| 8 | الإقامات الطويلة: مرة واحدة، replay آمن، عرض posted_periods/next_period_start/consumed | **مغلق** | case8: دورية شهرية مرة واحدة، replay بلا قيد ثانٍ، فترة مكررة 400، باقة 3 وحدات برسمين ورفض التجاوز، والعرض يعرض posted_periods=1 وnext_period_start وconsumed=3 |
| 9 | بصريات phase8 عبر الواجهة + عدم الارتداد | **مغلق** | 34/34 و14 لقطة (PENDING ثم 422 ثم TRANSFER CLEARED بالأساس والمرجع، جدول OTA net/gross/commission، RTL و390px)؛ phase7 35/35 وphase6 24/24 وphase5 19/19 وvisual:check 38/38؛ فحوص P08-05 الـ25 محفوظة |
| 10 | الفحص العدائي: idempotency/audit، أحداث مضاعفة، ادعاءات، إعادة P05/P06/P07 | **مغلق** | case10: كتابة بلا مفتاح 400، بلا CSRF 403، pan/cvv 400 بلا صدى، replay بلا صف/حدث مضاعف، owner-b ممنوع، `/system/ready` بلا ادعاء إنتاج/حي؛ الأطقم الكاملة 233/233 والعدائي 36/36 يغطيان P05/P06/P07، والهوية/التوزيع 48/48 |

## Findings

### F-RVW8-01 (عالٍ، مفتوح): العكس/التسوية بعد CLEARED لا يعيدان الذمة PENDING

- **السلوك المرصود**: بعد `SETTLED` (CLEARED)، نجح `ReverseCharge` (200) ثم أظهر
  `GetReservationClearance` الحالة **CLEARED** والرصيد **-100000** مع `settled=true` و
  `balanced=false` و**صفر** أحداث `finance.clearance_reopened`. وبالمثل `PostAdjustment`
  DECREASE أنتج رصيد **-10000** وبقيت CLEARED.
- **المخالفة**: docs/25 — «CLEARED من دفع/استرداد فعلي أو تحويل ذمة موثق (D-13)، **وأي حركة
  مالية لاحقة تعيده PENDING**»؛ وdocs/66 سؤال 6؛ وdocs/17. والرصيد نفسه يشمل
  `adjustments_total`، أي أن العكس/التسوية حركات مالية تغيّر الرصيد.
- **السبب**: `reverseCharge` (packages/backend/src/modules/finance/application/refund-service.ts:458)
  و`postAdjustment` (:549) يرحّلان قيوداً بـ`adjustsJournalId` لكن لا يستدعيان
  `reopenClearanceForFolios` (الاستدعاء الوحيد في الملف عند `resolveRefund` :450).
- **الأثر**: حالة CLEARED كاذبة يمكن أن تبقى بعد أن يصبح على المنشأة التزام/دائن للضيف،
  بلا audit، مع تناقض داخلي في نفس استجابة العرض (مُسوّى لكن غير متوازن).
- **الأدلة**: `review-g08/results.json` (تشغيل `RVW8-MU2SJ7H1`، فحصا case6 بعنوان
  «reversal/adjustment after CLEARED»)، و`run-output.log`، والسكربتات
  `cases/clearance.mjs`.

### F-RVW8-02 (متوسط، مفتوح): عملة `money` مُهملة في RecordPayment

- **السلوك المرصود**: على folio بعملة USD، دفعة `money.currency=IDR` (وgross/commission
  بـIDR) بلا حقل `currency` العلوي قُبلت **200** وخُطّت بعملة الحساب.
- **المخالفة**: docs/66 سؤال 7 «رفض mismatch العملة».
- **السبب**: `finance.controller.ts:483` يمرّر `currency: input.currency ?? null` ولا يمرّر
  `input.money.currency`؛ و`payment-service.ts:304-311` يفحص
  `input.currency ?? folio.currency` فقط. ومثله عملة `gross_money`/`commission_money`.
- **الأثر**: يمكن لعميل أن يظن أنه دفع بعملة أخرى فتُسجَّل بعملة الحساب بصمت؛ الترحيل نفسه
  متسق (بعملة الفوليو) لكن ادعاء العملة يُقبل بلا فحص.
- **الأدلة**: `review-g08/results.json` فحص case7 «money.currency mismatch on the folio is
  refused» (status=200)، وفي المقابل فحص «top-level currency mismatch is refused» نجح 400.

### F-RVW8-03 (متوسط، مفتوح — يحتمل قرار نموذج): إشعار دائن يرحّل دائناً في GL دون أثر في رصيد الفوليو

- **السلوك المرصود**: فاتورة 111000 وإشعار دائن 11000: قيد `REVENUE_OTHER` مدين /
  `FOLIO_GUEST` دائن (11000) يُنشأ، لكن `balance_due` بقي **111000**، ومجموع `FOLIO_GUEST`
  في GL لنفس المنشأة **100000**. أي أن الإشعار يخفّض GL ولا يخفّض الذمة الفرعية، ويمكن أن
  تمرّ التسوية (CLEARED) بينما يوجد رصيد دائن للضيف في GL.
- **السياق**: docs/08 يعرّف Credit Note كـ«تصحيح فاتورة وليس Refund بحد ذاته»، وdocs/25
  لم يُدخل أثر الإشعار في `balance_due` (أُدخل أثر العكس/التسوية فقط). لذا قد يكون مقصوداً
  ويتطلب قراراً: إما احتساب أثر الإشعار في `balance_due`/إعادة الفتح، أو عدم ترحيل دائن
  `FOLIO_GUEST` بلا مسار تسوية.
- **الأدلة**: `review-g08/probes.json` (فحص credit note).

## ملاحظات منخفضة/حدود (ليست findings حاجبة)

- إعادة استخدام مفتاح idempotency بمبلغ/مرجع مختلف على الفاتورة والدفع **ترفض 409 CONFLICT**
  (خُلاف قراءة كود أولية) — `probes.json`.
- `hotel_api` يملك UPDATE على `folio_payment`/`folio_refund` لانتقالات الحالة، لكن قواعد FSM
  ترفض إعادة كتابة محلول/هوية (23514) — `probes2.json`.
- حد معلن: تحويل ذمة مدفوعة بتسوية موجبة فقط يفشل مغلقاً `422 TRANSFER_NOT_SUPPORTED`
  (مخطط التحويل يحسب صافي+ضريبة الرسوم فقط) — `probes2.json`.
- حد معلن: `invoice_counter.approved` لا كاتب له في الكود، فـEX-03 الإنتاجي يبقى مرفوضاً
  دائماً (مطابق لحد G-08 المعلن، وليس finding).
- قراءة كود فقط (لم أُثبتها سلوكياً لأن لا كود يغلق الفوليو): بعض العمليات لا تفحص حالة
  الفوليو `OPEN`، و`updateReservationCheckoutState` يضبط PENDING دون تصفير `cleared_at`
  (فخ قيد كامن لا يبلغه الترتيب الطبيعي)؛ تُترك للمراجعة أثناء الإصلاح.

## ما لم أختبره (حدود المراجعة)

- لا AT منفذة ولا مزود دفع/FX حقيقي ولا قناة حية؛ لم أختبر الطباعة/التقارير (P11) ولا
  Night Audit الكامل (P10) ولا الأداء.
- لم أختبر ربط تسوية OTA بحجز خارجي فعلي (تحققت من الحقول وبقاء الربط false لحجز DIRECT
  وقرأت مسار الربط في `clearance-repository.ts`؛ الربط الفعلي يغطيه اختبار المنفّذ
  `finance-integration` الذي لم أعتمد عليه للحكم).
- لم أشغّل تراجع المهاجرات (`down`)، ولم أختبر الترقية من قاعدة بها بيانات مالية قديمة
  سالبة/شاذة سوى `db:check` وترقيات أطقم التوزيع.
- البصريات عبر Playwright محلياً لا Computer Use، وكل البيانات اصطناعية ببادئة `RVW8`.

## التوصية

1. **مطلوب قبل أي قبول**: إصلاح F-RVW8-01 (إعادة فتح CLEARED عند `ReverseCharge` و
   `PostAdjustment` مع audit، واختبارا رسم واحد/رسمان بعد CLEARED)، وإغلاق F-RVW8-02
   (فحص `money.currency` وgross/commission مقابل عملة الفوليو ورفض mismatch).
2. **يحتاج قرار المستخدم/النموذج**: F-RVW8-03 (أثر الإشعار الدائن في الذمة أو في مسار
   التسوية).
3. بعد الإصلاح: إعادة تشغيل هذه السلسلة كاملة وإعادة الحالات الـ48 والمسبارات، ثم مراجعة
   مركزة على المواضع المصلَحة. لا يمنح هذا الملف قبول G-08.

## أصول الأدلة

- القياسات المستقلة والسكربتات: `.local/verification/review-g08/` (`results.json`،
  `run-output.log`، `probes.json`، `probes2.json`، `visual-preservation.txt`، `cases/`،
  `lib/`).
- أدلة المنفّذ الأصلية محفوظة كما كانت في `.local/verification.bak-review-g08/`، والنتائج
  المعادة حديثاً في `.local/verification/P0*-*` (منها `P08-07/report.json` 34/34).
