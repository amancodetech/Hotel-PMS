17 سبتمبر 2026 (P12-04 إصلاح F-RVW12-01..03): مفتاح Idempotency لـ`OnboardPlatformTenant`
أصبح **عالمياً على مستوى المنصة** عبر جدول `platform_onboarding_request` (بصمة SHA-256 لمحتوى
الطلب المطبع + الاستجابة المخزنة، FORCE RLS ومنح API select/insert): نفس المفتاح بالمحتوى نفسه
يعيد النتيجة المخزنة `replayed=true` بلا أثر جديد، والمفتاح نفسه بمحتوى مختلف يرد **409
`IDEMPOTENCY_CONFLICT`** وفق القاعدة العامة أعلاه (سطر 98) بدل إنشاء منشأة/اشتراك ثانٍ؛ والسباق
آمن (قيد فريد + replay/رفض fail-closed، مع اختبارَي تزامن). وتُحصن ثماني دوال security definer
(`platform_create_tenant`، `platform_lifecycle_snapshot`، `platform_set_tenant_status`،
`platform_stop_tenant_sales`، `platform_resume_tenant_sales`، `platform_record_tenant_audit`،
`platform_support_tenant_profile`، `platform_support_tenant_audit`) بربط `p_actor` بسياق
الجلسة `app.platform_user_id` (42501) إضافةً إلى فحص الفاعل النشط؛ لا تغيير في عقد Phase 12
ولا صلاحيات جديدة. دليل القاعدة المجدد: `.local/verification/P12-04/db-evidence.txt`. التفاصيل
[docs/execution/P12-04.md](execution/P12-04.md).

17 سبتمبر 2026 (P12-03): أُضيفت 7 عمليات إلى [عقد Phase 12](contracts/phase12.openapi.json)
(25 إجمالاً، 0.32.0): `ListPlatformTenants` (دليل بحد أدنى من جداول المنصة فقط)،
`ListPlatformAudit` (تدقيق المنصة بحقول آمنة)، `CreatePlatformSupportGrant`/
`RevokePlatformSupportGrant` (`platform.support.manage` + MFA + Idempotency-Key على الإنشاء؛
منع منح الذات `SUPPORT_SELF_GRANT_DENIED`)، `ListPlatformSupportGrants` (`platform.read`)،
و`ReadPlatformSupportTenantProfile`/`ReadPlatformSupportTenantAudit` (`platform.support.read` +
MFA): بلا منحة `SUPPORT_GRANT_REQUIRED`، وبمنحة منتهية `SUPPORT_GRANT_EXPIRED`، وبنطاق ناقص
`SUPPORT_GRANT_SCOPE_DENIED`؛ وكل استخدام يُدقق `platform.support_access`. جلسة
`/auth/session` تُرجع الآن `platform` (الدور والصلاحيات). لا صلاحية منصة تمنح وصول نزلاء ولا
صلاحية منشأة تمنح إدارة اشتراك. التفاصيل [docs/execution/P12-03.md](execution/P12-03.md).

17 سبتمبر 2026 (P12-02): أُضيفت 5 عمليات إلى [عقد Phase 12](contracts/phase12.openapi.json)
(18 إجمالاً): `OnboardPlatformTenant` (POST `/platform/tenants`، `subscription.manage` + CSRF +
Idempotency-Key)، و`SuspendPlatformTenant`/`ReactivatePlatformTenant`/`ClosePlatformTenant`
(POST `.../suspension|reactivation|closure` مع If-Match إلزامي وIdempotency-Key وسبب)، و
`ListPlatformTenantLifecycle` (`platform.read`). التعليق يوقف الزيادات بـStop Sell موثق ويحفظ
الالتزامات/الاتصالات/policies writer؛ إعادة التفعيل تتحقق من الإصدار (`POLICY_VERSION_STALE` حتى
الإقرار) ولا تُحيي استحقاقاً منتهياً؛ الإغلاق لا يحذف بيانات مالية/تدقيق والدورات بعده تفشل مغلقة.
أحداث: `platform.tenant_onboarded/suspended/reactivated/closed`. التفاصيل
[docs/execution/P12-02.md](execution/P12-02.md).

17 سبتمبر 2026 (P12-01): أُضيفت 13 عملية إلى [عقد Phase 12](contracts/phase12.openapi.json)
(0.32.0): `ListPlatformPlans`/`CreatePlatformPlan`/`ListPlanPolicyVersions`/`CreatePlanPolicyVersion`
(`platform.read`/`subscription.manage`)، `ReadPlatformSubscription` (`platform.read`)،
`SetPlatformEntitlement`/`RecordPlatformUsage` (`subscription.manage` + CSRF + Idempotency-Key
على القياس)، `ListPlatformUsage`/`ListPlatformInvoices` (`platform.read`)،
`IssuePlatformInvoice` (`platform.billing.manage` + Idempotency-Key)، `VoidPlatformInvoice`
و`SettlePlatformInvoice` (`platform.billing.manage`؛ التسوية سجل يدوي بمرجع بلا بوابة)،
و`GetTenantSubscription` (`subscription.read` لمنشأة واحدة). الصلاحيات الجديدة:
`subscription.read` (TENANT_OWNER/TENANT_ADMIN/AUDITOR) و`platform.read`/`subscription.manage`/
`platform.billing.manage`/`platform.support.manage`/`platform.support.read` لأدوار المنصة
(`PLATFORM_ADMIN`/`PLATFORM_SUPPORT`)؛ لا صلاحية منصة في أدوار المنشآت ولا العكس، وكل عملية
منصة تُفحص في `PlatformGuard` + Application + القاعدة (RLS عبر `app.platform_user_id`).
MFA إلزامي على `subscription.manage`/`platform.billing.manage`/`platform.support.manage`/
`platform.support.read` (SEC-007). أحداث التدقيق: `platform.plan_created`/
`platform.plan_policy_version_created`/`platform.entitlement_set`/`platform.usage_recorded`/
`platform.invoice_issued`/`platform.invoice_voided`/`platform.invoice_settled` في
`platform_audit_event` مع مرآة `audit_event` للمستأجر. لا كتابة على
`journal`/`business_day`/`folio_charge` من اشتراك المنصة. التفاصيل
[docs/execution/P12-01.md](execution/P12-01.md).

