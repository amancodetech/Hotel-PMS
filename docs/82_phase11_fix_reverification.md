# docs/82: إعادة التحقق المستقلة من إصلاح F-RVW11-01..03 (المرحلة 11 — التقارير)

التاريخ: 16 سبتمبر 2026. الجلسة: إعادة تحقق مستقلة منفصلة عن جلسة التنفيذ P11 وعن جلسة
الإصلاح [docs/81](81_phase11_fix_session.md)، وفق الكتلة المفوضة فيها. جلسة تحقق فقط:
لم يُعدّل أي كود إنتاج أو اختبار أو مهاجرة، ولم يُقبل G-11، ولم تُفتح P12/P13.

**الحكم: PASS — لا findings مفتوحة في نطاق F-RVW11-01..03 ولا finding عالٍ.** تبقى G-11
**VERIFIED محلياً / REVIEW_PENDING**، والقبول قرار المستخدم حصراً؛ هذا التقرير لا يمنح
قبولاً ولا جاهزية إنتاج.

## 1) بوابة NO-GO (GO)

| العنصر | الحالة | الدليل |
|---|---|---|
| `docs/81_phase11_fix_session.md` موجود ويغلق توصيات docs/80 | موجود | قراءة كاملة (123 سطراً) |
| إصلاح F-RVW11-01 في الكود | موجود | `reporting-service.ts:540-552`: جلب الطرف الحالي بـ`'departure', from, '9999-12-31'` بلا سقف مع تقاطع الليالي في `pickupRows` |
| معالجة `insertSnapshot` الفارغ في الكود | موجود | `reporting-service.ts:1299-1320`: عند `null` تُقرأ اللقطة الفائزة وتُعاد `replayed=true` بدل 500 |
| `on conflict` في `insertSnapshot` | موجود | `reporting-repository.ts:394`: `on conflict on constraint "report_snapshot_reference_unique" do nothing returning *` وإرجاع `SnapshotRow \| null` |
| النافذة المحلية نصف المفتوحة | موجود | `reporting-repository.ts:613-614` و`:639-640`: `created_at >= (?::date::timestamp at time zone ?)` و`<` مع تمرير `property.timezone` من SETTLEMENTS (`reporting-service.ts:788-805`) |
| اختبار F-RVW11-01 | موجود | `tests/property/reporting-operational.pg.test.mjs:827-877` (إقامة ثابتة 3..30 مع [3,10) وإقامة جديدة 10..30 مع [10,12) ⇒ +2) |
| اختبار F-RVW11-02 | موجود | `reporting-operational.pg.test.mjs:879-907` (التقاطان متزامنان بمفتاحين مختلفين ⇒ [200,200] وreplay واحد وصف واحد) |
| اختبار F-RVW11-03 | موجود | `reporting-financial.pg.test.mjs:724-766` (استرداد عند 18:30Z يظهر في يوم Jakarta ولا يظهر في يوم UTC) |
| أدلة `.local/verification/P11-04/` | موجودة | 11 ملفاً (build/typecheck/reporting/check/property/identity/distribution/checksums-final/verify-final) |

لا عنصر ناقص ⇒ بدأ الفحص. لم يُكتب أي ملف قبل اجتياز البوابة.

## 2) إعادة إنتاج الأرقام الرسمية (بأوامري وبيئتي)

