# النموذج المنطقي للبيانات قبل SQL

حالة: مسودة عقد ملكية وعلاقات وقيود، لا Schema نهائياً. ORM المختار MikroORM وفق D-12؛ لا يغير الملكية أو ثوابت المجال.

| المجال المالك | مجموعات المفاهيم | الارتباطات والقيود |
|---|---|---|
| Identity | User/Membership/Role/Permission/Scope | User قد يملك عضويات متعددة؛ كل قرار وصول يحدد العضوية |
| Platform | Tenant/Plan/Subscription/Entitlement/Usage | SaaS billing مستقل عن Hotel billing. نُفذت في P12: خطط وإصدارات سياسة مؤرخة append-only، اشتراك واحد لكل Tenant بلقطة سياسة، استحقاقات وسجل أحداث، عدّادات استخدام بحدود تُفرض ذرياً في القاعدة، فوترة إدارية بلا بوابة دفع، سجل دورة عميل append-only، ودعم مؤقت بمنحة محددة الصلاحيات والمدة (SEC-006)؛ كل جداول platform بـFORCE RLS ولا تمنح أي وصول لسجلات النزلاء |
| Property | Property/Location/Resource/Type/Product/Composition | ملكية Tenant/Property ثابتة؛ نسخ تركيب مؤرخة |
| Inventory | Pool/Commitment/Hold/Block/Feasibility | لا ازدواج موارد؛ الخطط الداخلية لا تعد تخصيصاً للنزيل |
| Guests | Guest/ReservationGuest/Documents | Guest في Tenant، وصول Property بحسب العلاقة والحاجة |
| Reservations | Reservation/Item/Segment/Policies | الحجز Property واحدة؛ Items كثيرة؛ Segments مرتبة |
| Front Office | Assignment/Stay Events | موارد متعددة للمركب؛ تاريخ تخصيص وإشغال محفوظ |
| Rates | RatePlan/NightlyQuote/Restrictions/Package | نسخة الاتفاق لا تتغير بتغيير القالب |
| Finance | Folio/Charge/Tax/Payment/Refund/Invoice/Cashier | مبلغ وعملة ومراجع أصل؛ نشر غير قابل للمحو |
| Operations | Tasks/Discrepancies/WorkOrder | تغييرات الموارد عبر عقد Inventory لا تعديل موازي |
| Distribution | Connection/Mapping/Inbox/Sync/Exceptions | معرف خارجي فريد داخل اتصال/مزود ونطاق محدد |
| Guest Communications | Conversation/Message/Participant/Assignment/Template/Schedule/DeliveryAttempt | كل سجل Tenant/Property وConnection؛ هوية الرسالة الخارجية فريدة داخل الاتصال؛ الملاحظة الداخلية منفصلة عن الرسالة الخارجية |
| Reporting | MetricDefinitions/ReadModels | بيانات مشتقة بنطاق ووقت تحديث وتعريف مقياس |
| Audit | AuditEvents | غير قابل للتعديل من دور التطبيق العادي؛ تقليل الحساسية |

## حدود العلاقات

الحجز 1→N Items، Item 1→N Segments، Segment 1→N Assignments التاريخية مع نسخة مستخدمة صالحة لكل فترة. Composition N→N Resources عبر نسخ داخل Property. Commitment يرتبط بمصدر واحد محدد الهوية، ويمكن نقل استهلاك Group إلى Items دون duplication. Payment قد يوزع على Folios بقواعد مجموع، وRefund يشير لأصل قابل للاسترداد.

## القيود المنطقية

هوية العملية الخارجية ضمن Connection لا عالمياً؛ هوية منع التكرار ضمن Tenant/Operation/Key. نفس المفتاح لمحتوى مختلف تعارض. المرجع إلى Resource/Guest/Invoice/Conversation يتحقق من النطاق، لا مجرد وجود ID. ربط Participant بسجل Guest لا يعتمد على الاسم وحده، وقد يبقى الطرف الخارجي غير مدمج. تاريخ نهاية بعد البداية لنمط الإقامة؛ استخدام النهار يحتاج قدرة مستقلة. لا دورات أو تكرار في تركيب. Snapshot سعر/سياسة/تركيب عند الاتفاق. المورد الفيزيائي نفسه يُفحص عبر كل نسخ التركيبات المتزامنة.

لا تحديث متعدد الوحدات خارج خدمة Application المسؤولة عن المعاملة. سجل إرسال دائم مع معاملة التغيير؛ الإرسال الخارجي بعد نجاحها. لا نوسع المعاملة لتنتظر شبكة مزود.

## الحذف والاحتفاظ

الأحداث المالية والتدقيق لا تحذف بعملية تشغيلية عادية. موارد مستخدمة تُقاعد؛ مستخدم يُعطل؛ Guest يمر بسياسة احتفاظ/تقليل بيانات حسب السوق، مع الحفاظ على المراجع المطلوبة. لا Soft Delete شامل تلقائي لكل شيء؛ لكل مفهوم سياسة. نسخ البنية أو نقل Enterprise يحتاج خطة migration قابلة للتحقق لا تغيير tenant_id عشوائياً.

## قبل تحويلها إلى SQL

حُسمت D-02/03/04/07/08/14، مع D-05؛ اكتمل النموذج المنطقي التفصيلي وcardinalities ومفاتيح uniqueness وقيود scope/time وتصميم RLS واستعلامات الفهرسة في docs/25_logical_model_contract.md. المخطط الفيزيائي وmigration/rollback ينفذان بعد إذن البرمجة وبوابات المرحلة. تضاف منح الأدوار بنطاقاتها ونسخ السياسات والاعتمادات وفق D-18 وبيانات العملة والتحويل وفق D-17. هذه خطوات تصميم قبل تفويض التنفيذ، ولا تعد منفذة بهذه الحزمة.
