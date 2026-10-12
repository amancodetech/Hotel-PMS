import type { MikroORM } from '@mikro-orm/postgresql';
import { IdentityError } from '../domain/errors.js';
import {
  createAuthFlow,
  consumeAuthFlow,
  createSession,
  findSession,
  revokeSession,
  updateSessionTenant,
  upsertUserBySubject,
} from '../persistence/session-repository.js';
import {
  findMembership,
  listTenantsForUser,
} from '../persistence/org-repository.js';
import type {
  MembershipViewRow,
  SessionRow,
  UserRow,
} from '../persistence/types.js';
import {
  runScopedTransaction,
  setRequestContext,
} from '../../../persistence/tenant-context.js';
import { recordAudit } from './audit-service.js';
import { randomToken, sha256Hex } from './crypto.js';
import type { OidcClaims, OidcService } from './oidc-service.js';

export interface SessionView {
  session: SessionRow;
  user: UserRow;
}

export type SessionLoad =
  | { status: 'active'; session: SessionRow; user: UserRow }
  | { status: 'missing' }
  | { status: 'expired' }
  | { status: 'revoked' };

export interface LoginResult extends SessionView {
  csrfToken: string;
  memberships: MembershipViewRow[];
  activeTenantId: string | null;
  redirectAfter: string | null;
}

export class AuthService {
  constructor(
    private readonly orm: MikroORM,
    private readonly oidc: OidcService,
    private readonly sessionTtlMinutes: number,
  ) {}

  async startLogin(
    redirectAfter: string | null,
  ): Promise<{ url: string; browserSecret: string }> {
    const flow = await this.oidc.startLogin();
    const browserSecret = randomToken(32);
    await this.orm.em.fork().transactional(async (em) => {
      await createAuthFlow(em, {
        state: flow.state,
        nonce: flow.nonce,
        codeVerifier: flow.codeVerifier,
        redirectAfter,
        browserSecretHash: sha256Hex(browserSecret),
        ttlSeconds: 600,
      });
    });
    return { url: flow.url, browserSecret };
  }

  async completeLogin(
    callbackUrl: string,
    previousSessionId: string | null,
    browserSecret: string | null,
  ): Promise<LoginResult> {
    const state = new URL(callbackUrl).searchParams.get('state');
    if (!state) throw new IdentityError('OIDC_STATE_INVALID');
    const stored = await this.orm.em.fork().transactional(async (em) => {
      const consumed = await consumeAuthFlow(
        em,
        state,
        browserSecret ? sha256Hex(browserSecret) : null,
      );
      if (!consumed) throw new IdentityError('OIDC_STATE_INVALID');
      return consumed;
    });
    const claims = await this.oidc.completeLogin(callbackUrl, {
      state: stored.state,
      nonce: stored.nonce,
      codeVerifier: stored.code_verifier,
    });
    const result = await this.createSessionForClaims(claims, previousSessionId);
    return { ...result, redirectAfter: stored.redirect_after };
  }

  private async createSessionForClaims(
    claims: OidcClaims,
    previousSessionId: string | null,
  ): Promise<Omit<LoginResult, 'redirectAfter'>> {
    const csrfToken = randomToken(24);
    return this.orm.em.fork().transactional(async (em) => {
      const user = await upsertUserBySubject(em, {
        identitySubject: claims.subject,
        issuer: claims.issuer,
        email: claims.email,
        displayName: claims.displayName,
      });
      await setRequestContext(em, { userId: user.id });
      const memberships = await listTenantsForUser(em, user.id);
      const active = memberships.filter(
        (membership) =>
          membership.status === 'ACTIVE' &&
          membership.tenant_status === 'ACTIVE',
      );
      const activeTenantId = active.length === 1 ? active[0]!.tenant_id : null;
      let rotatedFrom: string | null = null;
      if (previousSessionId) {
        const previous = await revokeSession(em, previousSessionId);
        if (previous && previous.user_id === user.id) rotatedFrom = previous.id;
      }
      const session = await createSession(em, {
        userId: user.id,
        tenantId: activeTenantId,
        csrfTokenHash: sha256Hex(csrfToken),
        idToken: claims.idToken || null,
        authMethods: claims.authMethods,
        authTime: claims.authTime,
        ttlMinutes: this.sessionTtlMinutes,
        rotatedFrom,
      });
      return {
        session,
        user,
        csrfToken,
        memberships,
        activeTenantId,
      };
    });
  }

  async loadSession(sessionId: string | null): Promise<SessionLoad> {
    if (!sessionId) return { status: 'missing' };
    const session = await this.orm.em
      .fork()
      .transactional((em) => findSession(em, sessionId));
    if (!session) return { status: 'missing' };
    if (session.revoked_at) return { status: 'revoked' };
    if (Date.parse(session.expires_at) <= Date.now())
      return { status: 'expired' };
    const user = await this.orm.em.fork().transactional(async (em) => {
      const rows = (await em.execute(
        `select * from "app_user" where "id" = ?`,
        [session.user_id] as never[],
      )) as UserRow[];
      return rows[0] ?? null;
    });
    if (!user || user.status !== 'ACTIVE') return { status: 'revoked' };
    return { status: 'active', session, user };
  }

  async listMemberships(session: SessionRow): Promise<MembershipViewRow[]> {
    return runScopedTransaction(this.orm, { userId: session.user_id }, (em) =>
      listTenantsForUser(em, session.user_id),
    );
  }

  async selectTenant(
    session: SessionRow,
    tenantId: string,
    correlationId: string | null,
  ): Promise<SessionRow> {
    return runScopedTransaction(
      this.orm,
      { tenantId, userId: session.user_id },
      async (em) => {
        const membership = await findMembership(em, tenantId, session.user_id);
        if (!membership || membership.status === 'REVOKED')
          throw new IdentityError('MEMBERSHIP_NOT_FOUND');
        if (membership.status !== 'ACTIVE')
          throw new IdentityError('MEMBERSHIP_INACTIVE');
        const tenantStatus = (await em.execute(
          `select "status" from "tenant" where "id" = ?`,
          [tenantId] as never[],
        )) as Array<{ status: string }>;
        if (tenantStatus[0] && tenantStatus[0].status !== 'ACTIVE')
          throw new IdentityError('TENANT_STATE_CONFLICT', {
            state: tenantStatus[0].status,
          });
        const updated = await updateSessionTenant(em, session.id, tenantId);
        if (!updated) throw new IdentityError('SESSION_EXPIRED');
        await recordAudit(em, {
          tenantId,
          actorType: 'USER',
          actorId: session.user_id,
          actorLabel: null,
          action: 'auth.tenant_select',
          resourceType: 'tenant',
          resourceId: tenantId,
          outcome: 'SUCCESS',
          correlationId,
        });
        return updated;
      },
    );
  }

  async logout(
    session: SessionRow | null,
    correlationId: string | null,
  ): Promise<string | null> {
    if (!session) return this.oidc.endSessionUrl(null);
    await this.orm.em.fork().transactional(async (em) => {
      const revoked = await revokeSession(em, session.id);
      if (revoked?.active_tenant_id) {
        await setRequestContext(em, {
          tenantId: revoked.active_tenant_id,
          userId: revoked.user_id,
        });
        await recordAudit(em, {
          tenantId: revoked.active_tenant_id,
          actorType: 'USER',
          actorId: revoked.user_id,
          actorLabel: null,
          action: 'auth.logout',
          resourceType: 'session',
          resourceId: revoked.id,
          outcome: 'SUCCESS',
          correlationId,
        });
      }
    });
    return this.oidc.endSessionUrl(session.id_token);
  }
}
