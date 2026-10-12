import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import {
  readSetupBatch,
  startSetupBatch,
  advanceSetupBatch,
  simulateSetupProduct,
  setupUnitAddition,
  parseSetupV2,
  applySetupDraft,
  discardSetupDraft,
  importSetupUnits,
  listSetupTemplates,
  parseSetupIfMatch,
  previewSetupDraft,
  readSetupDraft,
  readSetupReadiness,
  saveSetupDraft,
  simulateSetupSale,
} from '@hotel/backend';
import type { SetupDraftInput, SetupTemplate } from '@hotel/backend';
import { IDENTITY } from '../identity/tokens.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import { RequirePermission } from '../identity/guards.js';
import type { AuthedRequest } from '../identity/guards.js';
import { serviceContext } from './property.controller.js';
import type { SetupDraftView } from '@hotel/backend';

const uuid = z.string().uuid();
const templateCode = z.enum([
  'ROOM',
  'CABIN',
  'TENT',
  'VILLA',
  'APARTMENT',
  'DORM',
  'SITE',
  'SUITE',
]);
const rentalMode = z.enum(['EXCLUSIVE', 'WHOLE_OR_PARTS', 'BEDS']);
const sharingScope = z.enum(['MIXED', 'FEMALE', 'MALE']);
const specCode = z.enum(['KING', 'TWIN']);

const setupPart = z
  .object({
    label: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{1,16}$/),
    capacity: z.number().int().min(1).max(100).nullable().optional(),
  })
  .strict();

const unitGroup = z
  .object({
    id: z.string().trim().max(64).nullable().optional(),
    template_code: templateCode,
    pattern: z.string().trim().max(32),
    exclusions: z.array(z.string().trim().max(16)).max(200).optional(),
    capacity: z.number().int().min(1).max(100).nullable().optional(),
    location_code: z.string().trim().max(40).nullable().optional(),
    rental_mode: rentalMode.nullable().optional(),
    privacy_ack: z.boolean().optional(),
    sharing_scope: sharingScope.nullable().optional(),
    beds_per_unit: z.number().int().min(1).max(50).nullable().optional(),
    guaranteed_specs: z.array(specCode).optional(),
    parts: z.array(setupPart).max(20).optional(),
    connected_codes: z
      .array(z.string().trim().min(1).max(80))
      .max(20)
      .optional(),
  })
  .strict();

