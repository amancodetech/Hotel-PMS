import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type {
  PermissionCode,
  PlatformPermissionCode,
  PlatformStaffRow,
  PolicyActor,
  SessionRow,
  UserRow,
} from '@hotel/backend';
import {
  evaluatePolicy,
  IdentityError,
  loadPlatformStaff,
  permissions,
  platformRoleHasPermission,
  policyError,
  runScopedTransaction,
} from '@hotel/backend';
import { IDENTITY } from './tokens.js';
import { APPROVAL_HEADER, CSRF_HEADER, PROPERTY_HEADER } from './runtime.js';
import type { IdentityRuntime } from './runtime.js';
import { originAllowed, requestActor, sessionIdFromRequest } from './http.js';
import { equalHex, sha256Hex } from '@hotel/backend';

export const IS_PUBLIC = 'identity:is-public';
export const REQUIRED_PERMISSION = 'identity:required-permission';
export const REQUIRED_PLATFORM_PERMISSION =
  'identity:required-platform-permission';

export const Public = () => SetMetadata(IS_PUBLIC, true);
export const RequirePermission = (permission: PermissionCode) =>
  SetMetadata(REQUIRED_PERMISSION, permission);
export const RequirePlatformPermission = (permission: PlatformPermissionCode) =>
  SetMetadata(REQUIRED_PLATFORM_PERMISSION, permission);

export interface RequestAuth {
  session: SessionRow;
  user: UserRow;
  actor: PolicyActor;
}

export interface RequestPlatformAuth {
  staff: PlatformStaffRow;
  actor: PolicyActor;
}

export interface AuthedRequest extends Request {
  auth?: RequestAuth;
  platformAuth?: RequestPlatformAuth;
}

function isPublic(reflector: Reflector, context: ExecutionContext): boolean {
  return (
    reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]) ?? false
  );
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(IDENTITY) private readonly runtime: IdentityRuntime,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    if (request.auth) return true;
    const sessionId = sessionIdFromRequest(this.runtime, request);
    const loaded = await this.runtime.auth.loadSession(sessionId);
    if (loaded.status === 'active') {
      request.auth = {
        session: loaded.session,
        user: loaded.user,
        actor: requestActor(
          this.runtime,
          loaded.session,
          loaded.user.display_name,
        ),
      };
      return true;
    }
    if (isPublic(this.reflector, context)) return true;
    if (loaded.status === 'expired') throw new IdentityError('SESSION_EXPIRED');
    if (loaded.status === 'revoked') throw new IdentityError('SESSION_REVOKED');
    throw new IdentityError('AUTH_REQUIRED');
  }
}

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    @Inject(IDENTITY) private readonly runtime: IdentityRuntime,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const method = context
      .switchToHttp()
      .getRequest<AuthedRequest>()
      .method.toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return true;
    if (isPublic(this.reflector, context)) return true;
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !originAllowed(this.runtime, origin))
      throw new IdentityError('ORIGIN_INVALID');
    const auth = request.auth;
    if (!auth) throw new IdentityError('AUTH_REQUIRED');
    const token = request.headers[CSRF_HEADER];
    if (
      typeof token !== 'string' ||
      !equalHex(sha256Hex(token), auth.session.csrf_token_hash)
    )
      throw new IdentityError('CSRF_INVALID');
    return true;
  }
}

@Injectable()
export class PolicyGuard implements CanActivate {
  constructor(
    @Inject(IDENTITY) private readonly runtime: IdentityRuntime,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.getAllAndOverride<PermissionCode>(
      REQUIRED_PERMISSION,
      [context.getHandler(), context.getClass()],
    );
    if (!permission) return true;
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const auth = request.auth;
    if (!auth) throw new IdentityError('AUTH_REQUIRED');
    const params = request.params as { tenantId?: string };
    const sessionTenant = auth.session.active_tenant_id;
    const tenantId = params.tenantId ?? sessionTenant;
    if (!tenantId) throw new IdentityError('TENANT_CONTEXT_REQUIRED');
    if (params.tenantId && params.tenantId !== sessionTenant)
      throw new IdentityError('TENANT_CONTEXT_MISMATCH');
    const propertyHeader = request.headers[PROPERTY_HEADER];
    const approvalHeader = request.headers[APPROVAL_HEADER];
    const decision = await runScopedTransaction(
      this.runtime.orm,
      { tenantId, userId: auth.actor.userId },
      (em) =>
        evaluatePolicy(em, {
          actor: auth.actor,
          tenantId,
          permission,
          propertyRef:
            typeof propertyHeader === 'string' ? propertyHeader : null,
          approvalId:
            typeof approvalHeader === 'string' ? approvalHeader : null,
        }),
    );
    if (!decision.allowed) throw policyError(decision);
    return true;
  }
}

@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(
    @Inject(IDENTITY) private readonly runtime: IdentityRuntime,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.getAllAndOverride<PlatformPermissionCode>(
      REQUIRED_PLATFORM_PERMISSION,
      [context.getHandler(), context.getClass()],
    );
    if (!permission) return true;
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const auth = request.auth;
    if (!auth) throw new IdentityError('AUTH_REQUIRED');
    const staff = await loadPlatformStaff(this.runtime.orm, auth.actor.userId);
    if (!staff || staff.status !== 'ACTIVE') {
      // Fail closed without confirming whether a staff record exists.
      throw new IdentityError('PERMISSION_DENIED');
    }
    if (!platformRoleHasPermission(staff.role_code, permission))
      throw new IdentityError('PERMISSION_DENIED', {
        reason: 'platform_role',
      });
    if (permissions[permission].mfaRequired && !auth.actor.mfa)
      throw new IdentityError('MFA_REQUIRED');
    request.platformAuth = { staff, actor: auth.actor };
    return true;
  }
}

@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly limit = 60;
  private readonly windowMs = 60_000;

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    // Frequent session bootstrap reads must not exhaust the login budget.
    if (request.method === 'GET' && request.path.endsWith('/auth/session'))
      return true;
    const key = request.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    if (entry.count > this.limit) throw new IdentityError('RATE_LIMITED');
    return true;
  }
}
