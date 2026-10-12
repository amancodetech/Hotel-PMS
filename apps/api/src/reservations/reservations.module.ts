import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import { GuestsController } from './guests.controller.js';
import { ReservationsController } from './reservations.controller.js';

@Module({})
export class ReservationsModule {
  static forRoot(runtime: IdentityRuntime): DynamicModule {
    return {
      module: ReservationsModule,
      controllers: [ReservationsController, GuestsController],
      providers: [{ provide: IDENTITY, useValue: runtime }],
    };
  }
}