16 سبتمبر 2026 (P11-01..P11-03): أُضيفت 9 عمليات إلى [عقد Phase 11](contracts/phase11.openapi.json): `ReadReport` (POST `/properties/{propertyId}/reports/query`، `report.operational.view` + CSRF؛ والمالي يتطلب `report.financial.view` إضافة داخل الخدمة) بوصف قياس/أساس/بسط/مقام/cutoff/`generated_at`/lag، و`ReadTenantReport` (`POST /tenants/{tenantId}/reports/query`) للمحفظة متعددة المنشآت بعملة واحدة ونطاق مصرح مشتق خادمياً و`property_ids` تضيّق فقط (fail-closed)، و`CaptureReportSnapshot`/`ListReportSnapshots` للقطة Pickup غير القابلة للكتابة فوقها، ثم دورة تصدير CSV خاص قصير العمر: `ExportReport` و`ExportTenantReport` (202، `report.export` مع MFA وCSRF وIdempotency-Key، ينفذها عامل التقارير مرة واحدة)، و`ListReportExports`/`DownloadReportExport`/`RevokeReportExport` (ملكة لعضوية المنشئ، بفحص صلاحية حي عند التنزيل، وTTL=15د، والانتهاء/الإبطال `410` مع مسح المحتوى، وCSV مُنقّى من صيغ الجداول). أحداث التدقيق: `report.snapshot_captured`/`report.export_created`/`report.export_downloaded`/`report.export_revoked`. لا يكفي إخفاء الواجهة: كل عملية تُفحص في API/Application/Jobs مع Tenant/Property/فترة/عملة.

# عقود API والصلاحيات والأحداث

16 سبتمبر 2026 (P10-01..P10-03): أُضيفت 5 عمليات إلى [عقد Phase 10](contracts/phase10.openapi.json): `GetNightAuditOverview` (`folio.read`) بلقطة يوم العمل والتشغيل والخطوات/checkpoints والاستثناءات وسجل التشغيل و`open_blocking`، `ListNightAuditRuns` (`folio.read`)، `StartNightAudit` (`business_day.close` MFA + CSRF + Idempotency-Key، 202) لإدراج تشغيل ينفذه العامل، `RetryNightAudit` لاستئناف الفاشل من أول checkpoint غير مكتمل (والمكتمل يعيد نتيجته المخزنة بـ`replayed`)، و`ResolveNightAuditException` لتعليق استثناء بمسؤول وسبب قابلين للتتبع. `RunNightAudit` (P08) يبقى بنفس operationId في عقد Phase 8 مع استجابة موسّعة متوافقة، ويشغّل الآن سلسلة `OPEN→AUDIT_PREPARING→AUDIT_VALIDATION→CLOSING→CLOSED`؛ `journal_postable_guard` يقبل حالات ما قبل الإغلاق ويرفض `CLOSING` بـ`BUSINESS_DAY_BUSY` و`CLOSED` بـ`BUSINESS_DAY_CLOSED` (D-13). صلاحية العامل: قد يدرج `journal`/`journal_line`/`folio_charge` و`business_day` لأجل الإغلاق ورسوم الليالي عبر `journal-service`، وبلا `update/delete` على أي سجل مالي منشور، مع `update` على `property` لقفل الصف قبل الكتابة.

16 سبتمبر 2026 (P09-03): أُضيفت 5 عمليات إلى [عقد Phase 9](contracts/phase9.openapi.json) (22 إجمالاً): `GetOperationsBoard` (`task.read`) بلقطة الحزم الخمس وDND والإشعارات، `ListShiftHandovers`/`CreateShiftHandover` (`task.read`/`task.manage`) بتسليم وردية يسجل عدّادات المهام/الأوامر/DND ومرجع جلسة صندوق اختياري بلقطة **لا يستبدل دفتر الصندوق**، و`ListNotifications`/`MarkNotificationRead` (`task.read`) لإشعارات داخلية (طارئ صيانة CRITICAL، بانتظار فحص WARNING، تسليم وردية INFO) بإيصالات قراءة لكل عضو ولا تمر إلى أي Adapter خارجي. أُضيف `resource_code` إلى عرض المهمة/أمر العمل ليرى العامل رقم الوحدة بلا هوية الضيف. الواجهة `/properties/:id/operations` والدورة الكاملة في P09-03.

