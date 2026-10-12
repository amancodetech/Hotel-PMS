# docs/76: المراجعة المستقلة المركزة لـG-10 (المرحلة 10 — التدقيق الليلي وإغلاق يوم العمل)

التاريخ: 16 سبتمبر 2026. المراجع: جلسة مستقلة وفق [docs/75](75_phase10_review_prompt.md)،
بلا سياق المنفّذ وبلا تعديل كود إنتاج أو اختبارات أو مهاجرات. هذا التقرير **لا يمنح قبول G-10**؛
القبول قرار المستخدم، وأي finding متوسط/عالٍ يفتح جلسة إصلاح مفوّضة قبله.

## 1) بوابة NO-GO: **GO**

تحققت عناصر الوجود كلها قبل أي فحص (بما فيها الاستثناء المرن للمخرجات المكافئة):

- بطاقات `docs/execution/P10-01.md`..`P10-03.md` بأدلة تنفيذ فعلية، وسجل
  `docs/execution/G-10.md` بحالة `VERIFIED محلياً / REVIEW_PENDING` (لا ACCEPTED).
- العقد `docs/contracts/phase10.openapi.json` مربوط فعلاً بـ`contracts:generate` (سطر في
  `package.json`) و`contracts:check` (`scripts/contracts.mjs`)، و5 عمليات Phase 10.
- `scripts/phase10-visual.mjs` مع سجل تشغيل ولقطات، وأدلة خام في
  `.local/verification/P10-01/`..`P10-03/` (check/identity/distribution، kill/resume وسباقاته،
  بصريات و`db-evidence.json`).
- مهاجرات P10 بعد `20260916150000`: `20260916170000_night_audit_core` و`…180000`/`…190000`/
  `…200000` (صلاحيات العامل)، واختبارات P10 في `tests/property/night-audit.pg.test.mjs`
  و`tests/night-audit-clock.test.mjs`، ووحدة/مسار night-audit في
  `packages/backend/src/modules/night-audit` و`apps/api/src/night-audit` و`apps/web/src/night-audit`
  و`apps/worker`.

## 2) الحكم التوصيفي: **PASS WITH FINDINGS** (لا قبول)

