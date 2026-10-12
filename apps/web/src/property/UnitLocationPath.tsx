import { useQuery } from '@tanstack/react-query';
import { Button, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { propertyApi } from '../api/property.js';

/** Fetches one ancestor path per distinct visible location; React Query deduplicates shared locations. */
export function UnitLocationPath({
  tenantId,
  propertyId,
  locationId,
}: {
  tenantId: string;
  propertyId: string;
  locationId: string | null;
}) {
  const { t } = useTranslation();
  const path = useQuery({
    queryKey: ['unit-location-path', tenantId, propertyId, locationId],
    enabled: Boolean(locationId),
    queryFn: () =>
      propertyApi.listLocationChildren(tenantId, propertyId, {
        parent_id: locationId!,
        limit: 1,
      }),
  });
  if (!locationId) return <>{t('psrSetup.root')}</>;
  if (path.isError)
    return (
      <Button onClick={() => void path.refetch()}>{t('psrSetup.retry')}</Button>
    );
  return (
    <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
      {path.data?.ancestors.map((node) => node.name).join(' / ') ?? '…'}
    </Typography>
  );
}
