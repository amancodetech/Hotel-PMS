import { Module, DynamicModule } from '@nestjs/common';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import { PropertiesController } from './property.controller.js';
import { ResourcesController } from './resource.controller.js';
import { PoolsController, ProductsController } from './product.controller.js';
import { CompositionsController } from './composition.controller.js';
import { ConnectionDraftsController } from './connection.controller.js';
import { SetupController } from './setup.controller.js';
import { SetupInsightsController } from './setup-insights.controller.js';

@Module({})
export class PropertyModule {
  static forRoot(runtime: IdentityRuntime): DynamicModule {
    return {
      module: PropertyModule,
      controllers: [
        PropertiesController,
        ResourcesController,
        ProductsController,
        PoolsController,
        CompositionsController,
        ConnectionDraftsController,
        SetupController,
        SetupInsightsController,
      ],
      providers: [{ provide: IDENTITY, useValue: runtime }],
    };
  }
}