16 سبتمبر 2026 (P09-02): أُضيفت 6 عمليات إلى [عقد Phase 9](contracts/phase9.openapi.json) (17 إجمالاً): `ListWorkOrders`/`CreateWorkOrder` (`maintenance.read`/`maintenance.manage`)، `AssignWorkOrder`، `TransitionWorkOrder`، `CloseWorkOrder`، `ReopenWorkOrder` (`maintenance.manage`). حالة المورد الصيانة تُشتق من الأوامر المفتوحة فقط (`maxImpact`: OOO>OOS>NONE) فإغلاق أمر لا يرفع سبباً آخر (AT-O03)، وإعادة الفتح بسبب موثق لا تتجاوز سبباً أحدث؛ والطارئ (OOO + فترة + `maintenance.emergency` MFA) ينشئ Block طارئاً وDisruption لكل تخصيص متعارض دون محو الحجز، وإغلاق الأمر يحلّ Disruptions بلكه ولا يحرر أي Block (التحرير عبر `ReleaseBlock`). أُعيد grant تحديث `inventory_disruption` لدور API لأنه صار مستخدماً بحلّ Disruptions.

16 سبتمبر 2026 (P09-01): أُضيفت في [عقد Phase 9](contracts/phase9.openapi.json) (11 عملية) `ListTasks`/`CreateTask` (`task.read`/`task.manage`)، `AssignTask` (`task.manage`)، `StartTask`/`CompleteTask` (`task.complete`)، `InspectTask` (`task.inspect`)، `ListDndLogs`/`LogDnd` (`task.read`/`task.manage`)، `FollowUpDnd` (`task.complete`)، و`GetOperationsPolicy`/`SetOperationsPolicy` (`task.read`/`task.manage`). مهمة التجهيز تُستهلك مرة واحدة لكل حدث `STAY_CHECKED_OUT`/`STAY_MOVED` (فهرس فريد جزئي على `source_event_id`) ويرافقها audit `ops.task_created` وتُعاد بأمان عبر `runOperationsIntake`. دورة المهمة PENDING→ASSIGNED→IN_PROGRESS→CLEAN→INSPECTED مع إعادة تعيين آمنة أثناء التنظيف (`CLEANING` بلا جاهزية)، وسياسة منشأة بنسخة (`inspection_required` و`long_stay_clean_interval_days`) تمنع الجاهزية قبل الفحص وتغلق التنظيف اليومي بلا جدول (`LONG_STAY_POLICY_MISSING`/`INTERVAL_NOT_ELAPSED`)، والفحص الذاتي مرفوض `SELF_INSPECTION_DENIED` عند اشتراط الفحص؛ وDND يسجل وقتاً ومحاولة متابعة بلا قلب النظافة. فالكتابة للمخزون (`housekeeping_state`) تمر عبر عقد property فقط. Work Orders وOOO/OOS واللوحات P09-02/P09-03.

إصلاح Phase 8 (15 سبتمبر 2026، [docs/68](68_phase8_fix_session.md)) — بلا تغيير عقد أو عملية: (1) كل كائن `money` يحمل `currency` معلنة في عمليات المالية يُفحص مقابل عملة مستنده (الحساب/الرسم/الدفعة/الوديعة/الفاتورة) ويُرفض الاختلاف بـ`400 INVALID_REQUEST` و`details.reason='currency_mismatch'` و`details.field` مثل `money.currency`/`gross_money.currency`/`commission_money.currency`/`tax_money.currency`/`unit_money.currency`/`allocations[0].money.currency`؛ غياب العملة يبقي الاستنتاج من المستند، ولا تحويل عملة (D-11/D-14). (2) `IssueCreditNote` حركة مالية: تخفض `balance_due` عبر `adjustments_total` (الذمة تقرأ قيود `FOLIO_GUEST` المنشورة) وتعيد CLEARED إلى PENDING بـ`finance.clearance_reopened`، والرصيد الدائن الناتج يمنع الحسم بـ`422 CLEARANCE_CREDIT` حتى استرداد ناجح. (3) `ReverseCharge`/`PostAdjustment` يعيدان CLEARED إلى PENDING مثل بقية الحركات المالية.

تحديث المرحلة 8 (P08-06، 15 سبتمبر 2026): أُضيفت في [عقد Phase 8](contracts/phase8.openapi.json) (35 عملية) `GetReservationClearance` (GET `/reservations/{reservationId}/clearance`، `folio.read`) لعرض الذمة بعد المغادرة (حسابات/فواتير/دفعات/استردادات/تصحيحات وإجماليات لكل عملة بلا FX، ودوريات وباقات الإقامات الطويلة، وربط الحجز الخارجي)، و`SettleClearance` (POST نفس المسار، `folio.charge` + CSRF + Idempotency-Key) الذي يجعل `financial_clearance_state='CLEARED'` فقط بقاعدة `SETTLED` (كل حساب برصيد صفر من قيود فعلية، وإلا `422 CLEARANCE_OUTSTANDING`/`CLEARANCE_CREDIT`) أو `TRANSFER_TO_PAYER` (دافع `COMPANY` مستقل + `collection_plan_ref` موثق، توجيه `AR_GUEST`/`FOLIO_GUEST` بلا إيراد جديد، وفق D-13)، و`ListExternalSettlements` (GET `/external-settlements`، `folio.read`) بفصل gross/net/commission وربط `distribution_external_booking` بلا تحويل عملة. **غادر لا تعني سدد**: أي حركة مالية لاحقة على حساب الحجز تعيد CLEARED إلى PENDING مع audit `finance.clearance_reopened`/`finance.clearance_cleared`؛ وتصحيحات P08-04 تدخل في `adjustments_total` ضمن `balance_due` بلا تعديل الأصل المنشور. أُصلح عيب P08-05 بإضافة `ListCashierSessions` إلى قائمة المنفذ، وأُضيف منح قراءة `distribution_external_booking` لدور API.

