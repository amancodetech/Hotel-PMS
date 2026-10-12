# جولة الفحص المركّز لـG-08 بعد إصلاح F-RVW8-01..03

التاريخ: 15 سبتمبر 2026. المرجع: [docs/67](67_phase8_independent_review.md) (حكم FAIL
والfindings) و[docs/68](68_phase8_fix_session.md) (جلسة الإصلاح والأدلة). النطاق: التحقق من
إغلاق F-RVW8-01 (عالٍ) وF-RVW8-02 وF-RVW8-03 (متوسطان)، ومن تحصينات الإصلاح، وعدم ارتداد
P08، وحدود P08 المعلنة فقط.

> **ملاحظة استقلال (معلنة)**: نُفذت هذه الجولة في الجلسة نفسها التي نفّذت الإصلاح، فهي ليست
> جلسة مستقلة تماماً كما في [docs/64](64_g07_focused_review.md). ولم يُعتمد أي رقم من جلسة
> الإصلاح: كل الأدلة أُعيد توليدها الآن بأدوات الفحص
> `.local/verification/review-g08-focused/` (بادئة `RVW8F`)، مع إعادة تشغيل المسح المستقل
> الأصلي `run.mjs` و`probes` و`probes2`. من يريد تأكيداً مستقلاً بالكامل يجد كتلة جلسة منفصلة
> في نهاية هذا الملف. القبول قرار المستخدم، وG-08 تبقى REMEDIATED / REVIEW_PENDING.

## أسئلة الحكم

1. **F-RVW8-01 (عالٍ):** هل أي حركة مالية بعد CLEARED (`ReverseCharge`، `PostAdjustment`،
   وحتى `IssueCreditNote`) تعيد الحجز PENDING مع `finance.clearance_reopened` واحد وتصفير
   أدلة الحسم، بلا audit مكرر إن كان PENDING أصلاً، مع بقاء الحسم مرفوضاً ما دام الرصيد غير
   صفري؟
2. **F-RVW8-02 (متوسط):** هل كل كائن `money` معلن يُرفض عند اختلاف العملة بـ400
   `currency_mismatch` وبالحقل الكامل الصحيح، بلا أي أثر (لا قيد ولا صف ولا version)، مع بقاء
   تدفق العملة المطابقة وIDR/USD سليماً، وبقاء DTO صارماً في فرض `currency`؟
3. **F-RVW8-03 (متوسط):** هل أثر الإشعار الدائن المنشور يظهر في `adjustments_total`/`balance_due`
   فلا فجوة بين الذمة الفرعية والدفتر، وبقيد واحد متوازن، وبمنع تجاوز الفاتورة، ومع إعادة فتح
   CLEARED وإبقاء الحسم مرفوضاً `CLEARANCE_CREDIT` حتى استرداد فعلي ناجح؟
4. **التحصينات/المخطط:** هل قيود القاعدة الخمسة قائمة وصفر انتهاك، وبلا مهاجرة جديدة أو معدّلة
   بعد `20260915210000`، وهل `updateReservationCheckoutState` يصفّر أدلة الحسم الأربعة،
   و`hotel_api` ما زال محروماً (42501) من تعديل/حذف القيود؟
5. **عدم الارتداد:** إعادة الأطقم الرسمية والبصريات والمسح المستقل، وهل `test:property` حتمي؟

## الحكم

**PASS — F-RVW8-01/F02/F03 مغلقة، والتحصينات قائمة، ولا ارتداد منتج، وF-RVW8F-01 (عزل
أطقم) أُغلق بإصلاح اختباري مأذون من المستخدم (انظر ملحق الإغلاق في الذيل).** هذا الحكم
**لا يمنح قبول G-08**؛ القبول قرار المستخدم، ولا تُفتح P09.

الجولة أنتجت **35 فحصاً مركزاً جديداً (35/35 PASS)** في `f1`–`f4`، وأعادت تشغيل كل أدلة عدم
الارتداد الرسمية. `sha256sum -c CHECKSUMS.sha256` قبل كتابة هذا الحكم: **528/528 OK**؛ وبعد
كتابته أُعيد توليد البصمات (يُسجَّل العدد في `focused-checksums-after.log`). `dev` أُوقف
والمنافذ 4100/4101/5173 حرة، وقواعد `hotel_test_*` المؤقتة أُسقطت.

