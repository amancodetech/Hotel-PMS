import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Button,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { propertyApi } from '../api/property.js';
import { setupApi } from '../api/setup.js';
import { ErrorAlert } from '../identity/shared.js';

type Simulation = Awaited<ReturnType<typeof setupApi.simulateProduct>>;
export function SetupProductSimulation({
  tenantId,
  propertyId,
}: {
  tenantId: string;
  propertyId: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [product, setProduct] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [adults, setAdults] = useState(1);
  const [quantity, setQuantity] = useState(1);
  const [result, setResult] = useState<Simulation | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const products = useQuery({
    queryKey: ['products', tenantId, propertyId],
    enabled: open,
    queryFn: () => propertyApi.listProducts(tenantId, propertyId),
  });
  function invalidate() {
    generation.current++;
    setResult(null);
    setError(null);
    setBusy(false);
  }
  async function simulate() {
    const current = ++generation.current;
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const response = await setupApi.simulateProduct(tenantId, propertyId, {
        product_id: product,
        from,
        to,
        adults,
        quantity,
      });
      if (current === generation.current) setResult(response);
    } catch (e) {
      if (current === generation.current) setError(e);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  return (
    <Paper variant="outlined" sx={{ p: 2, my: 2 }}>
      <Button
        onClick={() => {
          invalidate();
          setOpen(!open);
        }}
        aria-expanded={open}
      >
        {t('psrSetup.simulateTitle')}
      </Button>
      {open && (
        <Stack spacing={2}>
          <Alert severity="info">{t('psrSetup.simulateNotice')}</Alert>
          <ErrorAlert error={error ?? products.error} />
          <TextField
            fullWidth
            select
            label={t('product')}
            value={product}
            disabled={products.isLoading}
            onChange={(e) => {
              invalidate();
              setProduct(e.target.value);
            }}
          >
            {(products.data?.items ?? [])
              .filter((p) => p.status === 'ACTIVE')
              .map((p) => (
                <MenuItem key={p.id} value={p.id}>
                  {p.name} · {t(`resourceTypes.${p.kind}`)}
                </MenuItem>
              ))}
          </TextField>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            sx={{ '& .MuiTextField-root': { flex: 1, minWidth: 0 } }}
          >
            <TextField
              fullWidth
              type="date"
              label={t('psrSetup.simulateFrom')}
              InputLabelProps={{ shrink: true }}
              value={from}
              onChange={(e) => {
                invalidate();
                setFrom(e.target.value);
              }}
            />
            <TextField
              fullWidth
              type="date"
              label={t('psrSetup.simulateTo')}
              InputLabelProps={{ shrink: true }}
              value={to}
              onChange={(e) => {
                invalidate();
                setTo(e.target.value);
              }}
            />
            <TextField
              fullWidth
              type="number"
              label={t('psrSetup.simulateGuests')}
              inputProps={{ min: 1, max: 100 }}
              value={adults}
              onChange={(e) => {
                invalidate();
                setAdults(Number(e.target.value));
              }}
            />
            <TextField
              fullWidth
              type="number"
              label={t('psrSetup.simulateQuantity')}
              inputProps={{ min: 1, max: 20 }}
              value={quantity}
              onChange={(e) => {
                invalidate();
                setQuantity(Number(e.target.value));
              }}
            />
          </Stack>
          <Button
            variant="outlined"
            disabled={
              busy ||
              !product ||
              !from ||
              to <= from ||
              adults < 1 ||
              quantity < 1
            }
            onClick={() => void simulate()}
          >
            {t('psrSetup.simulateRun')}
          </Button>
          {result && (
            <>
              <Alert
                severity={result.result === 'AVAILABLE' ? 'success' : 'warning'}
              >
                {t(`availabilityResult.${result.result}`, {
                  defaultValue: t(`psrSetup.simulation_${result.result}`),
                })}
              </Alert>
              {result.reason_codes.map((reason) => (
                <Typography key={reason}>
                  {t(`reason.${reason}`, {
                    defaultValue: t('psrSetup.simulation_UNDETERMINED'),
                  })}
                </Typography>
              ))}
              {result.units.length > 0 && (
                <Typography>
                  {t('psrSetup.simulateResources')}:{' '}
                  {result.units
                    .flatMap((u) => u.resources.map((r) => r.code))
                    .join('، ')}
                </Typography>
              )}
              <Typography variant="caption">
                {t('psrSetup.simulateSnapshot')}
              </Typography>
            </>
          )}
        </Stack>
      )}
    </Paper>
  );
}
