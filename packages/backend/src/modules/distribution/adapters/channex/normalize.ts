import type {
  ChannelRevisionEnvelope,
  ConnectionContext,
  RevisionItem,
  RevisionType,
} from '@hotel/contracts';
import { ValidationError } from '../../domain/errors.js';
import { hashPayload } from '../../domain/hash.js';
import type { SanitizeResult } from './sanitize.js';

const knownAttributeKeys = new Set([
  'id',
  'booking_id',
  'revision_id',
  'status',
  'property_id',
  'ota_name',
  'ota_reservation_code',
  'amount',
  'currency',
  'commission',
  'taxes',
  'created_at',
  'updated_at',
  'inserted_at',
  'rooms',
  'customer',
  'guests',
  'values',
  'services',
  'addons',
]);

const statusMap: Record<string, RevisionType> = {
  new: 'new',
  created: 'new',
  modified: 'modified',
  modification: 'modified',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  cancellation: 'cancelled',
};

export interface NormalizeOptions {
  context: ConnectionContext;
  channelKeyByOtaName?: Record<string, string>;
  sanitized: SanitizeResult;
  receivedAt: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function normalizeChannelKey(
  channelKey: string,
  map: Record<string, string>,
): string | null {
  const direct = map[channelKey];
  if (direct) return direct;
  const canonical = channelKey.trim().toLowerCase().replace(/\s+/g, '');
  return map[canonical] ?? null;
}

function mapItem(room: Record<string, unknown>): RevisionItem {
  const details = asRecord(room.occupancy);
  let occupancy: number;
  if (details) {
    const counts = ['adults', 'children', 'infants'].map((key) => details[key]);
    if (
      counts.some(
        (count) =>
          typeof count !== 'number' || !Number.isInteger(count) || count < 0,
      ) ||
      Number(counts[0]) < 1
    )
      throw new ValidationError('Provider room occupancy is invalid', {
        field: 'rooms.occupancy',
      });
    if (counts[1] !== 0 || counts[2] !== 0)
      throw new ValidationError(
        'Provider child or infant occupancy is unsupported',
        { field: 'rooms.occupancy' },
      );
    // The current reservation contract consumes this scalar as adults. Never
    // collapse children/infants into adults before structured occupancy exists.
    occupancy = Number(counts[0]);
  } else {
    // Preserve legacy numeric fixtures, but never guess a missing or malformed count.
    occupancy = room.occupancy as number;
  }
  if (!Number.isInteger(occupancy) || occupancy < 1 || occupancy > 64)
    throw new ValidationError('Provider room occupancy is invalid', {
      field: 'rooms.occupancy',
    });
  return {
    item_ref: asString(room.id),
    item_ref_stable: typeof room.id === 'string' && room.id.length > 0,
    external_room_ref: asString(room.room_type_id),
    external_rate_ref: asString(room.rate_plan_id),
    occupancy,
    meal_plan_ref: asString(room.meal_plan),
    arrival: asString(room.checkin_date) ?? asString(room.arrival_date) ?? '',
    departure:
      asString(room.checkout_date) ?? asString(room.departure_date) ?? '',
    amount: asString(room.amount),
    currency: asString(room.currency),
  };
}

export function normalizeChannexRevision(
  raw: Record<string, unknown>,
  options: NormalizeOptions,
): ChannelRevisionEnvelope {
  const attributes = asRecord(raw.attributes) ?? raw;
  if (
    !options.context.external_property_id ||
    attributes.property_id !== options.context.external_property_id
  )
    throw new ValidationError(
      'Provider revision property does not match connection',
      { field: 'property_id' },
    );
  const revisionId =
    asString(attributes.revision_id) ?? asString(raw.id) ?? null;
  if (!revisionId)
    throw new ValidationError('Provider revision id is missing', {
      field: 'revision_id',
    });
  const status = asString(attributes.status)?.toLowerCase() ?? '';
  const revisionType = statusMap[status];
  if (!revisionType)
    throw new ValidationError('Provider revision status is not supported', {
      field: 'status',
    });
  const externalBookingId =
    asString(attributes.booking_id) ??
    asString(attributes.ota_reservation_code) ??
    null;
  if (!externalBookingId)
    throw new ValidationError('External booking id is missing', {
      field: 'booking_id',
    });

  const unmappedFields = [...options.sanitized.removedFields];
  for (const key of Object.keys(attributes))
    if (!knownAttributeKeys.has(key)) unmappedFields.push(`attributes.${key}`);

  let channelKey = options.context.channel_key;
  const otaName = asString(attributes.ota_name);
  if (otaName) {
    const mapped = normalizeChannelKey(
      otaName,
      options.channelKeyByOtaName ?? {},
    );
    if (mapped) channelKey = mapped;
    else unmappedFields.push('attributes.ota_name');
  }

  const rooms = Array.isArray(attributes.rooms) ? attributes.rooms : [];
  const items: RevisionItem[] = rooms
    .map((room) => asRecord(room))
    .filter((room): room is Record<string, unknown> => room !== null)
    .map(mapItem);
  if (revisionType !== 'cancelled' && items.length === 0)
    throw new ValidationError('Provider revision has no rooms', {
      field: 'rooms',
    });

  const payload = {
    provider_revision_id: revisionId,
    revision_type: revisionType,
    external_booking_id: externalBookingId,
    provider_booking_id: asString(attributes.booking_id),
    source_sequence: null,
    source_time:
      asString(attributes.updated_at) ?? asString(attributes.inserted_at),
    channel_key: channelKey,
    items,
    amount_total: asString(attributes.amount),
    currency: asString(attributes.currency),
    commission_amount: asString(attributes.commission),
    tax_amount: asString(attributes.taxes),
    net_amount: null,
    meal_plan_ref: null,
    occupancy: items[0]?.occupancy ?? null,
    unmapped_fields: [...new Set(unmappedFields)].sort(),
    payload_variant: null,
  };

  return {
    schema_version: 1,
    provider_key: 'channex',
    environment: options.context.environment,
    connection_id: options.context.connection_id,
    channel_key: channelKey,
    external_booking_id: externalBookingId,
    provider_booking_id: asString(attributes.booking_id),
    provider_revision_id: revisionId,
    revision_type: revisionType,
    source_sequence: null,
    source_time:
      asString(attributes.updated_at) ?? asString(attributes.inserted_at),
    received_at: options.receivedAt,
    items,
    amount_total: asString(attributes.amount),
    currency: asString(attributes.currency),
    commission_amount: asString(attributes.commission),
    tax_amount: asString(attributes.taxes),
    net_amount: null,
    meal_plan_ref: null,
    occupancy: items[0]?.occupancy ?? null,
    unmapped_fields: payload.unmapped_fields,
    payload_hash: hashPayload(payload),
    payload_safe_ref: null,
    sanitized: true,
  };
}

export function encodeFeedCursor(page: number): string {
  return Buffer.from(JSON.stringify({ v: 1, page })).toString('base64url');
}

export function decodeFeedCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as { v?: unknown; page?: unknown };
    const page = parsed.page;
    if (
      parsed.v !== 1 ||
      typeof page !== 'number' ||
      !Number.isInteger(page) ||
      page < 1
    )
      throw new Error('bad cursor');
    return page;
  } catch {
    throw new ValidationError('Invalid provider feed cursor');
  }
}

export function nextFeedCursor(
  meta: Record<string, unknown> | null,
  requestedPage: number,
  requestedLimit: number,
  fetched: number,
): string | null {
  const total = Number(meta?.total);
  if (Number.isFinite(total) && total > 0)
    return requestedPage * requestedLimit < total
      ? encodeFeedCursor(requestedPage + 1)
      : null;
  if (fetched >= requestedLimit) return encodeFeedCursor(requestedPage + 1);
  return null;
}
