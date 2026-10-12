نعم. هذا هو الملخص الكامل للمشروع وما تم الاتفاق عليه حتى الآن، ثم في النهاية سأضع لك **برومبت جاهز** تنسخه في نافذة جديدة وتبدأ منه مباشرة.

## الملخص الكامل للمشروع

اسم المشروع المؤقت:

**HOTEL PMS SAAS**

والهدف هو بناء **نظام إدارة فنادق احترافي من نوع PMS — Property Management System** يعمل كمنتج SaaS تجاري حقيقي، وليس كنموذج أولي أو مشروع بسيط.

النظام يجب أن يعمل على خادم مركزي، ويخدم أكثر من عميل وأكثر من فندق، مع عزل كامل وصارم للبيانات بين العملاء والفنادق.

### الفكرة الأساسية للمنتج

النظام يجب أن يجمع في منصة واحدة:

- إدارة العملاء في SaaS.
- إدارة مجموعات الفنادق.
- إدارة الفنادق والمنشآت.
- إدارة المستخدمين والصلاحيات.
- إدارة النزلاء.
- إدارة الحجوزات.
- المكتب الأمامي.
- تسجيل الدخول والخروج.
- إدارة الغرف.
- أنواع الغرف.
- الأسعار وخطط الأسعار.
- التوفر والمخزون.
- التدبير الفندقي.
- الصيانة.
- الملفات المالية.
- الرسوم.
- الضرائب.
- المدفوعات.
- الاستردادات.
- الفواتير.
- الصندوق.
- التدقيق الليلي.
- التقارير.
- السجلات التدقيقية.
- الاشتراكات وخطط SaaS.
- Feature Flags.
- الإشعارات.
- التكاملات.
- مدير قنوات الحجز والتوزيع.
- محرك الحجز المباشر مستقبلاً.

---

# 1. القرار المعماري الأساسي

تم الاتفاق على عدم البدء بـ Microservices من البداية.

البنية المقترحة:

**Modular Monolith**

مع حدود واضحة جداً بين الـ Modules.

السبب أن العمليات الأساسية في الفندق مترابطة بقوة، مثل:

**Reservation → Room Assignment → Check-In → Folio → Payment → Check-Out → Night Audit**

وبناء هذه الوظائف كخدمات منفصلة من البداية سيضيف تعقيداً كبيراً في:

- Distributed Transactions
- Eventual Consistency
- Network Failures
- Debugging
- Authorization

لذلك يبدأ النظام كتطبيق واحد منظم داخلياً إلى Modules مستقلة، ويمكن لاحقاً فصل Reporting وWorkers وIntegrations حسب الحاجة.

---

# 2. التكنولوجيا المعمارية الأساسية

تم اعتماد التوجه التالي:

**PostgreSQL** كقاعدة بيانات رئيسية.

**Redis** لـ:

- Cache
- Rate Limiting
- Coordination
- Session-related state عند الحاجة.

**Queue + Background Workers** لـ:

- الإشعارات.
- المزامنة.
- التقارير.
- التصدير.
- التكاملات.
- عمليات Retry.

**Private Object Storage** لـ:

- الفواتير.
- ملفات الضيوف.
- التقارير.
- التصديرات.
- المستندات.

والمنصة تحتوي أيضاً على:

- Reverse Proxy
- TLS
- Monitoring
- Logs
- Metrics
- Tracing
- Health Checks
- Backup
- CI/CD

---

# 3. Multi-Tenant SaaS Architecture

تم التفريق بوضوح بين:

**Platform**

المنصة نفسها.

**Tenant**

العميل التجاري والأمني.

**Hotel Group**

مجموعة فنادق داخل Tenant.

**Property**

الفندق أو المنشأة الفعلية.

**Department**

مثل:

- Front Office
- Housekeeping
- Finance
- Maintenance

**User**

المستخدم.

والتسلسل المقترح:

```text
Platform
   ↓
Tenant
   ↓
Hotel Group
   ↓
Property
   ↓
Departments / Rooms / Users
```

Tenant هو:

**Security + Commercial Boundary**

أما Property فهي:

**Operational Boundary**

---

# 4. استراتيجية عزل العملاء

تم اختيار:

