import { lazy, Suspense } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Button, Stack } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthProvider.js';
import { setupApi } from '../api/setup.js';
import { ErrorAlert, ForbiddenPanel } from '../identity/shared.js';
import { LoadingBlock } from '../identity/TenantSelectPage.js';

const LegacyWizard = lazy(() =>
  import('./SetupWizardPreviewPage.js').then((module) => ({
    default: module.SetupWizardPreviewPage,
  })),
);

function hasLocalDraft(tenantId: string | null): boolean {
  if (!tenantId) return false;
  try {
    // A malformed saved value must still reach the existing recovery UI.
    return (
      window.localStorage.getItem(`hotel:setup-wizard-preview:${tenantId}`) !==
      null
    );
  } catch {
    // Storage failure is not proof that the user's draft is absent.
    return true;
  }
}

// Keep local and server v1 drafts on their original editor. A v1 BEDS pool
// spanning rooms cannot be translated into v2 without changing its promise.
export function LegacySetupEntryPage() {
  const [params] = useSearchParams();
  const propertyId = params.get('propertyId');
  const validPropertyId = Boolean(
    propertyId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      propertyId,
    ),
  );
  const { activeTenantId, hasPermission, loading } = useAuth();
  const { t } = useTranslation();
  const serverMode =
    validPropertyId &&
    Boolean(activeTenantId) &&
    hasPermission('property.read');
  const draft = useQuery({
    queryKey: ['legacy-setup-entry', activeTenantId, propertyId],
    queryFn: () => setupApi.getDraft(activeTenantId!, propertyId!),
    enabled: serverMode,
    staleTime: 0,
  });
  if (loading) return <LoadingBlock />;
  if (!activeTenantId || (propertyId && !validPropertyId))
    return <Navigate replace to="/properties" />;
  if (propertyId && !hasPermission('property.read')) return <ForbiddenPanel />;
  if (serverMode && draft.isPending) return <LoadingBlock />;
  if (serverMode && draft.isError)
    return (
      <Stack spacing={2}>
        <ErrorAlert error={draft.error} />
        <Button onClick={() => void draft.refetch()}>
          {t('psrSetup.reload')}
        </Button>
      </Stack>
    );
  if (draft.data?.draft && 'schema_version' in draft.data.draft.input)
    return <Navigate replace to={`/properties/${propertyId}/structure`} />;
  if (serverMode && !draft.data?.draft)
    return <Navigate replace to={`/properties/${propertyId}/structure`} />;
  if (!propertyId && !hasLocalDraft(activeTenantId))
    return <Navigate replace to="/properties" />;
  return (
    <Suspense fallback={<LoadingBlock />}>
      <LegacyWizard key={`${activeTenantId}:${propertyId}`} resumeOnly />
    </Suspense>
  );
}

export function LegacyStructureRedirect() {
  const [params] = useSearchParams();
  const propertyId = params.get('propertyId');
  const validId =
    propertyId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      propertyId,
    );
  return (
    <Navigate
      replace
      to={validId ? `/properties/${propertyId}/structure` : '/properties'}
    />
  );
}
