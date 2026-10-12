# إغلاق G03-F3-A وG03-F3-B — REMEDIATED / REVIEW_PENDING

14 سبتمبر 2026. عالج هذا السجل النتيجتين المتبقيتين في [مراجعة الإغلاق](../44_g03_quarantine_followup_review.md) بعد [G03-F1-F3](G03-F1-F3.md). الحالة **REMEDIATED / REVIEW_PENDING**؛ لا قبول ذاتي ولا بدء P04. حُفظت إصلاحات F1/F2 وسائر الإصلاحات المقبولة وتعديلات المستخدم والترجمة، ولم تُعدّل أي مهاجرة مطبقة.

## السبب المشترك

الحجر كان مسجَّلاً لا نافذاً: `distribution_connection` بلا فحص حجر في سياستها، وسياسات التوابع تفحص صفها فقط، ودالة اكتشاف العمل (SECURITY DEFINER) تستبعد حجر Inbox وحده، وسجل المخالفات نفسه كان مقروءاً خاماً لدوري التشغيل. ثم إن سياسات RLS كانت تقرأ `distribution_consistency_conflict` مباشرة، فلم يكن ممكناً سحب الصلاحية دون كسر أثر الحجر.

## G03-F3-A — منع كشف سجل المخالفات مع إبقاء الحجر

- **الإصلاح:** سُحبت `select` عن `distribution_consistency_conflict` من `hotel_worker` و`hotel_test`، وفُعّلت RLS بلا سياسات (المالك فقط). استُبدلت القراءة المباشرة في السياسات بدالتين `SECURITY DEFINER`:
  - `distribution_row_quarantined(text, uuid)`: ترجع boolean فقط لصف واحد، بأسماء مؤهلة `public.` و`set search_path = pg_catalog, public`؛ ممنوعة على `public` ودوري التشغيل.
  - `distribution_quarantined(text, uuid)`: بوابة العلاقة (أدناه)، ممنوحة لدوري `hotel_worker` و`hotel_test` فقط؛ أي جدول غير معروف يرفع `22023` بدل تجاوز صامت.
- جدول المخالفات بقي مرئياً للمالك للتسوية، وتفاصيله لا تُستخدم في أي استعلام تطبيقي.
- **تقوية بعد فحص نقدي ذاتي:** مهاجرة `20260914240000_distribution_quarantine_acl_hardening.ts` سحبت `EXECUTE` الافتراضي لـ`PUBLIC` عن الدالة الباطنة `distribution_conflict_row_tenant` وعن وسيط الإفراج (كانا `SECURITY DEFINER` بمتناول أي دور، أي واجهة تعداد محتملة لمعرّف العميل)، وأضافت قيد `resolution in ('QUARANTINED_NOT_VALID','RELEASED')` يمنع إسكات الحجر بتعيين قيمة ثالثة غير مفحوصة. اختبار الانحدار يتحقق من الصلاحيات ومن رفض استدعاء الدالة الباطنة (`42501`) ومن رفض القيمة غير المعروفة (`23514`).
- **قرار المشغل (ب) — منع حذف الحجر الصامت:** مهاجرة `20260914250000_distribution_conflict_delete_guard.ts` تضيف وسيط `before delete` يرفض (`23514`) حذف أي صف لسجل المخالفات ما لم يكن `resolution = 'RELEASED'`؛ فيجب إصلاح البيانات ثم الإفراج المفحوص قبل أي تنظيف. أُثبت عملياً على قاعدة مؤقتة: حذف صف محجور `23514`، الإفراج مع خلل قائم `23514`، بعد إصلاح المرجع ينجح الإفراج ثم الحذف. والوسيط الجديد غير قابل للتنفيذ من `PUBLIC` (تحقق اختباري).
- **سد تجاوز `TRUNCATE`:** مهاجرة `20260914260000_distribution_conflict_truncate_guard.ts` تضيف وسيطاً على مستوى العبارة يرفض (`23514`) تفريغ السجل ما دام يحوي صفاً غير `RELEASED` (لأن `TRUNCATE` لا يطلق وسائط `DELETE` الصفّية). اختبار الانحدار يحاول `TRUNCATE` أثناء وجود صفوف محجورة ويتوقع الرفض، ويتحقق من أن الدالة غير قابلة للتنفيذ من `PUBLIC`.
- **الاختبار:** قراءة السجل تُرفض بـ`42501` بلا سياق وداخل Tenant A لكل من `hotel_worker` و`hotel_test`؛ `has_table_privilege` = false؛ الدالة الباطنة غير قابلة للتنفيذ من الدور التشغيلي؛ الجدول غير المعروف يرفع `22023`؛ والدالة العامة تُرجع `true` للاتصال المحجور دون كشف أي صف.

