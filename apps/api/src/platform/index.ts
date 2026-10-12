import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import { PlatformController } from './platform.controller.js';

@Module({})
export class PlatformModule {
  static forRoot(runtime: IdentityRuntime): DynamicModule {
    return {
      module: PlatformModule,
      controllers: [PlatformController],
      providers: [{ provide: IDENTITY, useValue: runtime }],
    };
  }
}
