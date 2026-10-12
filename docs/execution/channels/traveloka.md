# حزمة أدلة القناة: Traveloka

> مولّد من `channel-readiness.json` — كل الخلايا NOT_TESTED/NOT_DECLARED حتى دليل حي مخول.
> المحاكي أو قناة أخرى لا يملأ أي خلية ([docs/35](../../../docs/35_live_channels_runbook.md)).

- القناة: `traveloka` · المزود: `channex` · الحالة: **NOT_TESTED** · التفويض: **NOT_AUTHORIZED**
- أصل الدليل الحي (عند وجوده): `BLOCKED_EXTERNAL`

## مصفوفة AT-C

| الاختبار | الحالة | evidence_ref | test_run_id |
|---|---|---|---|
| AT-C01 | NOT_TESTED | — | — |
| AT-C02 | NOT_TESTED | — | — |
| AT-C03 | NOT_TESTED | — | — |
| AT-C04 | NOT_TESTED | — | — |
| AT-C05 | NOT_TESTED | — | — |
| AT-C06 | NOT_TESTED | — | — |
| AT-C07 | NOT_TESTED | — | — |
| AT-C08 | NOT_TESTED | — | — |
| AT-C09 | NOT_TESTED | — | — |
| AT-C10 | NOT_TESTED | — | — |

## الموارد

| النوع | الحالة |
|---|---|
| room | NOT_DECLARED |
| villa_whole | NOT_DECLARED |
| villa_parts | BLOCKED |
| apartment | NOT_DECLARED |
| bed | NOT_DECLARED |
| site | NOT_DECLARED |
| tent | NOT_DECLARED |
| cabin | NOT_DECLARED |
| house | NOT_DECLARED |
| composite | BLOCKED |

## الصلاحيات المطلوبة والاختبارات الخاصة

- `channel.read`
- `channel.connection.manage`
- `channel.mapping.manage`
- `channel.sale.manage`
- `channel.reconcile`
- `channel.reprocess`

- Property connection ID قد يختلف عن المعرف العام
- Mapping متعدد الإشغال والوجبات على مستوى room وRETAIL والخطط المشتقة

## الأسعار/الشروط

- عروض الوجبات لنفس المورد لا تضاعف الحصة
- gross/net/commission وpartial ARI تفسر بلا افتراض

## الدليل المطلوب للتفعيل

- تفويض/عقد EX-01 وبيانات الحساب المصرح
- Mapping متعدد الإشغال/الوجبات مع IDs الاتصال الفعلي
- دليل AT-C01..10 ودليل سحب D-20
- تفسير المال وحدود السعر وpartial ARI
