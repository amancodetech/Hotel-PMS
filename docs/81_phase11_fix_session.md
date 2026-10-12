# docs/81: جلسة إصلاح F-RVW11-01..03 (المرحلة 11 — التقارير)

التاريخ: 16 سبتمبر 2026. النطاق مفوّض من المستخدم ومحصور بما أوصت به
[docs/80](80_phase11_independent_review.md): إصلاح Pickup (F-RVW11-01، الحاجب)، وامتصاص
سباق التقاط اللقطة (F-RVW11-02)، وربط الاستردادات/الصندوق بيوم المنشأة المحلي
(F-RVW11-03)، مع اختبارات انحدار وتوثيق الحد المتبقي. لا تغيير عقد ولا واجهة ولا بصريات،
ولا قبول G-11 في هذه الجلسة؛ القبول قرار المستخدم بعد إعادة التحقق المستقل.

## 1) العيوب وإعادة الإنتاج (من docs/80)

- **F-RVW11-01 (متوسط، حاجب):** طرف «الآن» في Pickup يُجلب بـ`departure ∈ [from,to)`
  بينما طرف اللقطة يُجلب بـ`departure ≥ referenceDate` ثم يُقاطع الليالي مع الفترة؛ فأي
  إقامة تمتد بعد نهاية الفترة تُعلن حذفاً وهمياً، وأي إقامة جديدة ممتدة لا تُحتسب.
- **F-RVW11-02 (منخفض):** لقطتان متزامنتان لنفس (منشأة، تاريخ مرجعي) ⇒ `[200, 500]`
  (`UniqueConstraintViolation 23505`) بدل replay/409، مع بقاء صف واحد.
- **F-RVW11-03 (منخفض):** الاستردادات/فروق الصندوق تُرشّح بـ`created_at::date` (UTC)
  لا بتوقيت المنشأة؛ ولم يُنتج ديناميكياً في جولة المراجعة.

## 2) الأسباب المؤكدة (قبل الإصلاح)

- `reporting-service.ts` (مسار PICKUP): عدم تماثل طرفي المقارنة؛ اللقطة تُقاطع الليالي مع
  الفترة عبر `itemNightsInPeriod` بينما الجلب الحالي يقصّ على `[from,to)`.
- `reporting-repository.ts` `insertSnapshot`: إدراج مباشر بلا `on conflict`؛ انتهاك قيد
  الفرادة يصل كخطأ غير معالج.
- `reporting-repository.ts` `listRefundTotals`/`listCashierVariances`: `created_at::date`
  بتوقيت جلسة القاعدة، **وعيب كامن إضافي**: الطرف الأعلى كان `to + 1 day` أي نافذة شاملة
  بطول 48 ساعة تخالف نصف المفتوحة `[from,to)` المتبعة في payments/journal وباقي التقارير.

## 3) الإصلاح

1. **F-RVW11-01** — `reporting-service.ts` مسار Pickup: جلب الطرف الحالي بـ
   `departure ≥ from` بلا سقف (`'9999-12-31'`) ليطابق التقاط اللقطة، ويبقى التقاطع مع
   الفترة موحّداً في `pickupRows`. لا تغيير في شكل الرد.
2. **F-RVW11-02** — `reporting-repository.ts` `insertSnapshot`: الإدراج صار
   `on conflict on constraint "report_snapshot_reference_unique" do nothing returning *`
   ويعيد `SnapshotRow | null`؛ و`captureSnapshot` عند `null` يقرأ اللقطة الفائزة ويعيد
   `replayed=true` بدل 500 (لا حاجة لـsavepoint لأن `DO NOTHING` لا يُجهض المعاملة).
3. **F-RVW11-03** — `listRefundTotals`/`listCashierVariances` تقبلان `timezone` وترشّحان
   نافذة نصف مفتوحة بتوقيت المنشأة:
   `created_at >= (from::date::timestamp at time zone tz)` و
   `created_at < (to::date::timestamp at time zone tz)`؛ ويمرر مسار SETTLEMENTS
   `property.timezone`. أُصلح معها عيب النافذة الشاملة (`to + 1 day`).
   الحد المتبقي (موثق في [docs/25](25_logical_model_contract.md)): V1 لا يخزّن
   `business_date` على `folio_refund`/`cashier_session`، فالأساس هو اليوم المحلي للمنشأة
   المشتق من `created_at`؛ الربط الفعلي بيوم العمل مؤجل.

## 4) اختبارات الانحدار المضافة

- `reporting-operational.pg.test.mjs` — **F-RVW11-01**: إقامة ثابتة `3..30` مع فترة
  `[3,10)` ⇒ `added=removed=net=0` وبلا صفوف؛ وإقامة جديدة `10..30` مع فترة `[10,12)` ⇒
  `+2`.
- `reporting-operational.pg.test.mjs` — **F-RVW11-02**: التقاطان متزامنان بمفتاحي
  idempotency مختلفين لنفس التاريخ ⇒ `[200,200]`، التقاط واحد وreplay واحد بنفس المعرّف،
  وصف واحد في القاعدة.
- `reporting-financial.pg.test.mjs` — **F-RVW11-03**: استرداد عند `18:30Z` (= 01:30
  Jakarta) يظهر في يوم المنشأة المحلي ولا يظهر في يوم UTC.

## 5) التحقق بعد الإصلاح

| الفحص | النتيجة | السجل |
|---|---|---|
| `pnpm build` + `pnpm typecheck` | نجاح | `.local/verification/P11-04/build.log` و`typecheck.log` |
| `pnpm test:property:fast -- --filter=reporting` | **28/28 في 3 حزم** (25 + 3 جديدة) | `reporting.log` |
| `pnpm test:property` كامل | **295/295 في 40 حزمة** | `test-property-full.log` |
| `pnpm check` | **87/87 في 12 حزمة** (build/contracts/typecheck/lint/format/jest) | `check.log` |
| `pnpm test:identity` / `pnpm test:distribution` | 48/48 / 48/48 | `test-identity.log` و`test-distribution.log` |