ملاحظة منهجية: ثلاث نتائج حمراء أولى في أدوات الفحص كانت **أخطاء تأكيد في الأداة لا في المنتج**
(توقع `outstanding` حيث السلوك الصحيح `credit`؛ توقع 422 لتجاوز الإشعار حيث العقد 400؛ توقع
قبول غياب العملة حيث DTO يفرضها) — صُححت التأكيدات وأُعيد التشغيل، والسجلات النهائية هي
المعتمدة. لم يُعدَّل أي ملف إنتاج أو اختبار أو مهاجرة في هذه الجولة.

### 1) F-RVW8-01 (عالٍ) — **مغلق** (`f1.log` 5/5)

- **عكس رسم بعد CLEARED**: `settle` أعاد CLEARED، ثم `POST .../charges/{id}/reversal` 200 →
  الصف الخام `PENDING`، `cleared_at/basis/reference/payer` كلها null، `version+1`،
  وaudit `finance.clearance_reopened` **واحد**، و`credit=true` ورصيد `-150000` في
  `GetReservationClearance` (سلوك دائن صحيح، وليس outstanding).
- **تسوية متأخرة بعد CLEARED**: `PostAdjustment` INCREASE 50000 → PENDING + تصفير + audit
  واحد، والرصيد `50000`، ثم `settle` جديد رُفض **422 `CLEARANCE_OUTSTANDING`**.
- **حركة ثانية أثناء PENDING**: adjustment ثانٍ (DECREASE 1000) 200 و**لم يزد عدّاد إعادة
  الفتح** (بقي 1)، والرصيد `49000` في GetFolio، فلا audit مضاعف.

### 2) F-RVW8-02 (متوسط) — **مغلق** (`f2.log` 19/19)

- **15 محاولة mismatch** كلها **400** و`details.reason='currency_mismatch'` وبالحقل الكامل:
  `tax_money.currency` (رسم)، `money.currency`/`gross_money.currency`/`commission_money.currency`
  (دفع)، الاسترداد، التسوية، الفاتورة `money`/`tax_money`، الإشعار الدائن، جمع الوديعة،
  تطبيقها، الإفراج عنها، الجدول الدوري، الباقة (`unit_money.currency`)، وتوجيه
  `allocations[0].money.currency`.
- **صفر أثر**: لقطات `journal`/`folio_payment`/`folio_deposit`/`folio_invoice`/
  `folio_credit_note`/`folio.version` متطابقة قبل وبعد كل المحاولات (بما فيها محاولات
  OTA gross/commission).
- **ضوابط النجاح**: دفع IDR مطابق 200، دفع على حساب USD 200 مع رفض دفع IDR عليه
  `currency_mismatch`، والرصيد النهائي `94000` متسق. غياب `currency` مرفوض 400 (DTO صارم)،
  وهو يطابق ادعاء docs/68 أن غياب العملة يعني الاستنتاج الداخلي بينما حدود API تفرض الإعلان.

### 3) F-RVW8-03 (متوسط) — **مغلق** (`f3.log` 6/6)

- **فجوة GL/الذمة = صفر**: رسم 100000 + ضريبة 11000 → فاتورة 111000 → إشعار 11000:
  `adjustments_total='-11000'` و`balance_due='100000'` و`FOLIO_GUEST` الصافي
  `100000.000000` (مع استثناء ROUTING كما في المسح الأصلي).
- **قيد الإشعار واحد ومتوازن**: `REVENUE_OTHER` مدين 11000 / `FOLIO_GUEST` دائن 11000.
- **تجاوز الفاتورة**: إشعار 200000 → **400 `credit_note_exceeds_invoice`** وبلا صف جديد
  (العدد بقي 1).
- **إشعار بعد CLEARED**: 50000 → PENDING + تصفير + audit واحد + `credit=true` ورصيد `-50000`،
  والحسم رُفض **422 `CLEARANCE_CREDIT`**؛ ثم استرداد 50000 باعتماد مستخدم آخر (mfa-a) ونجاح
  `resolve` → الرصيد `0` و`GET clearance` غير outstanding و`settle` SETTLED **200 CLEARED**.

### 4) التحصينات/المخطط — **قائم** (`f4.log` 5/5)

- خمسة قيود على `reservation` (state/evidence/basis/FK دافع/قيد مركب) وقيد الدليل يمنع
  PENDING مع أدلة أو CLEARED بلا أساس/دافع. مسح كل الصفوف: **صفر انتهاك** للأربع علاقات.
- لا مهاجرة جديدة أو معدّلة في نافذة الإصلاح؛ الأحدث والمسجَّل مطبَّقاً:
  `Migration20260915210000_financial_clearance`.
