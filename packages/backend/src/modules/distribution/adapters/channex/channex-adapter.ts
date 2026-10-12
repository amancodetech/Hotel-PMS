import type {
  AcknowledgeResult,
  AdapterRequestMeta,
  AvailabilitySnapshot,
  CapabilityEvidence,
  Certainty,
  ChannelAdapter,
  ChannelRevisionEnvelope,
  ConnectionContext,
  MappingSnapshot,
  ProviderStateScope,
  PullPage,
  PushResultEnvelope,
  RestrictionSnapshot,
  SafeErrorCode,
} from '@hotel/contracts';
import {
  DistributionError,
  ValidationError,
  classifyHttpStatus,
} from '../../domain/errors.js';
import { parseConnectionContext } from '../../domain/validation.js';
import {
  HttpPolicyError,
  TransportFailure,
  retryAfterMs,
} from './http-client.js';
import type { HttpClient, HttpClientResponse } from './http-client.js';
import {
  decodeFeedCursor,
  nextFeedCursor,
  normalizeChannexRevision,
} from './normalize.js';
import {
  sanitizeProviderPayload,
  sanitizeWarningCodes,
  toSafeRef,
} from './sanitize.js';

export const channexAdapterVersion = 'channex-0.1.0';

export interface ChannexAdapterOptions {
  baseUrl: string;
  http: HttpClient;
  authHeaderName: string;
  resolveSecret: (secretRef: string) => Promise<string>;
  channelKeyByOtaName?: Record<string, string>;
  capabilitiesFor?: (channelKey: string) => CapabilityEvidence[];
  now?: () => string;
}

export interface ChannexAriState {
  property_id: string;
  observed_at: string;
  availability: Record<string, Record<string, number>>;
  restrictions: Record<
    string,
    Record<string, { rate: string; stop_sell: boolean }>
  >;
  evidence_level: 'PROVIDER_ONLY';
}

interface FailureShape {
  certainty: Certainty;
  safeErrorCode: SafeErrorCode;
  retryAfterMs: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function failureFromError(error: unknown): FailureShape {
  if (error instanceof ValidationError)
    return {
      certainty: 'NOT_SENT',
      safeErrorCode: 'VALIDATION_FAILED',
      retryAfterMs: null,
    };
  if (error instanceof TransportFailure)
    return {
      certainty: error.stage === 'BEFORE_SEND' ? 'NOT_SENT' : 'UNKNOWN',
      safeErrorCode: error.safeCode,
      retryAfterMs: null,
    };
  if (error instanceof HttpPolicyError)
    return {
      certainty: error.stage === 'PRE_REQUEST' ? 'NOT_SENT' : 'UNKNOWN',
      safeErrorCode: error.safeCode,
      retryAfterMs: null,
    };
  return { certainty: 'UNKNOWN', safeErrorCode: 'UNKNOWN', retryAfterMs: null };
}

function failureFromStatus(response: HttpClientResponse): FailureShape {
  const classification = classifyHttpStatus(response.status);
  return {
    certainty: classification.certainty,
    safeErrorCode: classification.code,
    retryAfterMs:
      classification.code === 'RATE_LIMITED'
        ? retryAfterMs(response.headers)
        : null,
  };
}

export class ChannexAdapter implements ChannelAdapter {
  readonly provider_key = 'channex';
  readonly adapter_version = channexAdapterVersion;
  private readonly options: ChannexAdapterOptions;

  constructor(options: ChannexAdapterOptions) {
    this.options = options;
  }

  private async request(
    context: ConnectionContext,
    request: {
      method: 'GET' | 'POST';
      path: string;
      body?: unknown;
      timeoutMs: number;
      correlationId: string;
    },
  ): Promise<HttpClientResponse> {
    parseConnectionContext(context);
    if (context.provider_key !== this.provider_key)
      throw new ValidationError('Connection provider does not match adapter', {
        field: 'provider_key',
      });
    if (!context.external_property_id)
      throw new ValidationError('External provider property is required', {
        field: 'external_property_id',
      });
    if (context.environment === 'staging') {
      const target = new URL(this.options.baseUrl);
      if (
        target.origin !== 'https://staging.channex.io' ||
        target.pathname.replace(/\/$/, '') !== '/api/v1' ||
        target.search ||
        target.hash ||
        target.username ||
        target.password ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          context.external_property_id,
        )
      )
        throw new ValidationError('Staging provider scope is invalid');
    }
    const secret = await this.options.resolveSecret(context.secret_ref);
    if (!secret)
      throw new ValidationError('Provider credential is unavailable');
    return this.options.http({
      method: request.method,
      url: `${this.options.baseUrl.replace(/\/$/, '')}${request.path}`,
      headers: { [this.options.authHeaderName]: secret },
      body: request.body,
      timeoutMs: request.timeoutMs,
      correlationId: request.correlationId,
    });
  }

