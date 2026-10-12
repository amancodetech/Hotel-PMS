# تجميد تصميم المرحلة 7 (P07): المكتب الأمامي

التاريخ: 15 سبتمبر 2026. المرجع الحاكم: [docs/59](59_phase7_execution_prompt.md) و[docs/32](32_execution_work_packages.md)
قسم P07، و[docs/26](26_api_events_contracts.md) و[docs/06](06_reservation_stay.md) و[docs/07](07_housekeeping_maintenance.md).
هذا الملف يثبّت الأسماء والعقود لأجل التنفيذ والمراجعة؛ لا يغيّر النموذج المالي ولا يفتح P08.

## 1) مبادئ ثابتة

- الغرفة = `resource` نوعها `ROOM`؛ الجاهزية من `resource.housekeeping_state`
  (CLEAN/DIRTY/INSPECTED) و`maintenance_state` (NONE/OOO/OOS). Dirty أو OOO/OOS أو حجب
  `inventory_block` نشط (PLANNED/EMERGENCY) لأي ليلة ضمن فترة البند يمنع التسليم (P07-06).
- Check-In/Out حدثان تشغيليان؛ لا تسوية ولا ذمة ولا PAN/CVV ولا رد مالي (P08).
- كل كتابة: idempotency إلزامي (نمط P06) + correlation + audit + حدث stay في نفس المعاملة.
- كل طلب كتابة يحمل `version` المتوقع للبند → عدم التطابق `412 STALE_VERSION`.
- حالات البند: توسيع `reservation_item.state` القائم فقط، والحالة الإجمالية للحجز مشتقة كما في P06.
- RoomAssignment كيان مستقل (D-03) بتاريخ ونطاق زمني، لا تراكب لنفس الغرفة.

## 2) المهاجرات والجداول

- `15140000_front_office_core` (P07-01):
  - `room_assignment`: id, tenant_id, property_id, item_id, segment_id (nullable), resource_id,
    start_date, end_date, state (PLANNED/ACTIVE/COMPLETED/CANCELLED), version, assigned_at,
    checked_in_at, checked_out_at, created_at, updated_at؛ FK مركبة (resource, property, tenant)
    و(item, property, tenant) و(segment, property, tenant)؛ GiST يمنع تراكب نفس (tenant,
    property, resource) لفترات `state in ('PLANNED','ACTIVE')` (أُعيد إنشاؤه بالأبعاد الثلاثة في
    مهاجرة `20260915150000_p07_hardening` بلا تغيير سلوك)؛ RLS/FORCE/trigger/منح كما في P06.
  - `reservation_item`: `checked_in_at`, `checked_out_at` timestamptz.
  - `stay_segment`: `state` (PLANNED/IN_HOUSE/CHECKED_OUT/CANCELLED) افتراض PLANNED و`checked_in_at`.
  - `reservation`: `financial_clearance_state` (PENDING/CLEARED/NOT_REQUIRED) افتراض PENDING
    تعبئة دلالية تشغيلية فقط (تُضبط PENDING عند Check-Out؛ لا تسوية).
  - `reservation_guest`: `departed_at` timestamptz للمغادرة الجزئية.
  - صلاحيات: `frontdesk.read`, `assignment.manage`, `stay.checkin`, `stay.move`, `stay.checkout`
    (تُمْنح TENANT_OWNER وTENANT_ADMIN كما في P06؛ تُضاف مفاتيح i18n للصلاحيات في ar/en-US/id-ID).
  - `stay_event` (append-only عام، يُنشأ هنا ويستخدمه P07-01..03):
  `stay_event`: id, tenant_id, property_id, reservation_id, item_id, segment_id nullable,
  type (STAY_CHECKED_IN/STAY_MOVED/STAY_EXTENDED/STAY_SPLIT/STAY_EARLY_DEPARTURE/
  STAY_PARTIAL_DEPARTURE/STAY_CHECKED_OUT), resource_id nullable, payload jsonb, occurred_at,
  unique (tenant_id, property_id, item_id, type, item_version)؛ RLS/FORCE/منح
  (api: select/insert؛ worker: select؛ test: all). الأحداث تُكتب داخل معاملة الحدث التشغيلي
  لتستهلكها P09 (مهمة تجهيز واحدة لكل STAY_CHECKED_OUT إعادة آمنة).

## 3) عمليات العقد `docs/contracts/phase7.openapi.json`

كلها تحت `/tenants/{tenantId}/properties/{propertyId}`؛ TenantId/PropertyId/Csrf/IdempotencyKey
كعقود P06؛ الكتابة POST بحمولة JSON و`200` (النمط القائم) + `default → Error`.

