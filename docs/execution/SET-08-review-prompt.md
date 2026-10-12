# برومبت المراجعة المستقلة لـSET-08

أنت مراجع مستقل بسياق نظيف لحزمة **SET-08 (جاهزية خادمية، لغات/إتاحة، أداء، تكامل)** في `/home/omar/Desktop/Hotel`. مهمتك إصدار حكم `GO` أو `GO_WITH_NOTES` أو `NEEDS_FIXES` قابل لإعادة الإنتاج، لا إصلاح الحزمة. لا تعدّل أي ملف مصدري أو اختبار؛ إن احتجت إثبات فشل اختبار فاستعمل نسخة مؤقتة تحت `/tmp/opencode` أو أعد التعديل فوراً وتحقق من `CHECKSUMS.sha256` بعده.

## اقرأ أولاً

1. `AGENTS.md` (لا تغيير D/G-13/العزل/النموذج المالي؛ لا قبول إنتاجي؛ SET-AT لا تُحوَّل إلى PASS).
2. `docs/execution/SET-08.md` كاملة (النطاق، الجرد، سجل 08.1..08.4، الأدلة، الفجوات المعلنة) و`docs/execution/SET-progress.md`.
3. العقود ذات الصلة: `docs/contracts/set.openapi.json` (`x-readiness-enforced-by`)، `docs/97_set_setup_contract_adr.md` (S10).

## الحالة المعلنة (تحقق منها، لا تفترض)

- البصمات الموثقة: بعد 08.1 `71c5bb7e…`، بعد 08.2 `74ff6e47…`، بعد 08.3 `48210e3a…`، بعد 08.4 `42773919d3a8ff00acd0e7d46ba545645514905d03cc75e8d44741a6739637a2`.
- `CHECKSUMS.sha256`: كل صفوفه OK (يتغير العدد مع إضافة ملفات التوثيق؛ لا تعتمد رقماً ثابتاً).
- أدلة: `.local/verification/SET-08-1-*.log`، `SET-08-2-*.log`، `SET-08-3-*.log` + `SET-08-3/scale-evidence.json`، `SET-08-4-*.log` + `SET-08-4/journey-evidence.json`، وبصري `.local/verification/SET-01/`.

## ما يجب إعادة إنتاجه (بالترتيب)

1. **تأكيد البصمة والتشيكسوم:** أعد حساب بصمة `find apps packages scripts tests docs/contracts …` وتأكد أنها تطابق بصمة 08.4 الموثقة، وأن `sha256sum -c CHECKSUMS.sha256` كله OK.
2. **08.1 بوابة SET-AT14:** اقرأ `updatePropertyById` و`ApplySetupDraft` وتحقق أن الرفض يستخدم نفس `setupReadinessIssues`؛ شغّل `pnpm dev:stop` ثم `pnpm test:property:fast -- --filter=property-api`؛ وقيّم هل توجد مسارات أخرى تسمح بـ`SETUP→ACTIVE` متجاوزة البوابة (ابحث عن كل `status.*ACTIVE` في خدمات property).
3. **تصنيف أخطاء قاعدة البيانات:** راجع `apps/api/src/database-errors.ts` واستخدامه في فلتر `SafeErrors`؛ شغّل طقم الوحدة. جرّب التفكير في أكواد SQLSTATE غير مصنفة قد تسرّب 500 (مثل 40001/40P01 serialization) وقيّم خطورتها.
4. **08.2 لغات/إتاحة:** شغّل `tests/i18n-parity.test.tsx` و`tests/web-a11y.test.tsx`. اختبر الفعالية بمُطفِرة (mutation): احذف مؤقتاً مفتاحاً متداخلاً من نسخة `/tmp` أو من ملف ثم أرجعه، وأثبت أن طقم التكافؤ يفشل فعلاً. راجع أن تركيز الملخص حقيقي (`tabIndex=-1` + effect) وأن `aria-invalid` مربوط بالحقول عبر MUI، وأن سكربت `index.html` يعمل قبل mount.
5. **08.3 أداء:** أعد تشغيل `pnpm test:property:fast -- --filter=inventory-scale` وقارن القيم مع `scale-evidence.json` (تحقق أن القياس على 50/500/2000 لا على حجم واحد، وأن الهدف 1s مذكور كهدف أولي لا SLA). راجع قرار إبقاء 500ms في `commitment/group/revision` مقابل `property_limits_profile.search_budget_ms` وهل التوثيق كافٍ.
6. **08.4 تكامل:** شغّل `pnpm test:integration` وأعد تشغيل رحلة `--filter=set08-journey`. تحقق من ادعاء `--faults BLOCKED_ENV` بمحاولة `docker compose version` بنفسك. راجع مصفوفة القيود: هل أي جزء خارجي ادُّعي أنه مُختبر؟
7. **البصري:** راجع `.local/verification/SET-01/report.json` وتأكد أن فحوص 320/360 وAT14/التفعيل وتبديل اللغة وسط المعالج فحوص فعلية (اقرأ كود `scripts/set01-visual.mjs`)، وإن أمكن أعد تشغيل `pnpm visual:set01` بعد `pnpm dev:start`.

## أسئلة الحكم الصريحة

- هل وعد SET-AT14 صار صادقاً في المسارين المعلنين بلا التفاف؟
- هل ادعاءات i18n/a11y قابلة للتكذيب (اختبار يفشل عند الكسر) أم مجرد وجود اختبارات؟
- هل قياس الأداء يمثل أحجاماً حقيقية أم تجميلاً؟ وهل الفجوات المعلنة (لا SLA، 2000 فوق سقف الملف، لا مهمة خلفية) صريحة؟
- هل الرحلة E2E تُثبت إعداد→تفعيل→بيع فعلاً، أم تتوقف قبل البيع؟ وهل الملاحظتان (خطة السعر DRAFT، تسعير إشغال 1) موثقتان بصدق؟
- هل أي من SET-AT12..17 حُوِّل خطأً إلى PASS؟ وهل لُمس D/G-13/EX-04؟

## المخرجات المطلوبة

اكتب `docs/execution/SET-08-independent-review.md` بالبنية المتبعة: نطاق المراجعة، ما أُعيد إنتاجه بالأوامر والنتائج، النتائج مصنفة `P0/P1/P2`، ما تعذّر التحقق منه ولماذا، ثم الحكم النهائي `GO`/`GO_WITH_NOTES`/`NEEDS_FIXES` مع شرط إعادة القبول إن لزم. حدّث بطاقة SET-08 بجولة المراجعة ولا تغيّر حالة SET-AT.