  async inspectCapabilities(
    context: ConnectionContext,
    _meta: AdapterRequestMeta,
  ): Promise<CapabilityEvidence[]> {
    parseConnectionContext(context);
    return this.options.capabilitiesFor?.(context.channel_key) ?? [];
  }

  async inspectMappings(
    context: ConnectionContext,
    _meta: AdapterRequestMeta,
  ): Promise<MappingSnapshot> {
    parseConnectionContext(context);
    throw new DistributionError(
      'UNSUPPORTED',
      'Mapping inspection requires a P13-verified provider endpoint',
      { provider: this.provider_key },
    );
  }

  async pullRevisions(
    context: ConnectionContext,
    cursor: string | null,
    limit: number,
    meta: AdapterRequestMeta,
  ): Promise<PullPage> {
    const page = cursor === null ? 1 : decodeFeedCursor(cursor);
    const pageSize = Math.max(1, Math.min(200, Math.trunc(limit)));
    let response: HttpClientResponse;
    try {
      response = await this.request(context, {
        method: 'GET',
        path: `/booking_revisions/feed?${new URLSearchParams({ 'filter[property_id]': context.external_property_id ?? '', 'pagination[page]': String(page), 'pagination[limit]': String(pageSize), 'order[inserted_at]': 'asc' })}`,
        timeoutMs: meta.deadline_ms,
        correlationId: meta.correlation_id,
      });
    } catch (error) {
      const failure = failureFromError(error);
      throw new DistributionError(
        failure.safeErrorCode,
        'Provider feed request failed',
      );
    }
    if (response.status >= 400) {
      const classification = classifyHttpStatus(response.status);
      throw new DistributionError(
        classification.code,
        'Provider feed request was rejected',
      );
    }
    const body = asRecord(response.body) ?? {};
    if (!Array.isArray(body.data))
      throw new ValidationError('Provider feed data is invalid');
    const data = body.data;
    const revisions: ChannelRevisionEnvelope[] = [];
    for (const entry of data) {
      const record = asRecord(entry);
      if (!record)
        throw new ValidationError('Provider feed revision is invalid');
      if (
        asRecord(record.attributes)?.property_id !==
        context.external_property_id
      )
        throw new ValidationError(
          'Provider revision property does not match connection',
          { field: 'property_id' },
        );
      const sanitized = sanitizeProviderPayload(record);
      revisions.push(
        normalizeChannexRevision(sanitized.safe, {
          context,
          channelKeyByOtaName: this.options.channelKeyByOtaName,
          sanitized,
          receivedAt: this.options.now?.() ?? new Date().toISOString(),
        }),
      );
    }
    return {
      revisions,
      next_cursor: nextFeedCursor(
        asRecord(body.meta),
        page,
        pageSize,
        revisions.length,
      ),
    };
  }

  async acknowledgeRevision(
    context: ConnectionContext,
    providerRevisionId: string,
    meta: AdapterRequestMeta,
  ): Promise<AcknowledgeResult> {
    const observedAt = this.options.now?.() ?? new Date().toISOString();
    try {
      const revision = await this.request(context, {
        method: 'GET',
        path: `/booking_revisions/${encodeURIComponent(providerRevisionId)}`,
        timeoutMs: meta.deadline_ms,
        correlationId: meta.correlation_id,
      });
      if (revision.status < 200 || revision.status >= 300) {
        const failure = failureFromStatus(revision);
        return {
          certainty: failure.certainty,
          provider_request_id: null,
          observed_at: observedAt,
          safe_error_code: failure.safeErrorCode,
          retry_after_ms: failure.retryAfterMs,
        };
      }
      const entity = asRecord(asRecord(revision.body)?.data);
      if (
        entity?.id !== providerRevisionId ||
        asRecord(entity.attributes)?.property_id !==
          context.external_property_id
      )
        return {
          certainty: 'NOT_SENT',
          provider_request_id: null,
          observed_at: observedAt,
          safe_error_code: 'VALIDATION_FAILED',
          retry_after_ms: null,
        };
      const response = await this.request(context, {
        method: 'POST',
        path: `/booking_revisions/${encodeURIComponent(providerRevisionId)}/ack`,
        timeoutMs: meta.deadline_ms,
        correlationId: meta.correlation_id,
      });
      if (response.status >= 200 && response.status < 300)
        return {
          certainty: 'PROVIDER_ACCEPTED',
          provider_request_id: toSafeRef(response.headers['x-request-id']),
          observed_at: observedAt,
          safe_error_code: null,
          retry_after_ms: null,
        };
      const failure = failureFromStatus(response);
      return {
        certainty: failure.certainty,
        provider_request_id: null,
        observed_at: observedAt,
        safe_error_code: failure.safeErrorCode,
        retry_after_ms: failure.retryAfterMs,
      };
    } catch (error) {
      const failure = failureFromError(error);
      return {
        certainty: failure.certainty,
        provider_request_id: null,
        observed_at: observedAt,
        safe_error_code: failure.safeErrorCode,
        retry_after_ms: failure.retryAfterMs,
      };
    }
  }

