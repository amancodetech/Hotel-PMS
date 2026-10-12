import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import { ReportsController } from './reports.controller.js';

@Module({})
export class ReportingModule {
  static forRoot(runtime: IdentityRuntime): DynamicModule {
    return {
      module: ReportingModule,
      controllers: [ReportsController],
      providers: [{ provide: IDENTITY, useValue: runtime }],
    };
  }
}
