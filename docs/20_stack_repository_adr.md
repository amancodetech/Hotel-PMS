# ADR D-12: المستودع والـStack

تحديث التنفيذ 13 سبتمبر 2026: أنشئت مسارات المرحلة 1 وأصبح Git المحلي صالحاً باستخدام دليله الموجود دون حذفه. الإصدارات الدقيقة في manifests وpnpm-lock.yaml، والتشغيل والنتائج في docs/28..29. لا بنية سحابية أو حسابات خارجية. Computer Use هو وسيلة القبول البصري المطلوبة لهذه المرحلة بتعليمات المستخدم الأحدث؛ لم يستخدم Playwright ولم يتوفر Computer Use. وصف عدم التنفيذ أدناه يوثق تاريخ قرار التصميم السابق.

الحالة: DECIDED بتفويض المستخدم لاختيار الـStack وحسم المستودع، 12 سبتمبر 2026. قرار تصميم؛ لم تنشأ تطبيقات أو بنية سحابية أو حسابات.

## الدليل والقرار

فحص المجلد /home/omar/Desktop/Hotel أظهر README وAGENTS ومواصفات docs ومراجع references، دون manifests أو كود تطبيق. أمر git rev-parse فشل؛ وجود دليل .git لا يثبت مستودعاً صالحاً. نعتمد المجلد الحالي جذر Monorepo للمنتج باسم hotel-pms-saas ونحافظ على وثائقه. تهيئة Git الفعلية تعالج في المرحلة 1 بعد فحص صلاحيات الدليل؛ لا حذف أو استبدال .git الموجود. لم يحدد remote ولم ننشئ مستودعاً خارجياً.

## الاختيارات المعتمدة

| الطبقة | الاختيار | السبب وحدود المسؤولية |
|---|---|---|
| اللغة والأدوات | TypeScript strict، Node.js LTS، pnpm workspaces | لغة واحدة للواجهة والخدمات وعقود التكامل؛ تثبيت الإصدارات المتوافقة في lockfile بالمرحلة 1 |
| واجهة التشغيل | React + Vite + React Router + TanStack Query | لوحة تشغيل داخلية تعتمد REST؛ فصل حالة الخادم والتنقل عن منطق المجال |
| مكونات وتوطين | MUI، react-i18next، Intl | مكونات تشغيلية مع RTL/LTR؛ ar وid-ID وen-US، واختبار الترجمة والاتجاه قبل اعتماد الشاشة |
| Backend | NestJS مع Express، Versioned REST وOpenAPI | Modules وحدود Application/Domain واضحة؛ Controller يفوض ولا يضمن المخزون بنفسه |
| التخزين | PostgreSQL + MikroORM ومهاجراته | معاملات وأقفال صريحة؛ ORM في Persistence فقط، والقيود وRLS تتطلب مهاجرات مخصصة ومراجعة |
| المهام | Redis + BullMQ وWorkers من نفس وحدات Backend | فصل تنفيذ الأعمال غير المتزامنة؛ PostgreSQL Outbox مصدر نية الإرسال ولا يعتمد ضمان المخزون على Redis |
| الهوية | Keycloak عبر OIDC | تسجيل الدخول وMFA وتهيئة SSO مؤسسي؛ العضويات والصلاحيات ونطاق المنشأة يملكها التطبيق |
| الجلسات | NestJS يدير OIDC وجلسة خادمية بملف ارتباط HttpOnly/Secure | الرموز لا تخزن في localStorage؛ حماية CSRF والتحقق من العضوية عند كل إجراء |
| النشر | Docker، AWS Jakarta ap-southeast-3، ECS Fargate وALB | API وWorkers وKeycloak عمليات منفصلة؛ تبقى خدمات المجال Modular Monolith |
| خدمات AWS | RDS PostgreSQL، ElastiCache Redis OSS، S3 خاص، Secrets Manager، CloudWatch | اختيار معماري؛ توافر الإصدارات والسعات في المنطقة والتكلفة يثبت قبل إنشاء الموارد |
| الاختبار والرصد | Jest، Testing Library، Playwright، Testcontainers، OpenTelemetry | اختبار PostgreSQL فعلي للعزل والتزامن؛ traces مترابطة بلا بيانات نزلاء خام |

