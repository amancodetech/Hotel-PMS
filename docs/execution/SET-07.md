# SET-07 — إكمال المكتب الأمامي والتدبير والتقارير لكل قالب

الحزمة والمهمة الفرعية: SET-07 بكامل مهامها 07.1..07.6.
نطاق التفويض ومصدره: توجيه المستخدم «لننتقل الى set 07» (22 سبتمبر 2026). **ملاحظة بوابة:** SET-06 ما زالت `FIXED_LOCAL` بانتظار إعادة قبول مستقل؛ البدء بـSET-07 قرار مستخدم صريح ويُسجَّل، وأي سلوك يعتمد على تغييرات SET-06 المؤرخة يُختبر على النسخة المحلية المصلَحة. لا تغيير لـG-13 ولا قبول إنتاجي، وSET-AT تبقى NOT_TESTED.
الحالة: **VERIFIED_LOCAL — 07.1..07.6 منفذة، و[المراجعة المستقلة](SET-07-independent-review.md) أعطت `NEEDS_FIXES`، وعالجت [حزمة R07](SET-07-fix-report.md) البنود الأربعة، ثم أبطلت [إعادة التحقق المستقلة المختصرة](SET-07-independent-reverification.md) نتائج P0/P1/P2 الأربع وأعادت الانحدارات والبوابات والبصريات خضراء؛ أُغلقت الحزمة محلياً 22 سبتمبر 2026**. الأدلة في قسم «سجل التنفيذ» أدناه.
المراجع الحاكمة: CAP-09/16، CAP-15، D-08، D-14، D-18، D-19/D-20 (لا تغيير)، INV/CMP الحالية، docs/94 §9-10 (SET-07 وSET-AT04/05/07/09/10/11/18)، docs/95:113، P07-01..05، P09-01..03، P11-01..03.

## السلوك المطلوب (07.1..07.6)

| المهمة | السلوك | معيار القبول |
| --- | --- | --- |
| 07.1 لوحة متعددة المكونات | اللوحة تعرض كل وحدات المخزون القابلة للتسكين (ROOM/BED/SITE/TENT/CABIN) بنوعها وأبها، ونوع المنتج المباع، وقائمة قدرات لكل حجز (`assign/check_in/check_out/move/extend/split/early/partial`) مع سبب واضح ومسار معالجة عند عدم الدعم | لا عملية مركبة تُنفَّذ جزئياً بصمت؛ عمود لكل مكوّن؛ SET-AT11 |
| 07.2 دخول/خروج | تعميم `authorizeRoom` على كل الموارد القابلة للتسكين (لا حصر ROOM)، وجاهزية تشمل سلسلة الأب (نظافة/صيانة/حجب)، وتسجيل DIRTY عند الخروج لكل الأنواع، ودورة كاملة (حجز→تسكين→دخول→خروج) لغرفة، فيلا كاملة، جزء، سرير، جناح متصل، موقع/خيمة/كوخ | SET-AT04/05/09/10/11 |
| 07.3 نقل/تمديد/جزئي | تمديد/مغادرة مبكرة يعالجان **كل** إسنادات المجموعة والحصص باتساق؛ نقل/تجزئة مجموعة يُرفضان برمز صريح ومسار معالجة (أو يُنفذان للمجموعة إن أثبت الاختبار الاتساق) | لا اختلاف حصص/إسنادات بعد العملية؛ «أثر النقل/التمديد واضح ومختبر» |
| 07.4 تدبير | تراجع جاهزية الأب/الأبناء في اللوحة والتسكين، وتطبيق حقول سياسة التشغيل القابلة للتطبيق من خطوة المعالج الرابعة (`inspection_required`) بلا اختراع أوقات، وتقرير/عدّادات جاهزية الوحدة المركبة | CAP-09/16، SET-AT10 |
| 07.5 تقارير | تنفيذ `ADR_REVPAR` المعلن، وتقرير حالة التدبير (CLEAN/DIRTY/CLEANING/INSPECTED/OOO/OOS)، وتغطية SET-AT18 لكل قالب بمقامات منفصلة بلا جمع الأب مع مكوناته، وتعريب تسميات المقاييس المعروضة | CAP-15، D-08، D-14 |
| 07.6 سياسة المشاركة | فرض `FEMALE/MALE` لقالب الأسرة: حقل جنس النزيل + تحقق خادمي عند البيع/الإدخال، وإظهاره في المعالج بعد التفعيل | وعد المنتج مفروض لا معلَّق؛ SET-05 (حدود) |

