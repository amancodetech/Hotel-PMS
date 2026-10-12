# SET-07 — حزمة الإصلاح R07 (ردّ على المراجعة المستقلة)

- **التاريخ:** 22 سبتمبر 2026.
- **المرجع:** [المراجعة المستقلة لـSET-07](SET-07-independent-review.md) — الحكم `NEEDS_FIXES` (P0 واحد، P1 واحد، P2 اثنان).
- **النطاق:** البنود الأربعة في توصية المراجعة (§6). لا تغيير لعقود SET-06 ولا لـG-13 ولا قبول إنتاجي، وSET-AT تبقى NOT_TESTED، ولم تبدأ SET-08.
- **الحالة:** أدلة منفذ — تنتظر **تحققاً مستقلاً مختصراً** يعيد إنتاج سيناريوهات P0/P1 قبل إغلاق SET-07 أو تحويلها إلى `GO_WITH_NOTES`.

## R07-F1 (P0) — إغلاق تجاوز فرض المشاركة عبر الاستيراد ومجموعات الحجز

**العلة:** `pickupGroupAllotment` كان يؤكد بند المجموعة دون استدعاء `assertSharingScopeGuests`، و`importReservations` ينشئ بنوداً لمنتج مقيد بلا أي ضيوف، فيمكن تأكيد `CONFIRMED` لمنتج `FEMALE` بـ`guest_count=0`.

**الإصلاح (حارس واحد مشترك، لا نسخ منطق):**

- `packages/backend/src/modules/reservations/application/group-service.ts`
  - `createGroupAllotment`: يفرض السياسة على ضيوف الحجز قبل حجز أي حصة (`assertSharingScopeGuests` مع `product.sharing_scope`).
  - `pickupGroupAllotment`: يفرضها مجدداً قبل أي `moveAllocationsToCommitment`، لأن pickup هو لحظة التأكيد.
- `packages/backend/src/modules/reservations/application/import-service.ts`
  - `findProductByCode` يعيد `sharing_scope`، وأي صف CSV لمنتج `FEMALE/MALE` يُرفض (الصفوف لا تحمل ضيوفاً فيستحيل التحقق) برمز الصف `GUEST_GENDER_REQUIRED` بدل `ACCEPTED`.
- النتيجة: مسارات البيع المقيدة الآن fail-closed عند: المسودة، التأكيد، التعديل، الدخول، **+ الاستيراد، إنشاء الحصة، pickup**. `MIXED/null` بلا تغيير.

## R07-F2 (P1) — تعريب عائلتَي مقاييس التدبير والوصول/المغادرة

**العلة:** مفاتيح الخادم `housekeeping_<state>.<type>` و`maintenance_<state>.<type>` و`arrivals_state_<state>`/`departures_state_<state>` لا تطابق أي مفتاح في `metricLabels`، والـfallback في `metricLabel` كان يجرّب الأساس قبل آخر نقطة فقط، فتظهر مفاتيح خام في اللغات الثلاث.

**الإصلاح:** `apps/web/src/reports/ReportsPage.tsx:metricLabel` (صُنِّفت مُصدَّرة للاختبار) تُحلّل الآن العائلات المولَّدة خادمياً:

- `housekeeping_<state>[.<type>]` / `maintenance_<state>[.<type>]` → `metricLabels.housekeeping|maintenance` + `housekeepingState|maintenanceState.<STATE>` + النوع.
- `arrivals|departures_state_<state>` → `metricLabels.arrivals_state|departures_state` + `reportStates|reservationState.<STATE>`.
- الأساس بالنقطة (`adr.ROOM`...) والـfallback الخام للوسم غير المترجم كما كانا.

## R07-F3 (P2) — جاهزية اللوحة تتبع سلسلة الأسلاف كاملة

**العلة:** `candidateReason` كان يفحص الأب المباشر فقط (`parent_*`) بينما `authorizeRoom` يفحص كل الأسلاف، فيُعرض الابن مؤهلاً ويرفضه التسكين `PARENT_DIRTY` عند عمق ≥2.

**الإصلاح:** `front-office-service.ts` يجلب أسلاف كل موارد اللوحة عبر `listAncestorResources` (نفس مصدر التسكين) ويمررها إلى `candidateReason`، فصار الفحص موحّداً على السلسلة كاملة.

## R07-F4 (P2) — أسبقية سبب القدرات