لا نفترض خبرة سابقة للفريق لم يقدمها المستخدم. هذا اختيار مبني على طبيعة لوحة التشغيل وتكاملات القنوات وحدود الوحدات. التثبيت الدقيق للإصدارات والتكلفة والسعة مهام المرحلة 1، وليس قرار Stack مفتوحاً من جديد. اختيار AWS لا يمثل تفويضاً بإنفاق أو نشر.

## التنظيم عند تفويض البرمجة

هذه مسارات موثقة فقط، لم تنشأ بعد: apps/web للواجهة، apps/api لخدمات NestJS، apps/worker لتشغيل Jobs؛ packages/backend للوحدات المشتركة بين API وWorkers، packages/contracts لعقود النقل المولدة، packages/ui وpackages/i18n؛ infra لتعريفات التشغيل لاحقاً. docs وreferences يبقيان في مكانهما.

داخل كل وحدة Backend: Application ثم Domain ثم Persistence/Adapters؛ مشاركة الكود بين العمليات لا تتيح الكتابة المباشرة في ملكية وحدة أخرى. الواجهة لا تستورد كيانات ORM. قاعدة التطبيق المشتركة تحتفظ بـtenant_id وRLS، وقاعدة هوية Keycloak منفصلة منطقياً وبصلاحيات مستقلة.

## التبعات والبدائل

اختير NestJS لتوحيد TypeScript وحدود الوحدات؛ Django أو Laravel بدائل صالحة لكن إدخال لغة Backend ثانية لا يقدم هنا سبباً كافياً. اختير React/Vite للوحة الموظفين؛ SSR للحجز العام يمكن حسمه ضمن المرحلة 14 دون نقل قواعد الحجز إلى الواجهة. اختير MikroORM للتحكم الصريح بالمعاملات؛ لا يوفر تلقائياً عزل Tenant أو صحة تركيب فيلا.

Keycloak يضيف عبء تحديث وتشغيل ونسخ احتياطي، لكنه يجمع الهوية وMFA والتكامل المؤسسي في حل قائم. تشغيله لا يمنح مدير الهوية حق قراءة حجوزات العملاء. اختير AWS Jakarta لقرب سوق الإطلاق، ولا تعد المنطقة وحدها إثباتاً للامتثال أو لإقامة كل البيانات؛ تراجع وجهات النسخ والسجلات والمزودين عند النشر.

## بوابة القبول

AT-T01: تشغيل API وWorker على نفس مورد اختباري متزامناً يثبت التزاماً واحداً وOutbox دون فقد. AT-T02: إعادة استعمال اتصال DB بين عميلين، بما في ذلك Jobs، لا تنقل السياق؛ دور التطبيق ليس مالك الجداول ولا BYPASSRLS. AT-T03: تسجيل الدخول والخروج وإبطال العضوية والجلسة وMFA يعمل دون رموز مكشوفة. AT-T04: بناء الواجهة والعقود وخدمات Backend من Monorepo واحد دون استيراد ORM في الواجهة. هذه مواصفات غير منفذة.

## مصادر الاختيار

اطلاع 12 سبتمبر 2026: [NestJS Authorization](https://docs.nestjs.com/security/authorization)، [معاملات MikroORM](https://mikro-orm.io/docs/transactions)، [PostgreSQL RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)، [React وبناء تطبيق مستقل](https://react.dev/learn/build-a-react-app-from-scratch)، [BullMQ](https://docs.bullmq.io/)، [Keycloak](https://www.keycloak.org/guides)، [مناطق AWS](https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html). المصادر تثبت القدرات العامة؛ اختيار المجموعة للمشروع حكم هندسي وليست توصية صادرة من هذه الجهات.