## السلوك الحالي بدليل ملف (جرد 22 سبتمبر 2026)

- اللوحة: `GetFrontDeskBoard` فقط (`apps/api/src/front-office/front-desk.controller.ts:48-63`)، ورف الكتبة يسرد `resource_type='ROOM'` حصراً (`room-assignment-repository.ts:391`)؛ لذلك موارد BED/SITE/TENT/CABIN تختفي من الرف ومن `roomById` فتُفرَّغ `allocated_rooms` للتركيبات المكوَّنة من أسرّة.
- الدخول/الخروج للمجموعات (فيلا كاملة) يعملان ويسجّلان كل الإسنادات (`front-office-service.ts:760-793`، `stay-checkout-service.ts:111-121`)، لكن `authorizeRoom` يرفض أي مورد غير ROOM (`:138`) وتسجيل DIRTY عند الخروج محصور بـROOM (`room-assignment-repository.ts:245`)؛ لا اختبار لمكتب أمامي بأسرّة/مواقع/خيام/أكواخ/جناح.
- الحركة: `findCurrentAssignmentForItem` يعيد إسناداً واحداً ويُستخدم في النقل/التمديد/التجزئة/المغادرة المبكرة (`stay-movement-service.ts:210,424,589,926`)؛ التمديد يعيد بناء كل الحصص لكن يمدد إسناداً واحداً، والتجزئة تنشئ إسناداً واحداً — أي تغيير جزئي صامت لمجموعة.
- واجهة: أزرار النقل/التمديد/التجزئة/المغادرة تُخفى صامتة لصفوف المجموعات (`apps/web/src/frontdesk/FrontDeskPage.tsx:272-297`) والتسميات «الفيلا كاملة» لكل مجموعة (`:219-221,268,938-950`).
- التدبير: حالات النظافة/الصيانة على مستوى المورد، لكن لا تراجع جاهزية الأب، وتطبيق خطوة التشغيل من المعالج يكتفي بكتابة `operations_policy_follow_up` (`setup-service.ts:1000-1008`).
- التقارير: `OCCUPANCY` بمقامات منفصلة لكل `resource_type` بلا جمع أب+أبناء (`reporting-service.ts:152-354`)؛ `ADR_REVPAR` معلن ويرجع 400 (`:984-989`)؛ `listMaintenanceStateCounts` غير مستدعى (`reporting-repository.ts:78-92`)؛ لا تقرير تدبير؛ تسميات المقاييس الخام بلا `metricLabels.*` في اللغات.
- سياسة المشاركة: تُخزن على المنتج لكن `FEMALE/MALE` ترفضها البيع بـ`SHARING_POLICY_NOT_ENFORCED` (`availability-service.ts:121-126`) ويرفضها المعالج (`setup.ts:362-371`)؛ لا حقل جنس للنزيل.

## قرارات داخل النطاق (تُسجَّل للمراجعة)

1. الدمج الآمن: 07.3 يبدأ بمنع التغيير الجزئي الصامت (رفض صريح `GROUP_STAY_OPERATION_UNSUPPORTED` برد 422 + `components` و`treatment`)، ثم يفتح تمديد/مغادرة مبكرة للمجموعات بعد اختبار اتساق الحصص والإسنادات.
2. 07.6 يتطلب هجرة إضافة (`guest.gender` nullable + تحقق)؛ التتبع المعلن يبقى `UNKNOWN` بلا تخمين، والمنتجات المقيدة ترفض النزيل مجهول الجنس fail-closed.
3. لا حارس قاعدة بيانات جديد لمخزون المركبات؛ القواعد الحالية (GiST/الحصص/الاحتواء) تكفي، وأي حاجة جديدة تُثبت باختبار إفشال قبل إضافتها.
4. أي وقت وصول/مغادرة افتراضي غير موجود في المجال لا يُخترع؛ يبقى مؤجلاً موثقاً حتى يوجد مستهلك حقيقي.

## خريطة الأثر

