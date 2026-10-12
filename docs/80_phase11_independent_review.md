# المراجعة المستقلة المركزة لـG-11 (المرحلة 11: التقارير)

التاريخ: 16 سبتمبر 2026. الجلسة: مراجعة مستقلة منفصلة عن جلسة تنفيذ P11، وفق
[docs/79](79_phase11_review_prompt.md) ونطاق [docs/78](78_phase11_execution_prompt.md)
وقالب [docs/34](34_implementer_handoff.md). المراجعة المستقلة غير إلزامية لـG-11، والقبول
قرار المستخدم حصراً.

**الحكم النهائي: PASS WITH FINDINGS — لا يُقبل G-11 قبل إغلاق F-RVW11-01 (متوسط).**
لا finding عالٍ. لم تُمَس أي ملفات إنتاج/اختبارات/مهاجرات، ولم يُفتح P12/P13 ولم تُعلن
جاهزية إنتاج.

## 1) بوابة NO-GO (GO)

| العنصر | الحالة | الدليل |
|---|---|---|
| بطاقات `docs/execution/P11-01..03.md` بأدلة فعلية | موجود | قراءة كاملة للبطاقات الثلاث |
| سجل `docs/execution/G-11.md` بحالة `VERIFIED محلياً / REVIEW_PENDING` | موجود | ليس ACCEPTED |
| عقد `docs/contracts/phase11.openapi.json` (0.31.0، 9 عمليات) مربوطاً بـ`contracts:generate`/`contracts:check` | موجود | `package.json:20`، `scripts/contracts.mjs` سطر 15/26/149/175 |
| حفظ operationId `ReadReport`/`ExportReport` المتوافقين مع v1 | متحقق | العقدان يعرّفان `ReadReport` و`ExportReport` على مساري v1 نفسيهما |
| `scripts/phase11-visual.mjs` مربوط بـ`visual:phase11` مع report.json ولقطات | موجود | `package.json:53` و`.local/verification/P11-03/report.json` + 8 لقطات |
| أدلة `.local/verification/P11-01..03/` (reporting/check/property/identity/distribution/contracts/db/بصريات/سجلات) | موجودة | فحص القوائم والسجلات الخام |
| مهاجرات P11 بعد `20260916200000` مع FORCE RLS ومنح أقل صلاحية | موجودة | `20260916210000_reporting_core`، `20260916220000_report_export`، `20260916230000_report_export_ready_check_fix` |
| اختبارات `tests/property/reporting-*.pg.test.mjs` خضراء موثقة | موجودة | 3 ملفات = 25 حالة (9+8+8) |
| وحدات/مسار `reporting` (backend/api/web/worker) | موجودة | `packages/backend/src/modules/reporting`، `apps/api/src/reporting`، `apps/web/src/reports`، `apps/worker` |

لا عنصر ناقص ⇒ بدأ الفحص.

## 2) إعادة إنتاج الأرقام الرسمية (بأوامري وبيئتي)

| الأمر | النتيجة المعاد إنتاجها | السجل الخام |
|---|---|---|
| `pnpm db:check` | نجاح اتصال القاعدة | `.local/verification/review-g11/db-check.log` |
| `pnpm check` | **87/87 في 12 حزمة** | `.local/verification/review-g11/check.log` |
| `pnpm contracts:check` | **9 عمليات Phase 11** والأنواع المولدة مطابقة | `.local/verification/review-g11/contracts-check.log` |
| `pnpm test:property` (كامل، بعد `dev:stop`) | **292/292 في 40 حزمة** | `.local/verification/review-g11/test-property-full.log` |
| `pnpm test:identity` | **48/48 في 7 حزم** | `.local/verification/review-g11/test-identity.log` |
| `pnpm test:distribution` | **48/48 في 11 حزمة** | `.local/verification/review-g11/test-distribution.log` |
| `pnpm dev:start` ثم `visual:phase11` | **14/14 و8 لقطات** | `.local/verification/review-g11/visual-phase11.log` |
| `visual:phase10/9/8/7/6/5` | **19/19، 28/28، 34/34، 35/35، 24/24، 19/19** | `visual-phase10.log`..`visual-phase5.log` |
| `pnpm visual:check` | **38/38** | `.local/verification/review-g11/visual-check.log` |
| `pnpm checksums` + `sha256sum -c` | **614/614 OK** قبل كتابة هذا التقرير (البصمات مطابقة لنسخة ما قبل الجلسة) | `checksums-before-report.log` و`checksums-verify-before-report.log` و`CHECKSUMS.before.sha256` |

