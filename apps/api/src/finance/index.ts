import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import { FinanceController } from './finance.controller.js';

@Module({})
export class FinanceModule {
  static forRoot(runtime: IdentityRuntime): DynamicModule {
    return {
      module: FinanceModule,
      controllers: [FinanceController],
      providers: [{ provide: IDENTITY, useValue: runtime }],
    };
  }
}
