# فصل بيئات staging/production وفق D-12

الحالة: **إعداد وتحقق محلي فقط**؛ لا موارد سحابية ولا أسرار حقيقية ولا نشر. إنشاء الموارد أو
النشر يحتاج تفويضاً خارجياً منفصلاً (EX-05)، والتطبيق الحالي يرفض الإنتاج عمداً حتى ينفذ ذلك.

## الملفات

| الملف                                              | الغرض                                               |
| -------------------------------------------------- | --------------------------------------------------- |
| `staging.env.example`                              | متغيرات بيئة staging المطلوبة بقيم عنصر نائب فقط    |
| `production.env.example`                           | متغيرات بيئة production المطلوبة بقيم عنصر نائب فقط |
| `../../packages/backend/src/deployment/profile.ts` | فاحص الملف الصارم (fail-closed)                     |
| `../../scripts/production-config-check.mjs`        | مشغل الفحص مع تنقيح الأسرار                         |

الأمثلة مفصولة تماماً عن `.env` المحلي: لا يقرأها التطبيق في وضع التطوير، ولا تُحمّل تلقائياً.
التحقق لا يعني اعتماداً بيئياً، وأي قيمة حقيقية تُدار عبر مخزن أسرار و`secret_ref` حسب
[docs/33](../../docs/33_channel_extension_contract.md).

## القواعد المفروضة (كلها إلزامية)

- **TLS**: كل عناوين الويب وOIDC وOTLP وwebhook بـ`https`، وPostgres بـ`sslmode=require`
  أو أقوى، وRedis بـ`rediss://`. أي عنوان loopback/محلي مرفوض.
- **الأسرار**: لا أسرار في ملفات البيئة (`SECRET_SOURCE` = `aws-secrets-manager` أو `vault`)،
  وكلمة مرور قاعدة البيانات والRedis و`KEYCLOAK_CLIENT_SECRET` بطول أدنى، ودور API ودور
  العامل منفصلان (أقل صلاحية).
- **العزل**: `RLS_ENFORCEMENT=require-force` و`TENANT_CONTEXT_MODE=session`؛ لا تشغيل بدون
  فرض RLS.
- **المراقبة**: `LOG_LEVEL` بلا debug، وendpoint OTLP وwebhook تنبيهات عامان بـhttps.
- **النسخ والاستعادة**: هدف `s3://`، جدول cron، احتفاظ ≥ 7 أيام، وهدفا RPO/RTO بالدقائق.
  في production يلزم `RESTORE_TEST_REF` يثبت اختبار استعادة موثقاً.
- **القنوات الحية**: `DISTRIBUTION_WORKER=on` يلزمه `LIVE_PROVIDER_KEYS` و
  `CHANNEL_LIVE_AUTHORIZATION_REF`؛ و`simulator` مرفوض في staging/production.
- **production فقط**: `COST_APPROVAL_REF` و`PRODUCTION_AUTHORIZATION_REF` إلزاميان؛ غيابهما
  يفشل الفحص.

## التكلفة (مؤشر تحضيري فقط)

كل أرقام التكلفة تبقى غير معتمدة حتى عرض سعر رسمي وموافقة إنفاق (EX-05). المؤشر المنشور
لمزود الاتصال في [docs/22](../../docs/22_connectivity_evidence.md)، وتقدير AWS يُبنى على بنية
D-12 (RDS PostgreSQL + ElastiCache + S3 خاص + Secrets Manager + CloudWatch) ويُقاس قبل pilot.
لا شراء ولا إنشاء مورد في هذه الحزمة.

## الاستخدام

```bash
# يجب أن يفشل: مثال بلا أسرار
node scripts/production-config-check.mjs --profile=production \
  --env-file=infra/environments/production.env.example

# يجب أن ينجح فقط عند اكتمال المتطلبات (تحقق محلي وليس تفويض نشر)
node scripts/production-config-check.mjs --profile=production --env-file=/path/to/complete.env
```

## الحماية المحلية الباقية

`loadConfig` في التطبيق ما زال يرفض `NODE_ENV=production` وكل URL غير محلي؛ لا تغيّر P13 ذلك.
الفاحص أداة تحقق مستقلة لبيئة مستقبلية، وليس طريقاً لتشغيل الإنتاج محلياً.
