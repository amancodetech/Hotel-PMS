# عقود العمليات والأحداث

حالة: فهرس مفاهيمي؛ عقد V1 الأساسي وأسماء عملياته وصلاحياته وأحداثه المحسومة في docs/26_api_permissions_events.md وdocs/contracts/v1.openapi.json. عمليات المراسلات هنا مؤجلة ولا تدخل عقد V1.

كل أمر يتطلب هوية موثوقة ونطاقاً وصلاحية ونسخة متوقعة عند التنافس ومعرف عملية عند التكرار. المدخلات التالية مفاهيم وليست حقول Schema نهائية.

| العملية | المدخل المفاهيمي | النتيجة والآثار | أسباب الرفض |
|---|---|---|---|
| SearchAvailability | عرض/فترة/كمية/نزلاء/استمرار | متاح/غير متاح/يتطلب تقسيم/تعذر الحسم؛ لا ضمان بمجرد البحث | نطاق أو قيود غير صالحة |
| CreateHold | طلب صالح ومهلة | التزام مؤقت مؤرخ | تعارض/نفاد/تعذر حسم |
| ConfirmReservation | عرض أو Hold وشروط وضمان | حجز والتزام ونسخ اتفاق | Hold منتهٍ/ضمان ناقص/تعارض |
| ModifyReservation | نسخة وتغيير وموافقة | تعديل ذري مع فرق سعر | stale version/تعارض/سياسة |
| CancelItem | سبب ونسخة Item | تحرير مستقبل وطلب آثار مالية | حالة إقامة لا تقبل إلغاء |
| AssignResources | Item وموارد وفترة | تخصيص مثبت يحفظ ضمان الجميع | جاهزية/قيود/خطة غير صالحة |
| CheckIn | Item وتخصيص ومتطلبات وصول | حدث دخول وإشغال | غير جاهز/دخل سابقاً بنتيجة مختلفة |
| MoveStay | مورد بديل وموافقة | قطاع جديد وتجهيز القديم | فشل بديل؛ الأصل باقٍ |
| CheckOut | Item وسياسة مال | مغادرة وDirty ومعالجة حساب | شروط ناقصة/تسوية غير مصرح بها |
| CreateBlock | سبب ونطاق وفترة | Block أو حالة معالجة | تعارض مخطط بلا حل |
| PostCharge | خدمة ونسخة سعر ومرجع | حدث مالي واحد | فترة مغلقة/مرجع مكرر مختلف |
| RequestPayment/Refund | مبلغ وعملة ومراجع | Pending/Success/Unknown | صلاحية/حد متاح/محتوى مفتاح مختلف |
| RunNightAudit | Property ويوم ونسخة | تقدم قابل للاستئناف | يوم خاطئ/استثناء مانع |
| ReprocessChannelEvent | اتصال ومرجع حدث | تطبيق أو استثناء بنفس الهوية | ترتيب مبهم/Mapping |
| SetDistributionSaleStatus | اتصال/عرض أو نوع/فترة/Open أو Stop Sell/نسخة | نية مزامنة مؤرخة من أحدث حالة مشتقة | نطاق/صلاحية/stale version؛ رفع مانع محدد قد ينجح مع effective_open=false إذا بقي مانع آخر |
| ReceiveGuestMessage | اتصال وهوية رسالة خارجية ومشاركون | رسالة واردة واحدة وربط موثوق أو قائمة مراجعة | قدرة غير مدعومة/توقيع/نطاق/ربط مبهم |
| ReplyToConversation | محادثة ومحتوى ومعرف عملية | نية إرسال واحدة وحالة تسليم قابلة للمطابقة | صلاحية/قناة غير داعمة/محادثة مغلقة/مستلم مبهم |
| AssignConversation | محادثة وموظف/فريق ونسخة | مسؤول وحالة خدمة محدثان | نطاق/صلاحية/stale version |
| ScheduleGuestMessage | حجز وقالب ووقت وغرض | جدولة تعيد التحقق قبل الإرسال | حجز أو مستلم غير صالح/قناة غير داعمة |

REST تحت /api/v1؛ المسارات والأكواد الأساسية في عقد OpenAPI. RequestPayment في هذا الفهرس مفهوم تاريخي؛ V1 يستخدم RecordPayment لإثبات تحصيل خارجي وفق D-11، لا معالجة بطاقات. Error model يميز validation/forbidden/not_found/conflict/stale_version/expired/undetermined/provider_pending. الرسالة موطّنة، code ثابت، وCorrelation ID؛ لا كشف بيانات عميل آخر. Pagination محدودة؛ Search/Sort مسموحان بقائمة حقول، لا تعبيرات قاعدة بيانات من العميل.

## فهرس أحداث المجال

ReservationConfirmed/Modified/Cancelled، InventoryCommitted/Released/Blocked، AssignmentChanged، StayCheckedIn/Moved/CheckedOut، HousekeepingRequested، ChargePosted، PaymentResolved، RefundResolved، BusinessDayClosed، DistributionSyncRequested، DistributionSaleStatusChanged، GuestMessageReceived، GuestReplyRequested، GuestMessageDeliveryUpdated، ConversationAssigned، GuestRequestCreatedFromConversation.

كل حدث: هوية ونسخة عقد وسياق Tenant/Property ومرجع Aggregate وتسلسل موثوق عندما ينطبق ووقت حدوث/تسجيل ومعرف ترابط/سبب. لا نسخ مستندات ضيف أو أسرار إلى الأحداث. Consumer لا يفترض exactly-once transport؛ يعتمد at-least-once مع منع تكرار الأثر.

Inbox يثبت الاستلام قبل المعالجة؛ Outbox أو آلية معادلة تثبت نية الإرسال مع التغيير. حذف سجل منع التكرار يخضع لأفق إعادة الإرسال والاسترداد، لا TTL اعتباطي. retry محدود مع backoff وتصنيف الأخطاء، وDLQ قابلة للفحص وإعادة المعالجة بنفس الهوية.