| الأمر | النتيجة المعاد إنتاجها | السجل الخام (`.local/verification/review-g11r/`) |
|---|---|---|
| `pnpm db:check` | نجاح اتصال القاعدة | `db-check.log` |
| `pnpm check` | **87/87 في 12 حزمة** (build/contracts/typecheck/lint/format/jest) | `check.log` |
| `pnpm contracts:check` | **9 عمليات Phase 11** والأنواع المولدة مطابقة | `contracts-check.log` |
| `pnpm test:property` (كامل، بعد `dev:stop`) | **295/295 في 40 حزمة** | `test-property-full.log` |
| `pnpm test:identity` | **48/48 في 7 حزم** | `test-identity.log` |
| `pnpm test:distribution` | **48/48 في 11 حزمة** | `test-distribution.log` |
| `pnpm dev:start` ثم `visual:phase11` | **14/14 و8 لقطات** | `visual-phase11.log` |
| `visual:phase10/9/8/7/6/5` | **19/19، 28/28، 34/34، 35/35، 24/24، 19/19** | `visual-phase10.log`..`visual-phase5.log` |
| `pnpm visual:check` | **38/38** | `visual-check.log` |
| `pnpm checksums` + `sha256sum -c` (قبل كتابة هذا التقرير) | **616/616 OK** | `checksums-before-report.log` و`checksums-verify-before-report.log` |

كل الأرقام المعلنة في docs/81 وG-11 أُعيدت مطابقة. لم يُعتمد أي رقم أو سجل من
`.local/verification/P11-0X/`؛ السجلات أعلاه من تشغيلي.

## 3) إعادة إنتاج F-RVW11-01..03 ببيانات مستقلة (24/24)

بذرة فريدة لهذه الجلسة: `RVW11R-MU45O78Y` (مُنشأة ديناميكياً)، منشأة خاصة جديدة
`d04695ed-bd37-46ea-bb04-b4338a7c31c6` بتوقيت `Asia/Jakarta`، ومنتجات ومعدلات وحجوزات
من إنشائي. السكربت `rvw11r-probes.mjs` والسجلان `probes-run.log` و`probes-results.json`.

| الفحص | النتيجة | التفصيل الخام |
|---|---|---|
| F-RVW11-01: لقطة بتاريخ مرجعي معلن `2026-10-04` وإقامة A `CONFIRMED` `10-03..10-10` (تمتد بعد نهاية الفترة) | PASS | اللقطة المخزنة تحوي A؛ تقرير PICKUP للفترة `[10-03,10-08)` ⇒ `added=0 removed=0 net=0` و`rows=[]` (لا حذف وهمي ولا صف) |
| F-RVW11-01: إقامة جديدة ممتدة B `CONFIRMED` `10-10..10-25` أُنشئت بعد اللقطة | PASS | تقرير PICKUP للفترة `[10-10,10-13)` ⇒ `added=3 removed=0 net=3` وصف واحد `item:...` بقيمة `+3` وتواريخ الليالي داخل الفترة |
| F-RVW11-01: إعادة التقاط نفس التاريخ المرجعي | PASS | `200` و`replayed=true` بنفس معرّف اللقطة |
| F-RVW11-02: 3 جولات التقاط متزامن (مفتاحان مختلفان لكل تاريخ `2026-11-02/03/04`) | PASS ×3 | كل جولة `[200,200]`، التقاط واحد (`replayed=false`) وreplay واحد (`replayed=true`) بنفس المعرّف، وصف واحد في القاعدة |
| F-RVW11-03: استرداد وجلسة صندوق عند `18:30Z` (= 01:30 Jakarta) في يوم المنشأة المحلي `2026-10-06` | PASS | `refunds_reserved=12346` و`cashier_closed=777` في `[10-06,10-07)`، وغائبان في يوم UTC `[10-05,10-06)` |
| F-RVW11-03: نصف مفتوحة `[from,to)` | PASS | صف عند منتصف ليل البداية المحلي (17:00Z) محتسب (+1)، وصف عند منتصف ليل النهاية (17:00Z من اليوم التالي) مستبعد من اليوم ويظهر في اليوم التالي (`999999`) |
| F-RVW11-03: اتساق مع payments | PASS | دفعتان `business_date` 10-06 و10-07 ⇒ تظهر الأولى فقط في `[10-06,10-07)` والثانية في اليوم التالي، أي نفس عقد النافذة نصف المفتوحة |