  async pushAvailability(
    context: ConnectionContext,
    snapshot: AvailabilitySnapshot,
    meta: AdapterRequestMeta,
  ): Promise<PushResultEnvelope> {
    return this.push(
      context,
      meta,
      '/availability',
      {
        values: snapshot.cells.map((cell) => ({
          property_id: context.external_property_id,
          room_type_id: cell.product_ref,
          date: cell.date,
          availability: cell.available,
        })),
      },
      snapshot.cells.map((cell) => `${cell.product_ref}:${cell.date}`),
    );
  }

  async pushRestrictions(
    context: ConnectionContext,
    snapshot: RestrictionSnapshot,
    meta: AdapterRequestMeta,
  ): Promise<PushResultEnvelope> {
    return this.push(
      context,
      meta,
      '/restrictions',
      {
        values: snapshot.cells.map((cell) => ({
          property_id: context.external_property_id,
          rate_plan_id: cell.rate_ref,
          date: cell.date,
          ...(cell.price !== null ? { rate: cell.price } : {}),
          ...(cell.min_stay !== null
            ? {
                min_stay_arrival: cell.min_stay,
                min_stay_through: cell.min_stay,
              }
            : {}),
          ...(cell.max_stay !== null ? { max_stay: cell.max_stay } : {}),
          ...(cell.stop_sell !== null ? { stop_sell: cell.stop_sell } : {}),
          ...(cell.closed_to_arrival !== null
            ? { closed_to_arrival: cell.closed_to_arrival }
            : {}),
          ...(cell.closed_to_departure !== null
            ? { closed_to_departure: cell.closed_to_departure }
            : {}),
        })),
      },
      snapshot.cells.map((cell) => `${cell.rate_ref}:${cell.date}`),
    );
  }

  async readProviderState(
    context: ConnectionContext,
    _scope: ProviderStateScope,
    _meta: AdapterRequestMeta,
  ): Promise<PushResultEnvelope> {
    parseConnectionContext(context);
    throw new DistributionError(
      'UNSUPPORTED',
      'Provider state readback requires a P13-verified endpoint',
      { provider: this.provider_key },
    );
  }

