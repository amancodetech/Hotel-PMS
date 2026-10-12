import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import { NightAuditController } from './night-audit.controller.js';

@Module({})
export class NightAuditModule {
  static forRoot(runtime: IdentityRuntime): DynamicModule {
    return {
      module: NightAuditModule,
      controllers: [NightAuditController],
      providers: [{ provide: IDENTITY, useValue: runtime }],
    };
  }
}
