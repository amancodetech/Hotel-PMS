import { z } from 'zod';
import {
  DISTRIBUTION_SCHEMA_VERSION,
  certaintyLevels,
  revisionTypes,
  safeErrorCodes,
} from '@hotel/contracts';
import type {
  AvailabilitySnapshot,
  ChannelRevisionEnvelope,
  ConnectionContext,
  MappingSnapshot,
  PushResultEnvelope,
  RestrictionSnapshot,
} from '@hotel/contracts';
import { ValidationError } from './errors.js';

const isoInstant = z
  .string()
  .max(40)
  .refine(
    (value) =>
      /Z$|[+-]\d{2}:\d{2}$/.test(value) && Number.isFinite(Date.parse(value)),
    'invalid instant',
  );
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const decimal = z.string().regex(/^\d{1,18}(\.\d{1,2})?$/);
const currency = z.enum(['IDR', 'USD']);
const identifier = z.string().min(1).max(200);
const optionalDecimal = decimal.nullable();
const optionalCurrency = currency.nullable();

const revisionItemSchema = z
  .object({
    item_ref: identifier.nullable(),
    item_ref_stable: z.boolean(),
    external_room_ref: identifier.nullable(),
    external_rate_ref: identifier.nullable(),
    occupancy: z.number().int().min(1).max(64),
    meal_plan_ref: identifier.nullable(),
    arrival: isoDate,
    departure: isoDate,
    amount: optionalDecimal,
    currency: optionalCurrency,
  })
  .strict()
  .superRefine((item, context) => {
    if (Date.parse(item.departure) <= Date.parse(item.arrival))
      context.addIssue({
        code: 'custom',
        message: 'departure must be after arrival',
        path: ['departure'],
      });
    if ((item.amount === null) !== (item.currency === null))
      context.addIssue({
        code: 'custom',
        message: 'amount and currency must both be set or both null',
        path: ['currency'],
      });
  });

export const channelRevisionEnvelopeSchema = z
  .object({
    schema_version: z.literal(DISTRIBUTION_SCHEMA_VERSION),
    provider_key: identifier,
    environment: identifier,
    connection_id: z.string().uuid(),
    channel_key: identifier,
    external_booking_id: identifier,
    provider_booking_id: identifier.nullable(),
    provider_revision_id: identifier,
    revision_type: z.enum(revisionTypes),
    source_sequence: z
      .string()
      .regex(/^\d{1,30}$/)
      .nullable(),
    source_time: isoInstant.nullable(),
    received_at: isoInstant,
    items: z.array(revisionItemSchema).max(500),
    amount_total: optionalDecimal,
    currency: optionalCurrency,
    commission_amount: optionalDecimal,
    tax_amount: optionalDecimal,
    net_amount: optionalDecimal,
    meal_plan_ref: identifier.nullable(),
    occupancy: z.number().int().min(1).max(64).nullable(),
    unmapped_fields: z.array(z.string().min(1).max(200)).max(200),
    payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
    payload_safe_ref: identifier.nullable(),
    sanitized: z.literal(true),
  })
  .strict()
  .superRefine((envelope, context) => {
    if (envelope.revision_type !== 'cancelled' && envelope.items.length === 0)
      context.addIssue({
        code: 'custom',
        message: 'items are required for new and modified revisions',
        path: ['items'],
      });
    if (envelope.amount_total !== null && envelope.currency === null)
      context.addIssue({
        code: 'custom',
        message: 'currency is required when amount_total is present',
        path: ['currency'],
      });
  });

export const pushResultEnvelopeSchema = z
  .object({
    schema_version: z.literal(DISTRIBUTION_SCHEMA_VERSION),
    provider_request_id: identifier.nullable(),
    provider_task_id: identifier.nullable(),
    observed_at: isoInstant,
    certainty: z.enum(certaintyLevels),
    safe_error_code: z.enum(safeErrorCodes).nullable(),
    retry_after_ms: z.number().int().min(0).max(86_400_000).nullable(),
    warnings: z.array(z.string().min(1).max(300)).max(100),
    cell_results: z
      .array(
        z
          .object({
            cell_key: z.string().min(1).max(300),
            status: z.enum(['ACCEPTED', 'REJECTED', 'UNKNOWN', 'PARTIAL']),
            safe_error_code: z.enum(safeErrorCodes).nullable(),
          })
          .strict(),
      )
      .max(20_000),
  })
  .strict();