- البصريات لم تُعد: لا تغيير واجهة ولا عقد ولا شكل رد (غياب `+`/إعادة replay كلاهما متوافق
  مع العقد 0.31.0)، والانحدار مغطى بـ`test:property` كاملاً.
- `pnpm checksums` + `sha256sum -c`: يعاد توليدها بعد وثائق هذه الجلسة
  (`checksums-final.log` و`checksums-verify-final.log`).

## 6) الحالة

- **F-RVW11-01: FIXED** (الخطر الحاجب) — يبقى مشروطاً بإعادة تحقق مستقلة قبل القبول.
- **F-RVW11-02: FIXED** و**F-RVW11-03: FIXED** مع حد V1 معلن أعلاه.
- G-11 تبقى **VERIFIED محلياً / REVIEW_PENDING**؛ لا ACCEPTED، ولا P12/P13، ولا جاهزية
  إنتاج.

## كتلة إعادة التحقق المستقلة (محادثة جديدة)

انسخ الكتلة التالية كأول رسالة في جلسة مستقلة (بلا سياق المنفذ):
```text
أعد التحقق مستقلاً من إصلاح F-RVW11-01..03 في /home/omar/Desktop/Hotel وفق
docs/81_phase11_fix_session.md الذي أغلق توصيات docs/80_phase11_independent_review.md.
هذه جلسة تحقق فقط: لا تعدّل كود إنتاج أو اختبارات أو مهاجرات، ولا تقبل G-11 نيابة عن
المستخدم، واكتب النتيجة فقط في docs/82_phase11_fix_reverification.md.

بوابة NO-GO: تأكد من أن docs/81 موجود، وأن الإصلاحات الثلاثة ظاهرة في الكود:
reporting-service.ts (جلب الطرف الحالي لـPICKUP بـdeparture >= from بلا سقف، ومعالجة
insertSnapshot الفارغ بإرجاع اللقطة الفائزة replayed=true)، وreporting-repository.ts
(on conflict on constraint report_snapshot_reference_unique do nothing، ونافذة محلية
نصف مفتوحة بـat time zone لـlistRefundTotals/listCashierVariances)، وأن اختبارات
الانحدار الثلاثة موجودة في tests/property/reporting-operational.pg.test.mjs و
reporting-financial.pg.test.mjs، وأن أدلة .local/verification/P11-04/ موجودة. إن غاب
عنصر توقف بلا كتابة أي ملف وأبلغ.

البيئة: export PATH="/tmp/hotel-pnpm10/node_modules/.bin:$PATH"؛ PostgreSQL 17.11 على
55432 وRedis على 56379 وKeycloak على 58080؛ api 4100/web 5173/worker 4101؛
COMPOSE_BIN=/tmp/hotel-toolchain/docker-compose-v5؛ أوقف dev قبل أطقم
property/identity/distribution ثم أعد تشغيله للبصريات فقط؛ الأسرار من .env؛ حسابات
اصطناعية owner-a/admin-a/member-a/auditor-a/owner-b؛ بياناتك ببادئة RVW11R- وبذرة فريدة.

أعد إنتاج سيناريو F-RVW11-01 ببياناتك المستقلة (لا تعتمد اختبارات المنفذ): لقطة بتاريخ
مرجعي معلن، إقامة CONFIRMED غير متغيرة تمتد بعد نهاية الفترة ⇒ يجب ألا يظهر أي حذف
(pickup_nights_removed=0 وبلا صف لها)، وإقامة جديدة ممتدة بعد النهاية ⇒ يجب أن تُحتسب
لياليها داخل الفترة؛ ثم كرر هجوم F-RVW11-02 (التقاطان متزامنان بمفتاحين مختلفين ⇒ 200/200
مع replay واحد وصف واحد) وF-RVW11-03 (استرداد/جلسة صندوق عند 18:30Z يجب أن يقع في يوم
المنشأة المحلي لا يوم UTC، وتأكد أن النافذة نصف مفتوحة [from,to) مطابقة لـpayments).

شغّل بنفسك: pnpm db:check ثم pnpm check ثم pnpm contracts:check ثم pnpm test:property
كاملاً ثم pnpm test:identity ثم pnpm test:distribution (بعد pnpm dev:stop) ثم
pnpm dev:start ثم pnpm visual:phase11 وphase10..5 وpnpm visual:check ثم pnpm checksums
وsha256sum -c CHECKSUMS.sha256. تحقق أيضاً أن الفحوص العدائية القديمة ما زالت محكمة:
لا update/delete على السجلات المنشورة (42501)، ولا إعادة فتح يوم مغلق (D-13)، وFORCE RLS
والمنح على report_snapshot/report_export كما هي.

اكتب في docs/82: جدول الثوابت المتأثرة (6 و10 و7) مغلق/غير مغلق مع أمر ومسار السجل،
وقائمة findings المتبقية بالخطورة، وبيان الاستقلال، وحدود ما لم تختبر، والتوصية
(PASS / PASS WITH FINDINGS / FAIL) دون منح قبول. توقف وأبلغ فوراً عند finding عالٍ أو
تعارض وثائق/سلوك أو حاجة بيانات/شبكة حقيقية أو أي مساس بسجل منشور/يوم مغلق. لا تفتح
P12/P13 ولا تعلن جاهزية إنتاج. شغّل checksums بعد كتابة تقريرك.
```