**Shared Database + Shared Schema + tenant\_id + PostgreSQL Row-Level Security**

مع إمكانية تقديم:

**Dedicated Database**

للعملاء الكبار مستقبلاً.

لكن العزل لن يعتمد فقط على `tenant_id`.

بل سيتم تطبيق Defense-in-Depth:

```text
Authentication
↓
Tenant Membership
↓
Property Access
↓
Permissions
↓
Resource Authorization
↓
Application Tenant Context
↓
Database RLS
↓
Cache Isolation
↓
File Isolation
↓
Background Job Isolation
↓
Reporting Isolation
```

قاعدة مهمة:

**لا يجوز الاعتماد على Frontend لحماية Tenant Data.**

وكذلك لا يعتبر `tenant_id` القادم من العميل حقيقة موثوقة.

---

# 5. دورة تشغيل الفندق

تم تحليل الدورة الأساسية:

```text
Inquiry
↓
Tentative Reservation
↓
Confirmed Reservation
↓
Pre-Arrival
↓
Room Assignment
↓
Arrival
↓
Check-In
↓
In-House
↓
Charges
↓
Payments
↓
Room Change / Extension
↓
Check-Out
↓
Folio Settlement
↓
Invoice
↓
Room Dirty
↓
Housekeeping
↓
Clean
↓
Inspected
↓
Sellable Again
```

مع التعامل أيضاً مع:

- Cancellation
- No-Show
- Early Check-In
- Late Check-Out
- Early Check-Out
- Extension
- Room Change
- Split Stay
- Multi-Room Reservation
- Group Reservation
- Walk-In

---

# 6. Reservation Domain

تم الاتفاق على عدم ربط الحجز مباشرة بالغرفة كحقل بسيط.

بل الفصل بين:

**Reservation**

و:

**Room Assignment**

لأن الحجز قد ينشأ بدون غرفة محددة.

كما يمكن أن تتغير الغرفة أثناء الإقامة.

وتم اقتراح:

**StaySegment**

لدعم:

- تغيير الغرفة.
- تغيير السعر.
- Split Stay.
- أجزاء مختلفة من الإقامة.

حالات الحجز المقترحة:

```text
Inquiry
↓
Tentative
↓
Confirmed
↓
Checked-In
↓
In-House
↓
Checked-Out
↓
Completed
```

ومسارات جانبية:

```text
Cancelled
No-Show
Waitlist
```

---

# 7. نموذج حالات الغرف

تم التأكيد بشدة على عدم استخدام:

**Room Status واحد فقط.**

بل يجب الفصل بين:

### Physical Status

مثل:

- Active
- Inactive

### Housekeeping Status

مثل:

- Dirty
- Cleaning
- Clean
- Inspected

### Maintenance Status

مثل:

- Normal
- Maintenance Pending
- Under Maintenance
- Out of Order
- Out of Service

### Availability Status

يتم اشتقاقها من:

- الحجوزات.
- التخصيصات.
- Blocks.
- OOO.
- OOS.
- التاريخ.

### Sellable Status

وهو نتيجة مشتقة.

مثلاً:

```text
Sellable =
Room Active
AND
Not Out of Order
AND
Not Out of Service
AND
Not Blocked
AND
No Reservation Conflict
AND
Inventory Available
```

---

# 8. المجال المالي

تم اعتماد مبدأ:

**Financial records are events, not editable rows.**

بمعنى:

لا يتم حذف أو تعديل التاريخ المالي لإخفاء الخطأ.

إذا حدث خطأ:

يتم إنشاء:

- Adjustment
- Reversal
- Refund
- Credit Note

مع الاحتفاظ بالأصل.

المجال المالي يشمل:

- Folio
- Charges
- Taxes
- Discounts
- Deposits
- Payments
- Refunds
- Adjustments
- Invoices
- Credit Notes
- Cashier
- Daily Revenue
- Night Audit

---

# 9. منع الأخطاء المالية

تم وضع قواعد لمنع:

### Double Charging

عبر:

- Transaction
- Idempotency
- Unique Constraints
- Business Keys

### Duplicate Payment

باستخدام:

**Idempotency Key**

بحيث إذا أعيد نفس الطلب:

يعيد النظام نتيجة العملية الأصلية ولا ينشئ Payment جديداً.