| # | operationId | المسار | الصلاحية | الحزمة |
|---|---|---|---|---|
| 1 | GetFrontDeskBoard | GET `/front-desk/board?date=` | frontdesk.read | P07-01 |
| 2 | AssignRoom | POST `/reservations/{reservationId}/items/{itemId}/assignments` | assignment.manage | P07-01 |
| 3 | CheckInStay | POST `/reservations/{reservationId}/items/{itemId}/check-in` | stay.checkin | P07-01 |
| 4 | MoveStay | POST `/reservations/{reservationId}/items/{itemId}/move` | stay.move | P07-02 |
| 5 | ExtendStay | POST `/reservations/{reservationId}/items/{itemId}/extend` | stay.move | P07-02 |
| 6 | SplitStay | POST `/reservations/{reservationId}/items/{itemId}/split` | stay.move | P07-02 |
| 7 | EarlyDepartureStay | POST `/reservations/{reservationId}/items/{itemId}/early-departure` | stay.move | P07-02 |
| 8 | PartialDepartureStay | POST `/reservations/{reservationId}/items/{itemId}/partial-departure` | stay.checkout | P07-02 |
| 9 | CheckOutStay | POST `/reservations/{reservationId}/items/{itemId}/check-out` | stay.checkout | P07-03 |
| 10 | ListChannelExceptions | GET `/inbox/exceptions` | channel.reprocess | F7 (P07-04) |

قواعد تشغيلية:
- 1: يرجع `{date, timezone, arrivals[], departures[], inHouse[], rooms[]}`؛ `date` الاختياري بتوقيت
  المنشأة (`property.timezone` من Asia/Jakarta/Makassar/Jayapura) والافتراضي اليوم المحلي،
  وكل صف يحمل item/reservation و`version` والالتزام والتخصيص الحالي
  و`housekeeping_state/maintenance_state` للموارد؛ المرشح `eligible=false` بأحد أسباب
  DIRTY/OOO/OOS/BLOCKED/OCCUPIED.
- 2: يقبل `{resource_id, start_date?, end_date?, version}`؛ يرفض غير ROOM أو Dirty/OOO/OOS
  أو محجوباً بـ`inventory_block` نشط (PLANNED/EMERGENCY) أو غير CONFIRMED بـ`INVALID_REQUEST`
  (سبب `BLOCKED` لفحص الحجب)/`INVALID_STATE_TRANSITION`، والتعارض `CONFLICT`.
- 3: يقبل `{resource_id?, version}`؛ يتطلب بنداً CONFIRMED بتاريخ وصول ≤ اليوم المحلي للمنشأة؛
  يرفض Dirty/OOO/Block كما في 2؛ يضبط البند/القطاع IN_HOUSE ويجمّع الحجز؛ يعيد بلا أثر عند replay.
- 4: `{to_resource_id, effective_date, version}`؛ يؤمّن البديل قبل الإغلاق، والتراكب `CONFLICT`؛
  يغلق التخصيص السابق من التاريخ وينشئ الجديد؛ حدث STAY_MOVED.
- 5: `{new_departure, version}`؛ تعارض GiST مع تخصيص/خروج → `CONFLICT` والقديم محفوظ؛ حدث STAY_EXTENDED.
- 6: `{at_date, version}`؛ ينشئ بنداً/قطاعاً متابعاً ويربطه، بلا تراكب قطاعات؛ حدث STAY_SPLIT.
- 7: `{effective_date, version}`؛ يقصّر المغادرة ويعيد تخصيص ما بعدها بأمان (`release` ثم إعادة)؛
  لا يعيد تسعير الماضي؛ حدث STAY_EARLY_DEPARTURE.
- 8: `{guest_ids[], version}`؛ يسجّل `departed_at` لضيوف محددين مع منع تكرار؛ حدث STAY_PARTIAL_DEPARTURE.
- 9: `{version}`؛ يؤكد إغلاق كل القطاعات ثم CHECKED_OUT؛ التخصيص COMPLETED والغرفة DIRTY؛
  `financial_clearance_state='PENDING'`؛ حدث STAY_CHECKED_OUT؛ لا مال.

## 4) الواجهة

- صفحة `apps/web/src/frontdesk/FrontDeskPage.tsx` على `/properties/:id/front-desk` بتبويبات:
  Arrivals / Departures / In-House / Room Rack، بإجراءات السياق (تخصيص/دخول/نقل/تمديد/مغادرة/خروج)
  وتأكيدات ورسائل أخطاء من `ApiError`، RTL و3 لغات.
- F7: تبويب «الاستيراد والاستثناءات» في `ReservationsPage` يستدعي ImportReservations
  وReprocessChannelEvent القائمين، ويعرض تقرير الأخطاء ويعيد المعالجة، بلا محتوى خام.
- زر دخول من `PropertiesPage` إلى المكتب الأمامي كما فُعل للحجوزات.
