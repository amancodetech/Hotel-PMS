# حزمة أدلة القناة: Trip.com

> مولّد من `channel-readiness.json` — كل الخلايا NOT_TESTED/NOT_DECLARED حتى دليل حي مخول.
> المحاكي أو قناة أخرى لا يملأ أي خلية ([docs/35](../../../docs/35_live_channels_runbook.md)).

- القناة: `trip-com` · المزود: `channex` · الحالة: **NOT_TESTED** · التفويض: **NOT_AUTHORIZED**
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

- مسار Ctrip/Trip.com وربط الغرف والخطط
- هوية حساب Trip المقصود والتغطية الفعلية

## الأسعار/الشروط

- العملة والسعر والقيود تثبت للحساب المقصود؛ لا افتراض من الاسم
- تغطية القناة الفعلية جزء من دليل التفعيل

## الدليل المطلوب للتفعيل

- تفويض/عقد EX-01 وبيانات الحساب المصرح
- تأكيد هوية الحساب والتغطية الفعلية
- دليل AT-C01..10 ودليل سحب D-20
- فحص العملة/القيود/التواريخ
