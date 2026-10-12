# المراجعة المستقلة المركزة لـG-12 (المرحلة 12: SaaS ودورة العميل)

التاريخ: 17 سبتمبر 2026. الجلسة: مراجعة مستقلة منفصلة عن جلسة تنفيذ P12، وفق
[docs/84](84_phase12_review_prompt.md) ونطاق [docs/83](83_phase12_execution_prompt.md)
وقالب [docs/34](34_implementer_handoff.md). المراجعة المستقلة **غير إلزامية** لـG-12،
والقبول قرار المستخدم حصراً.

**الحكم النهائي: PASS WITH FINDINGS — لا finding عالياً، ولا مانع للبوابة بحسب معايير
[docs/34](34_implementer_handoff.md) (لا مساس بعزل، ولا ازدواج مورد، ولا فقد revision،
ولا تكرار مال في الدفتر، ولا فتح بيع مجهول). لا يُعد هذا قبولاً لـG-12؛ القبول قرار
المستخدم. لم تُفتح P13 ولم تُعلن جاهزية إنتاج ولم تُلمس أي ملفات إنتاج/اختبارات/مهاجرات.**

**تنبيه تعارض وثيقة/سلوك محدود النطاق:** الثابت 2 يخالف نصاً عاماً في
[docs/26](26_api_permissions_events.md) سطر 98 (مفتاح بمحتوى مختلف ⇒
`409 IDEMPOTENCY_CONFLICT`) في حالة `OnboardPlatformTenant` — التفصيل في
[F-RVW12-01](#f-rvw12-01--متوسط-إعادة-استخدام-مفتاح-onboarding-بمحتوى-مختلف-تنشئ-منشأة-ثانية).
رُصد وأُبلغ في هذا التقرير ولم يوقف إكمال المراجعة لأنه finding مكتمل الأدلة لا يتطلب
إجراءً غير قابل للعكس، والبوابة لم تُقبل ولم تُفتح المرحلة التالية.

## 1) بوابة NO-GO (GO)

| العنصر | الحالة | الدليل |
|---|---|---|
| بطاقات `docs/execution/P12-01..03.md` | موجودة بأدلة فعلية | قراءة كاملة للبطاقات الثلاث |
| سجل `docs/execution/G-12.md` بحالة `VERIFIED محلياً / REVIEW_PENDING` | موجود | سطر 3؛ ليس ACCEPTED |
| عقد `docs/contracts/phase12.openapi.json` (0.32.0، **25 عملية**) مربوطاً بـ`contracts:generate`/`contracts:check` | موجود | `package.json:19-20`؛ `scripts/contracts.mjs:16,28,157-160,184` (تأكيد 25) |
| `scripts/phase12-visual.mjs` مربوط بـ`visual:phase12` | موجود | `package.json:54`؛ `.local/verification/P12-03/report.json` (19/19، 6 لقطات) |
| مهاجرات P12 بعد `20260916230000` (FORCE RLS ومنح أقل صلاحية) | موجودة | 8 مهاجرات `20260917010000..070000`؛ فحص `pg_class`/ACL مستقل أدناه |
| اختبارات `tests/property/platform-*.pg.test.mjs` | موجودة | 3 ملفات = 18 حالة (9+5+4) |
| أدلة `.local/verification/P12-01..03/` (اختبارات + db-evidence + check + property كامل + identity/distribution + بصريات + visual-check) | موجودة | قوائم وسجلات خام + إعادة تشغيل مستقلة أدناه |
| وحدات/مسار platform (backend/api/web) | موجودة | `packages/backend/src/modules/platform`، `apps/api/src/platform`، `apps/web/src/platform/PlatformPage.tsx` |

لا عنصر ناقص ⇒ بدأ الفحص. أُجريت كل الفحوص ببيئة المراجع نفسها (`PATH=/tmp/hotel-pnpm10/node_modules/.bin`،
PostgreSQL 17.11:55432، Redis:56379، Keycloak:58080، api:4100، web:5173، worker:4101).
الأسرار من `.env` فقط ولم تُطبع. بيانات المراجعة ببادئة `RVW12-` وبذرة/طوابع فريدة
(`RVW12-MU4B2WXK`)، ومنشآت اصطناعية متعددة (فعّالة ومعلّقة ومغلقة)، بلا بيانات نزلاء حقيقية.
لا Computer Use؛ Playwright استثناء معلن مطابق P05..P12 للبوابة المحلية فقط، بلا ادعاء
جهاز حقيقي أو قارئ شاشة.

## 2) إعادة إنتاج الأرقام الرسمية (بأوامري وبيئتي، لا بأرقام المنفّذ)

| الأمر | النتيجة المعاد إنتاجها | السجل الخام |
|---|---|---|
| `pnpm db:check` | نجاح اتصال القاعدة والهجرات | `.local/verification/review-g12/00-db-check.log` |
| `pnpm check` | **87/87 في 12 حزمة** | `.local/verification/review-g12/01-check.log` |
| `pnpm contracts:check` (داخل check) | **25 عملية Phase 12** والأنواع المولدة مطابقة | `01-check.log` |
| `pnpm test:property` كامل (بعد `pnpm dev:stop`) | **313/313 في 43 حزمة** | `.local/verification/review-g12/02-property-full.log` |
| `pnpm test:identity` | **48/48 في 7 حزم** | `.local/verification/review-g12/03-identity.log` |
| `pnpm test:distribution` | **48/48 في 11 حزمة** | `.local/verification/review-g12/04-distribution.log` |
| `pnpm dev:start` ثم `visual:phase12` | **19/19 و6 لقطات** | `.local/verification/review-g12/05-visual-phase12.log` |
| `visual:phase11/10/9/8/7/6/5` | **14/14، 19/19، 28/28، 34/34، 35/35، 24/24، 19/19** | `05-visual-phase*.log` |
| `pnpm visual:check` | **38/38** | `.local/verification/review-g12/05-visual-check.log` |
| `pnpm checksums` + `sha256sum -c` قبل كتابة التقرير | **658/658 OK** | `.local/verification/review-g12/06-checksums-*.log` |

كل الأرقام الرسمية المعلنة في `G-12.md` أُعيد إنتاجها؛ الفرق الوحيد أن عدّاد البصمات
صار 658 بعد إضافة `docs/84_phase12_review_prompt.md` نفسها (أرقام المنفذ 657 كانت قبل
إضافة الملف)، ولا اختلاف وظيفي. لم يُعتمد أي رقم أو سجل من جلسة التنفيذ.

## 3) جدول الثوابت الاثني عشر (نتيجة المراجعة المستقلة)

أمر إعادة الإنتاج الموحّد للمجسّات:
`node --env-file=.env .local/verification/review-g12/rvw12-probes.mjs` (100/100)
و`node --env-file=.env .local/verification/review-g12/rvw12-supplement.mjs` (5/5).

| # | الثابت | الحالة | إعادة الإنتاج/القيمة المرصودة | الدليل الخام |
|---|---|---|---|---|
| 1 | حد ذري + سباق منشأة حقيقي | **مغلق** | سباق استهلاك عند الحد `[200,422]` والعدّاد `used=1=limit` وحدث واحد؛ سباق `CreateProperty` حقيقي `[201,422]` ومنشأة واحدة + SQL خام؛ ثالث 422 | `rvw12-probes.mjs` const1؛ `probes-run-final.log`/`probes-results.json` |
| 2 | قياس idempotent | **مغلق (مع F-RVW12-01)** | نفس المفتاح ⇒ `replayed=true` بلا ازدواج عدّاد/حدث؛ مفتاح جديد عند الحد ⇒ 422 بلا حدث؛ مسار onboarding: replay صحيح وslug مكرر 409؛ لكن مفتاح onboarding نفسه بمحتوى مختلف ⇒ 201 ومنشأة ثانية (F-RVW12-01) | const2؛ سطر `NOTE constant 2`؛ `probes-results.json.onboardSameKeyDifferentSlug` |
| 3 | إصدارات سياسة مؤرخة/جمود | **مغلق** | أثر رجعي 422 `POLICY_BACKDATED`؛ الشرط `42501` لدور التشغيل على update/delete؛ الـtrigger يرفض حتى دوراً يملك grant (`23514 platform_policy_version_immutable`)؛ التعطيل أضاف حدثاً وبقي ENABLED السابق | const3 |
| 4 | انفصال الدفتر | **مغلق** | عدّادات `journal/journal_line/business_day/folio_charge` متطابقة قبل/بعد دورة كاملة (449/1005/103/196) و0 قيود `PLATFORM%`؛ فوترة إدارية idempotent وتسوية سجل يدوي بمرجع بلا بوابة | const4؛ `ledgerBeforeSaas`/`ledgerAfterSaas` في `probes-results.json` |
| 5 | FORCE RLS والعزل والمنح | **مغلق** | 13/13 جدول platform بـ`relforcerowsecurity=true`؛ سياق Tenant يرى اشتراكه فقط؛ منصة بلا منحة تقرأ 0 من `tenant/guest/reservation/folio/report_export`؛ `hotel_worker` 42501؛ لا INSERT مباشر على `tenant`؛ 0 صلاحيات منصة في أدوار المنشآت وأدوار المنصة code-defined بلا صفوف tenant role | const5/const11؛ استعلامات كتالوج + `rawDenied` |
| 6 | AT-27 وحفظ الالتزامات | **مغلق** | تعليق أثناء exposure/connection: snapshot يعلن `writer=PMS` و`connections_total=1/active=0` و`commitments_active`؛ Stop Sell صريح `platform_stop=true`؛ revision بعد التعليق أنتج `CREATED` وحجزاً، وصف الاتصال (`status/updated_at`) لم يتغير، ولا حذف/إلغاء | const6 |
| 7 | إعادة التفعيل والنسخ | **مغلق** | بدون إقرار ⇒ 409 `POLICY_VERSION_STALE` (pinned=1,current=2) والإصدار المطبق يبقى 1؛ بالإقرار ⇒ إعادة تثبيت v2 مدققة (`repinned_policy_version=2`)؛ استحقاق منتهٍ بقي `active=false` وظهر في `expired_entitlements`؛ `resume_sales` فتح Stop Sell المنصة فقط؛ If-Match خاطئ 412، حالة غير مطابقة 409، ناقص 400 | const7 |
| 8 | الإغلاق وعدم الحذف | **مغلق** | `deletions=0`؛ لا تغيّر في journal/folio/reservation/commitment/grant/lifecycle باستثناء سطري تدقيق/دورة الإغلاق؛ نفس المفتاح `replayed=true`؛ كل انتقال بعد الإغلاق 409 `TENANT_STATE_CONFLICT`؛ tenant=CLOSED | const8 |
| 9 | SEC-006/AT-S05 | **مغلق** | بلا منحة 403 `SUPPORT_GRANT_REQUIRED`؛ منحة `tenant.read` قصيرة عملت ثم `SUPPORT_GRANT_EXPIRED`؛ نطاق ناقص `SUPPORT_GRANT_SCOPE_DENIED`؛ منح الذات `SUPPORT_SELF_GRANT_DENIED`؛ السحب ⇒ رفض بسبب revoked؛ دالتا القراءة 42501 في القاعدة (profile+audit)؛ أحداث granted/access/revoked مسجلة | const9 + `rvw12-supplement.mjs` (5/5) |
| 10 | SEC-007 MFA | **مغلق** | platform-b (بلا TOTP): تعليق/فوترة/قراءة دعم ⇒ 403 `MFA_REQUIRED`؛ قراءة الدليل الدنيا `platform.read` بلا MFA مسموحة | const10 |
| 11 | إعادة اختبار التسرب | **مغلق** | مستخدم العميل 403 على كل مسارات المنصة؛ المنصة بلا منحة 0 صفوف SQL؛ العامل 42501؛ تصدير تقارير العميل لا يُدرج/يُنزَّل من جلسة المنصة (403) و0 صفوف SQL؛ الدليل لا يعرض اسم المنشأة (label المنصة فقط)؛ سياق منشأة لا يقرأ دورة منشأة أخرى | const11 + const5 |
| 12 | اللوحة والأطقم وعدم الانحدار | **مغلق** | اللوحة تعرض used/limit والتدقيق وأزرار دورة الحياة؛ عربي RTL؛ 390px بلا فائض (overflow=0)؛ مستخدم العميل يرى `platform-forbidden`؛ لا update/delete على journal/journal_line/folio_charge (`42501`)؛ يوم مغلق لا يُفتح (`business_day_transition_guard`، 23514)؛ الأطقم كاملة خضراء وP08/P10/P11 لم تُكسر | const12 + الجدول في القسم 2 |

## 4) العيوب (Findings)

### F-RVW12-01 — متوسط (غير مانع للبوابة): إعادة استخدام مفتاح onboarding بمحتوى مختلف تنشئ منشأة ثانية

- الموضع: `packages/backend/src/modules/platform/application/lifecycle-service.ts:139-171`
  (التحقق من `slug`؛ البحث عن slug قائم قبل أي بحث بمفتاح الـidempotency) و`:173-343`
  (مسار الإنشاء)، مع قيد الفرادة `platform_lifecycle_event_key_unique (tenant_id, idempotency_key)` في
  `packages/backend/src/persistence/migrations/Migration20260917030000_platform_customer_lifecycle.ts:46-47`،
  والقراءة `findLifecycleEventByKey` في
  `packages/backend/src/modules/platform/persistence/platform-repository.ts:243-254`.
  العقد العام المخالف: `docs/26_api_permissions_events.md:98`
  («مفتاح بمحتوى مختلف 409 IDEMPOTENCY_CONFLICT»).
- مثال فشل قابل للتكرار (بيانات `RVW12-`): `POST /api/v1/platform/tenants` بمفتاح
  `RVW12-MU4B2WXK-onboard-replay-…` للمرة الأولى (slug=`rvw12-mu4b2wxk-replay`) ⇒ 201
  و`replayed=false`؛ ثم نفس المفتاح مع slug مختلف (`rvw12-mu4b2wxk-replay-alt`) ⇒ **201
  وأنشئت منشأة/اشتراك ثانٍ** (سجل `NOTE constant 2 :: … status=201 alt_tenant_created=true`،
  و`probes-results.json.onboardSameKeyDifferentSlug = {status:201, altTenantCreated:true}`).
  المتوقع بحسب docs/26: `409 IDEMPOTENCY_CONFLICT` بلا أثر جديد.
- الأثر: مشغّل منصة (MFA + `subscription.manage`) يعيد إرسال نموذج معدّل بنفس المفتاح
  فيُنشئ منشأة/اشتراكاً إضافياً وربما فاتورة إدارية مكررة؛ لا مساس بعزل البيانات ولا
  بالدفتر ولا حركة مال فعلية (الفوترة إدارية بلا بوابة)، ويمكن تصحيحه بالإغلاق. عائلة
  السلوك نفسه موجودة في `recordPlatformUsage`/`issuePlatformInvoice`/grants (إعادة المفتاح
  تعيد النتيجة المخزنة بلا مقارنة محتوى) وهي متوافقة مع نمط المراحل السابقة، لكن الفارق
  الجوهري هنا أن إعادة الاستخدام تُنتج **أثراً جديداً** بدل إعادة نتيجة مخزنة.
- التوصية (لا نُفذت هنا): مفتاح idempotency عالمي لعملية onboarding (جدول مستقل يحفظ بصمة
  المحتوى)، أو توثيق نطاق المفتاح صراحة في بطاقة P12-02 لتسوية تعارض docs/26.

### F-RVW12-02 — منخفض (أدلة): ملف `db-evidence.txt` في P12-03 يسبق مهاجرة التحصين ويعرض منح PUBLIC

- الموضع: `.local/verification/P12-03/db-evidence.txt` (كتلة «support function grants»
  تعرض `PUBLIC` لدالتي الدعم)، بينما مهاجرة التحصين
  `packages/backend/src/persistence/migrations/Migration20260917070000_platform_function_hardening.ts:12-28`
  تسحب EXECUTE من PUBLIC. زمن الملف 23:32:29 مقابل 23:32:38 لملف المهاجرة (9 ثوانٍ قبل وجودها)،
  ولم يُحدَّث الملف بعدها.
- مثال فشل قابل للتكرار: `grep PUBLIC .local/verification/P12-03/db-evidence.txt` يعرض
  PUBLIC؛ بينما استعلام `pg_proc.proacl` الحالي يعطي:
  `platform_support_tenant_audit => hotel=X/hotel,hotel_api=X/hotel,hotel_test=X/hotel`
  بلا PUBLIC (وكذلك بقية دوال المنصة العشر).
- الأثر: لا أثر تشغيلي (الحالة الفعلية صحيحة وأعدت إثباتها)، لكن حزمة الأدلة تُضلل المراجع؛
  يوصى بإعادة توليد الملف بعد آخر مهاجرة.

### F-RVW12-03 — منخفض (تحصين دفاعي، غير مخالف للعقد الحالي): دوال المنصة تثق بوسيط `p_actor` ولا تقارنه بسياق الجلسة

- الموضع: `Migration20260917030000_platform_customer_lifecycle.ts:106-142`
  (`platform_set_tenant_status`)، `:145-186` (`platform_stop_tenant_sales`)،
  `:70-103` (`platform_lifecycle_snapshot`)، و`Migration20260917050000_platform_create_tenant.ts:13-39`،
  و`Migration20260917010000_platform_saas_core.ts:400-437` (`platform_record_tenant_audit`):
  التحقق هو `is_active_platform_staff(p_actor)` فقط، دون اشتراط `p_actor = app.platform_user_id`.
  [docs/25](25_logical_model_contract.md) يصفها «security definer محكومة بفاعل منصة نشط»،
  والـAPI يمرر فاعل الجلسة من `apps/api/src/platform/platform-context.ts:8-24`.
- مثال فشل قابل للتكرار: باستدعاء `select public.platform_lifecycle_snapshot($tenant, $actor)`
  بدور `hotel_api` مع `app.platform_user_id=''` و`$actor` = معرّف موظف منصة نشط ⇒ الدالة
  تنفذ وتعيد snapshot مجمّعاً (13 مفتاحاً) بدل 42501 (سجل `NOTE hardening` في
  `rvw12-supplement.mjs`).
- الأثر: من يملك وصول SQL بدور التشغيل يستطيع استدعاء مسارات المنصة الحساسة (تغيير حالة
  منشأة/وقف بيع/إنشاء منشأة) بمعرّف موظف منصة نشط دون سياق جلسة مصادق. لا يمنح وصولاً
  لبيانات النزلاء (RLS يبقى قائماً) ولا يخالف نص العقد، لكنه يقلل العمق الدفاعي مقارنة
  بفلسفة «القاعدة ضمان أخير» في docs/09. يوصى بمقارنة `p_actor` بـ`app.platform_user_id`
  داخل الدوال (أو تمرير السياق) عند أي تقوية لاحقة.

لا توجد findings خارج الثوابت الاثني عشر. لا finding عالٍ.

## 5) بيان الاستقلال

- جلسة المراجعة منفصلة ولم تنفذ P12؛ لم تُعدّل ملفات إنتاج ولا اختبارات ولا مهاجرات ولا
  عقد، ولم يُخفَّف أي فحص. الملفات الوحيدة المكتوبة: هذا التقرير، مجسّات `RVW12` وسجلاتها
  تحت `.local/verification/review-g12/`، وإعادة توليد `CHECKSUMS.sha256` بالأداة الرسمية.
- كل رقم معلن أعلاه أُعيد إنتاجه بأوامر المراجع نفسها؛ لم يُنقل رقم من `G-12.md` أو
  `P12-0X.md` أو سجلات المنفّذ، ولم يُقرأ أي ملف أدلة تنفيذ كمصدر للحكم (قُرئت للمقارنة فقط).
- مجسّات الثوابت مستقلة عن `tests/property/platform-*`: تسجيل دخول OIDC/TOTP خاص بها
  (Playwright)، وSQL خام عبر أدوار `hotel`/`hotel_api`/`hotel_worker`/`hotel_test`، وبيانات
  `RVW12-` من إنشائها، وبذرة واحدة `RVW12-MU4B2WXK` قابلة للتتبع.
- الأدلة السلبية مثبتة بفشل مغلق فعلي (403/409/412/422/42501) وباستعلامات عدّ خام، لا
  بإخفاء واجهة أو snapshot.

## 6) ما لم يُختبر / حدود المراجعة

- لا AT خارجية ولا قنوات حية ولا رسائل OTA ولا مزود دفع/FX ولا نشر؛ P13 محجوبة.
- استيراد cutover لمنشأة قائمة واستيراد منع الإدخال المزدوج خارج P12 (حد منفّذ معلن)؛
  سحب الحصة الخارجية ومطابقتها يتطلب دليل مزود حي (D-20/P13) — لم يُدَّع.
- البصريات بـPlaywright (استثناء P05..P12)؛ لا جهاز حقيقي ولا قارئ شاشة ولا Computer Use.
- لم أُفزّع (fuzz) سباق إنشاء إصدار سياسة أول متزامن على القاعدة مباشرة؛ محاولة واحدة
  متوازية أعطت `[201,422 POLICY_BACKDATED]` بلا 500، لكن النافذة الضيقة لتضارب
  `(plan_id, version)` لم تُستنفد.
- `closePlatformTenant` من حالة ACTIVE مسموح بحسب البطاقة ولا يطبّق Stop Sell (مسار إيقاف
  البيع الموثق هو التعليق)؛ رصدته ولم أعتبره عيباً لأن P12-02 لا تشترطه، لكنه يستحق
  توضيحاً تشغيلياً إن أُريد للإغلاق المباشر أن يوقف الزيادات.
- `hotel_test` دور اختبار يملك UPDATE على سجلات الدفتر (تصميم P08 السابق)؛ منع تعديل
  posted لدور التشغيل `hotel_api` مثبت بالمنح (42501) لا بـtrigger على `journal` — سلوك
  سابق لـP12 ومطابق للتوثيق.
- لم تُختبر حالات شبكة/مزود/رسائل ولا أي قرار D مفتوح؛ D-11/D-13/D-14/D-17/D-18/D-19/D-20
  استُخدمت كما هي محسومة.

## 7) الحكم النهائي

**PASS WITH FINDINGS.** الثوابت الاثنا عشر مغلقة بأدلة مراجع مستقلة، والأرقام الرسمية
أُعيد إنتاجها بالكامل، ولا finding عالياً ولا مانعاً للبوابة وفق معايير docs/34.
العيوب: F-RVW12-01 (متوسط — idempotency onboarding) وF-RVW12-02 (منخفض — أدلة قديمة)
وF-RVW12-03 (منخفض — تحصين دفاعي). **لا يُعد هذا قبولاً لـG-12**: القبول قرار المستخدم
حصراً، ولا تُفتح P13 ولا قنوات حية ولا جاهزية إنتاج، ولا تُعالَج العيوب في هذه الجلسة.