| الطبقة | التغيير |
| --- | --- |
| السلوك | لوحة/تسكين/دخول/خروج/حركة/تدبير لكل قالب؛ تقارير ADR_REVPAR وتدبير |
| المدخلات | DTOs بلا حقول جديدة إلا 07.6 (`gender`)، والقدرات قراءة فقط |
| الهوية | كما هي: tenant/property من السياق وصلاحيات scoped |
| التفويض | نفس صلاحيات `frontdesk.*`/`stay.*`/`task.*`/`report.*`؛ لا توسيع |
| البيانات | لا هجرة في 07.1–07.5؛ 07.6 هجرة `guest.gender` + فهرس اختياري فقط |
| المعاملة | العمليات تبقى داخل `runScopedTransaction` + `lockProperty` |
| التزامن | اختبار مجموعتين على نفس المكوّن؛ لا كسر GiST |
| التكرار | idempotency الموجود يبقى إلزامياً؛ الرفض لا يُخزَّن نجاحاً |
| الإصدار | `version` لكل عنصر/إسناد كما هو |
| التوافق | عقد phase7 يتوسع إضافةً؛ اختبارات اللوحة الحالية تُحدَّث للحقول الجديدة |
| العقود | `phase7.openapi.json` + `phase7.generated.ts`، و`phase11` لتقارير 07.5، وتوليد وفحص |
| الأحداث | لا أحداث جديدة؛ `stay_event`/`audit_event` كما هي |
| القراءة | رف اللوحة يشمل كل الأنواع بفرز ثابت |
| الواجهة | FrontDeskPage/OperationsPage/ReportsPage بحالات رفض واضحة وRTL واللغات الثلاث |
| الترجمة | مفاتيح جديدة للقدرات/الأنواع/التقارير في ar/en-US/id-ID |
| العمليات | تقرير تدبير + عدادات جاهزية مركبة |
| الرصد | كما هو (correlation/audit) |
| التوثيق | هذه البطاقة + السجل + أدلة |

## خطة الاختبار

- 07.1/07.2: تحديث `tests/property/front-office-board.pg.test.mjs` للحقول الجديدة؛ طقم جديد `tests/property/set07-templates.pg.test.mjs` يبني قوالب معالج (ROOM/VILLA/PARTS/DORM/SUITE/SITE/TENT/CABIN) عبر API الإعداد ثم دورة حجز→تسكين→دخول→خروج ويؤكد: ظهور كل مورد بنوعه، جاهزية الأب (أب DIRTY يمنع تسكين السرير)، DIRTY عند الخروج لكل نوع، ورموز القدرات.
- 07.3: سيناريوهات مجموعة: تمديد يمدد كل الإسنادات مع حصص متسقة، مغادرة مبكرة تقصّ الكل، نقل/تجزئة مجموعة → 422 برمز ومسار؛ مقارنة حصص قبل/بعد عبر SQL.
- 07.4: أب DIRTY/CLEANING/OOO/OOS يمنع تسكين الابن؛ تطبيق `inspection_required` من خطوة المعالج يمنع تسليم غير INSPECTED.
- 07.5: `ADR_REVPAR` من اليومية المحاسبية بلا تحويل عملة؛ تقرير تدبير بمقامات `CURRENT_STATE`؛ تغطية قوالب SET-AT18.
- 07.6: هجرة + منع بيع سرير FEMALE لنزيل MALE/UNKNOWN؛ MIXED يبقى يعمل.
- إغلاق الحزمة: مركّز SET، property كامل، distribution، `pnpm check`، البصري phase7/9/11 + بصري SET-01، ثم تحديث السجل.

## خريطة الملفات

- مجال/خدمات: `packages/backend/src/modules/front-office/**`، `operations/**`، `reporting/**`، `property/domain/errors.ts`، `reservations/**` (07.6).
- API: `apps/api/src/front-office/**`، `operations/**`، `reporting/**`.
- عقود: `docs/contracts/phase7.openapi.json`، `phase9.openapi.json`، `phase11.openapi.json`، `packages/contracts/src/*.generated.ts`.
- واجهة: `apps/web/src/frontdesk/FrontDeskPage.tsx`، `operations/OperationsPage.tsx`، `reports/ReportsPage.tsx`، `apps/web/src/api/{frontdesk,operations,reports}.ts`.
- i18n: `packages/i18n/src/locales/{ar,en-US,id-ID}.json`.
- اختبارات: `tests/property/front-office-board.pg.test.mjs`، `stay-*.pg.test.mjs`، `reporting-*.pg.test.mjs`، وطقم SET-07 الجديد.
- بصري: `scripts/phase7-visual.mjs`، `phase9-visual.mjs`، `phase11-visual.mjs`، `set01-visual.mjs`.

