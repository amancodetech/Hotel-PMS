# Reservation-driven ARI — batch 01, local derivation

12 October 2026. Status: **STOPPED_BY_USER / DRAFT_SOURCE_NOT_ACTIVATED / NOT_TESTED / INDEPENDENT_REVIEW_INCOMPLETE**.

The user stopped ARI implementation and requested upload of the current workspace source snapshot to GitHub. The draft source/hooks below remain preserved, without activation or executed verification; independent review is incomplete. Historical check-final-4 applies to the preceding source, not this snapshot. Upload is not production acceptance. No further ARI source changes, build, tests, services or provider execution are authorized by the upload task.

The earlier local batch authorization prioritized operational reservation close/reopen behavior. The preserved draft adds a transaction hook for direct confirm, modify and cancel, with an optional policy supplied by composition and absent by default. It does not activate runtime configuration, contact Channex, change the closed-only staging worker, implement Webhook/HTTPS, release protected exposure or change D-20. G-13 remains NOT ACCEPTED / FUNCTIONAL_BLOCKED.

## Owned files and design

- `packages/backend/src/modules/inventory/domain/reservation-ari-policy.ts`: finite policy and deterministic absolute local cells.
- `packages/backend/src/modules/inventory/application/reservation-ari-service.ts`: canonical reads in the reservation transaction, exact database/scope validation and local derived outbox.
- `packages/backend/src/modules/reservations/application/commitment-service.ts`: optional dependency and three calls after reservation mutation/version bump, before idempotency result storage.
- New focused unit/isolated PostgreSQL fixtures; existing worker, dispatcher, migrations, original hotel and historical trial data are outside this batch.

Policy selects exactly one whole product and its three physical room products for one half-open night, with explicit database, tenant, property, connection/version/status, four mapping/version/status/external-reference pins and the exact whole composition version. Runtime construction is absent. Only isolated `hotel_test_*` or the dated operational clone database is eligible; `hotel` is rejected. WHOLE enables only the whole variant; PARTS enables only the room variants. Canonical allocations, blocks, parent-aware resource/product/property readiness, active sale restrictions and protected exposure constrain eligibility. Cancellation recomputes these facts and cannot unconditionally reopen. Unknown or absent required evidence closes the local result. Mapping and geometry drift fail the opted-in transaction; replay returns the existing idempotency result before derivation. Unrelated tenant/property/product/date mutations skip before canonical SQL; modify supplies both old and new periods and recomputes the entire selected night when either intersects.

One `ReservationAriLocalSnapshot` outbox contains `canonical_ari`, with no dispatcher `cells` field. It is parked as `CANCELLED` with `LOCAL_EVIDENCE_ONLY` inside the same transaction, so existing leasing cannot dispatch it. This status means transport is disabled; it does not describe reservation cancellation or provider state. Therefore it is **local evidence**, not an AvailabilitySnapshot or RestrictionSnapshot ready for provider transmission. Runtime activation and a dedicated reviewed finite transport are **NOT_IMPLEMENTED**. Existing closed-only worker remains unchanged.

Exposure allocations in RESERVED state are retained by existing canonical conflict reads. Additional exposure-header reads protect any intersecting non-DRAFT/non-RELEASED state, including UNKNOWN and RECONCILING even when allocation rows are absent or released; they conservatively close this four-representation group across all connections. Active restrictions on overlapping representations also close intersecting atoms across connections. No protected exposure or restriction is released by this service. Query failures abort the transaction; absence of required product or geometry pins rejects it. The service is a local diagnostic derivation, not opening proof for the existing clone or provider.

## Binding evidence and unresolved gates

Historical sanitized `NP-channex-pms-20261011/prepared.json` binds clone tenant `4e4da283-994c-41af-93ce-54b7fa89814e`, property `f5651217-3100-4da5-91ec-d3fe1775db7c`, connection `b106e14f-5740-46a4-a1e7-a298e5f31e2b`, external Villa4 `e12fa48a-1939-4400-86fa-0b9575bf04e4`, date 2026-10-15. It has only a historical V04-R01 mapping `8ec2160a-b1e8-4d4d-ad27-6433e1989fbd`, room `4d36bfe6-8dae-4a7b-93d0-b66859d9877a`, rate `36cb82ac-cd2b-4a34-b369-9b1807a31cc7`. These are historical receipts, not current database verification.

Root-owned safe read-only clone/catalog extracts must establish the exact four product/resource/composition bindings, current connection/mapping versions, restrictions, intersecting RESERVED/UNKNOWN/RECONCILING exposures and selected-night canonical state. No identifiers or mapping versions will be invented. Missing bindings remain a gate for operational/provider trial. Tests use synthetic isolated data; they cannot prove the existing clone or provider state.

Before any later external opening: independently reviewed exact transport plan, fresh zero OTA count/closed baseline, finite authorization window, reviewed mappings and exclusive sale mode; all mode switches close and verify first. Provider GET alone never releases protected exposure.

## Verification and handoff

Implementer performed source/document work only. Root exclusively runs build, tests, databases, services, browser and network. No test result is asserted yet. New focused unit fixtures cover finite mode selection, retained denial reasons, unknown/missing/duplicate evidence, original database rejection, date validation and invalid geometry. New isolated PostgreSQL fixtures exercise actual confirm/modify/cancel service calls with synthetic products/mappings: whole/parts overlap in both directions, retained other-room commitment after partial cancellation, retained block/STOP_SELL/UNKNOWN/RECONCILING exposure, modify union of old/new periods, rollback including idempotency, replay, current inventory version, optional dependency absence and tenant/property/product/date early isolation. Evidence rows are asserted parked with no standard `cells` field. These fixtures are not an existing-clone or provider trial.

Deferred resume commands from the stopped plan, **not executed and not part of the upload task**:

```bash
pnpm --filter @hotel/backend build
NODE_OPTIONS=--experimental-vm-modules pnpm exec jest --runInBand tests/reservation-ari.test.mjs
PROPERTY_SHARED_API=0 pnpm test:property:fast --filter=reservation-ari.pg.test.mjs
```

Expected fixture counts before execution: 15 unit cases and 6 PostgreSQL cases; these are planned counts, not passing results. The existing property harness creates an isolated database and identity preconditions; the new fixture starts no API, worker, browser or provider requests itself. Root owns command receipts and any harness effects. Actual receipts and counts will be recorded after root execution. Independent Astra review is pending. External auto close/open, booking delivery/ACK, Webhook, OTA and production acceptance remain NOT_TESTED.

References: [diagnosis and full trial contract](NP-channex-auto-sync.md), [resume point](NP-trial-progress.md), [independent review](NP-channex-staging-independent-review.md). CAP-01/02/03/13, D-19/D-20 and existing BR/INV/CMP/AT identifiers retain their meaning; this local batch grants no acceptance gate.