كل الأرقام الرسمية المعلنة في `G-11.md` أُعيد إنتاجها مطابقة. لم يُعتمد أي رقم أو سجل من
جلسة التنفيذ؛ السجلات أعلاه من تشغيلي.

## 3) جدول الثوابت الاثني عشر

| # | الثابت | الحالة | أمر/أداة إعادة الإنتاج | الدليل الخام |
|---|---|---|---|---|
| 1 | وحدة/أساس/مقام معلن لكل رقم، وليالي عرض ≠ موارد محجوزة ≠ مشغولة ≠ أشخاص | مغلق | `node --env-file=.env .local/verification/review-g11/rvw11-probes.mjs` (const1) | `probes-run.log` (كل metric له unit+basis ونسب لها بسط/مقام؛ `item_night`/`resource_night`/`person` منفصلة) |
| 2 | AT-22/23 بلا جمع المركبات (REP-001) | مغلق | أعلاه بمورد مركب فعلي (فيلا 3 غرف + 6 أسرّة + حجزين حقيقيين) | `probes-run.log`: `display_nights.VILLA=2`، `resource_nights_reserved.ROOM=6`، لا رقم 8؛ `display_nights.BED=1`، `resource_nights_reserved.BED=6`، `persons.BED=2` |
| 3 | OOO/OOS والتصنيفات (D-08) وإقامة المالك/complimentary/no-show | مغلق | أعلاه (أوامر عمل فعلية + إقامات فعلية بتسجيل دخول) | OOS=1 داخل المقام التشغيلي وOOO=1 خارجه؛ `occupied_paid/owner/complimentary=1` لكل منها؛ `no_show_items=1` و`arrivals_total=4` وno-show ليس إشغالاً |
| 4 | قسمة الصفر: null مع `zero_denominator=true` وصفر حقيقي `0.000000` | مغلق | أعلاه (منشأة 3 غرف كلها OOO) | `occupancy_operational.ROOM=null`/`zero_denominator=true`/`null_reason=DENOMINATOR_ZERO` مقابل `occupancy_physical.ROOM=0.000000` |
| 5 | Tenant/Property/فترة، الصلاحيات، RLS وFORCE والمنح | مغلق | أعلاه + استعلامات `pg_class`/`has_table_privilege` والكتابة عبر دوري التشغيل | viewer بلا صلاحية 403؛ دور بـ`folio.read` بلا `report.financial.view` يُرفض مالياً (403)؛ `relforcerowsecurity=true` للجدولين؛ `hotel_api` insert/select بلا update/delete على اللقطة و`hotel_worker` update فقط على التصدير؛ إدراج عبر Tenant خاطئ ⇒ `42501` |
| 6 | Pickup: لقطة واحدة/تاريخ، replay، فشل مغلق، فرق بتاريخ معلن | **غير مغلق (جزئي)** | أعلاه (pickup) | replay=true ونفس المعرّف وصفّ واحد لكل تاريخ، و`404 report_snapshot_not_found`، وdiff معلن +2/−1/net=1 صحيح؛ **لكن F-RVW11-01**: إقامة غير متغيرة تمتد بعد نهاية الفترة تُعلن `-7` حذفاً، وإقامة جديدة تمتد بعد النهاية لا تُحتسب (+7 مفقودة) |
| 7 | مطابقة المال مع Journal في اللقطة/cutoff نفسها والعكس بلا تعديل الأصل | مغلق | أعلاه (fin) + SQL خام بدور `hotel_api` مع `app.tenant_id` | REVENUE_ROOM: API=300000 = SQL خام=300000؛ TAX: 30000=30000؛ delta=0؛ بعد العكس: الإيراد 0 و`revenue_delta=-300000` والأصل المنشور `net_amount=300000.000000` بلا تغيير وJournal الأصلي POSTED |
| 8 | لا خلط IDR/USD ولا تحويل ضمني؛ الدفعات ليست إيراداً؛ gross/commission/net منفصلة | مغلق | أعلاه (fin) | USD=0 على بيانات IDR وغياب العملة 400 `currency_required`؛ تحصيل 325000 لا يزيد الإيراد 300000؛ 250000/25000/225000 منفصلة |
| 9 | Multi-Property: منح خادمية، تضييق فقط، fail-closed | مغلق | أعلاه (portfolio) | الإجمالي = مجموع صفوف المنشآت؛ `property_ids` تضيّق لمنشأة واحدة؛ منشأة خارج المستأجر/غير معروفة 404؛ مسار مستأجر آخر 403 بلا أرقام؛ viewer محدود النطاق لا يوسّع عبر تقرير المستأجر (403) |
| 10 | التصدير الخاص: ملك المنشئ، TTL/انتهاء 410، إبطال يمسح، فحص حي، audit/correlation/idempotency | مغلق | أعلاه (export) + عامل التصدير الحقيقي | إنشاء 202/replay/409؛ تنزيل المنشئ 200 وبصمة `x-report-sha256` مطابقة؛ عضوية أخرى 404؛ مستأجر آخر 403؛ جلسة جديدة تعمل؛ DENY حي ⇒ 403 ثم استعادة 200؛ انتهاء/إبطال 410 مع `content=null`؛ أحداث التدقيق الثلاثة مع correlation؛ ملاحظة منخفضة حول نطاق المحفظة (أدناه) |
| 11 | منع Spreadsheet Injection | مغلق | أعلاه (حقن `=RVW11INJ("x")` في بيانات القناة ثم تصدير CHANNEL_PERFORMANCE) | الخلية تظهر `'=RVW11INJ` ولا حقل CSV يبدأ بـ`=`/`+`/`@`/tab/CR، والخلايا السالبة مُحيّدة أيضاً |
| 12 | الشاشة والأطقم وعدم الانحدار | مغلق | الأوامر أعلاه + فحوص الانحدار داخل `rvw11-probes.mjs` | فلاتر/فترة/عملة/وحدة/`generated_at`/lag/cutoff ظاهرة (بصريات 14/14)؛ ثلاث لغات وRTL و390px؛ تحديث/حذف Journal/JournalLine/FolioCharge مرفوض `42501`؛ إعادة فتح يوم مغلق مرفوضة `23514`؛ الأطقم كلها خضراء |

