import { isSetupV2 } from '../domain/setup-v2.js';
import { readinessV2 } from './setup-execution-v2.js';
import type { MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import { PropertyError } from '../domain/errors.js';
import { auditActor, authorize } from './context.js';
import type { ServiceContext } from './context.js';
import {
  assertCode,
  assertGroupTransition,
  assertName,
  assertPropertyConfigurable,
  assertPropertyTransition,
  isCurrency,
  isPropertyGroupStatus,
  isPropertyStatus,
  isTimezone,
  type Currency,
  type PropertyGroupStatus,
  type PropertyStatus,
  type Timezone,
} from '../domain/lifecycle.js';
import {
  findPropertyGroup,
  insertPropertyGroup,
  listPropertyGroups,
  updatePropertyGroup,
} from '../persistence/group-repository.js';
import {
  findPropertyView,
  insertProperty,
  listPropertyViews,
  lockProperty,
  updateProperty,
} from '../persistence/property-repository.js';
import { listResourceTypes } from '../persistence/resource-type-repository.js';
import { findSetupDraft } from '../persistence/setup-repository.js';
import { setupReadinessIssues } from '../domain/setup.js';
import { enforceUsageLimit } from '../../platform/application/usage-service.js';
import { translatePropertyWrite } from '../persistence/db.js';
import type {
  PropertyGroupRow,
  PropertyRow,
  PropertyViewRow,
  ResourceTypeRow,
} from '../persistence/types.js';

function propertyAudit(
  property: PropertyRow | PropertyViewRow,
): Record<string, unknown> {
  return {
    code: property.code,
    name: property.name,
    group_id: property.group_id,
    timezone: property.timezone,
    base_currency: property.base_currency,
    status: property.status,
    inventory_version: property.inventory_version,
    version: property.version,
  };
}

export interface PropertyGroupInput {
  code: string;
  name: string;
}

export interface PropertyGroupPatch {
  version: number;
  name?: string;
  status?: PropertyGroupStatus;
}

export async function readPropertyGroups(
  orm: MikroORM,
  context: ServiceContext,
): Promise<PropertyGroupRow[]> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.read', null);
      return listPropertyGroups(em, context.tenantId);
    },
  );
}

export async function createPropertyGroup(
  orm: MikroORM,
  context: ServiceContext,
  input: PropertyGroupInput,
): Promise<PropertyGroupRow> {
  const code = assertCode(input.code);
  const name = assertName(input.name);
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.manage', null);
      const group = await translatePropertyWrite(() =>
        insertPropertyGroup(em, {
          tenantId: context.tenantId,
          code,
          name,
        }),
      );
      await recordAudit(em, {
        tenantId: context.tenantId,
        ...auditActor(context),
        action: 'property_group.created',
        resourceType: 'PropertyGroup',
        resourceId: group.id,
        outcome: 'SUCCESS',
        afterSafe: { code: group.code, name: group.name, status: group.status },
        correlationId: context.correlationId,
      });
      return group;
    },
  );
}

export async function updatePropertyGroupById(
  orm: MikroORM,
  context: ServiceContext,
  groupId: string,
  patch: PropertyGroupPatch,
): Promise<PropertyGroupRow> {
  const name = patch.name === undefined ? undefined : assertName(patch.name);
  if (patch.status !== undefined && !isPropertyGroupStatus(patch.status))
    throw new PropertyError('INVALID_REQUEST', { field: 'status' });
  if (!Number.isInteger(patch.version) || patch.version < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'version' });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.manage', null);
      const current = await findPropertyGroup(em, context.tenantId, groupId);
      if (!current) throw new PropertyError('NOT_FOUND');
      if (patch.status !== undefined)
        assertGroupTransition(current.status, patch.status);
      const updated = await updatePropertyGroup(em, {
        tenantId: context.tenantId,
        groupId,
        version: patch.version,
        name,
        status: patch.status,
      });
      if (!updated) throw new PropertyError('STALE_VERSION');
      await recordAudit(em, {
        tenantId: context.tenantId,
        ...auditActor(context),
        action: 'property_group.updated',
        resourceType: 'PropertyGroup',
        resourceId: groupId,
        outcome: 'SUCCESS',
        beforeSafe: { name: current.name, status: current.status },
        afterSafe: { name: updated.name, status: updated.status },
        correlationId: context.correlationId,
      });
      return updated;
    },
  );
}

