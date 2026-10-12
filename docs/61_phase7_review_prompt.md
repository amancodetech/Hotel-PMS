# المراجعة المستقلة لـG-07 (المرحلة 7: المكتب الأمامي): برومبت جلسة منفصلة

التاريخ: 15 سبتمبر 2026. الغرض: مراجعة مستقلة لـP07-01..P07-05 قبل أي قبول لـG-07.
كتلة اللصق الجاهزة في نهاية الملف.

## كيف تُدار الجلسة

1. تُشغَّل في جلسة جديدة تماماً بلصق الكتلة في نهاية الملف فقط (لا يُشارك سياق المنفذ).
2. أي findings متوسطة/عالية تُفتح لها جلسة إصلاح بتفويض المستخدم قبل أي قبول.
3. لا يُعلن قبول G-07 إلا بقرار المستخدم صراحةً، ويفتح القبول P08 (المالية) فقط.

## ما يجب أن يعرفه المراجع قبل الانطلاق

- السياق الحاكم: [docs/59](59_phase7_execution_prompt.md) (برومبت التنفيذ)،
  [docs/60](60_phase7_design_freeze.md) (تجميد التصميم)، و[docs/32](32_execution_work_packages.md)
  قسم P07، وبطاقات [P07-01](execution/P07-01.md)..[P07-05](execution/P07-05.md)
  وسجل [G-07](execution/G-07.md).
- العمليات العشر في `docs/contracts/phase7.openapi.json`: `GetFrontDeskBoard` (frontdesk.read)،
  `AssignRoom` (assignment.manage)، `CheckInStay` (stay.checkin)، `MoveStay`/`ExtendStay`/
  `SplitStay`/`EarlyDepartureStay` (stay.move)، `PartialDepartureStay`/`CheckOutStay` (stay.checkout)،
  و`ListChannelExceptions` (channel.reprocess، F7).
- الحزم: P07-01 Board/تخصيص/Check-In؛ P07-02 نقل/تمديد/Split/خروج مبكر/مغادرة جزئية؛
  P07-03 Check-Out تشغيلي؛ P07-04 واجهة React + F7 + العملية 10؛ P07-05 بصريات وتحقق.
- ما يجب إعادة إنتاجه مستقلاً (لا تثق بأرقام المنفّذ): سباقات Check-In/Move/Extend/Check-Out
  متزامنة بفائز واحد أو رفض محفوظ؛ Dirty/OOO تمنع التسليم فعلاً؛ حدث `stay_event` واحد لكل
  عملية والنسخة/المفتاح يمنعان التكرار (replay يعيد بلا أثر، و409/412 واضحتان)؛ Check-Out
  لا يلمس المال (`financial_clearance_state='PENDING'` فقط) ويترك الغرفة DIRTY وحدثاً واحداً
  قابلاً لاستهلاك P09؛ Split لا يفقد ليالي/التزامات ولا يكررها؛ النقل يؤمّن البديل قبل إغلاق
  القديم والقديم محفوظ عند الفشل؛ F7 يعرض استثناءات بحقول آمنة بلا حمولة خام ويعيد المعالجة
  بلا كتابة جزئية؛ RLS/FORCE/المنح على `room_assignment`/`stay_event` وبقية مسارات P07.
- المطلوب كتابة الحكم في `docs/62_phase7_independent_review.md` (لا تعدّل كود إنتاج أو اختبارات):
  PASS / PASS WITH FINDINGS / FAIL، وبند مغلق/غير مغلق لكل سؤال، وfindings مصنفة بالخطورة مع
  أدلة إعادة إنتاج خام ومساراتها. **لا تمنح قبول G-07؛ القرار للمستخدم.**

## كتلة جاهزة للصق في جلسة مستقلة