export const availabilitySnapshotSchema = z
  .object({
    schema_version: z.literal(DISTRIBUTION_SCHEMA_VERSION),
    connection_id: z.string().uuid(),
    channel_key: identifier,
    inventory_version: z.number().int().min(0),
    cells: z
      .array(
        z
          .object({
            product_ref: identifier,
            date: isoDate,
            available: z.number().int().min(0).max(100_000_000),
            inventory_version: z.number().int().min(0),
          })
          .strict(),
      )
      .min(1)
      .max(20_000),
  })
  .strict();

export const restrictionSnapshotSchema = z
  .object({
    schema_version: z.literal(DISTRIBUTION_SCHEMA_VERSION),
    connection_id: z.string().uuid(),
    channel_key: identifier,
    inventory_version: z.number().int().min(0),
    cells: z
      .array(
        z
          .object({
            rate_ref: identifier,
            date: isoDate,
            price: optionalDecimal,
            currency: optionalCurrency,
            min_stay: z.number().int().min(1).max(3650).nullable(),
            max_stay: z.number().int().min(1).max(3650).nullable(),
            stop_sell: z.boolean().nullable(),
            closed_to_arrival: z.boolean().nullable(),
            closed_to_departure: z.boolean().nullable(),
            inventory_version: z.number().int().min(0),
          })
          .strict()
          .superRefine((cell, context) => {
            if ((cell.price === null) !== (cell.currency === null))
              context.addIssue({
                code: 'custom',
                message: 'price and currency must both be set or both null',
                path: ['currency'],
              });
          }),
      )
      .min(1)
      .max(20_000),
  })
  .strict();

export const mappingSnapshotSchema = z
  .object({
    connection_id: z.string().uuid(),
    channel_key: identifier,
    mapping_version: z.number().int().min(0),
    entries: z
      .array(
        z
          .object({
            external_room_ref: identifier,
            external_rate_ref: identifier,
            occupancy: z.number().int().min(1).max(64),
            internal_product_ref: identifier.nullable(),
            internal_rate_ref: identifier.nullable(),
            effective_at: isoInstant,
            status: z.enum(['ACTIVE', 'DRAFT', 'RETIRED']),
          })
          .strict(),
      )
      .max(20_000),
  })
  .strict();

export const connectionContextSchema = z
  .object({
    connection_id: z.string().uuid(),
    tenant_id: z.string().uuid(),
    property_id: z.string().uuid(),
    provider_key: identifier,
    environment: identifier,
    channel_key: identifier,
    secret_ref: identifier,
    external_property_id: identifier.nullable(),
    adapter_version: identifier,
  })
  .strict();

export interface EnvelopePolicy {
  allowedProviderKeys: ReadonlySet<string>;
  allowedChannelKeys: ReadonlySet<string>;
}

function fail(error: z.ZodError): never {
  const fields = [
    ...new Set(error.issues.map((issue) => issue.path.join('.') || '<root>')),
  ];
  throw new ValidationError('Invalid distribution payload', { fields });
}

function parse<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.infer<Schema> {
  const result = schema.safeParse(input);
  if (!result.success) fail(result.error);
  return result.data;
}

export function parseChannelRevisionEnvelope(
  input: unknown,
  policy: EnvelopePolicy,
): ChannelRevisionEnvelope {
  const envelope = parse(channelRevisionEnvelopeSchema, input);
  if (!policy.allowedProviderKeys.has(envelope.provider_key))
    throw new ValidationError('Unknown provider', {
      field: 'provider_key',
    });
  if (!policy.allowedChannelKeys.has(envelope.channel_key))
    throw new ValidationError('Unknown channel', { field: 'channel_key' });
  return envelope;
}

export function parseConnectionContext(input: unknown): ConnectionContext {
  return parse(connectionContextSchema, input);
}

export function parsePushResultEnvelope(input: unknown): PushResultEnvelope {
  return parse(pushResultEnvelopeSchema, input);
}

export function parseAvailabilitySnapshot(
  input: unknown,
): AvailabilitySnapshot {
  return parse(availabilitySnapshotSchema, input);
}

export function parseRestrictionSnapshot(input: unknown): RestrictionSnapshot {
  return parse(restrictionSnapshotSchema, input);
}

export function parseMappingSnapshot(input: unknown): MappingSnapshot {
  return parse(mappingSnapshotSchema, input);
}