### Refund

Refund ليس Delete Payment.

بل:

```text
Original Payment
↓
Refund Event
↓
Audit
```

### Historical Modification

السجل المنشور لا يتم تعديله مباشرة.

---

# 10. نظام المستخدمين والصلاحيات

تم اعتماد RBAC قابل للتخصيص.

الأدوار ليست Hardcoded.

تم اقتراح Role Templates مثل:

- Platform Admin
- Tenant Owner
- General Manager
- Front Office Manager
- Receptionist
- Cashier
- Accountant
- Housekeeper
- Housekeeping Supervisor
- Maintenance
- Reservation Agent
- Auditor

لكن المنطق الحقيقي يعتمد على Permissions granular.

مثل:

```text
reservation.view
reservation.create
reservation.modify
reservation.cancel

payment.view
payment.create
payment.refund

folio.view
folio.post
folio.adjust

report.financial.view
audit.view
```

كما أن الصلاحية مرتبطة أيضاً بـ:

**Property Scope**

---

# 11. API Architecture

تم اقتراح:

**Versioned REST API**

مثل:

```text
/api/v1/
```

مع دعم:

- Authentication
- Authorization
- Validation
- Standard Error Model
- Pagination
- Filtering
- Sorting
- Search
- Idempotency
- Rate Limiting
- Audit Metadata

ولا يتم وضع Business Logic داخل Controllers.

المسار الصحيح:

```text
HTTP
↓
Controller
↓
Application Use Case
↓
Domain
↓
Persistence
```

---

# 12. Frontend / UX

الواجهات الرئيسية:

- Login
- Tenant / Property Selection
- Dashboard
- Front Desk
- Room Rack
- Reservations
- Calendar
- Guest Profile
- Check-In
- Check-Out
- Folio
- Payments
- Housekeeping
- Reports
- Settings
- User Management
- Platform Admin

والتصميم يجب أن يدعم:

- Arabic
- English
- Indonesian
- RTL
- LTR

مع قابلية إضافة لغات أخرى.

---

# 13. Security

تم وضع Security Baseline تشمل:

- Authentication
- Authorization
- Secure Sessions
- Password Hashing
- MFA
- API Security
- Tenant Isolation
- Input Validation
- Encryption
- Secrets Management
- Audit Logs
- Rate Limiting
- Brute Force Protection
- CSRF
- CORS
- Secure Headers
- Backup Security

وأعلى المخاطر:

1. Cross-Tenant Leakage
2. Broken Authorization
3. Double Booking
4. Duplicate Payment
5. Financial Tampering
6. File Exposure
7. Session Theft
8. Integration Replay

---

# 14. Concurrency

من أهم قواعد المشروع.

تم تحليل مشاكل:

### شخصان يحجزان نفس الغرفة

يجب أن يكون التحقق والحجز داخل Transaction.

### موظفان ينفذان Check-In للحجز نفسه

الحل:

State Validation داخل Transaction.

### Double Click على Payment

الحل:

Idempotency Key.

### Concurrent Room Assignment

الحل:

Transaction + Locking + Conflict Check.

### Night Audit أثناء معاملات مفتوحة

يجب وجود Business Day State.

مثل:

```text
OPEN
↓
AUDIT_PREPARING
↓
AUDIT_VALIDATION
↓
CLOSING
↓
CLOSED
```

---

# 15. Audit Logs

الـ Audit Log يجب أن يسجل:

- Who
- What
- When
- Tenant
- Property
- Entity
- Entity ID
- Before
- After
- Reason
- IP
- Correlation ID

خصوصاً:

- Payments
- Refunds
- Adjustments
- User permissions
- Reservation changes
- Room changes
- Check-In
- Check-Out
- Night Audit
- Invoice changes

---

# 16. Reporting

التقارير الأساسية:

- Occupancy
- ADR
- RevPAR
- Room Revenue
- Other Revenue
- Tax
- Payments
- Cashier
- Arrivals
- Departures
- No Shows
- Cancellations
- Booking Sources
- Rate Plans
- Pickup

استراتيجية التقارير:

### المرحلة الأولى

Operational Database.

### عند النمو

Read Replica.

### لاحقاً

