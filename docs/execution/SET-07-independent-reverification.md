# SET-07 — إعادة التحقق المستقلة المختصرة بعد R07

- **التاريخ:** 22 سبتمبر 2026.
- **المرجع:** §6 من [المراجعة المستقلة](SET-07-independent-review.md) + [تقرير إصلاح R07](SET-07-fix-report.md).
- **النطاق:** إعادة إنتاج سيناريوهات P0 (استيراد + مجموعة)، P1 (تعريب مقاييس التدبير/الوصول)، P2 (عمق سلسلة الأسلاف + أسبقية أسباب القدرات)، ثم أطقم الانحدار والبوابات والبصريات، وقرار إغلاق SET-07. لا SET-08، ولا تغيير G-13، ولا قبول إنتاجي، وSET-AT تبقى NOT_TESTED.
- **الحكم:** **GO محلي — `VERIFIED_LOCAL`**. النتائج المانعة الأربع في المراجعة **مُبطَلة بإعادة إنتاج مستقلة**، والانحدارات خضراء. أُغلقت SET-07 محلياً.
- **بيان الاستقلال:** أُجريت هذه الجولة في جلسة جديدة عن جلسة الإصلاح، وكُتبت سبرات التحقق من الصفر (لم تستورد ملفات اختبار SET-07 الدائمة) على قاعدة اختبار معزولة أُنشئت وأُسقطت ذاتياً، ثم أُزيلت السبرات المؤقتة بعد التشغيل. سجلات R07 لم تُستخدم دليلاً؛ كل الأرقام أدناه من تشغيل هذه الجولة. الاستقلال محدود كون الجولة آلية داخل البيئة نفسها وليست مراجعة بشرية خارجية.

---

## 1) إعادة إنتاج P0 — تجاوز فرض المشاركة عبر الاستيراد ومجموعات الحجز

**المنهج:** منتج `BED` بنطاق `FEMALE` (ضبط مباشر على صف المنتج كما في المراجعة) + منتج `BED` مختلط على المورد نفسه؛ دورة: استيراد CSV بلا ضيوف ← مسودة مجموعة ← `group-allotment` ← `pickup`، مع مقارنة مسار البيع المباشر وقراءة `reservation_item` و`commitment` عبر SQL. القاعدة: `hotel_test_<run>_property` المؤقتة.

**النتيجة الخام (مقتطف السبر):**

```json
R07-RV-P0 import {"status":200,"rows_accepted":0,"rows_rejected":1,"error_code":"GUEST_GENDER_REQUIRED","reservations_created":0}
R07-RV-P0 blocked allotment {"status":422,"code":"GUEST_GENDER_REQUIRED","item_state":"INQUIRY","active_commitments":0}
R07-RV-P0 blocked pickup {"status":422,"code":"GUEST_GENDER_REQUIRED","item_state":"INQUIRY","active_commitments":0}
R07-RV-P0 mixed pickup {"status":200,"item_state":"CONFIRMED","active_commitments":1}
```

- مسار البيع المباشر (شاهد ضابط في السبر): مسودة لمنتج `FEMALE` بلا ضيف → **422 `GUEST_GENDER_REQUIRED`**.
- الاستيراد لا ينشئ أي حجز (`reservations_created=0`)، والصف يُرفض برمز `GUEST_GENDER_REQUIRED` لا يُقبل صامتاً.
- الحصة `group-allotment` لمنتج تغيّر نطاقه إلى `FEMALE` → **422** قبل أي كتابة، و`pickup` → **422** مع بقاء البند `INQUIRY` وصفر التزامات نشطة (fail-closed بلا أثر جزئي).
- العودة إلى `MIXED` تعيد البيع طبيعياً: `pickup=200` والبند `CONFIRMED` مع `guest_count=0` — وهذا هو **الحد المعلن نفسه** في تقرير الإصلاح (المنتج المختلط لا يحكم على الضيوف)، وليس تجاوزاً للسياسة المقيدة.
- **النتيجة: R07-P0-01 مُبطَل.**

## 2) إعادة إنتاج P2-01 — جاهزية اللوحة على سلسلة الأسلاف كاملة

