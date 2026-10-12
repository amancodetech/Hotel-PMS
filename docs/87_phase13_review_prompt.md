# المراجعة المستقلة الإلزامية لـG-13 (التفعيل الحي للقنوات الخمس): برومبت جلسة منفصلة

التاريخ: 17 سبتمبر 2026.
الغرض: مراجعة مستقلة **إلزامية** لمرحلة P13 قبل أي قبول لـG-13 وفق
[docs/34](34_implementer_handoff.md). تتحقق من حزمة P13 كاملة، وتعيد إنتاج الأرقام والأدلة،
وتهاجم مسارات الاتصال والحصص والسحب والـcutover، وتفصل الحقيقة المحلية عن الادعاء الحي.
**لا تُقبل G-13 من هذه الجلسة**: الحكم توصية، والقبول قرار المستخدم، وEX-01..05 بوابات خارجية.
كتلة اللصق الجاهزة في نهاية الملف.

## شرط البدء — بوابة NO-GO

**لا يبدأ أي فحص قبل التأكد من وجود حزمة P13.** إن غاب أي عنصر من قائمة الوجود: **توقف فوراً،
ولا تكتب `docs/88_phase13_independent_review.md` ولا أي ملف، ولا تُصدر FAIL**؛ أبلغ المستخدم
بقائمة العناصر الناقصة. غياب التنفيذ ليس فشل بوابة.

قائمة الوجود الإلزامية (تحقق منها بأي أداة قراءة):

- بطاقات التنفيذ: `docs/execution/P13-01.md`..`P13-07.md` بأدلة فعلية.
- سجل البوابة: `docs/execution/G-13.md` (حالة **NOT ACCEPTED / EXTERNAL BLOCKED / REVIEW NOT STARTED**).
- سجل EX: `docs/execution/channels/ex-registry.json` + فاحص `scripts/p13-ex-registry.mjs`
  + حزمة الاعتماد/نطاق pilot/خطة الأنواع والأنواع/القنوات
  (`provider-approval-package.md`, `pilot-scope.md`, `types-channels-plan.md`).
- تأهيل القنوات: `docs/execution/channels/channel-readiness.json` + فاحص
  `scripts/p13-channel-readiness.mjs` + قوالب `docs/execution/channels/<channel>.md` الخمسة.
- الإعداد: `packages/backend/src/deployment/profile.ts` + `scripts/production-config-check.mjs`
  + `infra/environments/{staging,production}.env.example` وREADME.
- الاستعادة: `scripts/p13-restore-rehearsal.mjs` وأدلة `.local/verification/P13-02/`.
- conformance: `tests/distribution/p13-conformance.test.mjs` + `scripts/p13-conformance.mjs`
  + `tests/property/p13-conformance.pg.test.mjs` وأدلة `.local/verification/P13-03/`.
- cutover: `tests/property/p13-cutover-rehearsal.pg.test.mjs` وأدلة `.local/verification/P13-05/`.
- المراقبة/التدريب: `scripts/p13-monitor-snapshot.mjs` + قوالب
  `docs/execution/channels/pilot-monitoring-template.md` و`cutover-and-recovery-runbooks.md`.

**استثناء مرن**: اقبل أي أثر مكافئ إن اختلفت الأسماء/المسارات ما دامت المخرجات نفسها.

## كيف تُدار الجلسة

1. جلسة جديدة تماماً بلصق الكتلة في نهاية الملف فقط (بلا سياق المنفذ).
2. بوابة NO-GO، ثم إعادة إنتاج الثوابت أدناه، ثم الأطقم الرسمية من الصفر.
3. أي finding متوسط/عالٍ يُفتح له إصلاح بتفويض المستخدم قبل أي قبول.
4. لا تُعلن G-13 ولا release ولا جاهزية إنتاج؛ الحكم توصية والقبول للمستخدم.
5. تُكتب النتيجة في `docs/88_phase13_independent_review.md` فقط، بلا تعديل كود/اختبارات/مهاجرات.

## البيئة والتشغيل

- `export PATH="/tmp/hotel-pnpm10/node_modules/.bin:$PATH"`؛ PostgreSQL 17.11 على 55432،
  Redis 56379، Keycloak 58080؛ api 4100، web 5173، worker 4101؛
  `COMPOSE_BIN=/tmp/hotel-toolchain/docker-compose-v5`.
- لا تشغّل dev أثناء أطقم property/identity/distribution: `pnpm dev:stop` قبلها ثم
  `pnpm dev:start` للبصريات. الأسرار من `.env` فقط ولا تُطبع.
- الحسابات الاصطناعية: owner-a/admin-a/member-a/auditor-a/owner-b ومسؤولو منصة. بيانات
  المراجعة ببادئة خاصة (`RVW13-`) وبذرة/طوابع فريدة وبلا بيانات نزلاء أو معرّفات مزود حقيقية.