تحديث المرحلة 8 (P08-04، 15 سبتمبر 2026): أُضيفت `RequestRefund`/`ResolveRefund` (payment.refund.request) و`ReverseCharge`/`PostAdjustment` (`folio.adjust`) و`RequestFxSnapshotApproval`/`RecordFxSnapshot`/`ListFxSnapshots` في [عقد Phase 8](contracts/phase8.openapi.json) (25 عملية)؛ الاسترداد محجوز ومحسم مرة واحدة باعتماد مستقل (SELF_APPROVAL_DENIED وdecided_by != requested_by)، والعكس الواحد بقيد مرتبط، والـFX لقطة معتمدة بلا قيد تحويل. `ApproveAction` يقبل الآن صلاحيات المالية المذكورة في `decideBody`.

تحديث المرحلة 8 (P08-03، 15 سبتمبر 2026): أُضيفت `RecordPayment`/`ReconcilePayment` (`payment.record`) و`ListPayments`/`GetPayment` (`folio.read`) في [عقد Phase 8](contracts/phase8.openapi.json) (18 عملية)؛ Unknown لا يرحّل قيداً حتى المطابقة الواحدة، والتحصيل لا يتكرر (مصدر/مفتاح)، وتسوية OTA تفصل gross/net/commission (BANK/COMMISSION_EXPENSE/OTA_CLEARING) بلا سطر إيراد جديد، والدفع لا يلمس المخزون أو Hold منتهياً (AT-R06). تحصين بنية الاختبار: API مشترك بقفل في `test:property` واستعارة fail-closed في `startApi`.

تحديث المرحلة 8 (P08-02، 15 سبتمبر 2026): أُضيفت في [عقد Phase 8](contracts/phase8.openapi.json) (14 عملية) `OpenFolio`/`ListFolios`/`GetFolio`/`PostCharge`/`RouteCharge`/`CreateChargeSchedule`/`PostSchedulePeriod`/`CreatePackageEntitlement`/`ConsumePackage`/`CollectDeposit`/`ApplyDeposit`/`ReleaseDeposit` بصلاحيتي `folio.charge` (كتابة) و`folio.read` (قراءة). الرسوم immutable بلقطة ضريبة ومصدر فريد، والتوجيه لا يضاعف الإيراد، والاستحقاق الدوري والباقة لا يتضاعفان (`SOURCE_ALREADY_POSTED`/`duplicate_consumption`)، والوديعة/تأمين الأضرار التزام لا إيراد مع تطبيق/تحرير مبرر؛ رفعت المهلة الداخلية لـ`test:property` من 600s إلى 1800s لأن المجموع الكامل صار 623s.

تحديث المرحلة 8 (P08-01، 15 سبتمبر 2026): أُضيفت `GetBusinessDay` (folio.read) و`RunNightAudit` (business_day.close مع MFA وIdempotency-Key) في [عقد Phase 8](contracts/phase8.openapi.json) (عمليتان)؛ Journal/JournalLine منشوران immutable بقيد قاعدة بيانات (لا update/delete لدور التشغيل) ومتوازنان لكل عملة بـtrigger مؤجل، ويوم العمل واحد نشط لكل منشأة بآلة حالة أمامية وحاجز ترحيل يرفض بـ`BUSINESS_DAY_BUSY/CLOSED/NOT_OPEN`؛ حدثا `finance.business_day_closed` و`finance.journal_posted`. `RunNightAudit` نُفذ متزامناً ويعيد 200 (بدل 202/If-Match في v1 المخطط) لأن الإغلاق ذري ضمن المعاملة؛ لا Night Audit كامل (P10) ولا Folio/Payments (P08-02..05).

تحديث المرحلة 5 (14 سبتمبر 2026): العمليات المنفذة فعلياً للأسعار والتوفر والالتزام والحصص موثقة حصراً في [عقد Phase 5](contracts/phase5.openapi.json): ListRatePlans/CreateRatePlan/UpdateRatePlan/SetRates/GetRateCalendar، SearchAvailability/QuoteStay/CreateHold/ListHolds/ReleaseHold، CreateBlock/ListBlocks/ReleaseBlock/SetResourceMaintenance، PreviewExposure/PublishExposure/WithdrawExposure/ListExposures/SetDistributionSaleStatus/GetSyncStatus/ReconcileConnection، مع `internal_rate_ref` الفعلي في SaveMapping. الضمان بPostgreSQL (قيدا استبعاد وقفل Property) والمحاكي/Outbox محلياً فقط؛ لا قناة حية ولا ConfirmReservation (P06).

