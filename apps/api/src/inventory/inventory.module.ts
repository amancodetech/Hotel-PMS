import { Module, DynamicModule } from '@nestjs/common';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import { RatesController } from './rates.controller.js';
import {
  AvailabilityController,
  BlocksController,
  HoldsController,
} from './inventory.controller.js';
import { ExposuresController } from './exposure.controller.js';

@Module({})
export class InventoryModule {
  static forRoot(runtime: IdentityRuntime): DynamicModule {
    return {
      module: InventoryModule,
      controllers: [
        RatesController,
        AvailabilityController,
        HoldsController,
        BlocksController,
        ExposuresController,
      ],
      providers: [{ provide: IDENTITY, useValue: runtime }],
    };
  }
}