## الحدود المعلنة

- «منطقة/منشأة كاملة» تبقى خارج النطاق (تحتاج قراراً، docs/94 §9).
- أوقات الوصول/المغادرة الافتراضية لا تُخترع (قرار 4).
- لا تعديل D-20/UNKNOWN/حدود العملات، ولا قنوات حية، ولا قبول إنتاجي.
- سياسة المشاركة بعد 07.6 تُفرض على مسارات الحجز المباشرة والقنوات المستقبلية على حد سواء عبر الخدمة نفسها.

## سجل التنفيذ

### 07.1 لوحة متعددة المكونات — DONE
- الرف يعرض كل وحدة قابلة للتسكين (ROOM/BED/SITE/TENT/CABIN) بنوعها وبالكود الأب (`parent_code`)، ويستبعد الآباء المركبين: `room-assignment-repository.ts` (`listBoardResources`)، `front-office-service.ts:roomView`.
- كل صف حجز يحمل `product_kind`، `allocation_readiness` لكل مكوّن، و`capabilities` (ثماني عمليات) مع سبب ثابت عند عدم الدعم؛ الأسباب تُعاد `null` عند الدعم.
- سبب مركّب صريح `GROUP_COMPONENT_SELECTION_REQUIRED` بدل الإخفاء الصامت، ومسار معالجة `REBOOK_AFTER_EARLY_DEPARTURE` في رفض API.
- واجهة: تسميات عامة للمجموعة (لا «فيلا كاملة» لغير الفلل)، شريحة نوع لكل وحدة، أزرار معطلة مع سبب وملاحظة معالجة، `allocation_readiness` بدل تخمين الواجهة.
- عقد `phase7.openapi.json`: `BoardRoomRef/BoardRoom/BoardCandidate` (+`resource_type`,`parent_code`)، `BoardStay` (+`product_kind`,`capabilities`,`allocation_readiness`)، `StayCapabilities/StayCapability/AllocationReadiness`، وتصحيح enum النظافة (+`CLEANING`). أُعيد التوليد والفحص.
- i18n: مفاتيح جديدة في ar/en-US/id-ID (`frontDeskGroupComponents`, `frontDeskCheckInGroupAction`, `frontDeskCapability*`, `boardReason.PARENT_*`/`INACTIVE`, `resourceTypeLabel`).

### 07.2 دخول/خروج لكل القوالب — DONE
- `authorizeRoom` صار عاماً لكل مورد نشط غير أب، ويورّث جاهزية الأب (نظافة/تنظيف/فحص/OOO/OOS) بأسباب `PARENT_*` (`listAncestorResources` جديدة في `resource-repository.ts`)؛ الآباء المركبون مرفوضون `RESOURCE_HAS_CHILDREN`.
- تسجيل DIRTY عند الخروج لكل أنواع الموارد (كان ROOM فقط)؛ أحداث الدخول/الخروج/التمديد/المغادرة تحمل `assignment_ids`/`resource_ids` كاملة.
- دورة كاملة مثبتة: غرفة، سرير، خيمة، كوخ، غرفة نوم كاملة (سريران)، فيلا كاملة — مع extend/early/checkout وحصص متسقة.

### 07.3 نقل/تمديد/جزئي — DONE
- التمديد والمغادرة المبكرة يعالجان **كل** الإسنادات الحية للمجموعة (كان إسناداً واحداً فقط مع إعادة بناء كل الحصص = اختلاف صامت).
- نقل/تجزئة مجموعة يُرفضان `422 GROUP_STAY_OPERATION_UNSUPPORTED` مع `operation/components/reason/treatment` وبلا أي كتابة جزئية (مقارنة قبل/بعد).