Reporting Database أو Data Warehouse.

---

# 17. SaaS Platform

يجب دعم:

- Plans
- Trial
- Subscription
- Feature Entitlements
- Usage Limits
- Property Limits
- User Limits
- Room Limits
- Billing
- Grace Period
- Suspension
- Activation
- Deactivation

ويجب الفصل بين:

**SaaS Billing**

و:

**Hotel Guest Billing**

---

# 18. Manager القنوات — القرار الجديد المهم

هذه كانت أهم إضافة لاحقة.

تم الاتفاق أن النظام لا يكون مجرد PMS.

بل يصبح:

**PMS + Channel Manager + Central Reservation + Direct Booking Platform**

ويجب أن يستطيع ربط الفندق مع:

- Booking.com
- Traveloka
- Agoda
- Expedia
- Trip.com
- وقنوات أخرى لاحقاً.

---

# 19. مدير قنوات البيع والتوزيع

تم الاتفاق أن:

**Channel Manager يجب أن يبدأ تأسيسه مباشرة بعد الأساس المعماري للنظام.**

ليس بعد اكتمال المشروع.

لكن يوجد فرق بين:

### Architectural Foundation

يبنى مبكراً.

و:

### Live Channel Connectivity

يتم بعد اكتمال:

- Property
- Room Types
- Rate Plans
- Availability
- Reservations

---

# 20. مسؤوليات Channel Manager

يجب أن يدعم:

### Central Inventory

النظام الداخلي هو مصدر الحقيقة.

### Availability Sync

إرسال التوفر إلى القنوات.

### Rates Sync

إرسال الأسعار.

### Restrictions

مثل:

- Minimum Stay
- Maximum Stay
- Closed to Arrival
- Closed to Departure
- Stop Sell

### Reservation Import

استقبال الحجوزات.

### Modification

استقبال التعديلات.

### Cancellation

استقبال الإلغاءات.

### No-Show

عند دعم القناة.

### Channel Mapping

ربط:

```text
PMS Room Type
↕
OTA Room Type
```

وكذلك:

```text
PMS Rate Plan
↕
OTA Rate Plan
```

---

# 21. Channel Manager Architecture

التصميم المقترح:

```text
Core PMS
↓
Central Inventory / Rates
↓
Distribution Orchestrator
↓
Channel Mapping
↓
Synchronization Engine
↓
Channel Adapters
↓
Booking.com
Traveloka
Agoda
Expedia
Trip.com
Other Channels
```

والاتجاه العكسي:

```text
OTA
↓
Adapter
↓
Normalize
↓
Idempotency
↓
Reservation Domain
```

---

# 22. قاعدة مهمة جداً بخصوص القنوات

تم رفض فكرة الاعتماد على:

**Scraping / Browser Automation**

كأساس للمنتج التجاري.

المفضل:

- Official APIs
- Certified Connectivity
- Integration Providers
- Channel Manager Providers

مع Adapter مستقل لكل مزود.

والهدف:

**إضافة قناة جديدة دون تعديل Core PMS.**

---

# 23. منع Overbooking عبر القنوات

تم تثبيت مبدأ:

**Central Availability Authority**

أي أن المخزون المركزي موجود داخل PMS.

مثلاً:

```text
Central Inventory
├── Booking.com
├── Traveloka
├── Agoda
├── Expedia
├── Website
└── Front Desk
```

وليس كل قناة لديها مخزون مستقل.

---

# 24. DevOps

البيئات:

```text
Development
↓
Testing
↓
Staging
↓
Production
```

البنية:

- Docker
- Reverse Proxy
- TLS
- PostgreSQL
- Redis
- Queue
- Workers
- Object Storage
- Monitoring
- Logging
- Backups
- CI/CD
- Health Checks
- Secrets

---

# 25. Testing Strategy

تم اعتماد:

- Unit Tests
- Domain Tests
- Integration Tests
- API Tests
- Database Tests
- E2E Tests
- Security Tests
- Performance Tests
- Concurrency Tests
- Multi-Tenant Isolation Tests
- Regression Tests

ومن أخطر الاختبارات:

```text
Tenant A → Tenant B data = MUST FAIL
```

وكذلك:

- Double Booking
- Duplicate Payment
- Concurrent Check-In
- Concurrent Room Assignment
- Night Audit race
- Duplicate Channel Event
- Failed Channel Retry

---

# 26. Observability

يجب دعم:

- Structured Logging
- Metrics
- Tracing
- Error Tracking
- Health Checks
- Alerts

والفصل بين:

**Audit Logs**

و:

**Application Logs**

و:

**Metrics**

و:

**Traces**

---

# 27. Backup & Disaster Recovery

تم اقتراح:

- Automated DB Backup
- Point-in-Time Recovery
- Object Storage Backup
- Restore Tests
- Disaster Recovery Plan

والأهداف الأولية:

**RPO ≤ 15 minutes**

**RTO ≤ 1 hour**

---

# 28. خارطة التنفيذ التي وصلنا إليها

بعد تعديل Channel Manager أصبحت الخطة:

```text
PHASE 0
تعريف المنتج والمجال
↓
PHASE 1
الأساس المعماري والهندسي
↓
PHASE 2
تأسيس مدير قنوات البيع والتوزيع
↓
PHASE 3
Identity + Tenant + RBAC + Isolation
↓
PHASE 4
Property + Rooms + Room Types
↓
PHASE 5
Rates + Availability + Inventory
↓
PHASE 6
Guests + Reservations
↓
PHASE 7
Front Office
↓
PHASE 8
Financial Core
↓
PHASE 9
Housekeeping + Maintenance
↓
PHASE 10
Night Audit
↓
PHASE 11
Reporting
↓
PHASE 12
SaaS Commercial Platform
↓
PHASE 13
Live OTA / Channel Connections
↓
PHASE 14
Direct Booking Engine + Enterprise Scaling
```

وهذا من أهم القرارات التي يجب عدم تغييرها في النافذة الجديدة إلا لسبب هندسي موثق.

---

# 29. Definition of Done

أي Module لا يعتبر مكتملاً إلا إذا كان:

- Implemented
- Tested
- Validated
- Documented
- Secure
- Tenant-Isolated
- Audited
- Observable
- Deployable

وبالنسبة للعمليات الحساسة أيضاً:

- Idempotent
- Concurrency-safe
- Retry-safe

---

# 30. الوثيقة التي تم إنشاؤها

تم إنشاء وثيقة Word باسم قريب من:

**HOTEL\_PMS\_SAAS\_وثيقة\_التأسيس\_والخطة\_التنفيذية\_النسخة\_النهائية.docx**

وكانت قرابة:

**38 صفحة**

وتحتوي على:

- Product Vision
- Modules
- Multi-Tenant
- Database Foundation
- Finance
- Reservations
- Room States
- RBAC
- API
- UX
- Security
- Concurrency
- Audit
- Reporting
- SaaS
- Channel Manager
- Integrations
- DevOps
- Testing
- Observability
- DR
- Risks
- ADRs
- Roadmap
- Definition of Done

لكن حدثت مشكلة في:

**معاينة الملف داخل ChatGPT**

وظهرت رسالة:

**المعاينة غير متاحة**

ثم حاولنا تحويله إلى PDF، لكن أداة إنشاء الملفات وصلت إلى Rate Limit ولم نستطع إخراج PDF صالح في هذه المحادثة.

---

# البرومبت الجاهز للنافذة الجديدة

انسخ النص التالي بالكامل إلى نافذة جديدة:

```text
أنت تعمل معي كفريق هندسي متكامل يضم:

- Principal Software Architect
- Senior Software Engineer
- SaaS Architect
- Hotel PMS Domain Expert
- Database Architect
- Backend Architect
- Frontend Architect
- Security Engineer
- DevOps Engineer
- QA Architect
- Product Manager
- Business Analyst
- UX/UI Architect
- Financial Systems Architect
- Integration Architect
- Channel Manager / OTA Connectivity Architect

اسم المشروع:

HOTEL PMS SAAS

نحن لا نبدأ المشروع من الصفر. لقد تم سابقاً إعداد System Foundation / Master Specification كاملة، وأريدك أن تواصل المشروع بناءً على القرارات التالية دون إعادة اختراعها أو تبسيطها.

━━━━━━━━━━━━━━━━━━━━
1. PRODUCT DEFINITION
━━━━━━━━━━━━━━━━━━━━

HOTEL PMS SAAS هو نظام إدارة فنادق تجاري Production-Grade يعمل كمنصة SaaS Multi-Tenant، يدعم عدة عملاء وعدة فنادق، مع عزل صارم للبيانات.

يجب أن يدعم مستقبلاً:

- Independent Hotels
- Boutique Hotels
- Resorts
- Villas
- Hotel Groups
- Hotel Management Companies
- Multi-Property Operations

المنصة ليست مجرد نظام غرف وحجوزات، وإنما:

Hotel PMS
+
Central Reservation
+
Channel Manager
+
SaaS Platform
+
Financial Core
+
Reporting
+
Direct Booking Engine مستقبلاً.

━━━━━━━━━━━━━━━━━━━━
2. ARCHITECTURE DECISION
━━━━━━━━━━━━━━━━━━━━

القرار المعماري المعتمد:

Modular Monolith First

مع Domain Boundaries صارمة.

لا نبدأ Microservices من البداية.

المكونات الأساسية:

Frontend
API Layer
Application Layer
Domain Layer
Persistence Layer
PostgreSQL
Redis
Queue
Background Workers
Private Object Storage
Monitoring
Logging
Tracing
Reverse Proxy
TLS

يمكن فصل Reporting وWorkers وIntegrations لاحقاً حسب الحجم.

━━━━━━━━━━━━━━━━━━━━
3. MULTI-TENANT MODEL
━━━━━━━━━━━━━━━━━━━━

التسلسل:

Platform
→ Tenant
→ Hotel Group
→ Property
→ Department
→ User

Tenant هو Security + Commercial Boundary.

Property هو Operational Boundary.

النموذج:

Shared Database
+
Shared Schema
+
tenant_id
+
PostgreSQL Row-Level Security
+
Application Authorization

مع إمكانية Dedicated Database للعملاء Enterprise مستقبلاً.

يجب تطبيق Tenant Isolation على:

API
Database
Background Jobs
Cache
Files
Logs
Reports
Notifications
Search

لا تعتمد على Frontend كطبقة حماية.

━━━━━━━━━━━━━━━━━━━━
4. HOTEL DOMAIN
━━━━━━━━━━━━━━━━━━━━

الدورة الأساسية:

Inquiry
→ Tentative
→ Confirmed
→ Pre-Arrival
→ Room Assignment
→ Arrival
→ Check-In
→ In-House
→ Charges
→ Payment
→ Room Change / Extension
→ Check-Out
→ Folio Settlement
→ Invoice
→ Housekeeping
→ Room Ready
→ Night Audit
→ Reporting

ويجب دعم:

Cancellation
No-Show
Early Check-In
Late Check-Out
Early Check-Out
Walk-In
Group Reservation
Multi-Room Reservation
Split Stay
Rate Change
Deposit
Refund

━━━━━━━━━━━━━━━━━━━━
5. RESERVATION MODEL
━━━━━━━━━━━━━━━━━━━━

لا تربط Reservation مباشرة بالغرفة.

يجب وجود:

Reservation
ReservationGuest
StaySegment
RoomAssignment

ويجب أن تكون هناك State Machine واضحة.

الـ Room Assignment يجب أن يحفظ التاريخ عند تغيير الغرفة ولا يقوم فقط بتغيير room_id.

━━━━━━━━━━━━━━━━━━━━
6. ROOM STATUS MODEL
━━━━━━━━━━━━━━━━━━━━

ممنوع استخدام status واحد للغرفة.

افصل:

Physical Status
Housekeeping Status
Maintenance Status
Availability Status
Sellable Status

Sellable Status يجب أن يكون derived.

━━━━━━━━━━━━━━━━━━━━
7. FINANCIAL MODEL
━━━━━━━━━━━━━━━━━━━━

المجال المالي يشمل:

Folio
Charges
Taxes
Discounts
Deposits
Payments
Refunds
Adjustments
Invoices
Credit Notes
Cashier
Daily Revenue
Night Audit

قاعدة إلزامية:

Financial records are events, not editable rows.

لا حذف أو تعديل تاريخي صامت.

أي تصحيح يتم عبر:

Adjustment
Reversal
Refund
Credit Note

يجب تصميم Idempotency للمدفوعات والاستردادات من البداية.

━━━━━━━━━━━━━━━━━━━━
8. RBAC
━━━━━━━━━━━━━━━━━━━━

الأدوار ليست Hardcoded.

استخدم:

User
→ Membership
→ Role
→ Permissions
→ Tenant Scope
→ Property Scope

Permissions granular مثل:

reservation.view
reservation.create
reservation.modify
reservation.cancel

payment.view
payment.create
payment.refund

folio.adjust
report.financial.view
audit.view

━━━━━━━━━━━━━━━━━━━━
9. API
━━━━━━━━━━━━━━━━━━━━

الاستراتيجية:

Versioned REST API
+
Async Events / Jobs

يجب دعم:

Authentication
Authorization
Validation
Error Model
Pagination
Filtering
Sorting
Search
Idempotency
Rate Limiting
Audit Metadata

Controllers لا تحتوي Business Logic.

━━━━━━━━━━━━━━━━━━━━
10. CHANNEL MANAGER — IMPORTANT
━━━━━━━━━━━━━━━━━━━━

هذا من أهم القرارات في المشروع.

مدير قنوات البيع والتوزيع يجب أن يبدأ تأسيسه مباشرة بعد Architecture Foundation.

ليس مجرد Integration نضيفه في النهاية.

الهدف هو دعم:

Booking.com
Traveloka
Agoda
Expedia
Trip.com
وقنوات أخرى مستقبلاً.

لكن لا تعتمد على Scraping أو Browser Automation كـ Core Architecture.

استخدم:

Official API
Certified Connectivity
Integration Provider
Adapters

البنية:

Core PMS
→ Central Inventory / Rates
→ Distribution Orchestrator
→ Mapping Engine
→ Sync Engine
→ Channel Adapters
→ OTA Providers

Inbound:

OTA
→ Adapter
→ Normalize
→ Idempotency
→ Reservation Domain

يجب دعم:

Availability Sync
Rate Sync
Restrictions
Reservation Import
Modification
Cancellation
No-Show where supported
Room Type Mapping
Rate Plan Mapping
Meal Plan Mapping
Retry
DLQ
Sync Monitoring
External Reservation IDs

PMS هو Central Availability Authority.

لا تسمح لأي قناة بالوصول المباشر إلى قاعدة البيانات.

━━━━━━━━━━━━━━━━━━━━
11. SECURITY
━━━━━━━━━━━━━━━━━━━━

Security Baseline يشمل:

Authentication
Authorization
Session Security
MFA
Tenant Isolation
Input Validation
Encryption
Secrets Management
Secure Headers
Rate Limiting
Brute Force Protection
Audit Logs
File Security
Backup Security

أعلى المخاطر:

Cross-Tenant Leakage
Broken Authorization
Double Booking
Duplicate Payment
Financial Tampering
File Exposure
Session Theft
Webhook Replay

━━━━━━━━━━━━━━━━━━━━
12. CONCURRENCY
━━━━━━━━━━━━━━━━━━━━

يجب تصميم:

Transactions
Locks
Unique Constraints
Idempotency
Optimistic Locking
Pessimistic Locking
State Validation
Queue Processing

سيناريوهات حرجة:

Two users booking same room
Two receptionists checking in same reservation
Duplicate payment request
Concurrent room assignment
Night Audit during active transactions
Worker processing same event twice
OTA sending same reservation event twice

━━━━━━━━━━━━━━━━━━━━
13. REPORTING
━━━━━━━━━━━━━━━━━━━━

Reports:

Occupancy
ADR
RevPAR
Room Revenue
Other Revenue
Tax
Payments
Cashier
Arrivals
Departures
No Shows
Cancellations
Pickup
Booking Sources
Rate Plans
Channel Performance

ابدأ باستخدام Operational DB بحذر ثم:

Read Replica
→ Reporting Store
→ Data Warehouse إذا لزم.

━━━━━━━━━━━━━━━━━━━━
14. LANGUAGES / UX
━━━━━━━━━━━━━━━━━━━━

دعم:

Arabic RTL
English LTR
Indonesian LTR

والنظام قابل لإضافة لغات أخرى.

الشاشات المهمة:

Login
Tenant / Property Selection
Dashboard
Front Desk
Room Rack
Reservations
Calendar
Guest Profile
Check-In
Check-Out
Folio
Payments
Housekeeping
Reports
Settings
User Management
Platform Admin
Channel Manager Dashboard

━━━━━━━━━━━━━━━━━━━━
15. DEVOPS
━━━━━━━━━━━━━━━━━━━━

البيئات:

Development
Testing
Staging
Production

البنية:

Docker
Reverse Proxy
TLS
PostgreSQL
Redis
Queue
Workers
Object Storage
Monitoring
Logging
Tracing
Backups
CI/CD
Health Checks
Secrets Management

━━━━━━━━━━━━━━━━━━━━
16. TESTING
━━━━━━━━━━━━━━━━━━━━

يجب دعم:

Unit Tests
Integration Tests
API Tests
Database Tests
E2E
Security Tests
Performance Tests
Concurrency Tests
Multi-Tenant Isolation Tests
Regression Tests

اختبارات حرجة:

Tenant A cannot access Tenant B
Double Booking
Duplicate Payment
Concurrent Check-In
Room Assignment Race
Night Audit Race
Duplicate Channel Event
Channel Retry
File Isolation
Financial Reconciliation

━━━━━━━━━━━━━━━━━━━━
17. ROADMAP — CURRENT APPROVED ORDER
━━━━━━━━━━━━━━━━━━━━

PHASE 0
Product & Domain Definition

PHASE 1
Architecture Foundation

PHASE 2
Channel Manager Foundation

PHASE 3
Identity + Tenant + RBAC + Isolation

PHASE 4
Property + Room Types + Rooms

PHASE 5
Rates + Availability + Inventory

PHASE 6
Guests + Reservations

PHASE 7
Front Office

PHASE 8
Financial Core

PHASE 9
Housekeeping + Maintenance

PHASE 10
Night Audit

PHASE 11
Reporting

PHASE 12
SaaS Commercial Platform

PHASE 13
Live OTA / Channel Connections

PHASE 14
Direct Booking Engine + Enterprise Scaling

مهم:

Channel Manager Foundation يبدأ مبكراً، لكن الاتصال الحي بالقنوات يبدأ بعد اكتمال Rooms + Rates + Availability + Reservations.

━━━━━━━━━━━━━━━━━━━━
18. DEFINITION OF DONE
━━━━━━━━━━━━━━━━━━━━

أي Module لا يعتبر مكتملاً إلا إذا كان:

Implemented
Tested
Validated
Documented
Secure
Tenant-Isolated
Audited
Observable
Deployable

وللعمليات الحساسة:

Idempotent
Concurrency-Safe
Retry-Safe

━━━━━━━━━━━━━━━━━━━━
19. WHAT I WANT FROM YOU NOW
━━━━━━━━━━━━━━━━━━━━

أريد منك أولاً أن تستوعب هذه القرارات كـ Project Baseline ولا تعيد شرحها لي من الصفر.

ثم ابدأ العمل على:

[اكتب هنا المهمة التالية]

مثال:

"ابدأ بإعداد PHASE 0 — Domain & Business Rules Specification بشكل تفصيلي وقابل للتحويل لاحقاً إلى Database وAPI وTesting Specifications."

أو:

"ابدأ بتصميم Database Specification المنطقية دون كتابة SQL."

أو:

"ابدأ بتصميم Channel Manager Foundation Specification بالتفصيل."

مهم:

لا تكتب كوداً إلا عندما أطلب ذلك صراحة.
لا تغير أي قرار معماري رئيسي دون توضيح السبب والـ Trade-offs.
تعامل مع المشروع كمنتج SaaS تجاري Production-Grade طويل الأمد.
```

### أفضل نقطة للبدء في النافذة الجديدة

أقترح أن تضع في آخر البرومبت:

> **ابدأ الآن بإعداد PHASE 0 — Domain & Business Rules Specification بشكل احترافي ومفصل، مع Glossary، Business Rules، State Machines، Invariants، Edge Cases، Acceptance Criteria، وDependency Map. لا تكتب أي كود.**

هذه هي الخطوة الصحيحة قبل تصميم قاعدة البيانات.