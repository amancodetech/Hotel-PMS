import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect, beforeAll, afterAll } from '@jest/globals';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
  withOwner,
} from './support/harness.mjs';
import { addBusinessDays, todayInTimeZone } from './support/business-dates.mjs';

let admin, tenant;
const day = (n) => addBusinessDays(todayInTimeZone('Asia/Jakarta'), n);
const key = () => randomUUID();
beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  tenant = admin.session.body.session.active_tenant_id;
});
afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test.each(['SENT', 'ACKNOWLEDGED', 'CHANNEL_VERIFIED', 'UNKNOWN', 'PARTIAL'])(
  'G13 R03 independent %s without withdrawal cutoff proof never releases protected inventory',
  async (withdrawalStatus) => {
    const created = await apiRequest(
      admin.context,
      'POST',
      `/tenants/${tenant}/properties`,
      {
        body: {
          code: `RVW13-${key().slice(0, 12)}`,
          name: 'Independent withdrawal synthetic',
          timezone: 'Asia/Jakarta',
        },
      },
    );
    expect(created.status).toBe(201);
    const p = created.body.property;
    const root = `/tenants/${tenant}/properties/${p.id}`;
    async function call(method, suffix, body, status = 200) {
      const response = await apiRequest(admin.context, method, root + suffix, {
        ...(body === undefined ? {} : { body }),
        headers: { 'idempotency-key': key() },
      });
      expect({
        status: response.status,
        ...(response.status === status ? {} : { body: response.body }),
      }).toEqual({ status });
      return response.body;
    }
    const resource = (
      await call(
        'POST',
        '/resources',
        { code: 'R1', type: 'ROOM', capacity: 2 },
        201,
      )
    ).resource;
    const product = (
      await call(
        'POST',
        '/products',
        {
          code: 'P1',
          name: 'Independent room',
          kind: 'ROOM',
          occupancy_adults_max: 2,
        },
        201,
      )
    ).product;
    await call(
      'POST',
      `/products/${product.id}/candidates`,
      { resource_id: resource.id },
      201,
    );
    await call('PATCH', `/products/${product.id}`, {
      version: product.version,
      status: 'ACTIVE',
    });
    const plan = (
      await call(
        'POST',
        '/rate-plans',
        {
          code: 'RATE',
          name: 'Independent rate',
          product_id: product.id,
          currency: 'IDR',
        },
        201,
      )
    ).rate_plan;
    await call('PATCH', `/rate-plans/${plan.id}`, {
      version: plan.version,
      status: 'ACTIVE',
    });
    await call('POST', '/rates/batch', {
      cells: [day(1), day(2)].map((date) => ({
        rate_plan_id: plan.id,
        date,
        occupancy: 2,
        money: { amount: '200000', currency: 'IDR' },
      })),
    });
    const connections = [];
    for (const channel of ['TIKET_COM', 'BOOKING_COM']) {
      const connection = (
        await call(
          'POST',
          '/connections',
          {
            provider_key: 'CHANNEX',
            environment: 'STAGING',
            channel_key: channel,
            external_property_id: `RVW13-${key()}`,
            secret_ref: 'local:hotel/rvw13-synthetic',
          },
          201,
        )
      ).connection;
      await call('PUT', `/connections/${connection.id}/mapping`, {
        channel_key: channel,
        external_room_ref: `room-${channel}`,
        external_rate_ref: `rate-${channel}`,
        occupancy: 2,
        internal_product_ref: product.id,
        internal_rate_ref: plan.id,
      });
      connections.push(connection.id);
    }
    const [a, b] = connections;
    async function preview(connection) {
      const rates = await call('GET', `/rates?from=${day(1)}&to=${day(3)}`);
      return call('POST', '/exposures/preview', {
        connection_id: connection,
        product_id: product.id,
        period: { arrival: day(1), departure: day(3) },
        resource_ids: [resource.id],
        inventory_version: rates.inventory_version,
      });
    }
    async function providerAccepted() {
      // Transport fixture only: explicitly no channel proof and no revision cutoff attestation.
      await withOwner((db) =>
        db.query(
          `update distribution_outbox_event set status='SENT', certainty='ACCEPTED',
       provider_request_id='RVW13-PROVIDER-ONLY', updated_at=now()
       where tenant_id=$1 and property_id=$2 and connection_id=$3 and aggregate_type='Exposure'`,
          [tenant, p.id, a],
        ),
      );
    }
    const proposed = await preview(a);
    expect(proposed.allowed).toBe(true);
    const published = await call(
      'POST',
      '/exposures',
      {
        preview_id: proposed.preview_id,
        preview_version: proposed.preview_version,
      },
      202,
    );
    const exposureId = published.operation_id;
    await providerAccepted();
    await call('POST', `/connections/${a}/reconcile`, {
      reason: 'Independent provider acceptance fixture',
    });
    await call(
      'POST',
      `/exposures/${exposureId}/withdraw`,
      { reason: 'Independent withdrawal without channel proof' },
      202,
    );
    await providerAccepted();
    // Synthetic status labels do not manufacture a channel proof or revision cutoff.
    await withOwner((db) =>
      db.query(
        `update distribution_outbox_event set status=$4, certainty=$5
     where tenant_id=$1 and property_id=$2 and connection_id=$3
       and aggregate_type='Exposure' and aggregate_id=$6`,
        [
          tenant,
          p.id,
          a,
          withdrawalStatus,
          ['UNKNOWN', 'PARTIAL'].includes(withdrawalStatus)
            ? 'UNKNOWN'
            : 'ACCEPTED',
          exposureId,
        ],
      ),
    );
    const before = await call('GET', `/connections/${a}/sync?attempts=true`);
    if (['SENT', 'ACKNOWLEDGED', 'CHANNEL_VERIFIED'].includes(withdrawalStatus))
      expect(before.provider_accepted_version).not.toBeNull();
    if (withdrawalStatus !== 'CHANNEL_VERIFIED')
      expect(before.channel_verified_version).toBeNull();
    // Simulate the caller discarding the first response, then retrying the same intent.
    // This is not a claim of an actual network transport failure.
    await call('POST', `/connections/${a}/reconcile`, {
      reason: 'Independent provider-only withdrawal attempt',
    });
    const reconciled = await call('POST', `/connections/${a}/reconcile`, {
      reason: 'Independent provider-only withdrawal attempt',
    });
    const competing = await preview(b);
    const state = await withOwner(async (db) => {
      const exposure = await db.query(
        'select state, cutoff from exposure where id=$1 and tenant_id=$2 and property_id=$3',
        [exposureId, tenant, p.id],
      );
      const allocations = await db.query(
        'select state, count(*)::int as count from exposure_allocation where exposure_id=$1 group by state',
        [exposureId],
      );
      const events = await db.query(
        'select event_type, event_version, status, certainty from distribution_outbox_event where tenant_id=$1 and property_id=$2 and aggregate_type=$3 and aggregate_id=$4 order by event_version',
        [tenant, p.id, 'Exposure', exposureId],
      );
      return {
        exposure: exposure.rows,
        allocations: allocations.rows,
        events: events.rows,
      };
    });
    const evidence = {
      boundary:
        'Synthetic isolated PG fixture; API setup and reconcile; owner SQL marks provider acceptance only, never channel proof.',
      withdrawal_status: withdrawalStatus,
      property_id: p.id,
      exposure_id: exposureId,
      before: {
        desired_version: before.desired_version,
        provider_accepted_version: before.provider_accepted_version,
        channel_verified_version: before.channel_verified_version,
        state: before.state,
      },
      reconciled,
      competing_preview: {
        allowed: competing.allowed,
        reason_codes: competing.reason_codes,
      },
      state,
    };
    const out =
      process.env.G13_EVIDENCE_DIR ?? '.local/verification/G13-current';
    mkdirSync(out, { recursive: true });
    const path = `${out}/withdrawal-independent-${Date.now()}.json`;
    writeFileSync(path, JSON.stringify(evidence, null, 2) + '\n');
    console.log(`G13 independent safe evidence: ${path}`);
    expect(reconciled.released).toBe(0);
    expect(competing.allowed).toBe(false);
    expect(competing.reason_codes).toContain('EXPOSURE_PROTECTED');
    expect(state.allocations).toEqual([{ state: 'RESERVED', count: 1 }]);
    expect(state.exposure[0].state).toBe('RECONCILING');
    const rejected = await apiRequest(
      admin.context,
      'POST',
      root + '/exposures',
      {
        body: {
          preview_id: competing.preview_id,
          preview_version: competing.preview_version,
        },
        headers: { 'idempotency-key': key() },
      },
    );
    expect(rejected.status).toBe(422);
    expect(rejected.body.code).toBe('PREVIEW_NOT_ALLOWED');
    const replay = await call('POST', `/connections/${a}/reconcile`, {
      reason: 'Independent provider-only withdrawal attempt',
    });
    expect(replay.released).toBe(0);
    expect((await preview(b)).allowed).toBe(false);
  },
);