- `hotel_api`: تعديل `journal` وحذف `journal_line` ما زالا **42501**.
- `updateReservationCheckoutState` ما زال يصفّر `financial_cleared_at/basis/reference/
  payer_folio_id` في التحديث نفسه (فحص مصدر مقترن بثابت القاعدة أعلاه).

### 5) عدم الارتداد (أُعيد بالكامل)

| الأمر | النتيجة | السجل |
|---|---|---|
| `pnpm db:check` | database connection successful | `focused-db-check.log` |
| `pnpm check` | **85/85 في 11 حزمة** (مع build/typecheck/lint/format/contracts) | `focused-check.log` |
| `pnpm contracts:check` | 43/30/36/21/15/10/**35** ومطابقة الأنواع | `focused-contracts-check.log` |
| `pnpm test:identity` | **48/48 في 7 حزم** | `focused-test-identity.log` |
| `pnpm test:distribution` | **48/48 في 11 حزمة** | `focused-test-distribution.log` |
| `pnpm test:property:fast -- --filter=adversarial` | **36/36 في سويتين** | `focused-test-adversarial.log` |
| `pnpm visual:phase8` | **34/34** (14 لقطة) | `focused-visual-phase8.log` |
| `pnpm visual:phase7` | **35/35** | `focused-visual-phase7.log` |
| `pnpm visual:phase6` | **24/24** | `focused-visual-phase6.log` |
| `pnpm visual:phase5` | **19/19** | `focused-visual-phase5.log` |
| `pnpm visual:check` | **38/38** | `focused-visual-check.log` |
| مسح المراجعة المستقل `run.mjs` | **48/48** (كان 45/48 في docs/67) | `focused-run.log` و`focused-run-results.json` |
| `probes.mjs` | **4/4** (فجوة CN = 0) | `focused-probes.log` |
| `probes2.mjs` | **4/4** (حد التحويل fail-closed) | `focused-probes2.log` |
| `pnpm test:property` (كامل) | **237/237 في 33 حزمة — مرتان** بعد إصلاح F-RVW8F-01 | `fixrf-property-1.log` و`fixrf-property-2.log` |
| `sha256sum -c` قبل الحكم | **528/528 OK** | `checksums-before-verdict.log` |

### 6) Finding جديد

**F-RVW8F-01 (متوسط — عزل أطقم؛ لا أثر منتج):** سويت `test:property` غير حتمية.
`corrections-finance` يعدّ قيود `source_type='ADJUSTMENT'` **لكامل المستأجر A** ويتوقع
العدد 2، بينما `finance-integration` (المستأجر نفسه) ينشر قيد تسوية ناجحاً أُضيف في جولة
الإصلاح («adjustment after CLEARED…»). عند تشغيل `finance-integration` قبل
`corrections-finance` يصبح العد 3 ويفشل الاختبار **زوراً** (لا عيب منتج).

- الدليل: تشغيلان كاملان فشلا بهذا الشكل (`focused-test-property.log` و
  `focused-test-property-r1.log`: `Expected 2 / Received 3`) ونجح تشغيلان
  (`focused-test-property-rerun.log` و`r2`) — وفي آخر تشغيل ناجح تُظهر القاعدة النهائية
  **3 قيود ADJUSTMENT للمستأجر A** (قيد `finance-integration` أُنشئ *بعد* عدّ
  `corrections`)، وهو الدليل المباشر على أن السبب ترتيب السويت لا المنتج.
- الأثر: نتائج بوابة `test:property` يمكن أن تكون حمراء كاذبة بنسبة مرصودة 50% في هذه
  الجولة؛ أرقام docs/68 للجولة كانت صحيحة لتشغيلها لكنها ليست مضمونة التكرار.
- التوصية (تتطلب تفويض إصلاح اختباري): حصر عدّ اختبار corrections بمنشأة/مراجع أطقمه أو
  إسقاط الاعتماد على العد المطلق — تغيير اختباري فقط بلا مساس بالمنتج.
- **الحالة: أُغلق بتفويض المستخدم — انظر ملحق الإغلاق أدناه.** ووفق قاعدة
  [docs/66](66_phase8_review_prompt.md) (أي finding متوسط/عالٍ يُفتح له إصلاح قبل القبول)
  لم يعد F-RVW8F-01 حاجزاً؛ وتبقى **G-08 = REMEDIATED / REVIEW_PENDING** حتى قرار القبول.

### 7) حدود ما لم يُعد فتحه

- لا AT منفذة ولا مزود دفع/FX ولا قناة حية ولا بيانات حقيقية ولا جاهزية إنتاج.
- لا تحويل عملة (D-11/D-14) ولا جمع IDR/USD، وEX-03 الإنتاجي ما زال مرفوضاً.
- الاستقلال: انظر ملاحظة الاستقلال أعلاه؛ كتلة التأكيد الخارجي أدناه.

## كتلة جلسة مستقلة (اختيارية للتأكيد الخارجي)

```text
أعد فحصاً مركزاً مستقلاً لإغلاق F-RVW8-01..03 في /home/omar/Desktop/Hotel بلا تعديل أي
ملف إنتاج أو اختبار أو مهاجرة. اقرأ docs/67 وdocs/68 وdocs/69 (هذا الملف) وdocs/66.
البيئة: export PATH="/tmp/hotel-pnpm10/node_modules/.bin:$PATH"؛ .env للأسرار (لا تُطبع)؛
dev على 4100/5173 وKeycloak 58080، وأوقف dev قبل أطقم property/identity/distribution.
أعد الأدلة بنفسك تحت .local/verification/review-g08-focused2/: أعِد إنتاج:
1) عكس/تسوية/إشعار دائن بعد CLEARED → PENDING + audit واحد + تصفير الأدلة + رفض الحسم
   (CLEARANCE_OUTSTANDING/CREDIT كما يقتضي الرصيد).
2) مصفوفة mismatch العملات (tax/gross/commission/unit/allocations) → 400 currency_mismatch
   بالحقل الصحيح وصفر أثر، مع ضوابط نجاح IDR/USD.
3) فجوة GL/الذمة = 0 بعد إشعار دائن، ومنع تجاوز الفاتورة، واسترداد يعيد الصفر وSETTLED.
4) عدم الارتداد: pnpm check وcontracts:check وidentity وdistribution والبصريات phase8..5
   وvisual:check ومسح run.mjs/probes/probes2.
5) كرر pnpm test:property كاملاً **مرتين على الأقل** وراقب F-RVW8F-01 (عدّ
   corrections-finance لقيد ADJUSTMENT مقابل قيد finance-integration)؛ سجّل الترتيب.
اكتب حكمك في جلسة منفصلة ولا تمنح قبول G-08.
```

## ملحق إغلاق F-RVW8F-01 (بتفويض المستخدم، 15 سبتمبر 2026)

- **الإصلاح اختباري فقط** (بلا أي مساس بالمنتج): صار عدّ اختبار
  `P08-04 adjustments are linked journals…` محصوراً بقيود التسوية المرتبطة برسم الاختبار نفسه
  عبر `and "adjusts_journal_id" = $2` مع `charge.journal_id`
  (`tests/property/corrections-finance.pg.test.mjs`)، فلم يعد يتأثر بقيود السويتات الأخرى في
  المستأجر نفسه.
- **الأدلة**: `fixrf-check.log` (**85/85**) و`fixrf-property-1.log` و`fixrf-property-2.log`
  (**237/237 في 33 حزمة، مرتان متتاليتان كاملتان**).
- **برهان الاستقلال عن الترتيب**: على قاعدة تشغيل كامل أخير، عدّ `ADJUSTMENT` لكامل المستأجر
  بقي **3** (وهو بالضبط سيناريو الفشل الكاذب السابق حين يتقدم `finance-integration`)، بينما
  العدّ الجديد المحصور برسم corrections أعاد **2** — أي أن التأكيد لم يعد يعتمد على ترتيب
  السويت. أُسقطت قاعدة الفحص المؤقتة بعد التوثيق.
- بقية أرقام الجولة أعلاه لم تتغير، وأُعيد توليد البصمات بعد هذا الملحق
  (`focused-checksums-after.log`).

## الأدلة الخام

- الأدوات: `.local/verification/review-g08-focused/{f1,f2,f3,f4}.mjs` و`lib/` (نسخة أدوات
  المراجعة مع تحصين نافذة TOTP لأجل الاستقرار، بلا أي تغيير في منطق الفحص).
- السجلات: `focused-f1.log` `focused-f2.log` `focused-f3.log` `focused-f4.log`
  وتقارير `f1.json`–`f4.json`، وسجلات عدم الارتداد والمسح الأصلي أعلاه، وسجلا
  `checksums-before-verdict.log` و`focused-checksums-after.log`.
- ملاحظة تشغيلية: أُسقطت قاعدتا الفحص المؤقتتان بعد الجولة، والمنافذ حرة بعد `pnpm dev:stop`.