export async function readResourceTypes(
  orm: MikroORM,
  context: ServiceContext,
): Promise<ResourceTypeRow[]> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.read', null);
      return listResourceTypes(em);
    },
  );
}

export interface PropertyInput {
  code: string;
  name: string;
  timezone: Timezone;
  baseCurrency: Currency;
  groupId: string | null;
}

export interface PropertyPatch {
  version: number;
  name?: string;
  groupId?: string | null;
  status?: PropertyStatus;
}

export async function readProperties(
  orm: MikroORM,
  context: ServiceContext,
): Promise<PropertyViewRow[]> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.read', null);
      return listPropertyViews(em, context.tenantId);
    },
  );
}

export async function readProperty(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
): Promise<PropertyViewRow> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.read', propertyId);
      const property = await findPropertyView(em, context.tenantId, propertyId);
      if (!property) throw new PropertyError('NOT_FOUND');
      return property;
    },
  );
}

export async function createProperty(
  orm: MikroORM,
  context: ServiceContext,
  input: PropertyInput,
): Promise<PropertyViewRow> {
  const code = assertCode(input.code);
  const name = assertName(input.name);
  if (!isTimezone(input.timezone))
    throw new PropertyError('INVALID_REQUEST', { field: 'timezone' });
  if (!isCurrency(input.baseCurrency))
    throw new PropertyError('INVALID_REQUEST', { field: 'base_currency' });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.manage', null);
      await enforceUsageLimit(em, context.tenantId, 'PROPERTIES', 1);
      if (input.groupId) {
        const group = await findPropertyGroup(
          em,
          context.tenantId,
          input.groupId,
        );
        if (!group) throw new PropertyError('CROSS_SCOPE_REFERENCE');
      }
      const property = await translatePropertyWrite(() =>
        insertProperty(em, {
          tenantId: context.tenantId,
          groupId: input.groupId,
          code,
          name,
          timezone: input.timezone,
          baseCurrency: input.baseCurrency,
        }),
      );
      await recordAudit(em, {
        tenantId: context.tenantId,
        ...auditActor(context),
        action: 'property.created',
        resourceType: 'Property',
        resourceId: property.id,
        outcome: 'SUCCESS',
        afterSafe: propertyAudit(property),
        correlationId: context.correlationId,
      });
      return property;
    },
  );
}

export async function updatePropertyById(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  patch: PropertyPatch,
): Promise<PropertyViewRow> {
  const name = patch.name === undefined ? undefined : assertName(patch.name);
  if (patch.status !== undefined && !isPropertyStatus(patch.status))
    throw new PropertyError('INVALID_REQUEST', { field: 'status' });
  if (!Number.isInteger(patch.version) || patch.version < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'version' });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.manage', propertyId);
      const current = await lockProperty(em, context.tenantId, propertyId);
      assertPropertyConfigurable(current.status);
      if (patch.status !== undefined)
        assertPropertyTransition(current.status, patch.status);
      // ADR S10(b): activating a property that still carries a stored draft
      // must fail closed when the draft input has blocking gaps, regardless of
      // a stale `completed` flag; this keeps the gate identical to what
      // GetSetupReadiness reports for the same draft. Properties without a
      // draft keep activating as before.
      if (patch.status === 'ACTIVE' && current.status === 'SETUP') {
        const draft = await findSetupDraft(em, context.tenantId, propertyId);
        if (draft) {
          const issues = isSetupV2(draft.input)
            ? readinessV2(draft.input)
            : setupReadinessIssues(draft.input);
          if (issues.length > 0)
            throw new PropertyError('SETUP_READINESS_BLOCKED', { issues });
        }
      }
      if (patch.groupId) {
        const group = await findPropertyGroup(
          em,
          context.tenantId,
          patch.groupId,
        );
        if (!group) throw new PropertyError('CROSS_SCOPE_REFERENCE');
      }
      const changed = await updateProperty(em, {
        tenantId: context.tenantId,
        propertyId,
        version: patch.version,
        name,
        groupId: patch.groupId,
        status: patch.status,
      });
      if (!changed) throw new PropertyError('STALE_VERSION');
      const updated = await findPropertyView(em, context.tenantId, propertyId);
      if (!updated) throw new PropertyError('NOT_FOUND');
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'property.updated',
        resourceType: 'Property',
        resourceId: propertyId,
        outcome: 'SUCCESS',
        beforeSafe: propertyAudit(current),
        afterSafe: propertyAudit(updated),
        correlationId: context.correlationId,
      });
      return updated;
    },
  );
}
