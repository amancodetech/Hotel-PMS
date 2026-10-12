import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import { FrontDeskController } from './front-desk.controller.js';

@Module({})
export class FrontOfficeModule {
  static forRoot(runtime: IdentityRuntime): DynamicModule {
    return {
      module: FrontOfficeModule,
      controllers: [FrontDeskController],
      providers: [{ provide: IDENTITY, useValue: runtime }],
    };
  }
}