**المنهج:** شجرة `GP(ROOM) ← SUB(ROOM) ← BX(BED)` عبر SQL (الجد الأب `DIRTY`، والأب المباشر نظيف)، منتج `BED` على `BX`، حجز وتأكيد، ثم قراءة اللوحة ومحاولة تسكين فعلية، وبعدها شاهد ضابط بتنظيف الجد.

**النتيجة الخام:**

```json
R07-RV-P2-01 dirty grandparent {"board_candidate":{"eligible":false,"reason":"PARENT_DIRTY"},"assignment_status":400,"assignment_reason":"PARENT_DIRTY"}
R07-RV-P2-01 clean grandparent {"board_candidate":{"eligible":true,"reason":null},"assignment_status":200}
```

- اللوحة والتسكين متطابقان عند العمق ≥2 (كانا متعارضين قبل R07-F3).
- الشاهد الضابط يثبت أن المنع سببه الجد الأعلى لا حالة أخرى.
- **النتيجة: R07-P2-01 مُبطَل.**

## 3) إعادة إنتاج P2-02 — أسبقية أسباب القدرات لصفوف المجموعة

**المنهج:** منتج غرفة نوم (DORM) بتركيبة سريرين، حجز بمكوّنَين، قراءة القدرات قبل الدخول وبعده.

**النتيجة الخام:**

```json
R07-RV-P2-02 confirmed group {"assign":"GROUP_COMPONENT_SELECTION_REQUIRED","check_in":null,"check_out":"STATE_NOT_IN_HOUSE","move":"STATE_NOT_IN_HOUSE","extend":null,"split":"STATE_NOT_IN_HOUSE","early_departure":"STATE_NOT_IN_HOUSE","partial_departure":"STATE_NOT_IN_HOUSE"}
R07-RV-P2-02 in-house group {"assign":"ALREADY_IN_HOUSE","check_in":"ALREADY_IN_HOUSE","check_out":null,"move":"GROUP_COMPONENT_SELECTION_REQUIRED","extend":null,"split":"GROUP_COMPONENT_SELECTION_REQUIRED","early_departure":null,"partial_departure":null}
```

- الأسبقية صحيحة: سبب الحالة (`ALREADY_IN_HOUSE`/`STATE_NOT_IN_HOUSE`) يتقدم، ثم شرط الإسناد النشط، ثم قاعدة المجموعة (عند وجود إسناد نشط فعلاً).
- **النتيجة: R07-P2-02 مُبطَل.**

## 4) إعادة إنتاج P1 — تعريب مقاييس التدبير/الوصول/المغادرة

**المنهج:** سبر مستقل لا ينسخ مصفوفة اختبار المنفذ، يمرّ على المفاتيح المولَّدة خادمياً بكل اللغات الثلاث (ar/en-US/id-ID):

- `housekeeping_{clean,dirty,cleaning,inspected}.{ROOM,BED,SITE,TENT,CABIN,DORM}`
- `maintenance_{none,ooo,oos}.{...}` 
- `arrivals_state_*`/`departures_state_*` لكل حالات البند التسع
- مفاتيح `resources_not_ready_current` و`adr/revpar_*` و`stay_revenue_*` و`arrivals/departures_total`
- حالات R17 المكذّبة نفسها (`housekeeping_clean.ROOM`، `maintenance_ooo.ROOM`، `arrivals_state_in_house`...) + fallback الخام للمفاتيح غير المعروفة.

**النتيجة:** 5/5 اختبارات ناجحة — لا `RAW:`، ولا ظهور لأي أساس خام (`housekeeping_`/`maintenance_`/`_state_`) في أي لغة، مع بقاء لاحقة النوع بياناً معلناً، وبقاء الـfallback الخام للمفاتيح غير المعلنة. **النتيجة: R07-P1-01 مُبطَل.**

## 5) الانحدارات والبوابات (تشغيل هذه الجولة)