## 4) العيوب (Findings)

### F-RVW11-01 — متوسط: Pickup يعلن حذفاً وهمياً ويُسقط إضافات عندما يمتد البقاء بعد نهاية الفترة

- الموضع: `packages/backend/src/modules/reporting/application/reporting-service.ts:540-549`
  (جلب العناصر الحالية بشرط `departure ∈ [from,to)`)، مقابل حساب فرق اللقطة بالتقاطع مع
  الفترة في `pickupRows` (`:406-446`)، والاستعلام في
  `packages/backend/src/modules/reporting/persistence/reporting-repository.ts:306-341`
  (`i.departure >= from and i.departure < to`).
- السبب: طرف «الآن» يجلب فقط العناصر المغادِرة داخل الفترة، بينما طرف اللقطة يحتسب تقاطع
  الليالي مع الفترة؛ فأي إقامة تمتد بعد نهاية الفترة تُعتبر اختفت، وأي إقامة جديدة كذلك
  لا تُقرأ.
- مثال فشل قابل للتكرار (بيانات `RVW11-`): لقطة بتاريخ 2026-09-16، إقامة `CONFIRMED`
  غير متغيرة `2026-09-19..2026-10-06`، تقرير PICKUP لفترة `[2026-09-19, 2026-09-26)`
  بتاريخ مرجعي 2026-09-16 ⇒ صف `item:d066ff67` بقيمة `-7` و`pickup_nights_removed=7`
  رغم عدم تغير أي شيء؛ وبالمقابل إقامة جديدة `2026-09-27..2026-10-05` أُنشئت بعد اللقطة
  لا يظهر لها أي صف في فترة `[2026-09-26, 2026-10-04)` (المتوقع `+7`).
- الأثر: أرقام Pickup خاطئة لكل إقامة متعددة الليالي تمتد بعد نهاية فترة التقرير، وقد
  تُظهر «حذف إيراد/ليالٍ» لم يحدث؛ يؤثر على ثابت 6 من ثوابت G-11. لا يمس العزل أو المال
  المنشور.
- الدليل: `.local/verification/review-g11/probes-run.log` (سطرا الفشل) و
  `probes-results.json`.

### F-RVW11-02 — منخفض: لقطتان متزامنتان لنفس (منشأة، تاريخ مرجعي) تُنتجان 500