- Playwright استثناء معلن للبصريات المحلية؛ لا Computer Use ولا شبكة/مزود/حساب حقيقي ولا رسائل OTA.

## القراءة الإلزامية

AGENTS.md ثم README.md وdocs/01 وdocs/17 وdocs/18 وdocs/34 ثم:
docs/22 (أدلة الاتصال وAT-C01..10)، docs/24 (Protected Exposure وD-20)، docs/33 (عقد التوسع)،
docs/35 (دليل التفعيل وrunbooks)، docs/12 (التوزيع وInbox/Outbox)، docs/20 (D-12)،
docs/26 (العقود والصلاحيات والأحداث)، docs/09 (SEC/هوية الخدمة)، docs/25 (الهجرات وFORCE RLS)،
docs/27 (G-13) وdocs/31/docs/32 (P13)، وبطاقات P13 وسجل G-13 وdocs/87 (هذا الملف).

افحص الكود الفعلي: `packages/backend/src/modules/distribution/**`،
`packages/backend/src/modules/inventory/application/exposure-service.ts`،
`packages/backend/src/modules/reservations/application/revision-service.ts` وسجلات
`.local/verification/P13-0X/`.

## نطاق المراجعة (ثوابت G-13)

**داخل النطاق:** صدق سجل EX وحالاته؛ فشل إعداد production بلا أسرار مع بقاء الحماية المحلية؛
الفرق بين المحاكي والدليل الحي؛ AT-C05/09 محلياً؛ auto availability وفصل القناة؛ readback/proof
وعدم ادعاء `CHANNEL_VERIFIED` بلا دليل؛ إصلاح حدث سحب Exposure (F-P13-01) وعدم رجوعه؛ حصرية
الحصة D-20 عبر القنوات؛ تبنّي/رفض مفتاح external في الـcutover (F-P13-02) وعدم الازدواج؛
rehearsal الفيلا WHOLE/PARTS؛ runbooks ومراقبة؛ وعدم الانحدار لكل المراحل السابقة.

**خارج النطاق:** قبول G-13 ذاته (قرار المستخدم)؛ اكتمال القنوات الخمس حياً (EX-01/EX-02)؛
قبول مزود/شراء/نشر؛ قيم تجارية/خطط.

## ما يجب إعادة إنتاجه مستقلاً

1. **صدق EX**: `node scripts/p13-ex-registry.mjs` ⇒ 5/5، EX-01/02/03/05 BLOCKED_EXTERNAL وEX-04
   IN_PROGRESS_LOCAL، ولا `live_tested=true` ولا دليل مختلق.
2. **تأهيل القنوات**: `node scripts/p13-channel-readiness.mjs --emit-docs` ⇒ 5/5،
   DECLARED_AND_TESTED=0، وكل AT-C01..10 `NOT_TESTED` بلا دليل.
3. **الإعداد**: مثالا staging/production يفشلان (exit 1)، وبيئة اصطناعية كاملة تنجح، و
   `loadConfig` يرفض `NODE_ENV=production` (الحماية المحلية باقية).
4. **الاستعادة**: `node --env-file=.env scripts/p13-restore-rehearsal.mjs` ⇒ PASS مع حفظ
   التعليق، صفر زيادات، وRPO/RTO مقاسين محلياً.
5. **conformance محلي**: `node scripts/p13-conformance.mjs` ⇒ 6/6، و
   `pnpm test:property:fast -- --filter=p13-conformance --bail` ⇒ 3/3.
6. **cutover**: `pnpm test:property:fast -- --filter=p13-cutover --bail` ⇒ 3/3 (استيراد/Feed
   بلا ازدواج، حصة فيلا لا تتداخل، فتح محدود، ambiguous fail-closed، الاتجاه المعاكس).
7. **المراقبة**: `node --env-file=.env scripts/p13-monitor-snapshot.mjs` ينتج JSON بلا أسرار.
8. **عدم الانحدار**: `pnpm db:check` ثم `pnpm check` ثم `pnpm test:property` كاملاً ثم
   `pnpm test:identity` ثم `pnpm test:distribution` (بعد `pnpm dev:stop`) ثم `pnpm dev:start`
   ثم `visual:phase12..phase5` و`pnpm visual:check` ثم `pnpm checksums` و
   `sha256sum -c CHECKSUMS.sha256`، مع إعادة اختبار مالي/إغلاق يوم (لا reopen D-13).

## توقف وأبلغ فوراً عند

