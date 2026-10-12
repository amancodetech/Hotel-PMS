import {
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  buildEndSessionUrl,
  calculatePKCECodeChallenge,
  ClientSecretPost,
  customFetch,
  discovery,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
} from 'openid-client';
import type { Configuration } from 'openid-client';
import { IdentityError } from '../domain/errors.js';
import { randomToken } from './crypto.js';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  mfaAcrValues?: string[];
}

export interface OidcClaims {
  subject: string;
  issuer: string;
  email: string | null;
  displayName: string | null;
  authMethods: string[];
  authTime: string | null;
  idToken: string;
  mfa: boolean;
}

const mfaAmr = new Set(['otp', 'mfa', 'hwk', 'swk', 'sms', 'tel', 'webauthn']);

export function detectMfa(
  claims: Record<string, unknown>,
  mfaAcrValues: string[],
): boolean {
  const amr = Array.isArray(claims.amr)
    ? claims.amr.map(String)
    : typeof claims.amr === 'string'
      ? [claims.amr]
      : [];
  if (amr.some((method) => mfaAmr.has(method.toLowerCase()))) return true;
  return (
    typeof claims.acr === 'string' &&
    mfaAcrValues.includes(claims.acr.toLowerCase())
  );
}

export class OidcService {
  private readonly config: OidcConfig;
  private configuration: Promise<Configuration> | null = null;

  constructor(config: OidcConfig) {
    this.config = config;
  }

  private load(): Promise<Configuration> {
    this.configuration ??= discovery(
      new URL(this.config.issuer),
      this.config.clientId,
      undefined,
      ClientSecretPost(this.config.clientSecret),
      {
        // Local loopback Keycloak only; configuration rejects production and
        // non-loopback hosts, so this dev escape hatch cannot reach the internet.
        execute: [allowInsecureRequests],
        [customFetch]: (url, options) =>
          fetch(url, {
            ...(options as unknown as RequestInit),
            signal: AbortSignal.timeout(1500),
          }),
      },
    ).catch((error: unknown) => {
      this.configuration = null;
      throw error;
    });
    return this.configuration;
  }

  async check(): Promise<void> {
    const configuration = await this.load();
    const issuer = configuration.serverMetadata().issuer;
    if (issuer !== this.config.issuer) throw new Error('OIDC issuer mismatch');
  }

  async startLogin(): Promise<{
    url: string;
    state: string;
    nonce: string;
    codeVerifier: string;
  }> {
    const configuration = await this.load();
    const state = randomState();
    const nonce = randomNonce();
    const codeVerifier = randomPKCECodeVerifier();
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
    const url = buildAuthorizationUrl(configuration, {
      redirect_uri: this.config.redirectUri,
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      claims: JSON.stringify({ id_token: { amr: null, acr: null } }),
    });
    return {
      url: url.href,
      state: state ?? randomToken(32),
      nonce,
      codeVerifier,
    };
  }

  async completeLogin(
    callbackUrl: string,
    expected: { state: string; nonce: string; codeVerifier: string },
  ): Promise<OidcClaims> {
    const configuration = await this.load();
    let response: Awaited<ReturnType<typeof authorizationCodeGrant>>;
    try {
      response = await authorizationCodeGrant(
        configuration,
        new URL(callbackUrl),
        {
          pkceCodeVerifier: expected.codeVerifier,
          expectedState: expected.state,
          expectedNonce: expected.nonce,
          idTokenExpected: true,
        },
      );
    } catch (error) {
      throw new IdentityError('OIDC_CALLBACK_FAILED', {
        reason: error instanceof Error ? error.name : 'unknown',
        code:
          error && typeof error === 'object' && 'code' in error
            ? String(error.code)
            : null,
        error:
          error && typeof error === 'object' && 'error' in error
            ? String(error.error)
            : null,
        message:
          error instanceof Error ? error.message.slice(0, 120) : 'unknown',
      });
    }
    const claims = response.claims() as Record<string, unknown>;
    const subject = claims.sub;
    if (typeof subject !== 'string' || !subject)
      throw new IdentityError('OIDC_CALLBACK_FAILED', { reason: 'no_subject' });
    const emailVerified = claims.email_verified === true;
    const email =
      emailVerified && typeof claims.email === 'string'
        ? claims.email.toLowerCase()
        : null;
    const displayName =
      typeof claims.name === 'string'
        ? claims.name
        : typeof claims.preferred_username === 'string'
          ? claims.preferred_username
          : null;
    return {
      subject,
      issuer: typeof claims.iss === 'string' ? claims.iss : this.config.issuer,
      email,
      displayName,
      authMethods: Array.isArray(claims.amr)
        ? claims.amr.map(String)
        : typeof claims.amr === 'string'
          ? [claims.amr]
          : [],
      authTime:
        typeof claims.auth_time === 'number'
          ? new Date(claims.auth_time * 1000).toISOString()
          : null,
      idToken: response.id_token ?? '',
      mfa: detectMfa(claims, this.config.mfaAcrValues ?? []),
    };
  }

  async endSessionUrl(idTokenHint: string | null): Promise<string | null> {
    try {
      const configuration = await this.load();
      const url = buildEndSessionUrl(configuration, {
        post_logout_redirect_uri: this.config.postLogoutRedirectUri,
        ...(idTokenHint ? { id_token_hint: idTokenHint } : {}),
      });
      return url.href;
    } catch {
      return null;
    }
  }
}