### 07.4 تدبير — DONE
- تراجع الجاهزية للأب مطبق في التسكين واللوحة (`PARENT_DIRTY`... إلخ).
- خطوة التشغيل في المعالج تطبق `inspection_required` على `property_operations_policy` (insert/update) بعد التطبيق، ويبقى `operations_policy_follow_up` لأوقات الوصول/المغادرة غير المنفذة (بلا اختراع أوقات).

### 07.5 تقارير — DONE
- **ADR_REVPAR** (كان 400 `kind_not_available`): يُبنى الآن في `buildFinancialReport` من الرسوم المنشورة (`folio_charge` حساب `REVENUE_ROOM`) مع مطابقة معلنة مع اليومية (`stay_revenue_journal`/`stay_revenue_charges`/`stay_revenue_delta`/`stay_revenue_reconciled`) وبلا أي تحويل عملة.
- **الإسناد بلا اختراع توزيع**: رسوم `STAY_NIGHT` تُنسب عبر معرّف البند في `source_ref` (`itemId:date`)، وبقية رسوم الغرفة تُنسب عبر بنود حجز الفوليو النشطة التي تغطي تاريخ العمل؛ أي رسم يغطي أكثر من نوع مورد يبقى **غير منسوب** ويظهر في `stay_revenue_unattributed`/`stay_revenue_unattributed_charges` بدل تقسيم صامت.
- **مقامات منفصلة (D-08/SET-AT18)**: `adr.<type>` بمقام `resource_nights_paid.<type>`، و`revpar_physical.<type>`/`revpar_operational.<type>` بمقامات فيزيائية/تشغيلية (OOO مستبعد)؛ لا مفتاح يجمع الأب مع مكوناته، والقسمة على صفر `null` + `DENOMINATOR_ZERO` (بلا صفر مضلل)، والنسبة المالية بست منازل HALF_UP عبر `moneyRatioMetric`.
- **مقاييس التدبير في OCCUPANCY (CURRENT_STATE)**: عدّادات لكل نوع مورد على حدة — `housekeeping_{clean,dirty,cleaning,inspected}.<type>` و`maintenance_{none,ooo,oos}.<type>` و`resources_not_ready_current.<type>` (OOO/OOS + DIRTY/CLEANING) من `listHousekeepingStateCounts` الجديدة و`listMaintenanceStateCounts` التي كانت غير مستدعاة.
- **تعريب التسميات**: `metricLabels.*` (62 أساساً ×3 لغات) و`reportStates.*` (7 حالات ×3) و`ReportsPage.metricLabel()` يترجم المفتاح الدقيق ثم الأساس مع إبقاء اللاحقة (النوع/الطابع) بيانًا معلنًا — لا إخفاء رقم بلا ترجمة (fallback للوسم الخام).
- اختبارات: `reporting-financial` (ADR_REVPAR: إسناد ROOM، غياب مفتاح BED، مطابقة اليومية، DENOMINATOR_ZERO لفترة بلا ليالي مدفوعة، وحظر العضو بلا صلاحية مالية 403) و`reporting-operational` (عدّادات النظافة/الصيانة لكل نوع + `resources_not_ready_current` + عدم دمج الأنواع).

### 07.6 سياسة المشاركة FEMALE/MALE — DONE
- **هجرة**: `Migration20260922110000_guest_gender` تضيف `guest.gender varchar(6)` nullable مع قيد `FEMALE/MALE`؛ الغياب = `UNKNOWN` معلن لا يُخمَّن.
- **حقل النزيل**: `guest-repository`/`guest-service` وواجهة `POST/GET /tenants/:id/guests` تحمل `gender` (اختياري، قيمة غير صالحة → 400)، والسجل يعرضه في تبويب النزلاء مع نموذج الإنشاء، وعقد phase6 (`Guest`/`GuestInput`/`ReservationGuestView`) وُسّع وأُعيد توليده.
- **الفرض الخادمي** (`reservations/domain/sharing-policy.ts`): عند البيع — مسودة الحجز (`createReservationDraft`) وتأكيد الحجز (`confirmReservation`) وتعديل الحجز (`modifyReservation`) — والدخول (`checkInStay`) لكل منتج `FEMALE/MALE`: كل ضيف مرشح (مقيّد بالبند إن وُجد، وغير مغادر) يجب أن يعلن جنساً مطابقاً؛ لا ضيوف → `GUEST_GENDER_REQUIRED` (422، `no_guest_declared`)، جنس مجهول → `GUEST_GENDER_REQUIRED` (`gender_unknown`)، تعارض → `SHARING_POLICY_VIOLATION` (422) مع `scope/guest_id/gender`. `MIXED/null` بلا تغيير.
- **رفع الحجب المؤقت**: أُزيل ردع `SHARING_POLICY_NOT_ENFORCED` من بحث التوفر (البحث بلا ضيوف لا يحكم) وقيد `sharing_scope_not_enforced` من المعالج؛ المعالج يعرض `MIXED/FEMALE/MALE`، وسجل SET-05 وُثّق بالتسليم.
- اختبارات `set07-sharing` (3): إعلان الجنس/الجهل المعلن/رفض قيمة غير صالحة، دورة كاملة لسرير FEMALE (رفض بلا ضيف/مجهول/ذكر، قبول أنثى، ثم رفض الدخول بعد تصحيح الجنس إلى MALE ثم null ثم قبول FEMALE)، وMIXED يبقى يعمل بيعاً ودخولاً.