- finding عالٍ جديد (خصوصاً ازدواج حجز، تحرير حصة بلا دليل، تسرب عزل)، أو تعارض وثيقة/سلوك.
- حاجة شراء/حساب/مزود/نشر/شبكة أو رسائل OTA، أو حاجة قرار D مفتوح (D-19/D-20/تجاري القنوات).
- محاولة مساس بسجل منشور أو إعادة فتح يوم مغلق (D-13)، أو تخفيف عزل/ضمان حصة.
- أي ادعاء قناة حية بلا دليل رسمي؛ المحاكي ليس دليلاً حياً وغياب الشكاوى ليس إثباتاً.

## المخرجات والحكم

- ملف واحد: `docs/88_phase13_independent_review.md` بأقسام: بوابة NO-GO، إعادة إنتاج الأرقام
  الرسمية (أمر/نتيجة/سجل خام)، جدول ثوابت G-13 مغلق/غير مغلق، findings مصنفة بالخطورة،
  بيان الاستقلال، حدود ما لم يُختبر، و**بوابة الجاهزية الإنتاجية** (تبقى مغلقة).
- الحكم توصية (`PASS WITH FINDINGS` / `FAIL`) مع تقييم جاهزية القنوات **المحلية**؛ لا يُعلن
  release ولا G-13؛ القبول قرار المستخدم، واكتمال الخمس حياً يتوقف على EX-01..05.

## ملاحظات للمستخدم

- هذه جلسة **مستقلة** عن تنفيذ P13؛ حكمها توصية فقط، و**قبول G-13 قرارك حصراً**.
- حتى مع `PASS` محلي، G-13 تبقى غير مكتملة حياً: EX-01/EX-02/EX-03/EX-04/EX-05 خارجية ومعلنة
  `BLOCKED_EXTERNAL` في `ex-registry.json`، ولا اكتمال للخمس بلا أدلة قنوات رسمية.
- أعد `checksums` بعد كتابة التقرير.

## الكتلة الجاهزة للصق في جلسة جديدة