## G03-F3-B — نقل الحجر من الجذر إلى التوابع واكتشاف العمل

**مصفوفة الحجر المعتمدة** (الحجر ينتقل من الوالد إلى الابن؛ الجذر `distribution_connection`):

| الجدول (الابن)                | يُحجب إذا كان محجوراً                        |
| ----------------------------- | -------------------------------------------- |
| `distribution_connection`     | نفسه                                         |
| `distribution_outbox_event`   | نفسه، أو اتصاله                              |
| `distribution_inbox_revision` | نفسه، أو اتصاله، أو استثناء `exception_id`/`ack_exception_id` المشار إليه (فحص صف مباشر بلا دورية) |
| `distribution_exception_case` | نفسه، أو اتصاله، أو Outbox، أو Inbox         |
| `distribution_dead_letter`    | نفسه، أو اتصاله، أو Outbox                   |
| `distribution_sync_attempt`   | نفسه، أو Outbox (وبالتالي الاتصال)           |
| `distribution_dedup_key`      | نفسه، أو Inbox (وبالتالي الاتصال)            |
| capability / mapping / booking / checkpoint | نفسه، أو الاتصال               |

- **الإصلاح:** سياسات RLS لكل الجداول أعلاه تستدعي `distribution_quarantined` في `using` و`with check`؛ فتشمل الحجب مسارات القراءة والكتابة و`leaseDueOutbox` و`claimPendingAck` و`renew` و`update` و`pull` وسحب checkpoint والاستثناءات وDLQ لأنها كلها تمر بالسياسات.
- **اكتشاف العمل:** `distribution_work_tenants` يستبعد الآن كل عمل مرتبط بصف محجور أو اتصال محجور، بما في ذلك استرداد ACK المستنفد؛ الدالة تبقى `SECURITY DEFINER` بمسار بحث مقيّد وبلا منح عام.
- **دوران:** لا حذف ولا إعادة نسبة؛ الصفوف تبقى كما هي، والحجب عرض سياساتي قابل للرفع عند التسوية.
- **الاختبارات:** قاعدة الترقية الحقيقية `legacyTenant` تُزرع الآن بجذر محجور يتيماً مع توابعه (`outbox`, `inbox` بحالة PENDING، `exception`, `dead_letter`, `dedup`, `sync_attempt`, `checkpoint`, `booking`, `capability`, `mapping`). بدور `hotel_worker` و`hotel_test`: كل صف غير مرئي بسياق العميل غير الموجود وبسياق Tenant A؛ المالك يراه؛ `listDistributionWorkTenants` لا يعيد العميل؛ `claimPendingAck` و`leaseDueOutbox` لا يحجزان شيئاً؛ تشغيل `DistributionRuntime` لا يستدعي الـAdapter لأي اتصال محجور. الجذر السليم ما زال يُحجز ويُرسل، والقيود ترفض الكتابات الجديدة لعميل غير موجود (`23503`).

## التسوية و`RELEASED`

- أُضيف عمودا `resolved_at` و`resolved_by` ووسيط إلزامي `distribution_conflict_release_guard` لا يسمح بتحويل الصف إلى `RELEASED` إلا إذا زال عدم الاتساق فعلاً:
  - `orphan_tenant`: يلزم وجود صف `tenant` المطابق (أو زوال الصف المخالف).
  - `tenant_mismatch`: يلزم تطابق عميل الصف الحالي مع عميل الوالد المسجّل بعد التسوية.
  - `orphan_parent`: يلزم ربط الـdedup أو زواله.
  - أي سبب غير معروف يرفع `23514` (فشل مغلق).
