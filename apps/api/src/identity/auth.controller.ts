import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  IdentityError,
  loadPlatformStaff,
  platformRolePermissions,
  readEffectivePermissions,
} from '@hotel/backend';
import { isPlatformRoleCode } from '@hotel/backend';
import { IDENTITY } from './tokens.js';
import type { IdentityRuntime } from './runtime.js';
import {
  clearSessionCookie,
  clearAuthFlowCookie,
  csrfCookieFromRequest,
  authFlowSecretFromRequest,
  redirectAfterFrom,
  requestCorrelation,
  sessionIdFromRequest,
  setAuthFlowCookie,
  setSessionCookie,
} from './http.js';
import { Public, AuthRateLimitGuard } from './guards.js';
import type { AuthedRequest } from './guards.js';
import { sessionDto } from './dto.js';

const loginQuery = z.object({ redirect_after: z.string().optional() }).strict();

@Controller('api/v1/auth')
@UseGuards(AuthRateLimitGuard)
export class AuthController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @Public()
  @Get('session')
  async currentSession(@Req() request: AuthedRequest) {
    const auth = request.auth;
    if (!auth) return { authenticated: false as const };
    const memberships = await this.runtime.auth.listMemberships(auth.session);
    let permissions = null;
    if (auth.session.active_tenant_id) {
      try {
        const effective = await readEffectivePermissions(this.runtime.orm, {
          actor: auth.actor,
          tenantId: auth.session.active_tenant_id,
          membershipId: null,
        });
        permissions = effective.permissions;
      } catch {
        permissions = null;
      }
    }
    const staff = await loadPlatformStaff(this.runtime.orm, auth.user.id);
    const platform =
      staff && staff.status === 'ACTIVE' && isPlatformRoleCode(staff.role_code)
        ? {
            role_code: staff.role_code,
            status: staff.status,
            permissions: [...platformRolePermissions[staff.role_code]],
          }
        : null;
    return sessionDto({
      session: auth.session,
      user: auth.user,
      memberships,
      csrfToken: csrfCookieFromRequest(request),
      mfa: auth.actor.mfa,
      permissions,
      platform,
    });
  }

  @Public()
  @Get('login')
  async login(@Query() query: unknown, @Res() response: Response) {
    loginQuery.parse(query);
    const redirectAfter = redirectAfterFrom(
      (query as { redirect_after?: string }).redirect_after,
    );
    const result = await this.runtime.auth.startLogin(redirectAfter);
    setAuthFlowCookie(this.runtime, response, result.browserSecret, 600);
    response.redirect(302, result.url);
  }

  @Public()
  @Get('callback')
  async callback(@Req() request: Request, @Res() response: Response) {
    const callbackUrl = new URL(request.originalUrl, this.runtime.apiOrigin);
    const browserSecret = authFlowSecretFromRequest(request);
    try {
      const result = await this.runtime.auth.completeLogin(
        callbackUrl.href,
        sessionIdFromRequest(this.runtime, request),
        browserSecret,
      );
      setSessionCookie(
        this.runtime,
        response,
        result.session.id,
        result.csrfToken,
        this.runtime.config.SESSION_TTL_MINUTES * 60,
      );
      clearAuthFlowCookie(this.runtime, response);
      const target = result.redirectAfter ?? '/';
      response.redirect(302, `${this.runtime.webOrigin}${target}`);
    } catch (error) {
      clearSessionCookie(this.runtime, response);
      clearAuthFlowCookie(this.runtime, response);
      const code =
        error instanceof IdentityError ? error.code : 'OIDC_CALLBACK_FAILED';
      response.redirect(
        302,
        `${this.runtime.webOrigin}/auth/callback?error=${encodeURIComponent(code)}`,
      );
    }
  }

  @HttpCode(200)
  @Post('logout')
  async logout(@Req() request: AuthedRequest, @Res() response: Response) {
    const endSessionUrl = await this.runtime.auth.logout(
      request.auth?.session ?? null,
      requestCorrelation(request),
    );
    clearSessionCookie(this.runtime, response);
    return response.json({ logged_out: true, end_session_url: endSessionUrl });
  }
}
