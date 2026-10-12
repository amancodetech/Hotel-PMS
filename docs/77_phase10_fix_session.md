# docs/77: جلسة إصلاح F-RVW10-01 (المرحلة 10 — ثبات طقم night-audit زمنياً)

التاريخ: 16 سبتمبر 2026. النطاق مفوّض ومحصورة كما أوصت [docs/76](76_phase10_independent_review.md):
تعديل **fixture فقط** في `tests/property/night-audit.pg.test.mjs`؛ بلا تغيير كود إنتاج ولا
مهاجرة ولا عقد ولا واجهة ولا بصريات. لا قبول G-10 في هذه الجلسة؛ القبول قرار المستخدم.

## 1) العيب وإعادة الإنتاج

- **Finding:** F-RVW10-01 (متوسط، أطقم/أدلة) — الاختباران:
  `P10-01 outstanding balances and in-house departures are surfaced...` و
  `P10-02 retry resumes a failed run after acknowledgement...`.
- **إعادة الإنتاج الفعلية (نافذة الفشل 00:00–16:59 UTC):** 16 سبتمبر 02:07 UTC،
  `pnpm test:property:fast -- --filter=night-audit` ⇒ **2 failed / 8 passed**،
  `new row for relation "stay_segment" violates check constraint "stay_segment_dates_check"`،
  والموضعان اللذان وثّقهما المراجع نفسهما. السجل:
  `.local/verification/P10-02/night-audit-repro-pre-fix.log`.

## 2) السبب المؤكد

الـfixture كان يبني `arrival` من `addDays(0)` بتوقيت UTC ثم يضبط
`end_date = localToday('Asia/Jakarta')` لصناعة إقامة «مستحقة المغادرة اليوم وما زالت
داخلة». حين يتساوى تاريخ جاكرتا مع تاريخ UTC (00:00–16:59 UTC) يصبح
`end_date = start_date` فيُخالف قيد `end_date > start_date`
(`Migration20260915050000_reservation_core.ts:118`). بعد 17:00 UTC يتقدّم تاريخ جاكرتا
يوماً فيمرّ الـfixture، ولهذا وثّق المنفّذ أدلته في نافذة 19:34–19:39 UTC.

## 3) الإصلاح (fixture فقط)

في الموضعين (`tests/property/night-audit.pg.test.mjs`، اختبارا WARN وRETRY) أصبح الـupdate
يشتق الطرفين من **تاريخ العمل** لا من ساعة UTC:

```sql
update "stay_segment"
    set "start_date" = $3::date - 1, "end_date" = $3
  where "item_id" = $1 and "property_id" = $2
```

- `start_date = business_date - 1` و`end_date = business_date` دائماً ⇒ القيد
  `end_date > start_date` محقق في كل الأوقات، والدلالة محفوظة: ليلة واحدة مستحقة المغادرة
  اليوم وما زالت IN_HOUSE (فلا تدخل `listInHouseSegments` لأن `end_date > business_date`
  غير محقق، وتظهر في `listUnresolvedDepartures` لأن `end_date <= business_date`).
- حُدّث تعليقا الـfixture ليشيرا إلى F-RVW10-01. لا تغيير في أي سلوك منتج.

## 4) التحقق بعد الإصلاح (داخل نافذة الفشل نفسها)

| الفحص | الوقت UTC | النتيجة | السجل |
|---|---|---|---|
| `pnpm test:property:fast -- --filter=night-audit` | 02:08 | **10/10** | `.local/verification/P10-02/night-audit.log` |
| `pnpm check` | 02:10 | **87/87 في 12 حزمة** | `.local/verification/P10-02/check-post-fix.log` |
| `pnpm test:property` كامل | 02:11 | **267/267 في 37 حزمة** (65.3s) | `.local/verification/P10-02/test-property-full.log` |
| `pnpm checksums` + `sha256sum -c` | — | يُعاد توليدها بعد التعديل ويُلحق السجل | `.local/verification/P10-03/checksums*.log` |

## 5) الحالة

- **F-RVW10-01: FIXED (fixture فقط)** بأدلة نافذة الفشل الفعلية؛ لا أثر منتج ولا حاجة
  لتغيير أي شيء في كود P10 (مطابق لتوصية المراجع).
- G-10 تبقى **VERIFIED محلياً / REVIEW_PENDING**؛ القبول قرار المستخدم، وبعده يُفتح P11 فقط
  بلا جاهزية إنتاج ولا قنوات حية.
- ملاحظة رمز idempotency (409 `CONFLICT` مقابل `IDEMPOTENCY_CONFLICT` في docs/26) تبقى
  بنداً توثيقياً خارج P10 كما ورد في docs/76.