تحديث المرحلة 4 (14 سبتمبر 2026): العمليات المنفذة فعلياً للمنشآت والموارد والمنتجات والمجموعات والتركيبات ومسودات القنوات موثقة حصراً في [عقد Phase 4](contracts/phase4.openapi.json) (36 عملية) وبصلاحيات `property.read`/`property.manage`/`property.resource.manage`/`composition.manage`/`channel.read`/`channel.connection.manage`/`channel.mapping.manage`؛ إدارة المنشآت والتركيبات والاتصالات تتطلب MFA وفق SEC-007. مسودات الاتصال لا تُفعَّل ولا تُكشف `secret_ref` ولا تُقبل `internal_rate_ref` حتى P05-01، وبقية عمليات V1 المخططة تبقى غير منفذة.

تحديث المرحلة 3 (13 سبتمبر 2026): العمليات المنفذة فعلياً للهوية والعضوية والأدوار والمنح والدعوات والاعتمادات والتدقيق موثقة حصراً في [عقد Phase 3](contracts/phase3.openapi.json) (30 عملية). الجلسة خادمية وcookie آمن و`x-csrf-token` إلزامي للعمليات المغيرة، وMFA يُفرض في Application على الصلاحيات الحساسة. عمليات V1 المخططة الأخرى تبقى غير منفذة في هذا العقد.

تحديث المرحلة 1: المسارات المنفذة حصراً موثقة في [عقد الصحة](contracts/foundation.openapi.json): liveness/readiness لـAPI وWorker. تبقى عمليات V1 الثلاث والأربعون في هذا الملف وعقده مخططة وغير منفذة؛ توليد أنواع TypeScript لا ينشئ endpoints عاملة أو موافقة صلاحيات.

حالة: عقد V1 قبل التنفيذ. [OpenAPI](contracts/v1.openapi.json) يحدد المسارات والحقول الأساسية القابلة للفحص آلياً؛ هذا الملف يحدد الثوابت العابرة للحقول والمعاملات وعقود المزود. مواصفات الشاشة والخدمة لا تعني أن endpoint يعمل حالياً.

14 سبتمبر 2026 (P06-01): أُضيفت عمليات قراءة الحجوزات والمسودة `ListReservations`/`GetReservation`/`CreateReservationDraft` وصلاحيتا `guest.read`/`guest.manage` وعمليات النزلاء `ListGuests`/`GetGuest`/`CreateGuest` في `docs/contracts/phase6.openapi.json`؛ لا تأكيد/تعديل/إلغاء بعد (P06-02) ولا مستندات نزلاء في أي استجابة.

14 سبتمبر 2026 (P06-03): أُضيفت `CreateGroupAllotment`/`PickupGroupAllotment`/`SplitReservationItem`/`MarkItemNoShow` في phase6.openapi.json (reservation.modify/cancel)؛ Pickup ينقل التخصيصات ولا يكررها وNo-show يرفض المقيم.

14 سبتمبر 2026 (P06-04): أُضيفت `ReprocessChannelEvent` (channel.reprocess) مع مستهلك revision محلي يحفظ EXTERNAL_CONFLICT كاستثناء دائم قبل أي ACK، ويطبق new/modified/cancelled على الحجز والالتزامات في معاملة واحدة.

15 سبتمبر 2026 (P07-01): أُضيفت `GetFrontDeskBoard`/`AssignRoom`/`CheckInStay` في `docs/contracts/phase7.openapi.json` بصلاحيات `frontdesk.read`/`assignment.manage`/`stay.checkin`؛ Check-In حدث تشغيلي واحد (stay_event) بلا تكرار وGiST يمنع تراكب الغرفة؛ النقل/التمديد/Split/المغادرة/Check-Out تبقى P07-02/P07-03.

15 سبتمبر 2026 (P07-02): أُضيفت `MoveStay`/`ExtendStay`/`SplitStay`/`EarlyDepartureStay` بصلاحية `stay.move` و`PartialDepartureStay` بصلاحية `stay.checkout` في `docs/contracts/phase7.openapi.json` (8 عمليات)؛ كل عملية معاملة واحدة ونسخة بند متزايدة وحدث `stay_event` واحد (STAY_MOVED/STAY_EXTENDED/STAY_SPLIT/STAY_EARLY_DEPARTURE/STAY_PARTIAL_DEPARTURE) وAudit؛ النقل يؤمّن البديل قبل إغلاق القديم، والتمديد يعيد إنشاء تخصيصات P06 تحت الالتزام نفسه بلا ازدواج، وSplit يقسم التخصيصات والقطاعات دون تراكب أو فقد مخزون، والمغادرة الجزئية تسجل `departed_at` مرة واحدة لكل ضيف. Check-Out يبقى P07-03.

15 سبتمبر 2026 (P07-03): أُضيفت `CheckOutStay` بصلاحية `stay.checkout` في `docs/contracts/phase7.openapi.json` (9 عمليات)؛ معاملة واحدة تغلق قطاعات IN_HOUSE إلى CHECKED_OUT وPLANNED إلى CANCELLED، وتحول البند CHECKED_OUT مع `checked_out_at` ونسخة +1، والتخصيص الجاري (PLANNED/ACTIVE) COMPLETED، و`reservation.financial_clearance_state='PENDING'` (علامة تشغيلية فقط)، والغرفة `housekeeping_state='DIRTY'` مع حفظ `maintenance_state`، وتجمّع الحجز CHECKED_OUT/PARTIALLY_CHECKED_OUT (لا COMPLETED)، وتكتب حدث `STAY_CHECKED_OUT` واحداً يحمل resource_id/item_id/segment_ids/departure قابل لإعادة آمنة بقيد unique لاستهلاك P09-01، مع Audit `stay.checked_out` وcorrelation؛ لا تسوية ولا ذمة ولا PAN/CVV ولا لمس price snapshot؛ بلا مهاجرة جديدة. الواجهة وF7 تبقى خارج هذه الحزمة.