**العلة:** `stayCapabilities` كان يقدّم `GROUP_COMPONENT_SELECTION_REQUIRED` على سبب الحالة/الإسناد لصفوف المجموعات (ورقة داخل المنشأة تعرض سبب المجموعة بدل `ALREADY_IN_HOUSE`).

**الإصلاح:** الأسبقية صارت: سبب الحالة أولاً، ثم شرط الإسناد النشط (`NO_ACTIVE_ASSIGNMENT`)، ثم قاعدة المجموعة؛ و`assign` لصف مجموعة `IN_HOUSE` يعرض الآن `ALREADY_IN_HOUSE`.

## الاختبارات الدائمة المضافة/المحدَّثة

- `tests/property/set07-sharing.pg.test.mjs` (اختبار جديد): رفض صف الاستيراد للمنتج المقيد (`rows_accepted=0`، `error_code=GUEST_GENDER_REQUIRED`)؛ استيراد MIXED يبقى مقبولاً؛ **إنشاء الحصة** لمنتج تغيّر نطاقه إلى `FEMALE` → 422؛ **pickup** → 422 ثم ينجح بعد العودة إلى `MIXED` مع بقاء `guest_count=0`.
- `tests/property/set07-templates.pg.test.mjs`: اختبار عمق السلسلة (جدّ `DIRTY` → ابن `PARENT_DIRTY` في اللوحة ومطابقة رفض التسكين)؛ تحديث أسبقية القدرات (مجموعة `CONFIRMED`: `move/split=STATE_NOT_IN_HOUSE`؛ مجموعة `IN_HOUSE`: `assign=ALREADY_IN_HOUSE` و`move/split=GROUP_COMPONENT_SELECTION_REQUIRED` مع إسناد نشط).
- `tests/reports-i18n.test.tsx` (جديد، يعمل في `pnpm check`): يمرّ على كل مفاتيح OCCUPANCY/ADR_REVPAR/ARRIVALS/DEPARTURES المولَّدة (حالات النظافة/الصيانة × الأنواع، حالات البنود، المفاتيح المالية) في اللغات الثلاث ويرفض أي `RAW:`.

## الأدلة (منفذ)

| الفحص | النتيجة | الدليل |
| --- | --- | --- |
| أطقم SET-07 (القالب + المشاركة) | **12/12** | `R07-set07.log` |
| لوحة المكتب الأمامي | **11/11** | `R07-board.log` |
| مجموعات الحجز (pickup/idempotency) | **4/4** | `R07-groups.log` |
| أطقم التقارير الأربعة | **33/33** | `R07-reporting.log` |
| اختبار تعريب التقارير | **4/4** (3 لغات + بنية) | `R07-i18n.log` |
| `pnpm check` (بناء/عقود/typecheck/lint/format + jest) | **103/103 في 15 حزمة** | `R07-check.log` |
| طقم property كامل | **421/421 في 55 حزمة** | `R07-property-full.log` |
| طقم التوزيع | **48/48** | `R07-distribution.log` |
| البصريات | phase6 **27/27**، phase7 **35/35**، phase9 **28/28**، phase11 **14/14**، SET-01 **37/37** | `R07-visual*.log` |

- بصمة النسخة بعد R07 (نفس أمر البصمة المعتمد): `e4fd418d0893ac96433c45d3f20e5550b6cd1791170fc1d6aea6efa8d4ef0b1a`.

## حدود معلنة بعد الإصلاح

- `createGroupAllotment`/`pickupGroupAllotment` ما زالتا بلا `Idempotency-Key` مطلوب (إعادة pickup تفشل مغلقاً بـ`INVALID_STATE_TRANSITION`) — كما وثّقت المراجعة؛ الإخضاع للمفتاح يحتاج توسيع عقد SET لاحقاً.
- حالة `delta≠0` عند تصحيح يومية بلا رسوم، وعدم خلط `MIXED` بين عملتين بقيت «غير متحققة» كما سجّلت المراجعة، ولا تدّعي R07 تغطيتها.
- لا واجهة لتعديل جنس النزيل بعد الإنشاء (لا `UpdateGuest`) — ثغرة تشغيلية معلنة تحتاج قراراً/حزمة لاحقة.
- الاستيراد يرفض صفوف المنتجات المقيدة كلياً (لا يمكن إعلان الضيوف في CSV)؛ أي استيراد بضيوف يحتاج تصميم أعمدة جديداً وقراراً.
