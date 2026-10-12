/**
 * P11 reporting metric catalog. Every number carries a declared unit of
 * measure and a declared physical or operational basis, per docs/13 and D-08.
 * Ratios never divide by zero: they are `null` with `zero_denominator: true`,
 * not a misleading zero. Composite products (villa + its rooms) and mixed
 * resource types (beds + rooms) are reported as separate labeled metrics and
 * must never be summed into one figure (AT-22/23, REP-001).
 */
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
  'PORTFOLIO',
] as const;

export type ReportKind = (typeof reportKinds)[number];

export type ReportDomain = 'OPERATIONAL' | 'FINANCIAL';

export interface ReportKindDefinition {
  readonly domain: ReportDomain;
  readonly descriptionKey: string;
  /** Financial kinds additionally require `report.financial.view`. */
  readonly requiresCurrency: boolean;
}

export const reportKindDefinitions: Record<ReportKind, ReportKindDefinition> = {
  OCCUPANCY: {
    domain: 'OPERATIONAL',
    descriptionKey: 'reports.kinds.OCCUPANCY',
    requiresCurrency: false,
  },
  ADR_REVPAR: {
    domain: 'FINANCIAL',
    descriptionKey: 'reports.kinds.ADR_REVPAR',
    requiresCurrency: true,
  },
  ARRIVALS: {
    domain: 'OPERATIONAL',
    descriptionKey: 'reports.kinds.ARRIVALS',
    requiresCurrency: false,
  },
  DEPARTURES: {
    domain: 'OPERATIONAL',
    descriptionKey: 'reports.kinds.DEPARTURES',
    requiresCurrency: false,
  },
  PICKUP: {
    domain: 'OPERATIONAL',
    descriptionKey: 'reports.kinds.PICKUP',
    requiresCurrency: false,
  },
  REVENUE: {
    domain: 'FINANCIAL',
    descriptionKey: 'reports.kinds.REVENUE',
    requiresCurrency: true,
  },
  TAX: {
    domain: 'FINANCIAL',
    descriptionKey: 'reports.kinds.TAX',
    requiresCurrency: true,
  },
  SETTLEMENTS: {
    domain: 'FINANCIAL',
    descriptionKey: 'reports.kinds.SETTLEMENTS',
    requiresCurrency: true,
  },
  CHANNEL_PERFORMANCE: {
    domain: 'FINANCIAL',
    descriptionKey: 'reports.kinds.CHANNEL_PERFORMANCE',
    requiresCurrency: true,
  },
  PORTFOLIO: {
    domain: 'FINANCIAL',
    descriptionKey: 'reports.kinds.PORTFOLIO',
    requiresCurrency: true,
  },
};

export function isReportKind(value: string): value is ReportKind {
  return Object.hasOwn(reportKindDefinitions, value);
}

/**
 * Declared bases. `PHYSICAL` counts every active resource of the type (D-08:
 * the original physical denominator is always shown). `OPERATIONAL` removes
 * OOO resource-nights from the denominator and keeps OOS visible as downtime.
 * `CURRENT_STATE` reads the resource maintenance snapshot as of now.
 */
export const reportBases = [
  'PHYSICAL',
  'OPERATIONAL',
  'CURRENT_STATE',
  'ACTIVE_ITEM_NIGHTS',
  'SNAPSHOT_DIFF_ACTIVE_ITEM_NIGHTS',
  'POSTED_JOURNAL',
  'POSTED_CHARGES',
  'PAYMENT_RECORDS',
  'CHANNEL_RECORDS',
] as const;

export type ReportBasis = (typeof reportBases)[number];

export interface ReportMetric {
  readonly key: string;
  readonly label: string;
  readonly value: string | null;
  readonly unit: string;
  readonly basis: ReportBasis;
  readonly numerator: string | null;
  readonly denominator: string | null;
  readonly zero_denominator: boolean;
  readonly null_reason: string | null;
}

export function metric(input: {
  key: string;
  label: string;
  value: string | number | null;
  unit: string;
  basis: ReportBasis;
  numerator?: string | number | null;
  denominator?: string | number | null;
  nullReason?: string | null;
}): ReportMetric {
  const asText = (value: string | number | null | undefined) =>
    value === null || value === undefined ? null : String(value);
  const numerator = asText(input.numerator);
  const denominator = asText(input.denominator);
  return {
    key: input.key,
    label: input.label,
    value: asText(input.value),
    unit: input.unit,
    basis: input.basis,
    numerator,
    denominator,
    zero_denominator:
      input.value === null &&
      input.nullReason === 'DENOMINATOR_ZERO' &&
      denominator !== null,
    null_reason: input.value === null ? (input.nullReason ?? null) : null,
  };
}

/**
 * Ratio with 6 intermediate decimals (same precision rule as D-14 for
 * non-money ratios) computed with scaled integers, not binary floats.
 * A zero denominator returns null with reason DENOMINATOR_ZERO.
 */
export function ratioMetric(input: {
  key: string;
  label: string;
  numerator: bigint;
  denominator: bigint;
  unit: string;
  basis: ReportBasis;
}): ReportMetric {
  if (input.denominator === 0n)
    return metric({
      key: input.key,
      label: input.label,
      value: null,
      unit: input.unit,
      basis: input.basis,
      numerator: input.numerator.toString(),
      denominator: input.denominator.toString(),
      nullReason: 'DENOMINATOR_ZERO',
    });
  const scale = 1_000_000n;
  const scaled =
    (input.numerator * scale * 2n + input.denominator) /
    (input.denominator * 2n);
  const whole = scaled / scale;
  const fraction = (scaled % scale).toString().padStart(6, '0');
  return metric({
    key: input.key,
    label: input.label,
    value: `${whole}.${fraction}`,
    unit: input.unit,
    basis: input.basis,
    numerator: input.numerator.toString(),
    denominator: input.denominator.toString(),
  });
}

export function daysBetween(
  fromInclusive: string,
  toExclusive: string,
): number {
  const from = Date.parse(`${fromInclusive}T00:00:00Z`);
  const to = Date.parse(`${toExclusive}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

export function periodNights(from: string, to: string): number {
  return Math.max(0, daysBetween(from, to));
}