| الفحص | الأمر | النتيجة | الدليل |
| --- | --- | --- | --- |
| سبرات P0/P1/P2 المستقلة | `pnpm test:property:fast -- --filter=zz-r07-rv-probe` + jest مباشر لسبر التعريب (أُزيلت بعده) | **3/3** + **5/5** | `R07-RV/probe.log`، `R07-RV/i18n-probe.log` |
| طقم property الكامل | `pnpm test:property:fast` | **421/421 في 55 حزمة** | `R07-RV/property-full.log` |
| أطقم SET-07 والتركيز | `... --filter=set07\|front-office-board\|reservation-groups\|reporting-` | **60/60 في 8 حزم** (set07 12، لوحة 11، مجموعات 4، تقارير 33) | `R07-RV/focused.log` |
| طقم التوزيع | `pnpm test:distribution:fast` | **48/48** + تطبيق الهجرات (110 جداول) | `R07-RV/distribution.log` |
| بوابة `pnpm check` | `pnpm check` | **103/103 في 15 حزمة** + عقود/توليد/typecheck/lint/format (منها `reports-i18n`) | `R07-RV/check.log` |
| البصريات | phase6 / phase7 / phase9 / phase11 / SET-01 | **27/27، 35/35، 28/28، 14/14، 37/37** | `R07-RV/visual-*.log` |
| بوابة سلامة الملفات | `pnpm checksums` + `sha256sum -c CHECKSUMS.sha256` | **773/773 OK** (بعد إعادة توليد كانت لازمة) | `CHECKSUMS.sha256` |

## 6) بصمة النسخة

أُعيد التحقق من البصمة بعد إزالة السبرات المؤقتة، بالأمر المعتمد (sha256 لملفات `ts/tsx/mjs/json` في `apps/packages/scripts/tests/docs/contracts` بعد استثناء `dist/node_modules`، عبر تجميع `sha256sum` مرتب):

```text
find apps packages scripts tests docs/contracts -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mjs' -o -name '*.json' \) \
  ! -path '*/dist/*' ! -path '*/node_modules/*' -print0 | sort -z | xargs -0 sha256sum | sha256sum
```

النتيجة: `e4fd418d0893ac96433c45d3f20e5550b6cd1791170fc1d6aea6efa8d4ef0b1a` — **مطابقة** لبصمة تقرير R07، أي أن الشجرة المُتحقَّق منها هي نفسها التي رُوجعت أدلتها.

**بوابة سلامة الملفات:** كان `CHECKSUMS.sha256` متأخراً عن تغييرات SET-05..07 (53 ملفاً فاشلاً في `sha256sum -c` قبل الجولة). أُعيد التوليد بـ`pnpm checksums` ثم `sha256sum -c CHECKSUMS.sha256` = **773/773 OK**، وهو ما يمرّ به `ci.yml`.

## 7) الحدود المعلنة (تبقى)

- `createGroupAllotment`/`pickupGroupAllotment` بلا `Idempotency-Key` مطلوب (إعادة `pickup` تفشل مغلقاً `INVALID_STATE_TRANSITION`) — توسيع عقد لاحق.
- `reservation_guest.item_id` غير مستخدم في الواجهات، فيُعامَل ضيف مستوى الحجز كمرشح لكل بند مقيّد (تحفّظ fail-closed).
- الاستيراد يرفض صفوف المنتجات المقيدة كلياً (لا أعمدة ضيوف في CSV)؛ أي استيراد بضيوف يحتاج تصميم أعمدة وقراراً.
- لا واجهة لتعديل جنس النزيل بعد الإنشاء (لا `UpdateGuest`).
- حالتا `delta≠0` عند تصحيح يومية بلا رسوم، وعدم خلط `MIXED` بين عملتين، بقيتا غير مُعاد إنتاجهما في هذه الجولة (كما في المراجعة) ولا تدّعي هذه الجولة تغطيتهما.
- خارج الحكم: SET-06 ما زالت `FIXED_LOCAL` بانتظار إعادة قبول مستقل، وG-13 كما هي، وSET-AT كلها NOT_TESTED، ولا قبول إنتاجي.

## 8) التوصية

- **إغلاق SET-07 بحالة `VERIFIED_LOCAL`** وإحالة حدود §7 إلى قرار المستخدم/الحزم اللاحقة، مع بقاء SET-06 على حالها حتى إعادة قبول مستقلة.
- الخطوة التالية المقترحة: فتح SET-08 وفق الخطة، مع تسجيل الملاحظات المعلنة أعلاه في بطاقتها.
