import 'reflect-metadata';
import {
  Catch,
  Controller,
  Get,
  Inject,
  Module,
  Query,
  Res,
  HttpException,
} from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import {
  correlationId,
  IdentityError,
  inspectReadiness,
  logEvent,
  PropertyError,
} from '@hotel/backend';
import type { Probes } from '@hotel/backend';
import type { ApiError } from '@hotel/contracts';
import { IdentityModule } from './identity/identity.module.js';
import { PropertyModule } from './property/property.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { ReservationsModule } from './reservations/reservations.module.js';
import { FrontOfficeModule } from './front-office/index.js';
import { FinanceModule } from './finance/index.js';
import { OperationsModule } from './operations/index.js';
import { NightAuditModule } from './night-audit/index.js';
import { ReportingModule } from './reporting/index.js';
import { PlatformModule } from './platform/index.js';
import type { IdentityRuntime } from './identity/runtime.js';
import { Public } from './identity/guards.js';
import { PROBES } from './identity/tokens.js';
import { classifyDatabaseError } from './database-errors.js';

const querySchema = z.object({}).strict();

@Catch()
class SafeErrors implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const transportStatus =
      exception &&
      typeof exception === 'object' &&
      'status' in exception &&
      typeof exception.status === 'number' &&
      exception.status >= 400 &&
      exception.status <= 599
        ? exception.status
        : undefined;
    const databaseCode =
      exception &&
      typeof exception === 'object' &&
      'code' in exception &&
      typeof (exception as { code?: unknown }).code === 'string'
        ? (exception as { code: string }).code
        : null;
    const databaseFailure = classifyDatabaseError(databaseCode);
    const status =
      databaseFailure?.status ??
      (exception instanceof IdentityError || exception instanceof PropertyError
        ? exception.status
        : exception instanceof HttpException
          ? exception.getStatus()
          : exception instanceof z.ZodError
            ? 400
            : (transportStatus ?? 500));
    const code =
      databaseFailure?.code ??
      (exception instanceof IdentityError || exception instanceof PropertyError
        ? exception.code
        : status === 404
          ? 'NOT_FOUND'
          : status === 400
            ? 'INVALID_REQUEST'
            : status === 413
              ? 'PAYLOAD_TOO_LARGE'
              : 'INTERNAL_ERROR');
    const details =
      databaseFailure !== null
        ? { reason: databaseFailure.reason }
        : exception instanceof IdentityError ||
            exception instanceof PropertyError
          ? exception.details
          : {};
    if (
      !(exception instanceof IdentityError) &&
      !(exception instanceof PropertyError) &&
      !(exception instanceof z.ZodError) &&
      !(exception instanceof HttpException) &&
      databaseFailure === null
    ) {
      const errorName =
        exception instanceof Error ? exception.name : typeof exception;
      const errorCode =
        exception &&
        typeof exception === 'object' &&
        'code' in exception &&
        typeof (exception as { code?: unknown }).code === 'string'
          ? (exception as { code: string }).code
          : null;
      logEvent('unhandled_error', {
        service: 'api',
        correlation_id: String(response.getHeader('x-correlation-id')),
        error_name: errorName,
        error_code: errorCode ?? undefined,
      });
    }
    const body: ApiError = {
      code,
      message: `errors.${code}`,
      correlation_id: String(response.getHeader('x-correlation-id')),
      details,
    };
    if (status === 503) response.setHeader('Retry-After', '1');
    response.status(status).json(body);
  }
}

@Public()
@Controller('api/v1/system')
class SystemController {
  constructor(@Inject(PROBES) private readonly probes: Probes) {}

  @Get('health')
  health(@Query() query: unknown) {
    querySchema.parse(query);
    return { status: 'alive', service: 'api' };
  }

  @Get('ready')
  async ready(@Query() query: unknown, @Res() response: Response) {
    querySchema.parse(query);
    const report = await inspectReadiness(this.probes);
    if (report.status === 'ready') return response.json(report);
    response.setHeader('Retry-After', '1');
    return response.status(503).json({
      code: 'DEPENDENCY_UNAVAILABLE',
      message: 'errors.DEPENDENCY_UNAVAILABLE',
      correlation_id: response.getHeader('x-correlation-id'),
      details: report,
    });
  }
}

export async function createApp(
  probes: Probes,
  identityRuntime?: IdentityRuntime,
) {
  @Module({
    imports: identityRuntime
      ? [
          IdentityModule.forRoot(identityRuntime),
          PropertyModule.forRoot(identityRuntime),
          InventoryModule.forRoot(identityRuntime),
          ReservationsModule.forRoot(identityRuntime),
          FrontOfficeModule.forRoot(identityRuntime),
          FinanceModule.forRoot(identityRuntime),
          OperationsModule.forRoot(identityRuntime),
          NightAuditModule.forRoot(identityRuntime),
          ReportingModule.forRoot(identityRuntime),
          PlatformModule.forRoot(identityRuntime),
        ]
      : [],
    controllers: [SystemController],
    providers: [{ provide: PROBES, useValue: probes }],
  })
  class FoundationModule {}
  const app = await NestFactory.create<NestExpressApplication>(
    FoundationModule,
    { logger: false, bodyParser: false },
  );
  app.disable('x-powered-by');
  app.use((request: Request, response: Response, next: NextFunction) => {
    const id = correlationId(request.headers['x-correlation-id']);
    (request as Request & { correlationId?: string }).correlationId = id;
    response.setHeader('x-correlation-id', id);
    response.setHeader('cache-control', 'no-store');
    response.on('finish', () =>
      logEvent('request', {
        service: 'api',
        correlation_id: id,
        status: response.statusCode,
      }),
    );
    next();
  });
  app.use(helmet());
  app.useBodyParser('json', { limit: '16kb' });
  app.useGlobalFilters(new SafeErrors());
  return app;
}