### R07 حزمة الإصلاح (ردّ على المراجعة المستقلة) — DONE
- **R07-F1 (P0):** الفرض على مسارات المجموعات: `createGroupAllotment` و`pickupGroupAllotment` يستدعيان `assertSharingScopeGuests`، و`importReservations` يرفض أي صف CSV لمنتج `FEMALE/MALE` برمز الصف `GUEST_GENDER_REQUIRED` (الملفان: `group-service.ts`، `import-service.ts`). لا حارس جديد ولا نسخ منطق.
- **R07-F2 (P1):** `ReportsPage.metricLabel` (مُصدَّرة) تُحلّل عائلات المفاتيح المولَّدة: `housekeeping_<state>[.<type>]`/`maintenance_<state>[.<type>]` عبر `housekeepingState|maintenanceState`، و`arrivals|departures_state_<state>` عبر `reportStates|reservationState`، فلا مفتاح خام في اللغات الثلاث.
- **R07-F3 (P2):** `candidateReason` يستقبل سلسلة الأسلاف كاملة (`listAncestorResources` — نفس مصدر `authorizeRoom`) بدل الأب المباشر، فتتطابق اللوحة والتسكين عند عمق ≥2.
- **R07-F4 (P2):** أسبقية أسباب القدرات: الحالة ← شرط الإسناد النشط ← قاعدة المجموعة؛ صف مجموعة `IN_HOUSE` يعرض `ALREADY_IN_HOUSE` في `assign`.
- اختبارات دائمة: `set07-sharing` (+1: استيراد مرفوض، حصة/pickup بـ422 ثم نجاح MIXED)، `set07-templates` (+1 لعمق السلسلة وتحديث أسبقية المجموعات)، و`tests/reports-i18n.test.tsx` (كل مفاتيح التقارير ×3 لغات بلا `RAW:`).

> بصمة النسخة بعد R07: `e4fd418d0893ac96433c45d3f20e5550b6cd1791170fc1d6aea6efa8d4ef0b1a` (أُعيد التحقق منها في جولة إعادة التحقق على الشجرة نفسها بعد إزالة السبرات المؤقتة).

### إعادة التحقق المستقلة المختصرة (بعد R07) — DONE
- سبرات مؤقتة من كتابة جلسة التحقق (أُزيلت بعد التشغيل) على قاعدة معزولة: P0 استيراد/حصة/pickup رُفضت جميعها بـ422 `GUEST_GENDER_REQUIRED` بلا أثر جزئي، وP2-01 اللوحة والتسكين متطابقان `PARENT_DIRTY` عند العمق 2، وP2-02 أسبقية `ALREADY_IN_HOUSE`/`STATE_NOT_IN_HOUSE` قبل سبب المجموعة، وP1 مصفوفة مفاتيح التقارير ×3 لغات بلا `RAW:`.
- الانحدارات: property **421/421 في 55 حزمة**، تركيز SET-07 واللوحة والمجموعات والتقارير **60/60 في 8 حزم**، التوزيع **48/48**، `pnpm check` **103/103 في 15 حزمة**، البصريات phase6 **27/27** وphase7 **35/35** وphase9 **28/28** وphase11 **14/14** وSET-01 **37/37**، وبوابة الملفات `pnpm checksums` + `sha256sum -c` **773/773 OK** (كان `CHECKSUMS.sha256` متأخراً عن SET-05..07 فأُعيد توليده).
- التفاصيل والنتائج الخام والحدود: [تقرير إعادة التحقق](SET-07-independent-reverification.md).