- الموضع: `reporting-service.ts:1218-1234` (فحص ثم إدراج) و`:1270` (الإدراج)، مع قيد
  الفرادة `report_snapshot_reference_unique` في
  `Migration20260916210000_reporting_core.ts:31-34`.
- مثال فشل قابل للتكرار: طلبا `POST .../reports/snapshots` متزامنان بنفس `reference_date`
  ومفتاحي idempotency مختلفين ⇒ `[200, 500]` و`{"code":"INTERNAL_ERROR"}`، مع بقاء صف
  واحد (القيد منع الكتابة فوق اللقطة، وهذا سليم).
- الأثر: فشل غير رشيق عند التزامن (500 بدل replay/409)؛ لا فساد بيانات.
- الدليل: `probes-run.log` سطر `concurrent capture statuses=[200,500]`، وسجل الـAPI
  `.local/dev-run.log` يحوي `UniqueConstraintViolationException` برمز `23505` من مسار
  `unhandled_error` وقت الفحص.

### F-RVW11-03 — منخفض: حدود فترة الاستردادات/فروق الصندوق بـ`created_at` (UTC) لا بيوم العمل/توقيت المنشأة

- الموضع: `reporting-repository.ts:594-615` (`listRefundTotals`) و`:617-639`
  (`listCashierVariances`)؛ الجدولان بلا `business_date` في V1
  (`Migration20260915190000_refunds_fx.ts:26-45` لجدول `folio_refund`).
- الأثر: التقارير المالية الأخرى تُرشّح بـ`business_date` بتوقيت المنشأة، أما هذه الصفوف
  فتُرشّح بـ`created_at` مع `::date` بتوقيت جلسة القاعدة (UTC هنا)، فقد يقع استرداد جرى
  بعد منتصف ليل Jakarta في فترة اليوم السابق، ويختلف عن يوم ترحيل قيده (يوم حلّ الاسترداد).
- الحالة: **لم يُعد إنتاجه ديناميكياً** (تدفق اعتماد الاسترداد لم يُشغَّل في هذه الجولة)؛
  عيب ثابت من قراءة الكود وبنية الجداول.
- الأثر العملي محدود لأن الاستردادات ليست إيراداً وTTL التقرير قصير، لكنه انحراف معلن عن
  LOC-004/أساس BusinessDate.

### ملاحظات غير مصنفة كعيوب

- تصدير المحفظة (`ExportTenantReport`): تُحسب `resolved_property_ids` عند الإنشاء، وفحص
  التنزيل الحي على مستوى المستأجر (`report.export`) لأن `property_id=null`؛ فسحب
  `report.financial.view` لمنشأة واحدة بعد الإنشاء لا يمنع تنزيل التصدير حتى انتهاء TTL
  (15د) أو سحب `report.export`. حد مقبول محلياً ويُسجل للوضوح.
- `listMaintenanceResourceNights` يجمع أوامر OOO/OOS دون تقييد `resource.state='ACTIVE'`
  بينما المقام الفيزيائي يعدّ ACTIVE فقط؛ حالة نظرية لم تُنتج ديناميكياً (الواجهة تمنع
  غالباً أوامر على موارد متقاعدة) وتُسجل كحد لا كعيب مثبت.
- في قاعدة التطوير المحلية لا يوجد أي منشأة للمستأجر B، فاختبار «منشأة مستأجر آخر» في
  المحفظة استُخدم فيه مسار fail-closed نفسه (معرّف خارج المستأجر ⇒ 404) مع فحوص RLS
  والمسار عبر مستأجر آخر (403)؛ لم يُنشأ fixture لمنشأة B تجنباً لتوسيع بيانات المراجعة.
- قاعدة التطوير تراكم عليها من تشغيل أطقم الهوية أدوار إضافية لـ`member-a`
  (`AUDITOR`/`REPORT_VIEWER`)، لذا استُخدم `viewer-v` (MEMBER فقط) كأساس نظيف في فحوص
  النطاق. هذه حالة fixture وليست عيباً في P11؛ أطقم المنفذ تعمل على قاعدة اختبار جديدة.

## 5) عدم الانحدار (P08/P10) وD-13

- `pnpm test:property` كاملاً **292/292** يشمل أطقم finance/night-audit؛ و`check` 87/87
  وidentity/distribution 48/48.
- فحوص عدائية مباشرة عبر دوري التشغيل: `update journal` و`delete journal_line` و
  `delete folio_charge` ⇒ `42501 permission denied`؛ `delete report_export` كعامل ⇒
  `42501`؛ محاولة `update business_day set state='OPEN'` على يوم مغلق ⇒
  `23514 CLOSED business day cannot be changed` (D-13).