- إجراء التسوية المحدود: المالك فقط ينفّذ SQL مباشر على الجدول بعد إصلاح البيانات (إنشاء العميل الناقص أو تصحيح المرجع)، ثم `update ... set resolution='RELEASED'`. لا توجد واجهة تسوية، ولا يُعدَّل `tenant_id` تلقائياً، ويُحفظ `detected_at` والأثر.
- **الاختبارات:** الإفراج قبل إصلاح الاتساق يُرفض (`23514`) لسجل العميل الناقص ولخللي العميل/الوالد؛ بعد إنشاء العميل يُقبل الإفراج ويُسجَّل `resolved_at`/`resolved_by`، ويبقى `tenant_id` الأصلي كما هو، وتبقى قيود FK غير مُتحقَّقة كما هي وترفض الكتابات الجديدة غير السليمة. الإفراج عن الجذر يعيد الاتصال وInbox المتسقين فقط، ويبقى Outbox ذو المخالفة المستقلة محجوراً وغير قابل للحجز. سجل المخالفات بعد الإفراج يبقى للمالك وحده.

## المهاجرة والملفات

- أربع مهاجرات جديدة (لم تُمس المهاجرات المطبقة):
  - `Migration20260914230000_distribution_quarantine_closure.ts` — الدالتان، سحب/منح الصلاحيات، RLS على السجل، العمودان والوسيط، إعادة كتابة سياسات الجداول الإحدى عشرة، وإعادة تعريف `distribution_work_tenants`، مع `down()` يستعيد حالة `230000`.
  - `Migration20260914240000_distribution_quarantine_acl_hardening.ts` — سحب `EXECUTE` عن `PUBLIC` للدالتين الباطنتين وقيد قيم `resolution`.
  - `Migration20260914250000_distribution_conflict_delete_guard.ts` — وسيط `before delete` يمنع الحذف قبل `RELEASED` (قرار المشغل ب).
  - `Migration20260914260000_distribution_conflict_truncate_guard.ts` — وسيط `before truncate` يسد تجاوز الحذف الجماعي.
- اختبارات وتجهيزات: `tests/distribution/integration/tenant-quarantine-upgrade.pg.test.mjs` (5 اختبارات إجمالاً لهذا الملف)، `tests/distribution/integration/legacy-tenant-fixtures.mjs`، و`scripts/test-distribution.mjs` (تمرير قاعدة دور `hotel_test`).

## النتائج

| الفحص                                                     | النتيجة                                                              |
| --------------------------------------------------------- | -------------------------------------------------------------------- |
| `pnpm check`                                              | 79/79 في 10 suites                                                   |
| `pnpm test:identity`                                      | 48/48 في 7 suites                                                    |
| `pnpm test:distribution`                                  | 48/48 في 11 suites (45 سابقاً + 3 انحدار F3-A/F3-B/RELEASED)         |
| `pnpm test:integration` / `pnpm test:containers`          | PASS / PASS                                                          |
| `pnpm db:migrate` / `pnpm db:check`                       | نجاح على قاعدة التطوير                                               |
| `pnpm visual:phase3` / `pnpm visual:check`                | 23/23 و38/38 (لا تغيير واجهة)                                        |
| أداة المراجعة `.local/verification/review-g03-quarantine/reproduce.mjs` | تفشل الآن عند أول قراءة للسجل بـ`42501`؛ الحالتان مغطاتان باختبارات مستقلة |
| `pnpm checksums` + `sha256sum -c`                         | مطابقة بعد التحديث                                                   |
| سبر عدائي (قاعدة مؤقتة)                                   | قراءة الاتصال المحجور 0 صفوف؛ الكتابة في نطاق محجور `42501`؛ سحب صلاحية الدالة يُفشل الاستعلام (`42501`) لا يتجاوزه؛ `migration:down` ثم `up` ناجحان |
| مثال قرار (ب) العملي (قاعدة مؤقتة)                        | حذف صف محجور `23514`؛ إفراج مع خلل قائم `23514`؛ إصلاح المرجع ثم إفراج ناجح ثم حذف ناجح |
| تجاوز `TRUNCATE` (قاعدة اختبار)                            | `truncate` مع صفوف محجورة `23514`، وبعد تفريغ مشروع لا يبقى ما يُحجر |

## حدود

- النطاق محلي فقط: لا نشر ولا قناة حية ولا commit/PR، وP04 محجوب حتى مراجعة مستقلة جديدة.
- الامتياز التشغيلي المطلوب للمالك لقراءة السجل وتشغيل التسوية موثق أعلاه؛ الأدوار التشغيلية لا تصل إليه.
- انتقال الحجر يعتمد على سياسات RLS وعلى دالتَي الحجر؛ أي خطأ صلاحية فيهما يُفشل الاستعلام (fail closed) ولا يتحول إلى تجاوز صامت.
