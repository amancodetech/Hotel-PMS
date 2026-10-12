import type { Certainty, SafeErrorCode } from '@hotel/contracts';

export const retryableErrorCodes: readonly SafeErrorCode[] = [
  'RATE_LIMITED',
  'TIMEOUT',
  'PROVIDER_ERROR',
  'UNKNOWN',
];

export function isRetryable(code: SafeErrorCode): boolean {
  return retryableErrorCodes.includes(code);
}

export class DistributionError extends Error {
  constructor(
    public readonly code: SafeErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DistributionError';
  }
}

export class UnknownProviderError extends DistributionError {
  constructor(providerKey: string) {
    super('UNSUPPORTED', `Unknown provider: ${providerKey}`, { providerKey });
    this.name = 'UnknownProviderError';
  }
}

export class ValidationError extends DistributionError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('VALIDATION_FAILED', message, details);
    this.name = 'ValidationError';
  }
}

export class StaleCursorError extends DistributionError {
  constructor(connectionId: string) {
    super('CONFLICT', 'The pull cursor moved while the page was in flight', {
      connectionId,
    });
    this.name = 'StaleCursorError';
  }
}

export interface HttpClassification {
  code: SafeErrorCode;
  certainty: Certainty;
  retryable: boolean;
}

export function classifyHttpStatus(status: number): HttpClassification {
  if (status === 400 || status === 422)
    return {
      code: 'VALIDATION_FAILED',
      certainty: 'REJECTED',
      retryable: false,
    };
  if (status === 401 || status === 403)
    return { code: 'AUTH_FAILED', certainty: 'REJECTED', retryable: false };
  if (status === 404)
    return { code: 'NOT_FOUND', certainty: 'REJECTED', retryable: false };
  if (status === 409)
    return { code: 'CONFLICT', certainty: 'REJECTED', retryable: false };
  if (status === 408 || status === 504)
    return { code: 'TIMEOUT', certainty: 'UNKNOWN', retryable: true };
  if (status === 429)
    return { code: 'RATE_LIMITED', certainty: 'UNKNOWN', retryable: true };
  if (status >= 500)
    return { code: 'PROVIDER_ERROR', certainty: 'UNKNOWN', retryable: true };
  return { code: 'PROVIDER_ERROR', certainty: 'UNKNOWN', retryable: true };
}

export function classifyTransportFailure(
  stage: 'BEFORE_SEND' | 'AFTER_SEND',
): HttpClassification {
  return stage === 'BEFORE_SEND'
    ? { code: 'TIMEOUT', certainty: 'NOT_SENT', retryable: true }
    : { code: 'TIMEOUT', certainty: 'UNKNOWN', retryable: true };
}