```text
راجع محلياً نتائج المرحلة 13 (P13: التفعيل الحي للقنوات الخمس) في /home/omar/Desktop/Hotel
دون كتابة كود إنتاج أو تعديل اختبارات أو مهاجرات، ودون أي فعل خارجي. هذه المراجعة المستقلة
اللازمة لبوابة G-13 وفق docs/34 ونمط docs/75/79: تحقق من حزمة P13 وثوابتها، وأعد إنتاج الأرقام
والأدلة، وافصل بوضوح بين الدليل المحلي (محاكي/conformance/rehearsal) والقناة الحية
(NOT_TESTED/BLOCKED_EXTERNAL)، ولا تقبل G-13 ولا تعلن release؛ سلّم حكماً توصيفياً
(PASS WITH FINDINGS/FAIL) مع findings مصنفة وخطورة وأدلة إعادة إنتاج.

بوابة NO-GO (قبل أي فحص): تأكد من وجود docs/execution/P13-01..07.md وdocs/execution/G-13.md
بحالة NOT ACCEPTED/EXTERNAL BLOCKED/REVIEW NOT STARTED، وسجل docs/execution/channels/ex-registry.json
وفاحصه scripts/p13-ex-registry.mjs، وتأهيل القنوات channel-readiness.json وفاحصه
scripts/p13-channel-readiness.mjs وقوالب القنوات الخمس، وإعداد النشر
packages/backend/src/deployment/profile.ts وscripts/production-config-check.mjs ومثالَي
infra/environments/{staging,production}.env.example، وrehearsal الاستعادة
scripts/p13-restore-rehearsal.mjs، وconformance tests/distribution/p13-conformance.test.mjs
وscripts/p13-conformance.mjs وtests/property/p13-conformance.pg.test.mjs، وcutover
tests/property/p13-cutover-rehearsal.pg.test.mjs، والمراقبة scripts/p13-monitor-snapshot.mjs
وقوالب docs/execution/channels/pilot-monitoring-template.md وcutover-and-recovery-runbooks.md،
وأدلة .local/verification/P13-01..07/. إن غاب عنصر: توقف فوراً، لا تكتب docs/88 ولا أي ملف،
لا تُصدر FAIL، وأبلغ المستخدم بالعناصر الناقصة. غياب التنفيذ ليس فشل بوابة. اقبل أي أثر مكافئ.

البيئة: export PATH="/tmp/hotel-pnpm10/node_modules/.bin:$PATH"؛ PostgreSQL 17.11 على 55432،
Redis 56379، Keycloak 58080؛ api 4100، web 5173، worker 4101؛ COMPOSE_BIN=/tmp/hotel-toolchain/docker-compose-v5.
أوقف dev قبل أطقم property/identity/distribution (pnpm dev:stop) ثم أعد pnpm dev:start للبصريات.
الأسرار من .env فقط ولا تُطبع. بياناتك ببادئة RVW13- وبذرة فريدة، بلا بيانات نزلاء أو معرّفات
مزود حقيقية. لا Computer Use؛ Playwright استثناء معلن للبصريات المحلية.

القراءة الإلزامية: AGENTS.md ثم README.md وdocs/01 وdocs/17 وdocs/18 وdocs/34 ثم docs/22 وdocs/24
وdocs/33 وdocs/35 وdocs/12 وdocs/20 وdocs/26 وdocs/09 وdocs/25 وdocs/27 وdocs/31 وdocs/32 (P13)
وبطاقات P13 وسجل G-13 وdocs/87، وافحص الكود في packages/backend/src/modules/distribution/**
وpackages/backend/src/modules/inventory/application/exposure-service.ts
وpackages/backend/src/modules/reservations/application/revision-service.ts.

ثم أعد تشغيل الأدلة بنفسك: pnpm db:check؛ pnpm check؛ pnpm test:property (كامل)؛ pnpm test:identity؛
pnpm test:distribution بعد pnpm dev:stop؛ node scripts/p13-ex-registry.mjs؛
node scripts/p13-channel-readiness.mjs؛ node scripts/production-config-check.mjs --profile=production
--env-file=infra/environments/production.env.example (يجب أن يفشل)؛ إثبات رفض loadConfig للإنتاج؛
node --env-file=.env scripts/p13-restore-rehearsal.mjs؛ node scripts/p13-conformance.mjs؛
pnpm test:property:fast -- --filter=p13-conformance --bail؛
pnpm test:property:fast -- --filter=p13-cutover --bail؛
node --env-file=.env scripts/p13-monitor-snapshot.mjs؛ ثم pnpm dev:start والبصريات
visual:phase12..phase5 وvisual:check؛ ثم pnpm checksums وsha256sum -c CHECKSUMS.sha256.

أعد إنتاج الثوابت تحت .local/verification/review-g13/ بأدوات مستقلة ولا تعتمد أرقام المنفذ:
1) صدق EX: 5/5، EX-01/02/03/05 BLOCKED_EXTERNAL وEX-04 IN_PROGRESS_LOCAL، بلا live_tested ولا دليل مختلق.
2) تأهيل القنوات: 5/5، DECLARED_AND_TESTED=0، وكل AT-C01..10 NOT_TESTED بلا دليل؛ لا خلية يملؤها محاكي.
3) الإعداد: مثالا staging/production يفشلان مغلقين، وبيئة اصطناعية كاملة تنجح، والحماية المحلية ترفض production.
4) الاستعادة: PASS مع بقاء تعليق البيع، صفر زيادات، وRPO/RTO مقاسين؛ الكتابة بعد بدء النسخة لا تُستعاد.
5) F-P13-01: حدث Stop Sell للسحب موجود ونسخته أحدث، ولا تحرير قبل قبوله؛ أعد تشغيل p13-conformance (3/3).
6) AT-C05/09: لا نجاح زائف، retry-after يحترم، UNKNOWN/PARTIAL لا تتحول إلى verified، والاستعادة تمنع الزيادات حتى المطابقة.
7) readback/proof: provider accepted ≠ channel verified؛ CHANNEL_VERIFIED فقط بدليل.
8) D-20: حصة خارجية واحدة لكل مورد/فترة عبر قناتين؛ الفيلا WHOLE تمنع الأجزاء والعكس؛ لا تحرير بلا دليل.
9) F-P13-02: استيراد ثم revision = حجز واحد (تبنٍّ موثق)، revision ثم استيراد = DUPLICATE، وتعدد المرشحين = EXTERNAL_KEY_AMBIGUOUS بلا حجز ثالث.
10) rehearsal الفيلا وفتح محدود بلا ازدواج حجوزات وبلا زيادة مخزون، وwindow/مراقبة بلا ادعاء حي.
11) عدم الانحدار: check/property/identity/distribution/visuals/checksums كاملة، ولا reopen D-13 ولا مساس بسجل منشور.
12) حدود G-13: EX-01..05 تبقى بوابات خارجية؛ لا قبول ولا release ولا ادعاء قناة حية؛ بوابة الجاهزية الإنتاجية مغلقة.

في التقرير: لكل عيب الخطورة وfile:line ومثال فشل قابل للتكرار وأثره، وجدول الثوابت مغلق/غير مغلق
مع أمر إعادة الإنتاج ومسار السجل الخام، وبيان الاستقلال وحدود ما لم يُختبر، ثم الحكم النهائي
PASS WITH FINDINGS أو FAIL. اكتب النتيجة فقط في docs/88_phase13_independent_review.md ولا تصلح
شيئاً بنفسك. توقف وأبلغ فوراً عند finding عالٍ جديد أو حاجة فعل خارجي/قرار D مفتوح أو محاولة
مساس بسجل منشور أو إعادة فتح يوم مغلق (D-13). لا تقبل G-13 بالنيابة عن المستخدم. شغّل checksums
بعد كتابة تقريرك.
```