انسخ الكتلة التالية كأول رسالة في جلسة جديدة تماماً (بلا سياق المنفذ):
```text
راجع محلياً نتائج المرحلة 7 (P07: المكتب الأمامي) في /home/omar/Desktop/Hotel دون كتابة كود
إنتاج أو تعديل اختبارات أو مهاجرات. لا تقبل G-07 نيابة عن المستخدم؛ سلّم حكماً توصيفياً
(PASS/PASS WITH FINDINGS/FAIL) مع findings مصنفة بالخطورة وأدلة إعادة إنتاج.

البيئة: export PATH="/tmp/hotel-pnpm10/node_modules/.bin:$PATH"؛ PostgreSQL 17.11 على 55432،
Redis 7.4.11 على 56379، Keycloak 26.7.3 على 58080. لا تشغّل dev أثناء أطقم property/identity
(تنازع 4100)؛ أوقفه pnpm dev:stop ثم أعد تشغيله للبصريات فقط. الأسرار من .env فقط ولا تُطبع.
الحسابات الاصطناعية: owner-a (بلا MFA)، admin-a (TOTP)، member-a، auditor-a، owner-b.
بيانات جديدة ببادئة مراجعتك وبذرة/طوابع فريدة، وبلا بيانات نزلاء حقيقية.

القراءة الإلزامية: AGENTS.md ثم README.md وdocs/01 وdocs/17 وdocs/32 (قسم P07) وdocs/59
وdocs/60 وdocs/execution/P07-01..05 وdocs/execution/G-07 وdocs/contracts/phase7.openapi.json
وscripts/contracts.mjs وscripts/phase7-visual.mjs. افحص الكود في
packages/backend/src/modules/front-office وapps/api/src/front-office وapps/web/src/frontdesk
وapps/web/src/reservations/ImportExceptionsTab.tsx، ومهاجرة 20260915140000_front_office_core.

أعد تشغيل الأدلة بنفسك: pnpm db:check ثم pnpm check ثم pnpm contracts:check ثم
pnpm test:property ثم pnpm test:distribution ثم pnpm test:identity (بعد pnpm dev:stop) ثم
pnpm dev ثم pnpm visual:phase7 وpnpm visual:phase6 وpnpm visual:phase5 وpnpm visual:check
ثم pnpm dev:stop ثم pnpm checksums وsha256sum -c.

أعد إنتاج الحالات الآتية بأدواتك المستقلة تحت .local/verification/review-g07/ (بيانات اصطناعية):
1) سباق Check-In متزامن على نفس البند/الغرفة → فائز واحد وحدث STAY_CHECKED_IN واحد بلا تخصيص
   أو قطاع ثانٍ؛ وإعادة نفس المفتاح replay، ومفتاح مختلف بعد النجاح 409، ونسخة قديمة 412.
2) الجاهزية: Dirty/OOO/OOS تمنع التخصيص/Check-In؛ Block/OOO لا يُتجاوَز.
3) النقل: البديل يؤمن قبل إغلاق القديم؛ تعارض الغرفة يفشل بلا أثر على القديم؛ السجل القديم
   COMPLETED/مقصوص لا يُحذف.
4) التمديد: تعارض GiST مع تخصيص/خروج آخر → CONFLICT والقديم محفوظ؛ لا إعادة تسعير
   (price_snapshot_id ثابت)؛ سباق تمديدين → فائز واحد.
5) Split: بندان/قطاعان متتابعان بلا تراكب، ومجموع الليالي/الالتزامات مرة واحدة، والأصل و
   المتابع IN_HOUSE؛ رفض at_date خارج النطاق.
6) الخروج المبكر والمغادرة الجزئية: الماضي ثابت، والمغادرة الجزئية مرة واحدة لكل ضيف مع
   منع التكرار وحدث واحد.
7) Check-Out: سباق متزامن بفائز واحد وحدث STAY_CHECKED_OUT واحد؛ إدراج الحدث مرتين لا يضاعف؛
   التخصيصات COMPLETED والغرفة DIRTY مع حفظ maintenance_state؛ ولا أي لمس لمال/ذمة/PAN/CVV
   (`financial_clearance_state` يبقى PENDING).
8) RLS/المنح: دور API لا يرى/يعدّل عبر المنشآت؛ مراجعة GRANT على room_assignment/stay_event؛
   و403 لعضو بلا صلاحية و400 لمفتاح idempotency مفقود.
9) F7: تشغيل الاستيراد dry-run من الواجهة/API، إظهار تقرير صف بصف وبلا محتوى خام؛ قائمة
   الاستثناءات بحقول آمنة فقط (لا payload/payload_hash/tenant_id)، وعزل owner-b (404 ولا تسريب)؛
   إعادة معالجة استثناء OPEN فعلياً بلا كتابة جزئية.
10) الفحص العدائي على مسارات P05/P06 بعد إدخال المكتب الأمامي: أي كتابة بلا idempotency/audit،
    أي حدث مضاعف، أي تراكب room_assignment أو plan_allocation، وأي ادعاء AT/قناة حية بلا دليل.

ثم اكتب حكمك في docs/62_phase7_independent_review.md: جدول الأسئلة أعلاه مغلق/غير مغلق،
وقائمة findings بالخطورة ومسارات الأدلة الخام، وبيان الاستقلال (لماذا لا تعتمد أرقام المنفّذ)،
وحدود ما لم تختبره. لا تصلح شيئاً بنفسك؛ إن ظهر finding عالٍ متوقف عند إشعار المستخدم.
توقف وأبلغ فوراً عند: finding عالٍ جديد، أو تعارض بين الوثائق والسلوك، أو حاجة بيانات/شبكة حقيقية.
```