> تحديث 16 سبتمبر 2026: أُغلقت F-RVW10-01 بجلسة إصلاح محصورة وتحققت مستقلاً — انظر
> [القسم 9](#9-تحديث-ما-بعد-الإصلاح-إغلاق-f-rvw10-01-تحقق-مستقل-16-سبتمبر-2026)؛ الحكم
> النهائي **PASS**. **قَبِل المستخدم G-10 محلياً في 16 سبتمبر 2026** بقرار صريح بعد هذا
> التقرير (سُجّل في `G-10`/`docs/27`/`docs/34`/`README`)، ولا يعني القبول جاهزية إنتاج أو قنوات.

ثوابت المنتج الثمانية كلها **مغلقة بأدلة مستقلة**، لكن إعادة تشغيل الأرقام الرسمية كشفت
Finding متوسطاً واحداً في ثبات الأطقم الرسمية (F-RVW10-01) يمنع اعتبار حزمة الأدلة مكتملة
حتى إصلاحه. لا FAIL على أي بند من ثوابت البوابة.

## 3) إعادة إنتاج الأرقام الرسمية (منفّذ ← مراجع)

| الأمر | أرقام المنفّذ (G-10) | إعادة إنتاج المراجع | الحكم | السجل الخام |
|---|---|---|---|---|
| `pnpm db:check` | نجاح | نجاح (`database connection successful`) | مطابق | `.local/verification/review-g10/db-check.log` |
| `pnpm check` | 87/87 في 12 حزمة | **87/87 في 12 حزمة** | مطابق | `.local/verification/review-g10/check.log` (سطر 130) |
| `pnpm contracts:check` | 5 عمليات Phase 10 | **5 عمليات** ومطابقة الأنواع | مطابق | `.local/verification/review-g10/contracts-check.log` |
| `pnpm test:property` | 267/267 في 37 حزمة | **265/267 في 37 حزمة — فشلان** (F-RVW10-01) | غير مطابق (متوسط) | `.local/verification/review-g10/test-property-full.log` |
| `pnpm test:property:fast -- --filter=adversarial` | 36/36 | **36/36** | مطابق | `.local/verification/review-g10/adversarial-fast.log` |
| `pnpm test:identity` | 48/48 | **48/48** | مطابق | `.local/verification/review-g10/test-identity.log` |
| `pnpm test:distribution` | 48/48 | **48/48** | مطابق | `.local/verification/review-g10/test-distribution.log` |
| `pnpm visual:phase10` | 19/19 | **19/19 و8 لقطات** | مطابق | `.local/verification/review-g10/visual-phase10.log` |
| `visual:phase9/8/7/6/5` | 28/34/35/24/19 | **28/34/35/24/19** | مطابق | `.local/verification/review-g10/visual-phase*.log` |
| `pnpm visual:check` | 38/38 | **38/38** | مطابق | `.local/verification/review-g10/visual-check.log` |
| `pnpm checksums` + `sha256sum -c` | — | **586 بصمة، 586/586 OK، والملف لم يتغير** قبل إضافة هذا التقرير | مطابق | `review-g10/checksums.log` و`checksums-verify.log` و`checksums-diff.log` |

kill/resume: لم أشغّل سكربت المنفّذ كدليل وحيد، بل نفّذت **أداتي المستقلة** (أدناه) بنتيجة
**14/14** و**9 قتلات SIGKILL فعلية** بPID بعد كل checkpoint.

## 4) جدول الثوابت الثمانية (مغلقة كلها)

| # | الثابت | الحالة | إعادة الإنتاج المستقلة | السجل الخام |
|---|---|---|---|---|
| 1 | آلة اليوم والحاجز: يوم واحد نشط، لا reopen (D-13)، `CLOSING`⇒BUSY قابل لإعادة المحاولة و`CLOSED` لا يستقبل، وفشل خطوة لا يعيد ما نجح | **مغلق** | `node --env-file=.env .local/verification/review-g10/rvw10-verify.mjs` — يوم واحد نشط (فهرس `business_day_single_active`)، trigger `business_day_transition_guard` يرفض إعادة فتح `CLOSED` (23514) وأي انتقال غير أمامي، وBUSY/CLOSED عبر HTTP، والرسم الليلي يبقى بعد فشل VALIDATE ثم لا يتكرر عند retry | `review-g10/rvw10-verify-run.log` + `rvw10-verify-summary.json` (73/73) |
| 2 | رسوم الليالي مرة واحدة + kill/resume (AT-F06): قتل عامل فعلي بعد كل checkpoint بلا Charge ثانٍ ولا فجوة، وإعادة التشغيل بعد الاكتمال بلا أثر ثانٍ، والخطوات مربوطة Property+BusinessDate+Step | **مغلق** | `node --env-file=.env .local/verification/review-g10/rvw10-kill-resume.mjs` — 9 SIGKILL بعد PREPARE…CLOSE_DAY، `journals=2` و`charges=2` ثابتة، `SUCCEEDED/steps_done=10/attempt=10`، إعادة تشغيل العامل بعد الاكتمال لم تغيّر شيئاً، و`replayed=true`؛ وفهرس الخطوة الفريد (23505) | `review-g10/rvw10-kill-resume-run.log` + `rvw10-kill-resume-summary.json` (14/14) |
| 3 | السباقات (AT-F07): ترحيل متزامن مع الإغلاق بفائز واحد/BUSY، وإغلاقان متزامنان بلا يومين مغلقين ولا فتح متداخل | **مغلق** | ضمن `rvw10-verify.mjs`: `Promise.all` لترحيل+إغلاق (200/200 أو 200/409 BUSY) بلا تسرب ليوم مغلق (رفض لاحق `BUSINESS_DAY_CLOSED` ونجاح على اليوم الجديد)، وإغلاقان متزامنان: يوم `CLOSED` واحد + يوم `OPEN` تالٍ واحد + Charge واحد | `review-g10/rvw10-verify-run.log` |
| 4 | AT-28 والتوقيت: سياسة المنشأة (Asia/Jakarta) لا ساعة الخادم/UTC، بمهاد عند الحدود، والواجهة تعرض `business_date` والتوقيت | **مغلق** | في `rvw10-verify.mjs`: حدّا 16:59Z/17:00Z، وفتح `2026-09-17` (Jakarta) بعد منتصف الليل مع رفض `2026-09-16` (UTC) كـ`BUSINESS_DAY_NOT_OPEN`، و`overview` يعيد `date/timezone`؛ واختبار `night-audit-clock.test.mjs` ضمن `check` 87/87؛ والواجهة تعرضهما (رسم phase10) | `review-g10/rvw10-verify-run.log` و`visual-phase10.log` |
| 5 | الاستثناءات والتحقق: فشل شرط يمنع الإغلاق، لا no-show تلقائي لمقيم، لا إخفاء رصيد غير معالج، والاستثناء المسموح بمسؤول وسبب وسجل | **مغلق** | في `rvw10-verify.mjs`: ARRIVAL/DEPARTURE/MISSING_FOLIO تمنع (422) والبنود تبقى `CONFIRMED/IN_HOUSE` بلا no-show/check-out تلقائي، ACK بمالك وسبب ⇒ إغلاق، و`OUTSTANDING_BALANCE` WARNING بالمبلغ لا يُخفى ولا يمنع وحده | `review-g10/rvw10-verify-run.log` |
| 6 | قواعد P08 لم تُكسر وP09 لم ترتد: توازن/جمود/Decimal/HALF_UP، ومسارات P09/P07/P05 | **مغلق** | `pnpm test:property` الكامل شمل finance-core/finance-integration/folio/payments/billing/corrections + operations-board/tasks/work-orders + adversarial-p05 (كلها خضراء عدا فشلَي F-RVW10-01)، والفحص العدائي 36/36؛ وفحوص SQL مستقلة: كل journal متوازن ومطابق لمجموع سطوره، سطرا `FOLIO_GUEST`/`REVENUE_ROOM`، حدود Decimal(20,6) صامدة، واختبارا `adversarial-p05` (Disruption الطوارئ وسحب Holds المنتهية) مرّا | `test-property-full.log` + `rvw10-verify-run.log` |
| 7 | RLS والعزل والصلاحيات: FORCE RLS ومنح أقل صلاحية، owner-b محجوب، عضو بلا `business_day.close`/MFA يُرفض، idempotency/audit/correlation على كل كتابة | **مغلق** | في `rvw10-verify.mjs`: الجداول الأربعة `relforcerowsecurity=true` ولكل منها سياسة، جلسة API بعميل B ترى 0 صفوف، worker بلا DELETE/UPDATE على الدفتر (42501، insert-only)، HTTP: member 403، owner-b 404/403، owner-a 403 `MFA_REQUIRED`، والمفاتيح المتكررة تعيد نفس النتيجة (409 عند اختلاف المحتوى)؛ وكل كتابات P10 في `audit_event`/`night_audit_event` تحمل correlation و`api_idempotency` مسجّل | `review-g10/rvw10-verify-run.log` |
| 8 | الواجهة والبصريات: شاشة اليوم (تقدم/خطأ/إعادة محاولة/سجل)، RTL و390px بلا فائض، وإعادة تشغيل بعد إغلاق مكتمل تعيد النتيجة نفسها؛ ولا حذف/إضعاف فحوص | **مغلق** | `visual:phase10` 19/19 (منها 10 checkpoints، استثناء مانع، ACK، retry بلا رسم ثانٍ، رفض MFA، RTL، 390px)، وphase9..5 بالمجاميع السابقة نفسها، و`visual:check` 38/38؛ وإعادة التشغيل بعد إغلاق مكتمل تعيد النتيجة نفسها (`replayed=true` مع نفس اليوم المغلق، بلا يوم أو Charge ثانٍ) عبر API وUI | `review-g10/visual-*.log` + `rvw10-verify-run.log` |

## 5) Findings

### F-RVW10-01 — متوسط (أطقم/أدلة، بلا أثر منتج): طقم night-audit يتوقف على ساعة اليوم

- **السلوك:** `pnpm test:property` لا يعيد 267/267 في كل الأوقات؛ اختباران يفشلان بين
  الساعة 00:00 و16:59 UTC (حين يكون تاريخ جاكرتا مساوياً لتاريخ UTC):
  - `P10-01 outstanding balances and in-house departures are surfaced, not hidden or auto-resolved`
  - `P10-02 retry resumes a failed run after acknowledgement without a second charge`
- **السبب المؤكد:** الـfixture يقوم بـ`update stay_segment set end_date = today` لإقامة
  `arrival=today` (المحسوب بـ`addDays(0)` بتوقيت UTC) مع `today = localToday('Asia/Jakarta')`،
  فيصبح `end_date = start_date` ويخالف قيد `stay_segment_dates_check (end_date > start_date)`
  (`Migration20260915050000_reservation_core.ts:118`). المنفّذ وثّق أدلته في نافذة 19:34–19:39 UTC
  حيث كانت جاكرتا قد عبرت منتصف الليل فمرّ الـfixture.
- **إعادة الإنتاج:** `pnpm test:property:fast -- --filter=night-audit` في أي وقت قبل 17:00 UTC
  ⇒ 8/10 (فشلان). السجل: `.local/verification/review-g10/night-audit-repro.log`، والسجل الكامل:
  `review-g10/test-property-full.log` (الأسطر 83–117)، وموضعا العيب:
  `tests/property/night-audit.pg.test.mjs:530` و`:876`.
- **الأثر:** لا أثر على كود الإنتاج أو الثوابت (تحققت مستقلاً: ARRIVAL/DEPARTURE/retry/no
  second charge كلها تعمل)، لكنه يمنع إعادة إنتاج الأرقام الرسمية على مدار الساعة ويجعل
  دليلَين من أدلة البوابة غير ثابتين؛ جلسة إصلاح اختباري محصورة (تعديل fixture فقط) كافية،
  مع إعادة تشغيل `test:property` كاملاً وتحديث G-10.
- **التصنيف:** متوسط (أطقم/أدلة). لا يستدعي إيقافاً؛ لا عالٍ ولا حرج.

### ملاحظات غير مصنّفة كfindings (خارج نطاق P10 أو اتفاق قديم)

- مفتاح idempotency بمحتوى مختلف يعيد 409 `CONFLICT` مع `details.reason=idempotency_key_reused`
  بينما ينص docs/26 على 409 `IDEMPOTENCY_CONFLICT`. السلوك موحّد ومقصود منذ P06/P07
  (يؤكده `tests/property/idempotency-scope.pg.test.mjs:135`) وليس تغييراً من P10؛ الحالة HTTP
  والوظيفة صحيحتان، والفرق في اسم الرمز فقط — يُترك لقرار توثيقي لاحق خارج هذه المراجعة.
- لا ملاحظات أخرى: لم أرصد أي محاولة reopen (D-13) في القاعدة أو الخدمة أو العقد أو الواجهة.

## 6) بيان الاستقلال (لماذا لا أعتمد أرقام المنفّذ)

1. كل الأرقام الرسمية أُعيد تشغيلها من الصفر على البيئة المحلية: `db:check`، `check`
   (بناء + types + lint + format + unit)، `contracts:check`، `test:property` كامل،
   adversarial، identity، distribution، البصريات السبع، checksums و`sha256sum -c`.
   سجلاتي محفوظة تحت `.local/verification/review-g10/` ولا يعتمد أي حكم فيها على سجلات
   المنفّذ في `P10-0X/`.
2. كتبت أدواتي الخاصة (`rvw10-verify.mjs` و`rvw10-kill-resume.mjs`) بمُدخلات اصطناعية
   `RVW10-*` وقواعد جديدة، وبفحوص SQL/HTTP من صياغتي: لم أنسخ استدعاءات اختبارات المنفّذ
   ولا اعتمدت ملخصاته؛ ولا استخدمت سكربت القتل الخاص به.
3. أعدت إنتاج الثوابت من السلوك الفعلي: قتل عامل حقيقي بPID (9 مرات)، وسباقات متزامنة،
   وحقن استثناءات، وقراءة الجداول بأدوار التشغيل `api`/`worker`، وفحص القيود والفهارس
   والفهارس الفريدة وtriggers من `pg_class`/`pg_policies`.
4. الفحص المستقل كشف فشلاً لم يوثقه المنفّذ (F-RVW10-01) — دليل إضافي على عدم الاعتماد على
   أرقامه. كما قارنت `CHECKSUMS.sha256` قبل/بعد فلم يتغير، ما يعني أن المراجعة لم تمسّ أي
   ملف من الحزمة، وأن بصمات المنفّذ سليمة.
5. لم أُصلح شيئاً: لا كود إنتاج ولا اختبارات ولا مهاجرات؛ والملف الوحيد المكتوب في الحزمة
   هو هذا التقرير، إضافة إلى أدلة المراجعة التحتية في `review-g10/` وفق docs/75.

## 7) حدود ما لم أختبره

- لا Computer Use ولا جهاز حقيقي ولا قارئ شاشة؛ Playwright استثناء معلن مطابق P05..P09
  للبوابة المحلية فقط (لا ادعاء إنتاج).
- خارج النطاق عمداً: P11+، القنوات الحية/OTA، مزود الدفع/FX، الجاهزية الإنتاجية، EX-03،
  والمراجعة المستقلة لتصميم P05..P09.
- لم أحقن مسارات `PAYMENT_UNKNOWN` و`MISSING_PRICE` و`RATE_CURRENCY_MISMATCH` استقلالياً
  (راجعت الكود ومسار VALIDATE، وتغطيها اختبارات الطقم المنفّذة عدا فشلَي F-RVW10-01)؛
  الثابت 5 مُثبت مستقلًا عبر ARRIVAL/DEPARTURE/MISSING_FOLIO/OUTSTANDING_BALANCE.
- لم أختبر انهيار API/worker أثناء الإغلاق بجداول زمنية أطول، ولا تعدد المنشآت المتزامن
  على أكثر من منشأة واحدة (السباقات نُفذت داخل منشأة واحدة كما يقتضي الحاجز).
- سلوك حدود منتصف الليل اختُبر على مستوى الوحدة والخدمة (بمهاد `HOTEL_CLOCK_NOW`) وليس
  بتشغيل API كامل بساعة مجمّدة؛ رفض الإنتاج مثبت بنيوياً (schema يرفض `NODE_ENV=production`).
- الترجمة العربية/الإندونيسية فُحصت عبر بصريات RTL القائمة، لا بمراجعة لغوية بشرية.

## 8) التوصية

1. فتح جلسة إصلاح مفوّضة لـ**F-RVW10-01** (تعديل fixture فقط ليصبح مستقلاً عن ساعة UTC)،
   وإعادة `pnpm test:property` كاملاً أي قبل الساعة 17:00 UTC لإثبات 267/267، ثم تحديث
   `G-10` بسجل الإصلاح. ليست حاجةً لإصلاح منتج؛ لا شيء في كود P10 يتطلب تغييراً.
2. بعد ذلك، القبول قرار المستخدم؛ إن قُبل G-10 فيُفتح P11 فقط، بلا جاهزية إنتاج ولا قنوات
   حية، مع بقاء ملاحظة رمز idempotency بنداً توثيقياً خارج P10.

## 9) تحديث ما بعد الإصلاح: إغلاق F-RVW10-01 (تحقق مستقل، 16 سبتمبر 2026)

نُفذت جلسة الإصلاح المحصورة ([docs/77](77_phase10_fix_session.md))، وأعدت التحقق منها
استقلالاً **داخل نافذة الفشل نفسها (قبل 17:00 UTC)**:

- **نطاق التغيير المثبت بالبصمات:** مقارنة `CHECKSUMS` قبل المراجعة/بعد الإصلاح تُظهر أن
  الملف الوحيد المتغير في الاختبارات هو `tests/property/night-audit.pg.test.mjs` (تغيّر
  بصمته)، مع مستندات فقط (`G-10` و`README` و`docs/27` و`docs/34` و`docs/77` وهذا التقرير)؛
  **لا تغيير في كود إنتاج ولا عقد ولا مهاجرة ولا واجهة ولا بصريات** — مطابق لبيان المنفّذ.
- **الرقعة:** في موضعي WARN (الأسطر 530–536) وRETRY (الأسطر 878–884) صار الـfixture:
  `set "start_date" = $3::date - 1, "end_date" = $3` حيث `$3` هو تاريخ العمل
  (Jakarta)، فيتحقق `end_date > start_date` دائماً مع بقاء الدلالة (ليلة واحدة مستحقة
  المغادرة اليوم وما زالت IN_HOUSE)، مع تعليقَي إحالة إلى F-RVW10-01.
- **إعادة التشغيل المستقلة في 04:51–04:57 UTC (داخل النافذة):**
  - `pnpm test:property:fast -- --filter=night-audit` ⇒ **10/10** — `review-g10/night-audit-post-fix.log`
  - `pnpm test:property` الكامل ⇒ **267/267 في 37 حزمة** — `review-g10/test-property-post-fix.log`
  - `pnpm check` ⇒ **87/87 في 12 حزمة** و5 عمليات Phase 10 — `review-g10/check-post-fix.log`
  - `pnpm checksums` + `sha256sum -c` ⇒ **588/588 OK** — `review-g10/checksums-post-fix.log`
- **النتيجة:** F-RVW10-01 = **FIXED / CLOSED**، ولا findings مفتوحة في هذه المراجعة.
  حكم المراجعة النهائي **PASS** (ثوابت G-10 الثمانية مغلقة وأرقامها الرسمية معادة بالكامل).
  **قَبِل المستخدم G-10 محلياً بقرار صريح (16 سبتمبر 2026)** فحُدِّثت الحالة في
  `G-10`/`docs/27`/`docs/34`/`README` إلى ACCEPTED محلياً وفُتح **P11 فقط**؛ لا P11 منفذة
  في هذه الجلسة ولا برومبت لها، ولا جاهزية إنتاج ولا قنوات حية.
