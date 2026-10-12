import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { one, toJson } from '../../../persistence/sql.js';
import type { AuthFlowRow, SessionRow, UserRow } from './types.js';

export interface UpsertUserInput {
  identitySubject: string;
  issuer: string;
  email: string | null;
  displayName: string | null;
}

export async function upsertUserBySubject(
  em: EntityManager,
  input: UpsertUserInput,
): Promise<UserRow> {
  const row = await one<UserRow>(
    em,
    `insert into "app_user"
       ("id", "identity_subject", "issuer", "email", "display_name")
     values (?, ?, ?, ?, ?)
     on conflict ("issuer", "identity_subject") do update
       set "email" = excluded."email",
           "display_name" = excluded."display_name",
           "updated_at" = now()
     returning *`,
    [
      randomUUID(),
      input.identitySubject,
      input.issuer,
      input.email,
      input.displayName,
    ],
  );
  if (!row) throw new Error('User upsert returned no row');
  return row;
}

export async function findUserById(
  em: EntityManager,
  id: string,
): Promise<UserRow | null> {
  return one<UserRow>(em, `select * from "app_user" where "id" = ?`, [id]);
}

export interface CreateFlowInput {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectAfter: string | null;
  browserSecretHash: string;
  ttlSeconds: number;
}

export async function createAuthFlow(
  em: EntityManager,
  input: CreateFlowInput,
): Promise<AuthFlowRow> {
  const row = await one<AuthFlowRow>(
    em,
    `insert into "auth_flow"
       ("id", "state", "nonce", "code_verifier", "redirect_after",
        "browser_secret_hash", "expires_at")
     values (?, ?, ?, ?, ?, ?, now() + (? * interval '1 second'))
     returning *`,
    [
      randomUUID(),
      input.state,
      input.nonce,
      input.codeVerifier,
      input.redirectAfter,
      input.browserSecretHash,
      input.ttlSeconds,
    ],
  );
  if (!row) throw new Error('Auth flow insert returned no row');
  return row;
}

export async function consumeAuthFlow(
  em: EntityManager,
  state: string,
  browserSecretHash: string | null,
): Promise<AuthFlowRow | null> {
  if (!browserSecretHash) return null;
  return one<AuthFlowRow>(
    em,
    `update "auth_flow"
        set "used_at" = now()
      where "state" = ? and "browser_secret_hash" = ?
        and "used_at" is null and "expires_at" > now()
      returning *`,
    [state, browserSecretHash],
  );
}

export interface CreateSessionInput {
  userId: string;
  tenantId: string | null;
  csrfTokenHash: string;
  idToken: string | null;
  authMethods: string[];
  authTime: string | null;
  ttlMinutes: number;
  rotatedFrom?: string | null;
}

export async function createSession(
  em: EntityManager,
  input: CreateSessionInput,
): Promise<SessionRow> {
  const row = await one<SessionRow>(
    em,
    `insert into "auth_session"
       ("id", "user_id", "active_tenant_id", "csrf_token_hash", "id_token",
        "auth_methods", "auth_time", "expires_at", "rotated_from")
     values (?, ?, ?, ?, ?, ?::jsonb, ?, now() + (? * interval '1 minute'), ?)
     returning *`,
    [
      randomUUID(),
      input.userId,
      input.tenantId,
      input.csrfTokenHash,
      input.idToken,
      toJson(input.authMethods),
      input.authTime,
      input.ttlMinutes,
      input.rotatedFrom ?? null,
    ],
  );
  if (!row) throw new Error('Session insert returned no row');
  return row;
}

export async function findSession(
  em: EntityManager,
  id: string,
): Promise<SessionRow | null> {
  return one<SessionRow>(em, `select * from "auth_session" where "id" = ?`, [
    id,
  ]);
}

export async function updateSessionTenant(
  em: EntityManager,
  id: string,
  tenantId: string,
): Promise<SessionRow | null> {
  return one<SessionRow>(
    em,
    `update "auth_session"
        set "active_tenant_id" = ?, "updated_at" = now()
      where "id" = ? and "revoked_at" is null and "expires_at" > now()
      returning *`,
    [tenantId, id],
  );
}

export async function revokeSession(
  em: EntityManager,
  id: string,
): Promise<SessionRow | null> {
  return one<SessionRow>(
    em,
    `update "auth_session"
        set "revoked_at" = now(), "updated_at" = now()
      where "id" = ? and "revoked_at" is null
      returning *`,
    [id],
  );
}

export async function findSessionForUserTenant(
  em: EntityManager,
  userId: string,
  tenantId: string,
): Promise<SessionRow | null> {
  return one<SessionRow>(
    em,
    `select * from "auth_session"
      where "user_id" = ? and "active_tenant_id" = ?
        and "revoked_at" is null and "expires_at" > now()
      order by "created_at" desc
      limit 1`,
    [userId, tenantId],
  );
}