15 سبتمبر 2026 (P07-04): واجهة المكتب الأمامي `/properties/:id/front-desk` (Arrivals/Departures/In-House/Room Rack بأزرار تخصيص/دخول/نقل/تمديد/Split/مغادرة/خروج وتأكيدات) وF7 في `ReservationsPage` (استيراد CSV dry-run/apply بتقرير صف بصف + استثناءات المستهلك وإعادة المعالجة). أُضيفت قراءة `ListChannelExceptions` GET `/inbox/exceptions` بصلاحية `channel.reprocess` في `docs/contracts/phase7.openapi.json` (10 عمليات) باستعلام محصور بالمنشأة وإرجاع حقول آمنة فقط بلا حمولة خام؛ لم تُضف مهاجرة ولم يُلمس phase6.

15 سبتمبر 2026 (P07-06 إصلاح F-RVW7-01..04): `GetFrontDeskBoard` يقبل `date` اختيارياً ويعيد `{date, timezone}` حيث `date` هو اليوم المحلي للمنشأة (`property.timezone`) والافتراضي اليوم المحلي؛ التخصيص وCheck-In يفحصان `inventory_block` النشط (PLANNED/EMERGENCY) لأي ليلة ضمن فترة البند/التخصيص فيردان 400 `INVALID_REQUEST` بسبب `BLOCKED` واللوحة تعرض `eligible=false reason=BLOCKED`؛ إلغاء البند مباشرة (P06) أو عبر revision القناة أو No-show يغلق تخصيصات `room_assignment` الحية PLANNED→CANCELLED في المعاملة نفسها بلا مساس بالالتزام/المخزون؛ مفتاح idempotency أصبح مقيّداً بالمنشأة للعمليات ذات المنشأة (قيد `(tenant, operation, key, property_id)` بـNULLS NOT DISTINCT في مهاجرة `20260915150000_p07_hardening` مع إعادة إنشاء GiST بثلاثة أبعاد)، فإعادة استخدام مفتاح عبر منشأتين تنشئ سجلاً مستقلاً ولا ترجع استجابة منشأة أخرى. لا تغيير في النموذج المالي ولا جاهزية إنتاج.

14 سبتمبر 2026 (P06-05): أُضيفت `ImportReservations` (reservation.create) لاستيراد CSV محدود بوضع dry-run/apply، بتقرير صف بصف وبصمة ملف تمنع الأثر المزدوج، ودون استهلاك مخزون في الاستيراد.

## قواعد النقل والتفويض

REST /api/v1؛ نطاق كل عملية تشغيلية /tenants/{tenantId}/properties/{propertyId}. هوية الجلسة من Keycloak عبر API وجلسة خادمية؛ لا تثق بالنطاق في المسار حتى membership والتفويض. Cookie آمن وCSRF لكل فعل مغير. Service credential للوارد منفصل ومحدود المزود، لا Cookie الموظف.

الأوامر تحمل Idempotency-Key، وأوامر التعديل If-Match لنسخة المورد. create لا يحتاج If-Match على مورد لم يوجد لكنه يتحقق من inventory_version/preview_version إن كان القرار معتمداً عليه. إعادة نفس الطلب تعيد نفس النتيجة بعد التحقق الحالي من الصلاحية؛ لا تكشف response مخزنة لمستخدم فقد العضوية. العمل الجاري لنفس المفتاح يعيد 409 OPERATION_IN_PROGRESS مع Retry-After. version مختلفة تعيد 412 STALE_VERSION، ومفتاح بمحتوى مختلف 409 IDEMPOTENCY_CONFLICT.

مبالغ Money حقول amount كنص decimal وcurrency IDR/USD؛ تواريخ إقامة YYYY-MM-DD ولحظات UTC date-time، ومعرفات UUID داخلية وStrings خارجية. date_to/ departure غير شاملين داخل النظام؛ Adapter يرسل خلايا تاريخ مفردة أولاً لتجنب غموض نهاية نطاق المزود قبل اختباره. timestamps لا تحدد ترتيب revision إن لم يعط المزود تسلسلاً موثوقاً.

الخطأ: code ثابت، message قابل للتوطين، correlation_id، details محدودة بلا PII. 400 بنية غير صالحة، 401 جلسة، 403 صلاحية إجراء، 404 مورد خارج النطاق أو غير موجود، 409 تعارض مجال، 412 نسخة قديمة، 422 شروط أو قدرة أو حد، 429 معدل، 503 تعذر حسم/اعتماد غير متاح. لا إرجاع successful reservation مع status=UNDETERMINED.

## كتالوج العمليات

كل صف هو operationId في OpenAPI، والصلاحية نفسها داخل API وApplication وJobs عند الحاجة. بيانات sensitive تتطلب صلاحية إضافية عند عرضها.

