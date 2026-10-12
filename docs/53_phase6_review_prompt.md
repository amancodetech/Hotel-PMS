# المراجعة المستقلة لـG-06 (المرحلة 6): برومبت جلسة منفصلة

التاريخ: 15 سبتمبر 2026. الغرض: مراجعة مستقلة لـP06-01..P06-06 قبل أي قبول لـG-06.
انسخ الكتلة التالية كأول رسالة في جلسة جديدة تماماً (بلا سياق المنفذ).

```text
راجع محلياً نتائج المرحلة 6 (P06: الحجوزات والنزلاء والاستيراد) في /home/omar/Desktop/Hotel
دون كتابة كود إنتاج أو تعديل اختبارات. لا تقبل G-06 نيابة عن المستخدم؛ سلّم حكماً توصيفياً
(PASS/PASS WITH FINDINGS/FAIL) مع findings مصنفة بالخطورة وأدلة إعادة إنتاج.

البيئة: export PATH="/tmp/hotel-pnpm10/node_modules/.bin:$PATH"؛ PostgreSQL 17.11 على 55432،
Redis 7.4.11 على 56379، Keycloak 26.7.3 على 58080 (لا تشغّل dev أثناء أطقم property).
الأسرار من .env فقط ولا تُطبع. الحسابات الاصطناعية: owner-a (بلا MFA)، admin-a (TOTP)،
member-a، auditor-a، owner-b.

القراءة الإلزامية: AGENTS.md ثم README.md وdocs/01 وdocs/17 وdocs/32 (P06) وdocs/49، وبطاقات
docs/execution/P06-01..06 وdocs/execution/G-06، وعقود docs/contracts/phase6.openapi.json
وscripts/contracts.mjs. افحص الكود في packages/backend/src/modules/reservations وapps/api/src/reservations
والواجهة apps/web/src/reservations وscripts/phase6-visual.mjs.

أعد تشغيل الأدلة بنفسك: pnpm build ثم pnpm check ثم pnpm contracts:check ثم pnpm test:identity
ثم pnpm test:distribution ثم pnpm test:property (بعد pnpm dev:stop) ثم pnpm dev ثم
pnpm visual:phase5 وpnpm visual:phase6 وpnpm visual:check ثم pnpm checksums وsha256sum -c.
أعد الفحوص العدائية على الأقل: (أ) تأكيد/تعديل/إلغاء متزامن ومفتاح idempotency مختلف المحتوى،
(ب) Pickup/Split بلا تكرار أو تراكب، (ج) ReprocessChannelEvent: duplicate/out-of-order/
LINK_MISSING/ITEM_COUNT_MISMATCH/EXTERNAL_CONFLICT مع بقاء الأصل، (د) الاستيراد: بصمة ملف
مكررة، مفتاح مكرر من مصدر آخر، CSV خبيث/كبير، (هـ) RLS ومنح الأدوار على الجداول الجديدة
(api_idempotency، reservation_group_allotment، reservation_import_run/row) وهل API يرى بيانات
عميل آخر، (و) مستقلية guest.read وهل أي استجابة تكشف نزلاء/مالاً دون صلاحية.

الأسئلة الحرجة: هل أي كتابة بلا audit/Outbox عند اللزوم؟ هل يمكن تحرير الأصل عند فشل؟
هل توجد ادعاءات AT أو قنوات حية بلا دليل؟ هل الحدود المعلنة (لا مالية/لا واجهات تأكيد)
مطابقة للواقع؟ هل توجد findings عالية/متوسطة جديدة غير موثقة؟

التوقف والإبلاغ فوراً عند: finding عالٍ، أو اختلاف بين الوثائق والسلوك، أو حاجة بيانات/شبكة
حقيقية. لا تصلح شيئاً بنفسك؛ ابنِ تقريراً في docs/55_phase6_independent_review.md مع الأدلة
الخام ومساراتها واقتراح ترتيب الإصلاح، ثم سجّل حكمك النهائي.
```

## كيف تُدار الجلسة

1. تُشغَّل في جلسة جديدة تماماً بلصق الكتلة أعلاه فقط (لا يُشارك سياق المنفذ).
2. أي findings متوسطة/عالية تُفتح لها جلسة إصلاح بتفويض المستخدم قبل أي قبول.
3. لا يُعلن قبول G-06 إلا بقرار المستخدم صراحةً، ويفتح القبول P07 فقط.
