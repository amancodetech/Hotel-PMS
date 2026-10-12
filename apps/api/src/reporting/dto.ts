import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const reportKinds = [
  'OCCUPANCY',
  'ADR_REVPAR',
  'ARRIVALS',
  'DEPARTURES',
  'PICKUP',
  'REVENUE',
  'TAX',
  'SETTLEMENTS',
  'CHANNEL_PERFORMANCE',
] as const;

export const readReportBody = z
  .object({
    kind: z.enum(reportKinds),
    period: z.object({ date_from: isoDate, date_to: isoDate }).strict(),
    currency: z.enum(['IDR', 'USD']).optional(),
    resource_type: z.string().min(1).max(32).optional(),
    reference_date: isoDate.optional(),
  })
  .strict();

export const captureSnapshotBody = z
  .object({ reference_date: isoDate.optional() })
  .strict();

export const exportReportBody = readReportBody
  .extend({ format: z.literal('CSV').optional() })
  .strict();

export const exportTenantReportBody = z
  .object({
    kind: z.enum(['PORTFOLIO']),
    period: z.object({ date_from: isoDate, date_to: isoDate }).strict(),
    currency: z.enum(['IDR', 'USD']),
    format: z.literal('CSV').optional(),
  })
  .strict();

export const listExportsQuery = z
  .object({ property_id: z.string().uuid().optional() })
  .strict();

export const readTenantReportBody = z
  .object({
    kind: z.enum(['PORTFOLIO']),
    period: z.object({ date_from: isoDate, date_to: isoDate }).strict(),
    currency: z.enum(['IDR', 'USD']),
    property_ids: z.array(z.string().uuid()).max(50).optional(),
  })
  .strict();
