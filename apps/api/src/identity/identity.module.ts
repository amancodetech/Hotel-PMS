import { Module, DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { IDENTITY } from './tokens.js';
import type { IdentityRuntime } from './runtime.js';
import { AuthController } from './auth.controller.js';
import { InvitationsController, TenantsController } from './org.controller.js';
import {
  ApprovalRequestsController,
  PermissionsController,
  RoleGrantsController,
  RolesController,
} from './governance.controller.js';
import {
  AuthRateLimitGuard,
  CsrfGuard,
  PlatformGuard,
  PolicyGuard,
  SessionGuard,
} from './guards.js';

@Module({})
export class IdentityModule {
  static forRoot(runtime: IdentityRuntime): DynamicModule {
    return {
      module: IdentityModule,
      controllers: [
        AuthController,
        TenantsController,
        InvitationsController,
        RolesController,
        RoleGrantsController,
        PermissionsController,
        ApprovalRequestsController,
      ],
      providers: [
        { provide: IDENTITY, useValue: runtime },
        SessionGuard,
        CsrfGuard,
        PolicyGuard,
        PlatformGuard,
        AuthRateLimitGuard,
        { provide: APP_GUARD, useExisting: SessionGuard },
        { provide: APP_GUARD, useExisting: CsrfGuard },
        { provide: APP_GUARD, useExisting: PolicyGuard },
        { provide: APP_GUARD, useExisting: PlatformGuard },
      ],
    };
  }
}