  // Observations only. This deliberately does not implement the generic proof
  // envelope: that contract cannot express observed values or expected matches.
  async readAriState(
    context: ConnectionContext,
    scope: ProviderStateScope,
    meta: AdapterRequestMeta,
  ): Promise<ChannexAriState> {
    const start = Date.parse(`${scope.date_from}T00:00:00Z`);
    const end = Date.parse(`${scope.date_to}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(scope.date_from) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(scope.date_to) ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end < start ||
      end - start > 99 * 86400000 ||
      new Date(start).toISOString().slice(0, 10) !== scope.date_from ||
      new Date(end).toISOString().slice(0, 10) !== scope.date_to ||
      scope.product_refs.length > 20 ||
      scope.rate_refs.length > 20 ||
      scope.product_refs.length + scope.rate_refs.length === 0 ||
      new Set(scope.product_refs).size !== scope.product_refs.length ||
      new Set(scope.rate_refs).size !== scope.rate_refs.length ||
      [...scope.product_refs, ...scope.rate_refs].some(
        (ref) => !/^[A-Za-z0-9][A-Za-z0-9-]{0,199}$/.test(ref),
      )
    )
      throw new ValidationError('Provider readback scope is invalid');
    const query = new URLSearchParams({
      'filter[property_id]': context.external_property_id ?? '',
      'filter[date][gte]': scope.date_from,
      'filter[date][lte]': scope.date_to,
    });
    const availability: ChannexAriState['availability'] = {};
    const restrictions: ChannexAriState['restrictions'] = {};
    async function load(
      adapter: ChannexAdapter,
      path: string,
    ): Promise<Record<string, unknown>> {
      const response = await adapter.request(context, {
        method: 'GET',
        path,
        timeoutMs: meta.deadline_ms,
        correlationId: meta.correlation_id,
      });
      if (response.status < 200 || response.status >= 300)
        throw new DistributionError(
          failureFromStatus(response).safeErrorCode,
          'Provider readback request failed',
        );
      const data = asRecord(asRecord(response.body)?.data);
      if (!data) throw new ValidationError('Provider readback data is invalid');
      return data;
    }
    const rooms = scope.product_refs.length
      ? await load(this, `/availability?${query}`)
      : {};
    const rates = scope.rate_refs.length
      ? await load(
          this,
          `/restrictions?${query}&filter[restrictions]=rate,stop_sell`,
        )
      : {};
    for (let at = start; at <= end; at += 86400000) {
      const date = new Date(at).toISOString().slice(0, 10);
      for (const ref of scope.product_refs) {
        const value = asRecord(rooms[ref])?.[date];
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
          throw new ValidationError(
            'Provider availability cell is missing or invalid',
          );
        (availability[ref] ??= {})[date] = value;
      }
      for (const ref of scope.rate_refs) {
        const cell = asRecord(asRecord(rates[ref])?.[date]);
        if (
          !cell ||
          typeof cell.stop_sell !== 'boolean' ||
          typeof cell.rate !== 'string' ||
          !/^\d+(\.\d+)?$/.test(cell.rate)
        )
          throw new ValidationError(
            'Provider restriction cell is missing or invalid',
          );
        (restrictions[ref] ??= {})[date] = {
          rate: cell.rate,
          stop_sell: cell.stop_sell,
        };
      }
    }
    return {
      property_id: context.external_property_id ?? '',
      observed_at: this.options.now?.() ?? new Date().toISOString(),
      availability,
      restrictions,
      evidence_level: 'PROVIDER_ONLY',
    };
  }

  async readChannelEvidence(
    context: ConnectionContext,
    _scope: ProviderStateScope,
    _meta: AdapterRequestMeta,
  ): Promise<PushResultEnvelope> {
    parseConnectionContext(context);
    throw new DistributionError(
      'UNSUPPORTED',
      'Channel evidence requires a P13-verified endpoint',
      { provider: this.provider_key },
    );
  }

  private async push(
    context: ConnectionContext,
    meta: AdapterRequestMeta,
    path: string,
    body: Record<string, unknown>,
    cellKeys: string[],
  ): Promise<PushResultEnvelope> {
    const observedAt = this.options.now?.() ?? new Date().toISOString();
    const base = {
      schema_version: 1 as const,
      provider_request_id: null,
      provider_task_id: null,
      observed_at: observedAt,
    };
    let response: HttpClientResponse;
    try {
      response = await this.request(context, {
        method: 'POST',
        path,
        body,
        timeoutMs: meta.deadline_ms,
        correlationId: meta.correlation_id,
      });
    } catch (error) {
      const failure = failureFromError(error);
      return {
        ...base,
        certainty: failure.certainty,
        safe_error_code: failure.safeErrorCode,
        retry_after_ms: failure.retryAfterMs,
        warnings: [],
        cell_results: cellKeys.map((cellKey) => ({
          cell_key: cellKey,
          status: failure.certainty === 'NOT_SENT' ? 'UNKNOWN' : 'UNKNOWN',
          safe_error_code: failure.safeErrorCode,
        })),
      };
    }
    const requestId = toSafeRef(response.headers['x-request-id']);
    if (response.status < 200 || response.status >= 300) {
      const failure = failureFromStatus(response);
      return {
        ...base,
        provider_request_id: requestId,
        certainty: failure.certainty,
        safe_error_code: failure.safeErrorCode,
        retry_after_ms: failure.retryAfterMs,
        warnings: [],
        cell_results: cellKeys.map((cellKey) => ({
          cell_key: cellKey,
          status: failure.certainty === 'REJECTED' ? 'REJECTED' : 'UNKNOWN',
          safe_error_code: failure.safeErrorCode,
        })),
      };
    }
    const responseBody = asRecord(response.body) ?? {};
    const responseMeta = asRecord(responseBody.meta);
    const warnings = sanitizeWarningCodes([
      ...(Array.isArray(responseMeta?.warnings) ? responseMeta.warnings : []),
      ...(Array.isArray(responseBody.warnings) ? responseBody.warnings : []),
    ]);
    const tasks = Array.isArray(responseBody.data)
      ? responseBody.data.map(asRecord)
      : [];
    const acceptedTask =
      tasks.length === 1 &&
      tasks[0]?.type === 'task' &&
      typeof tasks[0]?.id === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        tasks[0].id,
      );
    // An asynchronous task accepts the batch, not individual cells or channel state.
    const cellResults = cellKeys.map((cellKey) => ({
      cell_key: cellKey,
      status: 'UNKNOWN' as const,
      safe_error_code: null,
    }));
    return {
      ...base,
      provider_request_id: requestId,
      provider_task_id: acceptedTask ? toSafeRef(tasks[0]?.id) : null,
      certainty: warnings.length
        ? 'PARTIAL'
        : acceptedTask
          ? 'PROVIDER_ACCEPTED'
          : 'UNKNOWN',
      safe_error_code: acceptedTask ? null : 'PROVIDER_ERROR',
      retry_after_ms: null,
      warnings,
      cell_results: cellResults,
    };
  }
}
