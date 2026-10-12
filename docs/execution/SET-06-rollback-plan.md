# SET-06 — خطة الرجوع (Rollback) والاستعادة

النطاق: هجرات SET-06 `160000`/`170000`/`180000` وهجرة الإصلاح `Migration20260922100000_composition_revival_provenance`.  
القاعدة: هذه السلسلة **forward-only**. لا يُشغَّل `migration:down` عبرها؛ كل `down()` يرمي خطأً تشغيلياً **قبل** أي SQL أو تعديل على سجل الهجرات.

## لماذا لا يوجد down() آمن

| الهجرة | الأثر الذي لا يمكن عكسه |
| --- | --- |
| 160000 | أتقاعدت صفوف `composition_version` متداخلة (بيانات)، لا مجرد فهرس. |
| 170000 | أحيَت صفوفاً متقاعدة وأسقطت حارس التداخل العام. |
| 180000 | رخّت قيد الفترة ليسمح بنافذة يوم واحد؛ صفوف لاحقة تعتمد عليه. |
| 221000 | جدول إثبات + trigger حارس للإحياء + إعادة تقاعد المرجّع. |

إرجاع السجل دون البيانات ينتج schema/data drift (أثبته المراجع المستقل على قاعدة مؤقتة). لذلك `down()` يرمي رسالة تشغيلية تحيل إلى هذا الملف.

## الرجوع المفضّل: إصلاح أمامي

1. تأكد أن كل الهجرات مطبقة: `pnpm db:migrate` (يجب أن يصل إلى `Migration20260922100000` دون جديد).
2. تحقق من الثوابت:

```sql
select to_regclass('public.composition_status_audit');
select tgname from pg_trigger where tgname = 'guard_composition_revival';
select count(*) from "composition_version" v
 where v."status" = 'ACTIVE'
   and exists (
     select 1 from "audit_event" a
      where a."tenant_id" = v."tenant_id" and a."property_id" = v."property_id"
        and a."action" = 'composition.superseded'
        and a."after_safe" ->> 'retired' = 'true'
        and a."before_safe" ->> 'composition_id' = v."id"::text
   );
```

النتيجة المتوقعة: الجدول و trigger موجودان، وعدد الصفوف `0` (لا إحياء غير مقصود باقٍ).

3. أي إحياء مستقبلي لصف `RETIRED` يجب أن يسبقه سطر موافقة في `composition_status_audit` (`to_status = 'ACTIVE'`)؛ وإلا يرفض trigger `guard_composition_revival` العملية. هذا يمنع تكرار عيب 170000.

## الاستعادة الكاملة (كارثة تشغيلية)

1. خذ/استعد النسخة الاحتياطية المأخوذة **قبل** تطبيق 160000 (pg_dump كامل للنطاق).
2. استعدها إلى قاعدة جديدة، ووجّه `DATABASE_URL`/`MIGRATION_DATABASE_URL` إليها.
3. `pnpm db:migrate` للأمام حتى الرأس. سيعيد تشغيل 160000/170000 ثم 221000، و221000 تعيد تقاعد أي صف أُحيي بخطأ اعتماداً على سجل التدقيق الموثوق.
4. أعد فحص ثوابت الخطوة أعلاه قبل إعادة فتح الخدمة.

## ملاحظات

- إن لم تتوفر نسخة احتياطية سابقة لـ160000، فالحل هو forward-fix فقط؛ لا يوجد `down()` آمن.
- إصلاح 221000 يعتمد على `audit_event` (`composition.superseded` مع `after_safe.retired = true`) كسجل منشأ موثوق للتقاعد المقصود. أي تقاعد مقصود سبق SET-06 ولم يُسجَّل بهذا الشكل لا يمكن تمييزه آلياً، ويجب مراجعته يدوياً من مالك البيانات.
- لا تُعدَّل هجرات مطبقة؛ أي تصحيح لاحق يكون بهجرة أمامية جديدة.