## 4) الفحوص العدائية (8/8)

| الفحص | النتيجة |
|---|---|
| `update journal` / `delete journal_line` / `delete folio_charge` بدور `hotel_api` | `42501` للثلاثة |
| `delete report_snapshot` بدور `hotel_api` و`update report_snapshot` بدور `hotel_worker` | `42501` |
| `delete report_export` بدور `hotel_worker` | `42501` |
| إعادة فتح يوم مغلق عبر `update business_day set state='OPEN'` (D-13) | `23514 CLOSED business day cannot be changed`، وبقي الصف `CLOSED` بعد الفحص (المعاملة أُرجعت) |
| `FORCE RLS` على `report_snapshot` و`report_export` | `relforcerowsecurity=true` للجدولين |
| المنح | `hotel_api` على snapshot: select/insert فقط وبلا update/delete؛ `hotel_worker` على export: select/update فقط وبلا insert/delete |

## 5) جدول الثوابت المتأثرة (6 و10 و7)

| # | الثابت | الحالة | أمر/مسار السجل |
|---|---|---|---|
| 6 | Pickup: لقطة واحدة/تاريخ، replay، فشل مغلق، فرق بتاريخ معلن، وتماثل الطرفين | **مغلق** (كان جزئياً بسبب F-RVW11-01) | `rvw11r-probes.mjs` (5 فحوص مستقلة) + اختبار F-RVW11-01/F-RVW11-02 داخل `test:property` 295/295 — `probes-run.log` و`test-property-full.log` |
| 7 | مطابقة المال مع Journal في اللقطة/cutoff نفسها بلا مساس بالأصل | **مغلق** (الإصلاح لا يمس مسارات الإيراد/Journal؛ وأُعيد ديناميكياً اتساق نافذة SETTLEMENTS نصف المفتوحة مع `business_date` في payments) | `probes-run.log` (فحصا النافذة والاتساق) + حزمة `reporting-financial` داخل `test-property-full.log` |
| 10 | تصدير خاص قصير العمر ملك المنشئ، TTL/410، فحص حي، audit/correlation، منع Injection | **مغلق** (بلا انحدار: دورة إنشاء/جاهزية/تنزيل/إبطال والتفاف الصلاحية عبر البصريات) | `visual-phase11.log` (14/14) + `reporting-exports` داخل `test-property-full.log`؛ ملاحظة docs/80 حول نطاق المحفظة تبقى حد V1 معلناً لا عيباً جديداً |

## 6) Findings المتبقية

- **لا finding عالٍ، ولا متوسط، ولا منخفض في نطاق F-RVW11-01..03.** العيوب الثلاثة مغلقة
  بأدلة مستقلة، وثابت 6 لم يعد جزئياً.
- **ملاحظة بيئة (منخفضة، غير مصنفة عيباً في P11):** أول `pnpm dev:start` في هذه الجلسة لم
  يجهز العامل خلال المهلة (`night_audit_tick_failed`/`report_export_tick_failed` برسالة
  `Cannot read properties of undefined (reading 'Client')` أثناء تسابق إعادة بناء watch)،
  ثم نجح تشغيل نظيف ثانٍ ولم تتكرر الأخطاء (آخر `tick_failed` عند epoch 1789566196 قبل
  إعادة التشغيل)، وعملت التدقيقات الليلية والتصدير في البصريات بعدها. السجلان:
  `dev-start.log` مقابل `dev-start-2.log` و`.local/dev-run.log`.
- **حدود V1 معلنة (ليست findings):** F-RVW11-03 لا يزال مشتقاً من `created_at` لعدم وجود
  `business_date` في `folio_refund`/`cashier_session`، وهو موثق في
  [docs/25](25_logical_model_contract.md) سطر 1؛ وملاحظتا docs/80 (نطاق صلاحية تصدير
  المحفظة، وعدم تقييد `listMaintenanceResourceNights` بحالة المورد) تبقى حدوداً معلنة كما
  هي.

