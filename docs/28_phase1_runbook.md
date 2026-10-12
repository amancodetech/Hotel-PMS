# تشغيل أساس المرحلة 1

الإصدار 0.7، 13 سبتمبر 2026. بيئة تطوير محلية فقط، لا تشغيل إنتاجي أو بيانات نزلاء. نتائج القبول في [سجل التحقق](29_phase1_verification.md).

## المتطلبات والإصدارات

Node 22.23.2 من خط LTS، وpnpm 10.34.5، وDocker Engine مع إضافة Compose. يحتفظ كل manifest بإصدارات مباشرة دقيقة، ويقفل pnpm-lock.yaml الاعتماديات المتعدية. لا تستخدم `npm install` داخل المشروع ولا تنشئ lockfile آخر.

| المكون | الإصدار المثبت |
|---|---|
| TypeScript | 5.9.3، strict |
| React / Vite | 19.3.0 / 7.3.6 |
| NestJS / Express | 11.2.3 / 5.2.1 |
| MUI | 7.3.11 |
| MikroORM | 7.2.0، ESM، CLI وMigrator وtsx |
| Redis client / BullMQ | 5.11.1 / 5.81.5 |
| PostgreSQL | 17.11-alpine |
| Redis | 7.4.11-alpine |
| Keycloak | 26.7.3 |
| Jest | 30.5.1 |