- لا تحديث/حذف على أي سجل مالي منشور، ولا مساس بيوم مغلق، ولم تُكسر أطقم البصريات
  phase10..phase5 أو `visual:check`.

## 6) بيان الاستقلال

- كل أرقام هذا التقرير أُعيدت إنتاجها بأوامري على البيئة المحلية، والسجلات الخام محفوظة
  تحت `.local/verification/review-g11/`؛ لم يُعتمد أي سجل أو رقم من `.local/verification/P11-0X/`.
- ثوابت التقارير أُعيدت إنتاجها ببيانات اصطناعية خاصة ببادئة `RVW11-` ومعرّف بذرة فريد
  لكل تشغيل، وقراءة الأرقام تمت من API ومن SQL خام بدور التشغيل (`hotel_api` مع
  `app.tenant_id`) لا بدور المهاجرات.
- أمثلة استقلال: هجوم الصيغ استخدم خلية عدائية من إنشائي (`=RVW11INJ("x")`) لا خلية
  المنفذ؛ عزل التصدير جُرّب بعضوية ثانية (`mfa-a`) وجهاز/جلسة جديدة وDENY حي؛ مطابقة
  المال أُعيد حسابها بـSQL خام وقارنت ردود التقرير لنفس الفترة/العملة؛ العكس جُرّب وقيست
  صافيته دون تعديل الأصل المنشور.
- لم أعدّل كود إنتاج أو اختبارات أو مهاجرات: `CHECKSUMS.sha256` قبل كتابة هذا التقرير
  مطابق حرفياً لنسخة ما قبل الجلسة (614/614 OK)، وبعد إضافة التقرير يعاد توليده وتُفحص
  البصمات كاملة في سجل منفصل.

## 7) حدود ما لم يُختبر

- لا قنوات حية ولا OTA ولا مزود دفع/FX ولا بيانات/حسابات حقيقية ولا نشر، وEX-03 تبقى
  بوابة خارجية؛ لا AT خارجية ولا جاهزية إنتاج.
- تدفق الاسترداد/الصندوق الديناميكي لم يُشغَّل (F-RVW11-03 ثابت فقط)؛ إعادة فتح يوم مغلق
  مفحوصة عبر منع القاعدة لا عبر مسار إداري.
- البصريات بـPlaywright كاستثناء معلن مطابق P05..P11؛ لا ادعاء جهاز حقيقي أو قارئ شاشة.
- الفحص العدائي ركّز على مسارات P11 (تقارير/لقطات/تصدير/RLS)؛ لا يعيد مراجعة النظام كله،
  وP12/P13 خارج النطاق.
- لم يُختبر سلوك تزامن التقارير المالية تحت كتابات متزامنة كثيفة (العزل المعاملاتي
  للقراءتين داخل معاملة واحدة مقروء من الكود وثابت في الفحوص الهادئة).
- لا اختبار أحمال/Performance لتقارير الفترات الكبيرة (حد 366 يوماً/100 صف مطبق في الكود
  ومفحوص سلوكياً في أطقم المنفذ).

## 8) التوصية

1. **F-RVW11-01 (متوسط)** يجب إصلاحه وإعادة التحقق المستقل منه قبل أي قبول لـG-11: توحيد
   طرفي المقارنة (جلب العناصر المتقاطعة مع الفترة `arrival < to AND departure > from` أو
   ترشيح اللقطة بنفس شرط المغادرة) وإضافة اختبار انحدار لإقامة تمتد بعد نهاية الفترة.
2. **F-RVW11-02 (منخفض)** يُعالج بامتصاص قيد الفرادة (`on conflict`/إرجاع اللقطة القائمة
   بـ`replayed=true`) أو 409 مفهوم بدل 500، مع اختبار تزامن.
3. **F-RVW11-03 (منخفض)** يُحسم بتوثيق حد معلن أو ربط الصفوف بيوم عمل/توقيت المنشأة عند
   توفر `business_date`؛ لا يمنع القبول وحده.
4. الملاحظات غير المصنفة تُسجل كحدود V1.

عند إغلاق البنود أعلاه يبقى قرار قبول G-11 للمستخدم حصراً؛ هذه المراجعة لا تفتح P12/P13
ولا تعلن أي جاهزية إنتاج.