## 7) بيان الاستقلال

- كل الأرقام والنتائج أعلاه أُعيدت إنتاجها بأوامري على البيئة المحلية، والسجلات الخام تحت
  `.local/verification/review-g11r/`؛ لم يُعتمد أي سجل أو رقم من `.local/verification/P11-04/`.
- سيناريوهات F-RVW11-01..03 أُعيد إنتاجها بسكربت من إنشائي ببذرة فريدة وبيانات
  `RVW11R-` وبمنشأة وحجوزات وصفوف استرداد/صندوق جديدة (تواريخ مغادرة/مرجعية مختلفة عن
  تواريخ المنفذ والمراجع السابق)، والقراءة تمت من API ومن SQL خام بدوري التشغيل
  (`hotel_api`/`hotel_worker`) لا بدور المهاجرات.
- لم يُعدّل أي كود إنتاج أو اختبار أو مهاجرة: فحص `find -newermt` لبداية الجلسة على
  `apps/packages/tests/scripts/docs/infra` لم يُرجع أي ملف مصدري (بلا dist/مولدات)،
  و`pnpm checksums` قبل كتابة التقرير أعاد **616/616 OK** مطابقة لعدد P11-04.
- قراءة اختبارات المنفذ كانت للتحقق من وجود اختبارات الانحدار في البوابة فقط؛ التحقق
  السلوكي جرى بسكربتي المستقل.

## 8) حدود ما لم يُختبر

- لا قنوات حية ولا OTA ولا مزود دفع/FX ولا بيانات/حسابات حقيقية ولا نشر؛ EX-03 تبقى
  بوابة خارجية، ولا AT خارجية ولا جاهزية إنتاج.
- مطابقة الإيراد/الضريبة مع `journal_line` لم تُعد اشتقاقاً مستقلاً في هذه الجلسة (فُحصت
  على مستوى الحزمة ضمن `test:property`)، لأن الإصلاح لا يمس مسارات الإيراد/Journal.
- في هجوم F-RVW11-02 لا يمكن تمييز فرع `DO NOTHING` داخلياً عن فرع «اللقطة موجودة»؛
  الثابت المطلوب ([200,200]، replay واحد، صف واحد) مُثبت في 3 جولات، والفرعان مقروءان في
  الكود.
- ملاحظات docs/80 غير المصنفة (حد نطاق تصدير المحفظة، حالة مورد OOO/OOS) لم تُعد إنتاجها
  ديناميكياً.
- لا اختبار أحمال/أداء لفترات كبيرة؛ البصريات بـPlaywright كاستثناء معلن بلا ادعاء جهاز
  حقيقي أو قارئ شاشة.

## 9) التوصية

**PASS** — إصلاح F-RVW11-01..03 متحقق منه مستقلاً، والثابت 6 مغلق، والثوابت 7 و10 بلا
انحدار، ولا findings مفتوحة في نطاق الإصلاح. **لا يُعد هذا قبولاً لـG-11**؛ القبول قرار
المستخدم حصراً بعد هذا التقرير، وG-11 تبقى **VERIFIED محلياً / REVIEW_PENDING**. لا
P12/P13 ولا جاهزية إنتاج.

## 10) الأدلة الخام

`.local/verification/review-g11r/`: `db-check.log`، `check.log`، `contracts-check.log`،
`test-property-full.log`، `test-identity.log`، `test-distribution.log`،
`visual-phase11.log`، `visual-phase10.log`..`visual-phase5.log`، `visual-check.log`،
`dev-start.log`، `dev-start-2.log`، `rvw11r-probes.mjs`، `probes-run.log`،
`probes-results.json`، `checksums-before-report.log`، `checksums-verify-before-report.log`،
ثم بعد كتابة هذا التقرير: `checksums-final.log` و`checksums-verify-final.log`.