اختير Node المحلي المدعوم لتجنب تغيير أدوات الجهاز العامة. عند الانتقال إلى خط Node آخر، حدّث engines و.nvmrc وCI وأعد الفحوص، لا تغير Stack D-12. [جدول Node الرسمي](https://nodejs.org/en/about/previous-releases)، [إصدارات PostgreSQL](https://www.postgresql.org/docs/release/)، [تصحيحات Redis 7.4](https://redis.io/docs/latest/operate/oss_and_stack/stack-with-enterprise/release-notes/redisce/redisce-7.4-release-notes/)، [Keycloak](https://www.keycloak.org/downloads.html).

## تثبيت وتشغيل

نفذ من جذر `/home/omar/Desktop/Hotel`:

```bash
pnpm install --frozen-lockfile
pnpm env:init
pnpm infra:up
pnpm dev
```

`env:init` ينشئ `.env` لأول مرة فقط، بصلاحية 0600 وكلمات مرور عشوائية، ولا يستبدل ملفاً موجوداً أو يطبع أسراره. `.env.example` بلا أسرار. يجب أن تتوافق كلمات المرور وعناوين الاتصال مع volumes القائمة؛ تغيير كلمة مرور في الملف وحده لا يغير مستخدم PostgreSQL الموجود.

`dev` يبني أولاً، يفحص تعارض منافذ العمليات الثلاث، ثم يشغل مراقبة TypeScript وAPI وWorker وVite. التعديلات على TS تعاد ترجمتها؛ تعديل `.env` أو manifest يستدعي إيقاف التطوير وإعادة التشغيل. لا ينتقل Vite بصمت إلى منفذ مختلف. إذا تعارض منفذ، اختر منفذاً فارغاً في `.env` وأعد التشغيل.

### أدوات هذه الجلسة

لم تكن إضافة Compose مثبتة وكان إصدار pnpm العام مختلفاً. استُخدمت أدوات مؤقتة دون تعديل تثبيت الجهاز العام:

```bash
export PATH="/tmp/hotel-pnpm10/node_modules/.bin:$PATH"
export COMPOSE_BIN="/tmp/hotel-toolchain/docker-compose-v5"
pnpm infra:status
pnpm dev
```

هذه المسارات قد تزول عند تنظيف `/tmp`. لإعادة إعداد جهاز آخر، ثبّت pnpm 10.34.5 وإضافة Compose بالطريقة الرسمية. `COMPOSE_BIN` اختياري لمسار binary رسمي عند غياب الإضافة؛ إن لم يحدد يستعمل المشروع `docker compose`. استخدمت الجلسة Compose 5.5.0، وتمت مطابقة SHA256 مع ملف الإصدار الرسمي قبل التنفيذ. [تعليمات Compose](https://docs.docker.com/compose/install/standalone/).

## المنافذ والمسارات

| الخدمة | العنوان الافتراضي | الغرض |
|---|---|---|
| Web | http://127.0.0.1:5173/ | حالة النظام؛ `/preferences` للتفضيلات |
| API | http://127.0.0.1:4100/api/v1/system/health | liveness للعملية |
| API | http://127.0.0.1:4100/api/v1/system/ready | فحص DB وRedis وKeycloak |
| Worker | http://127.0.0.1:4101/health و`/ready` | صحة عملية Worker واعتمادياتها |
| PostgreSQL | 127.0.0.1:55432 | قاعدة التطبيق المحلية |
| Redis | 127.0.0.1:56379 | بنية الطوابير، ليست قفل المخزون |
| Keycloak | http://127.0.0.1:58080/ | إدارة هوية محلية، دون OIDC تطبيق منفذ |
| Keycloak health | http://127.0.0.1:59000/health/ready | إدارة صحة محلية، لا تعرض للإنتاج |

المنافذ مربوطة بـloopback. قاعدة Keycloak في حاوية منفصلة بلا منفذ قاعدة بيانات منشور على الجهاز. اسم مسؤول Keycloak المحلي `local-admin`؛ كلمة مروره داخل `.env` الخاص فقط، ولم تنشأ حسابات ضيوف أو موظفين أو realm للمنتج.

Vite يمرر `/api` إلى API و`/worker-health` إلى Worker لتجنب CORS في البيئة المحلية. لا تثق في هذه الوساطة كمصادقة. تعيد المسارات غير المنفذة خطأ، ولا توجد CRUD وهمية.

## الفحوص

```bash
pnpm check
pnpm db:check
pnpm db:migrate
pnpm db:roles
pnpm identity:local
pnpm provision:local
pnpm test:integration --faults
pnpm test:containers
pnpm test:distribution
pnpm test:identity
pnpm visual:check
pnpm visual:phase3
pnpm audit --audit-level=high
pnpm checksums
sha256sum -c CHECKSUMS.sha256
```

`db:roles` ينشئ أدوار PostgreSQL المحلية `hotel_api` و`hotel_worker` و`hotel_test` بلا أسرار مطبوعة، و`identity:local` يجهز Realm وHوكلاء والعميل وتدفق MFA والمستخدمين الاصطناعيين، و`provision:local` ينشئ عميلين اصطناعيين وعضوياتهم (idempotent). شغّلها بعد `infra:up` وقبل `dev` أو اختبارات الهوية. `test:identity` يحتاج منفذ 4100 حراً (يوقف API مؤقتاً عبر السكربت) وينشئ قاعدة اختبار فريدة ويسقطها في النهاية. `visual:phase3` يحتاج `pnpm dev` قائماً.

`test:distribution` يبني ثم ينشئ قواعد اختبار محلية بأسماء فريدة لكل تشغيل (`hotel_test_<runId>_new` و`_legacy` و`_legacy_ack`) على PostgreSQL المحلي: الأولى جديدة، والثانية ببيانات اصطناعية سابقة، والثالثة تُهاجَر إلى `Migration20260913120000_distribution_core` فقط ثم تُزرع فيها بيانات ACK قديمة اصطناعية وتُرقّى للأحدث. يشغل تكامل التوزيع كاملاً (رسائل/ترتيب/fencing/ACK/DLQ/استرداد ما قبل الترقية بحالات MAPPING_MISSING واستثناء ACK بجدول الاستثناءات وعاملين متنافسين) ثم يحذف فقط القواعد واللقطات التي أنشأها (`/.snapshot-hotel_test_*.json`) فيدع اللقطة المرجعية `.snapshot-hotel.json` وحدها. يستخدم بيانات اصطناعية فقط. سكربت البصمات يستبعد لقطات قواعد الاختبار والمخرجات المولدة ويبقي اللقطة المرجعية.

`visual:check` يشغل Playwright مع Chromium حقيقي (اعتمادية تطوير مقفلة) ضد Web قائم على `http://127.0.0.1:5173`، ويكتب 20 لقطة وتقريراً في `.local/verification/P01-01/` المستبعد من الحزمة. هذا بديل الفحص البصري المعتمد بدلاً من Computer Use، ولا يعني جهاز جوال حقيقي أو متصفحات أخرى.

`check` يشغل البناء وتوليد أنواع العقد والتحقق المعياري من OpenAPI وفحص الأنواع وESLint وPrettier وJest. يحتاج Jest سماحاً بمنافذ loopback لاختبارات HTTP والاتصالات الصامتة. لا تستخدم نجاحه كقبول AT للمراحل اللاحقة.

`test:integration` دون `--faults` يفحص الخدمات القائمة فقط. معه يوقف حاويات `hotel-phase1` واحدة في كل مرة ثم يعيدها في `finally`؛ راقب البيئة، ولا تشغله أثناء استخدام زميل لها. إذا انقطعت عملية الاختبار قسراً شغّل `pnpm infra:up` لاستعادة الخدمات.

`test:containers` ينشئ PostgreSQL وRedis مؤقتين ببيانات اصطناعية وكلمة مرور عشوائية، ويختبر SELECT ودورة BullMQ واحدة ثم يغلقهما. لا يتصل بحساب خارجي، ولا يشغّل حجزاً أو Outbox. قد يحتاج Docker إلى تنزيل صورة خدمة تنظيف Testcontainers.

## المهاجرات وحدود العزل

قاعدة التطوير تحتوي الآن 12 جدول `distribution_*` من المرحلة 2 (Inbox/Outbox/Attempts/Dedup/Mapping/Capabilities/Checkpoint/Exception/DeadLetter) بعد `pnpm db:migrate`. لا كيانات مجال مخزون/حجز/مال. لا تستعمل `schema:update` أو SQL تلقائياً لبناء ERD كله. ملفات migrations المستقبلية توضع في `packages/backend/src/persistence/migrations` ثم يبنى المشروع قبل تطبيقها؛ الإعداد transactional وallOrNothing، والحذف التلقائي معطل.

`apps/worker` يشغل runtime التوزيع فقط عند `DISTRIBUTION_WORKER=on` (افتراضياً off في `.env.example`) وبمزود المحاكي المحلي؛ لا تصلح لقناة حية. تبقي جداول `distribution_*` بلا RLS أو دور تشغيل محدود حتى P03-03، ومراجع tenant/property بلا FK حتى P03/P04 وفق سجل التبعيات في docs/32. لا تشغيل عملاء أو بيانات حقيقية على هذه القاعدة.

يقرأ CLI عنوان `MIGRATION_DATABASE_URL`؛ API وWorker يقرآن `DATABASE_URL`. في هذا الأساس المحلي يشيران إلى حساب bootstrap نفسه، بلا بيانات مجال. هذا ليس الفصل الأمني النهائي: قبل إنشاء جداول العملاء في المرحلة 3 يجب فصل دور مالك/مهاجرات عن دور التطبيق غير المالك وغير BYPASSRLS وتطبيق RLS والتفويض وسياق المعاملة واختبارها. لا يسمح إعداد المرحلة 1 بـNODE_ENV=production.

لا جداول Membership أو Tenant أو Property، ولا جلسات OIDC أو MFA أو CSRF لعمليات أعمال، ولا صلاحيات مؤسسية منفذة. قاعدة Keycloak لا تعطي التطبيق هذه الضمانات تلقائياً. لا تحمل مسارات الصحة بيانات عملاء أصلاً.

## البنية والسجلات

`apps/web` لا يستورد Backend أو ORM؛ توجد قيود ESLint على الاستيراد. `apps/api` يستقبل HTTP ثم يفوض فحص الجاهزية إلى Application في `packages/backend`. محولات اتصال الخدمات في Persistence، وDomain محجوز بلا منطق أعمال بعد. `apps/worker` عملية مستقلة من الوحدات نفسها؛ لا consumers لأعمال المراحل اللاحقة.

تتحقق الإعدادات قبل فتح الخوادم. معرف correlation غير صالح يستبدل بـUUID؛ لا يعكس النص الخام. الخطأ `{code,message,correlation_id,details}`؛ message مفتاح ثابت، والواجهة تعرض ترجمة ولا تعرض `error.message` الخام. السجلات تقبل حقولاً محددة، دون URL اتصال أو body أو headers أو stack. فحص Redis له حد شامل للمصافحة، وفحوص DB وKeycloak لها مهلات اتصال/استعلام.

OpenTelemetry مهيأ دون exporters أو اكتشاف موارد أو تتبع طلبات تلقائي أو اتصالات خارجية. هذا أساس إعداد، لا مراقبة إنتاجية أو tracing تشغيلي مكتمل.

## الإيقاف والاستعادة

```bash
pnpm dev:stop
pnpm infra:stop
```

يمكن استخدام Ctrl+C في جلسة `pnpm dev`. أمر `dev:stop` يتحقق من PID ومجلد واسم عملية المشروع على Linux قبل إيقافها؛ لا يستخدم kill عاماً. يسجل التطوير PID محلياً تحت `.local` المستبعد من الحزمة. `infra:stop` يحتفظ بالبيانات؛ لا تستخدم `down -v` لحل مشكلة بدء تشغيل.

للتشخيص: `pnpm infra:status`، ثم health/readiness. الحالة 503 عند تعطل اعتماد متوقعة، ولا تعني أن العملية ماتت؛ liveness مستقل. إذا بقيت Keycloak غير جاهزة فانتظر بدءها وافحص سجلات حاويتها محلياً دون نشر بيانات الإعداد. عطل `docker.sock` يحتاج صلاحية Docker المناسبة، ولا يعالج بتوسيع صلاحيات المقبس للجميع.

## CI والملفات

`.github/workflows/ci.yml` تعريف قابل للتشغيل على مستودع مخوّل مستقبلاً؛ لم يربط أو يشغّل على خدمة خارجية في هذه المرحلة. صلاحياته قراءة المحتوى فقط، ولا خطوة نشر أو رفع أسرار. فحوصه نفسها شُغلت محلياً؛ لا تدّعِ نجاح تشغيل GitHub لم يحدث.

يُعاد توليد `packages/contracts/src/v1.generated.ts` من عقد V1 أثناء البناء؛ وجوده لا يعني تنفيذ عملياته. هذا الملف وdist وnode_modules و.env و.local مستبعدة من Git/الحزمة. CHECKSUMS يتتبع المصدر والوثائق وlockfile، ويفحص عدم تسرب قيم كلمات مرور البيئة المحلية إليها. هذا فحص تسرب محدد، لا بديل عن تدقيق أمني كامل.

القفل يتضمن تصحيحين محدودين في pnpm-workspace.yaml: multer 2.3.0 تحت NestJS، وuuid 11.1.1 تحت dockerode؛ يراجعان عند تحديث الحزم الأم. نجح فحص السجل بعدهما، دون ادعاء غياب كل ثغرة ممكنة.