| العملية | الصلاحية | نتيجة وشروط مجال إضافية |
|---|---|---|
| ListResources / CreateResource | property.read / property.resource.manage | code محلي فريد؛ لا مالك من Tenant آخر |
| CreateComposition / ActivateComposition | composition.manage | لا دورة/ورقة مكررة/علاقة عبر منشآت، افحص الالتزامات المستقبلية |
| SetRates | rate.manage | batch ذري داخل Property؛ المبلغ والضرائب والوجبة والعملة واضحة |
| SearchAvailability | reservation.read | نتيجة آنية بلا ضمان، لا معرفات خطط الغير |
| CreateHold / ConfirmReservation | reservation.create | claims ثابتة وHold مهلة أو حجز مؤكد؛ لا تجاوز Exposure نشطة |
| GetReservation / ListReservations | reservation.read | النزيل والمال محجوبان دون guest.read وfolio.read |
| ModifyReservation / CancelItem | reservation.modify / reservation.cancel | للحجز المباشر؛ OTA يتطلب RequestExternalChange ولا تحرير قبل تأكيد |
| RequestExternalChange | reservation.external_change.request | PendingExternal، رابط قناة، لا ادعاء إرسال عند عدم دعم القدرة |
| AssignResources / MoveStay | assignment.manage / stay.move | مطابقة PlanAllocation؛ تأمين الجديد وحفظ السابق عند الفشل |
| CheckIn / CheckOut | stay.checkin / stay.checkout | جاهزية وتخصيص ونسخة؛ الرصيد يعالج بذمة أو يمنع الإتمام المالي |
| CreateBlock / ReleaseBlock | inventory.block | سبب وفترة؛ emergency يتطلب maintenance.emergency ويعالج التعارض |
| CreateConnection / ActivateConnection | channel.connection.manage | secret_ref لا secret، تفويض حساب وcapability evidence واختبارات |
| SaveMapping | channel.mapping.manage | مراجع خارجية موثقة وفحص الدلالة وليس الاسم فقط |
| PreviewExposure / PublishExposure / WithdrawExposure | channel.sale.manage | معاينة ثم تثبيت موارد D-20؛ السحب لا يحرر الحصة حتى تحقق |
| SetDistributionSaleStatus | channel.sale.manage | Stop Sell جديد أو Open يحدد restriction_id؛ effective state مشتقة |
| GetSyncStatus / ReconcileConnection | channel.read / channel.reconcile | يفصل queued/provider accepted/channel verified/unknown |
| ReprocessChannelEvent | channel.reprocess | نفس revision ونتيجة أصلية أو استثناء موثق؛ لا نسخة حدث جديدة |
| ListChannelExceptions | channel.reprocess | قراءة فقط للاستثناءات OPEN/IN_PROGRESS في منشأة واحدة بحقول آمنة؛ لا حمولة خام ولا عبور منشأة |
| CreateTask / CompleteTask | task.manage / task.complete | حدود المنشأة والمسؤول؛ العامل لا يقرأ ملف هوية الضيف |
| PostCharge / RecordPayment / RequestRefund | folio.charge / payment.record / payment.refund.request | ترحيل في يوم مفتوح؛ إثبات الدفع وapproval_ref للاسترداد إذا تطلبت السياسة |
| ApproveAction | approval.approve | approver مختلف، نفس hash/نسخة/عملة/حد، صلاحية على الإجراء ذاته |
| RunNightAudit | business_day.close | step idempotency وحاجز CLOSING وفترة صحيحة |
| ReadReport / ExportReport | report.operational.view / report.export | التقرير المالي يتطلب report.financial.view؛ export خاص محدود العمر |
| CreateRole / GrantRole / RevokeMembership | role.manage / role.grant / membership.revoke | لا grants أعلى من ما يحق تفويضه؛ إبطال authz_version |
| GetEffectivePermissions | membership.read | المستخدم يرى صلاحياته؛ عرض صلاحيات غيره يتطلب role.manage |
| SetEntitlement | subscription.manage | مسؤول SaaS؛ لا يمنح وصول نزلاء؛ تعليق لا يوقف استقبال حجوزات اتصالات ما زالت تبيع |

الأسماء السابقة channel.manage/payment.create/refund/folio.adjust وreport.* ليست wildcard؛ تترجم لقوالب legacy محددة فقط. إذن تعديل مالي لا يتيح حذف Journal. المصادقة وحدها لا تكفي لأي عملية.

GrantRole يحدد scope_type صراحة: PROPERTIES بقائمة غير فارغة أو TENANT بقائمة فارغة ومنح مؤسسي مصرح. القائمة الفارغة وحدها لا تعني كل المنشآت، ولا تجمع نطاقات أدوار منفصلة. NonNegativeMoney للأسعار يسمح بالصفر عند سياسة مجانية مصرح بها؛ مبالغ التحصيل والاسترداد PositiveMoney أكبر من صفر، ولا يسمح إرسال سعر صفري إلى قناة لا تدعمه.

## أحداث المجال

Envelope ثابت: event_id، event_type، schema_version=1، tenant_id، property_id عند الحد التشغيلي، aggregate_type/id/version، occurred_at، recorded_at، correlation_id، causation_id، payload محدود بالمراجع. لا أسرار أو مستندات أو أسماء نزلاء عامة في payload. المستهلك يثبت (consumer,event_id) داخل معاملة أثره.

