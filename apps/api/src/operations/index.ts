import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import { OperationsController } from './operations.controller.js';

@Module({})
export class OperationsModule {
  static forRoot(runtime: IdentityRuntime): DynamicModule {
    return {
      module: OperationsModule,
      controllers: [OperationsController],
      providers: [{ provide: IDENTITY, useValue: runtime }],
    };
  }
}