const draftInput = z
  .object({
    property: z
      .object({
        name: z.string().trim().min(2).max(120).nullable().optional(),
        code: z.string().trim().max(20).nullable().optional(),
        country: z.string().trim().max(60).nullable().optional(),
        timezone: z
          .enum(['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'])
          .nullable()
          .optional(),
        base_currency: z.enum(['IDR', 'USD']).nullable().optional(),
        types: z.array(templateCode).max(8).optional(),
      })
      .strict(),
    unit_groups: z.array(unitGroup).max(20),
    operations: z
      .object({
        check_in: z
          .string()
          .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/)
          .nullable()
          .optional(),
        check_out: z
          .string()
          .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/)
          .nullable()
          .optional(),
        inspection_required: z.boolean().optional(),
        explicit_states: z.boolean().optional(),
      })
      .strict(),
    pricing: z
      .object({
        postponed: z.boolean(),
        plan_name: z.string().trim().max(80).nullable().optional(),
        sell_from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .optional(),
        sell_to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .optional(),
        base_price: z
          .string()
          .regex(/^[0-9]{1,14}(\.[0-9]{1,6})?$/)
          .nullable()
          .optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

const previewBody = z
  .object({ preview_version: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();

const importBody = z
  .object({
    mode: z.enum(['DRY_RUN', 'APPLY']),
    file_name: z.string().trim().min(1).max(200),
    content: z.string().min(1),
  })
  .strict();

const simulationQuery = z
  .object({
    scope: z.enum(['WHOLE', 'PART', 'BED']),
    unit_code: z.string().trim().min(1).max(40),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

function draftDto(view: SetupDraftView) {
  return {
    draft_id: view.draft_id,
    property_id: view.property_id,
    revision: view.revision,
    updated_at: view.updated_at,
    updated_by_user_id: view.updated_by_user_id,
    completed: view.completed,
    input: view.input,
  };
}

function templateDto(template: SetupTemplate) {
  return {
    code: template.code,
    resource_type: template.resourceType,
    default_rental_mode: template.defaultRentalMode,
    supports_parts: template.supportsParts,
    supports_beds: template.supportsBeds,
    default_capacity: template.defaultCapacity,
    guaranteed_setup_options: template.guaranteedSetupOptions,
  };
}

@Controller('api/v1/tenants')
export class SetupController {
  constructor(@Inject(IDENTITY) private readonly runtime: IdentityRuntime) {}

  @RequirePermission('property.read')
  @Get(':tenantId/properties/:propertyId/setup-batches')
  async batchStatus(
    @Req() req: AuthedRequest,
    @Param('tenantId') tenant: string,
    @Param('propertyId') property: string,
    @Query() query: unknown,
  ) {
    const q = z.object({ id: uuid.optional() }).strict().parse(query);
    return readSetupBatch(
      this.runtime.orm,
      serviceContext(req, uuid.parse(tenant)),
      uuid.parse(property),
      q.id,
    );
  }
  @RequirePermission('property.resource.manage')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/setup-batches')
  async batchStart(
    @Req() req: AuthedRequest,
    @Param('tenantId') tenant: string,
    @Param('propertyId') property: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
  ) {
    const input = z
      .discriminatedUnion('mode', [
        z
          .object({
            mode: z.literal('DRAFT'),
            preview_version: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
        z
          .object({
            mode: z.literal('ADDITION'),
            input: z.unknown(),
            preview_version: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      ])
      .parse(body);
    return startSetupBatch(
      this.runtime.orm,
      serviceContext(req, uuid.parse(tenant)),
      uuid.parse(property),
      input,
      { idempotencyKey: key, ifMatch },
    );
  }
  @RequirePermission('property.resource.manage')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/setup-batches/:batchId/advance')
  async batchAdvance(
    @Req() req: AuthedRequest,
    @Param('tenantId') tenant: string,
    @Param('propertyId') property: string,
    @Param('batchId') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    const input = z
      .object({
        index: z.number().int().min(0),
        preview_version: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(body);
    return advanceSetupBatch(
      this.runtime.orm,
      serviceContext(req, uuid.parse(tenant)),
      uuid.parse(property),
      uuid.parse(id),
      input,
      key,
    );
  }

  @RequirePermission('property.read')
  @Get(':tenantId/setup-templates')
  async listTemplates(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
  ) {
    const templates = await listSetupTemplates(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
    );
    return { items: templates.map(templateDto) };
  }

  @RequirePermission('property.read')
  @Get(':tenantId/properties/:propertyId/setup-draft')
  async getDraft(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
  ) {
    const draft = await readSetupDraft(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
    );
    return { draft: draft ? draftDto(draft) : null };
  }

  @RequirePermission('property.manage')
  @Put(':tenantId/properties/:propertyId/setup-draft')
  async putDraft(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
  ) {
    const input =
      typeof body === 'object' && body !== null && 'schema_version' in body
        ? parseSetupV2(body)
        : (draftInput.parse(body) as SetupDraftInput);
    const result = await saveSetupDraft(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      input,
      {
        idempotencyKey: idempotencyKey ?? null,
        ifMatch: parseSetupIfMatch(ifMatch),
      },
    );
    return { draft: draftDto(result.draft), replayed: result.replayed };
  }

  @RequirePermission('property.read')
  @Get(':tenantId/properties/:propertyId/setup-readiness')
  async readiness(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
  ) {
    return readSetupReadiness(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
    );
  }

  @RequirePermission('property.read')
  @Get(':tenantId/properties/:propertyId/setup-simulation')
  async simulation(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Query() query: unknown,
  ) {
    const parsed = simulationQuery.parse(query);
    return simulateSetupSale(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        scope: parsed.scope,
        unitCode: parsed.unit_code,
        from: parsed.from,
        to: parsed.to,
      },
    );
  }

  @RequirePermission('property.read')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/setup-draft/preview')
  async previewDraft(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
  ) {
    return previewSetupDraft(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
    );
  }

  @RequirePermission('property.resource.manage')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/setup-draft/apply')
  async applyDraft(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
  ) {
    return applySetupDraft(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      previewBody.parse(body).preview_version,
      {
        idempotencyKey: idempotencyKey ?? null,
        ifMatch: parseSetupIfMatch(ifMatch),
      },
    );
  }

  @RequirePermission('property.read')
  @Get(':tenantId/properties/:propertyId/setup-product-simulation')
  async productSimulation(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Query() query: unknown,
  ) {
    const parsed = z
      .object({
        product_id: uuid,
        from: z.iso.date(),
        to: z.iso.date(),
        adults: z.coerce.number().int().min(1).max(100),
        quantity: z.coerce.number().int().min(1).max(20),
      })
      .strict()
      .parse(query);
    return simulateSetupProduct(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      {
        productId: parsed.product_id,
        from: parsed.from,
        to: parsed.to,
        adults: parsed.adults,
        quantity: parsed.quantity,
      },
    );
  }

  @RequirePermission('property.read')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/setup-unit-additions/preview')
  async previewAddition(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Body() body: unknown,
  ) {
    return setupUnitAddition(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      body,
    );
  }

  @RequirePermission('property.resource.manage')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/setup-unit-additions')
  async applyAddition(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
  ) {
    const parsed = z
      .object({
        input: z.unknown(),
        preview_version: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(body);
    return setupUnitAddition(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      parsed.input,
      { previewVersion: parsed.preview_version, ifMatch, idempotencyKey: key },
    );
  }

  @RequirePermission('property.resource.manage')
  @HttpCode(200)
  @Post(':tenantId/properties/:propertyId/setup-unit-imports')
  async importUnits(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = importBody.parse(body);
    return importSetupUnits(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      input,
      idempotencyKey ?? null,
    );
  }

  @RequirePermission('property.manage')
  @Delete(':tenantId/properties/:propertyId/setup-draft')
  async deleteDraft(
    @Req() request: AuthedRequest,
    @Param('tenantId') tenantId: string,
    @Param('propertyId') propertyId: string,
    @Headers('if-match') ifMatch: string | undefined,
  ) {
    const result = await discardSetupDraft(
      this.runtime.orm,
      serviceContext(request, uuid.parse(tenantId)),
      uuid.parse(propertyId),
      { ifMatch: parseSetupIfMatch(ifMatch) },
    );
    return result;
  }
}