| الحدث | Payload مفاهيمي مطلوب | المستهلك وأثره |
|---|---|---|
| ReservationConfirmed/Modified/Cancelled | reservation_id، item_ids، inventory_version، source_revision_id? | Distribution يعيد الاشتقاق؛ Operations مهام فقط |
| InventoryCommitted/Released/Blocked | commitment_or_block_id، affected_product_ids، interval، inventory_version | تحديث read models وOutbox، لا خصم ثانٍ |
| ExposureReserved/Withdrawn/Released | exposure_id، allocation_version، connection_id، period | Dispatcher وReconciliation؛ لا تحرير من ACK نقل فقط |
| DistributionSyncRequested | connection_id، inventory_version، cell_set_ref | Worker يسحب آخر snapshot، لا ينشر نسخة قديمة |
| ChannelRevisionStored/Resolved | inbox_id، resolution_state، reservation_id?، exception_id? | ACK أو معالجة قابلة للاستئناف |
| ChannelExternalBookingAdopted (تدقيق، P13) | reservation_id، connection_id، external_booking_id، revision_id | ربط حجز مستورد بلا ازدواج عند Cutover؛ لا ينشئ التزاماً ولا يستهلك مخزوناً |
| StayCheckedIn/Moved/Extended/Split/EarlyDeparture/PartialDeparture/CheckedOut | item_id، assignment_ids، business_date | مهام تجهيز وقراءة إشغال؛ لا محو التاريخ |
| ChargePosted/PaymentResolved/RefundResolved | financial_entry_id، currency، amount، business_date | تقارير ومطابقة مرة واحدة |
| BusinessDayClosed | date، close_run_id، journal_cutoff | تقارير لقطة متسقة |
| RoleGrantChanged/MembershipRevoked | membership_id، authz_version | إبطال الكاش والجلسة؛ التحقق المركزي لا ينتظر وصول invalidation |

events المالية تحفظ مرجع posting وليس أمراً يعيد تحصيله. حدث إلغاء الحجز لا يأمر البنك برد المال تلقائياً. Events المراسلات السابقة تبقى للمرحلة 14.

## Adapter Channex

Contract مستقل: pullRevisions(cursor)، acknowledgeRevision(id)، pushAvailability(cells)، pushRestrictions(cells)، readProviderState(scope)، readChannelEvidence(scope)، inspectMappings، inspectCapabilities. كل نتيجة تحمل provider_request_id وحالة certainty والأخطاء على مستوى الخلية. لا method cancelOtaReservation عامة قبل دليل دعمها.

المسارات التي ثبتت بالمصدر: GET /booking_revisions/feed وPOST /booking_revisions/{id}/ack، POST /availability وPOST /restrictions لدى مزود الاتصال؛ ليست endpoints في API الخاص بنا. Adapter يربط property_id الخارجي بسجل Connection من إعداد موثوق، لا يقبل tenant_id من payload. مرجع المصدر ودلالته في docs/22_connectivity_evidence.md.

Webhook العام يعامل كتنبيه فقط في V1: تحقق إعداد authentication الموثق ثم جدولة سحب Feed بمفتاح الخدمة المملوك. لا يؤكد حجزاً اعتماداً على رسالة غير موثوقة. إذا توقيع الحدث غير متاح، احصره في signal محدود المعدل لا يحمل authority؛ البيانات المرجعية تجلب عبر API المصادق. لا endpoint عام يعيد تمرير URL من webhook إلى شبكة داخلية.

الحقل غير الموجود UNKNOWN لا صفر، والوجبات والعمولة وصافي التحويل لا تستنتج من إجمالي الحجز. تغير عدد غرف OTA دون room identity موثوق يستلزم مطابقة بنود صريحة؛ لا تستخدم ترتيب array كهوية دائمة. القراءة من مزود آخر بعد migration تمر بـExternalBookingLink حتى لا تنشئ حجزاً مكرراً. في Cutover (P13): revision لمفتاح خارجي يقابل حجزاً مستورداً غير مرتبط **وحيداً** يتبنّاه ذرياً (تدقيق `channel.external_booking_adopted`) بدل إنشاء حجز ثانٍ؛ وتعدد المرشحين يفشل مغلقاً بكود `EXTERNAL_KEY_AMBIGUOUS` للمراجعة البشرية.

## فحص العقد

قيود إضافية: PublishExposure يتطلب معاينة allowed=true غير منتهية مع preview_version وinventory_version مطابقين للحالة الحالية ونفس نطاق الطلب؛ الموافقة تبطل عند تغيرها. CompositionInput يقبل أوراقاً أو تراكيب فرعية أو كليهما، بشرط ورقة نهائية واحدة على الأقل بعد التسطيح وعدم تجاوز الحدود. PositiveMoney أكبر من صفر؛ دقة الترحيل المحددة في D-14 تتحقق في المجال. MODIFY_DATES يتطلب requested_period. ReservationItemView تعيد هوية البند ونسخته؛ product_id قد يغيب للحجز الخارجي غير المربوط، ولا يفرض حد الطلب الداخلي على حجوزات خارجية محفوظة للاستثناء.

AT-A01: نفس مفتاح ومحتوى مختلف يرفض؛ نفس مفتاح بعد فقد العضوية لا يكشف response. AT-A02: رقم عملة بصيغة floating أو currency غير مدعومة يرفض. AT-A03: Open مع صيانة يعيد effective_open=false وسبباً، لا overwrite للتوفر. AT-A04: طلب OTA cancel لا يحرر الحجز قبل revision موثوقة. AT-A05: أية عملية إدارية خارج Property ترفض في Application ولو استدعيت من Job. AT-A06: الاستجابة 200 ذات warning تنشئ حالة partial ولا تؤشر قناة verified.
