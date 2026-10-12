import type { SafeErrorCode } from '@hotel/contracts';

export interface HttpClientRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  correlationId: string;
}

export interface HttpClientResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: unknown;
}

export type HttpClient = (
  request: HttpClientRequest,
) => Promise<HttpClientResponse>;

export class TransportFailure extends Error {
  constructor(
    public readonly stage: 'BEFORE_SEND' | 'AFTER_SEND',
    public readonly safeCode: SafeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TransportFailure';
  }
}

export class HttpPolicyError extends Error {
  constructor(
    public readonly safeCode: SafeErrorCode,
    message: string,
    public readonly stage: 'PRE_REQUEST' | 'POST_RESPONSE' = 'PRE_REQUEST',
  ) {
    super(message);
    this.name = 'HttpPolicyError';
  }
}

export interface FetchLike {
  (input: string, init: RequestInit): Promise<Response>;
}

const beforeSendCodes = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

function collectFailureSignals(
  error: unknown,
  depth = 0,
): { names: string[]; codes: string[]; messages: string[] } {
  if (depth > 4 || !error || typeof error !== 'object')
    return { names: [], codes: [], messages: [] };
  const record = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  const signals = {
    names: typeof record.name === 'string' ? [record.name] : [],
    codes: typeof record.code === 'string' ? [record.code] : [],
    messages: typeof record.message === 'string' ? [record.message] : [],
  };
  if (record.cause) {
    const nested = collectFailureSignals(record.cause, depth + 1);
    signals.names.push(...nested.names);
    signals.codes.push(...nested.codes);
    signals.messages.push(...nested.messages);
  }
  if (Array.isArray(record.errors))
    for (const item of record.errors) {
      const nested = collectFailureSignals(item, depth + 1);
      signals.names.push(...nested.names);
      signals.codes.push(...nested.codes);
      signals.messages.push(...nested.messages);
    }
  return signals;
}

function isTimeoutFailure(error: unknown): boolean {
  const signals = collectFailureSignals(error);
  return (
    signals.names.includes('TimeoutError') ||
    signals.names.includes('AbortError') ||
    signals.messages.some((message) => /timeout/i.test(message))
  );
}

function isUnreachableFailure(error: unknown): boolean {
  const signals = collectFailureSignals(error);
  if (signals.codes.some((code) => beforeSendCodes.has(code))) return true;
  return signals.messages.some((message) =>
    [...beforeSendCodes].some((code) => message.includes(code)),
  );
}

export interface ChannexHttpClientOptions {
  allowHosts: readonly string[];
  live?: boolean;
  allowExternal?: boolean;
  fetchImpl?: FetchLike;
  maxBodyBytes?: number;
}

function isLoopback(hostname: string): boolean {
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname);
}

export function createChannexHttpClient(
  options: ChannexHttpClientOptions,
): HttpClient {
  const allowHosts = new Set(options.allowHosts);
  const live = options.live ?? false;
  const allowExternal = options.allowExternal ?? false;
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((url, init) => fetch(url, init));
  const maxBodyBytes = options.maxBodyBytes ?? 2_000_000;

  return async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      throw new HttpPolicyError('VALIDATION_FAILED', 'Invalid provider URL');
    }
    if (!['https:', 'http:'].includes(url.protocol))
      throw new HttpPolicyError(
        'VALIDATION_FAILED',
        'Unsupported provider URL protocol',
      );
    if (!allowHosts.has(url.hostname))
      throw new HttpPolicyError(
        'UNSUPPORTED',
        'Provider host is not allowlisted',
      );
    const loopback = isLoopback(url.hostname);
    if (!loopback && !(live && allowExternal))
      throw new HttpPolicyError(
        'UNSUPPORTED',
        'External provider hosts require an explicit live authorization',
      );
    if (live && url.protocol !== 'https:' && !loopback)
      throw new HttpPolicyError(
        'UNSUPPORTED',
        'Live provider calls require TLS',
      );
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-correlation-id': request.correlationId,
      ...request.headers,
    };
    let body: string | undefined;
    if (request.body !== undefined) {
      body = JSON.stringify(request.body);
      headers['content-type'] = 'application/json';
    }
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: request.method,
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(request.timeoutMs),
      });
    } catch (error) {
      if (isTimeoutFailure(error))
        throw new TransportFailure('AFTER_SEND', 'TIMEOUT', 'Provider timeout');
      if (isUnreachableFailure(error))
        throw new TransportFailure(
          'BEFORE_SEND',
          'TIMEOUT',
          'Provider unreachable',
        );
      throw new TransportFailure(
        'AFTER_SEND',
        'PROVIDER_ERROR',
        'Provider request failed',
      );
    }
    const length = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(length) && length > maxBodyBytes) {
      await response.body?.cancel();
      throw new HttpPolicyError(
        'PROVIDER_ERROR',
        'Provider response is too large',
        'POST_RESPONSE',
      );
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new TransportFailure(
        'AFTER_SEND',
        'PROVIDER_ERROR',
        'Provider response could not be read',
      );
    }
    if (text.length > maxBodyBytes)
      throw new HttpPolicyError(
        'PROVIDER_ERROR',
        'Provider response is too large',
        'POST_RESPONSE',
      );
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (response.ok)
          throw new HttpPolicyError(
            'PROVIDER_ERROR',
            'Provider returned invalid JSON',
            'POST_RESPONSE',
          );
        parsed = null;
      }
    }
    const responseHeaders: Record<string, string | undefined> = {};
    for (const [key, value] of response.headers.entries())
      responseHeaders[key.toLowerCase()] = value;
    return { status: response.status, headers: responseHeaders, body: parsed };
  };
}

export function retryAfterMs(
  headers: Record<string, string | undefined>,
): number | null {
  const raw = headers['retry-after'];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(Math.round(seconds * 1000), 86_400_000);
  const date = Date.parse(raw);
  if (Number.isFinite(date))
    return Math.min(Math.max(date - Date.now(), 0), 86_400_000);
  return null;
}
