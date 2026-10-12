import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { Alert, Button, CircularProgress, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthProvider.js';

export function LoginPage() {
  const { t } = useTranslation();
  const { loading, session } = useAuth();
  if (loading)
    return (
      <CircularProgress aria-label={t('loading')} className="page-spinner" />
    );
  if (session.authenticated) return <Navigate to="/" replace />;
  return (
    <main className="auth-page" id="main">
      <section className="auth-card" aria-labelledby="login-title">
        <Typography id="login-title" component="h1" variant="h1">
          {t('brand')}
        </Typography>
        <Typography color="text.secondary">{t('loginIntro')}</Typography>
        <Button
          variant="contained"
          size="large"
          href="/api/v1/auth/login?redirect_after=/"
        >
          {t('signIn')}
        </Button>
        <Typography variant="body2" color="text.secondary">
          {t('loginLocalOnly')}
        </Typography>
      </section>
    </main>
  );
}

export function CallbackPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const error = params.get('error');
  const { refresh } = useAuth();
  const session = useQuery({
    queryKey: ['session-after-callback'],
    queryFn: async () => {
      await refresh();
      return true;
    },
    enabled: !error,
    retry: false,
  });
  useEffect(() => {
    if (!error && session.isSuccess) void navigate('/', { replace: true });
  }, [error, session.isSuccess, navigate]);
  if (error)
    return (
      <main className="auth-page" id="main">
        <section className="auth-card" aria-labelledby="callback-title">
          <Typography id="callback-title" component="h1" variant="h1">
            {t('signIn')}
          </Typography>
          <Alert severity="error">
            {t(`errors.${error}` as 'errors.INTERNAL_ERROR')}
          </Alert>
          <Button
            variant="contained"
            href="/api/v1/auth/login?redirect_after=/"
          >
            {t('retrySignIn')}
          </Button>
          <Button href="/login">{t('backToLogin')}</Button>
        </section>
      </main>
    );
  return (
    <main className="auth-page" id="main">
      <CircularProgress aria-label={t('loading')} />
    </main>
  );
}