## أدلة SET-07 (منفذ)

| الفحص | النتيجة | الدليل |
| --- | --- | --- |
| طقم SET-07 الجديد | **8/8 ×3** (بعد R07) | `SET-07-templates.log`، `R07-set07.log`، `R07-set07-repeat{1,2}.log` |
| تركيز المكتب الأمامي (4 أطقم) | **37/37 ×3** | `SET-07-repeat{1,2,3}.log` |
| أطقم التقارير الأربعة (بعد 07.5) | **33/33** (منها اختبارا 07.5 الجديدان) | `SET-07-5-reporting.log` |
| طقم SET-07.6 للمشاركة | **4/4 ×3** (مع سيناريو الاستيراد/المجموعة) | `SET-07-6-sharing.log`، `R07-set07.log`، `R07-set07-repeat{1,2}.log` |
| اختبار تعريب التقارير (جديد) | **4/4** (3 لغات + بنية) | `R07-i18n.log` |
| طقم setup-compositions (سياسة المشاركة) | **16/16** | `SET-07-6-setup.log` |
| طقم property كامل | **421/421 في 55 حزمة** | `SET-07-property-full.log`، `R07-property-full.log` |
| طقم التوزيع | **48/48** | `SET-07-distribution.log` |
| `pnpm check` | **103/103 في 15 حزمة** + بناء/عقود/typecheck/lint/format | `SET-07-check.log`، `R07-check.log` |
| بصري phase6 (النزلاء/الجنس) | **27/27** | `SET-07-6-visual6.log`، `R07-visual6.log` |
| بصري phase7 | **35/35** (9 لقطات) | `SET-07-visual7.log`، `R07-visual7.log` |
| البصري phase9 | **28/28** (9 لقطات) | `SET-07-visual9.log`، `R07-visual9.log` |
| البصري phase11 (بعد التعريب) | **14/14** (8 لقطات) | `SET-07-5-visual11.log`، `R07-visual11.log` |
| البصري SET-01 | **37/37** (13 لقطة) | `SET-07-visual-set01.log`، `R07-visual-set01.log` |
| إصلاحات أدوات | locator «Partial departure» في `phase7-visual.mjs` (ISO مقابل تاريخ مُنسّق)، وتحديث انتظارات `phase11-visual.mjs` من مفاتيح خام إلى تسميات معرَّبة | — |

## المتبقي وخطة الاستئناف

- **مغلقة محلياً: لا مهام تنفيذ أو تحقق متبقية (07.1..07.6 + R07 + إعادة التحقق DONE).** أُبطلت نتائج P0/P1/P2 الأربع بإعادة إنتاج مستقلة مختصرة على قاعدة معزولة ([التقرير](SET-07-independent-reverification.md))؛ الحالة `VERIFIED_LOCAL`، والحدود المعلنة في §7 من التقرير تبقى بلا ادعاء تغطية.
- **قيود 07.6 المعلنة:** الربط بالبند (`reservation_guest.item_id`) غير مستخدم بعد في الواجهات، فيُعامَل أي ضيف على مستوى الحجز كمرشح لكل بند مقيّد (تحفّظ fail-closed)؛ وإنشاء واجهة إسناد ضيوف-لبنود لاحقاً يضيّق الفحص دون تغيير الرمز.
- **تذكير بوابة:** SET-06 ما زالت `FIXED_LOCAL` بانتظار إعادة حكم مستقل؛ SET-07 بدأت بتوجيه المستخدم الصريح.
- **ملاحظة قرار 07.5:** الإيراد المؤهل = رسوم `REVENUE_ROOM` المنشورة المنسوبة لنوع مورد واحد فقط؛ لا يُقسَّم رسم مختلط ولا يُحوَّل. أي توسيع لاحق (توزيع إيراد المركّب على مكوناته) يحتاج قراراً موثقاً واختبار SET-AT18 قبل التنفيذ.
