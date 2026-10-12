# Independent review — reservation-driven ARI batch 01

12 October 2026. Reviewer: GPT-6 Astra. **REVIEW_IN_PROGRESS / ROOT_EXECUTION_PENDING**. This review covers the optional local reservation transaction hook and finite canonical derivation only. The reviewer reads source and root-supplied evidence; root alone executes builds, tests, databases, services, browser and provider operations. No independent runtime execution is claimed.

## Summary

The bounded first batch is useful if it proves that direct confirm, modify and cancel atomically derive absolute inventory state from the committed canonical facts. A non-dispatchable `ReservationAriLocalSnapshot` can establish this local seam without claiming provider closure or reopening. Source implementation and root-run results remain pending at this initial review entry.

## Findings

Local PASS requires review of actual source and actual root execution evidence, with every P0/P1 finding closed. Planned fixtures and historical checks are not results of this batch.

### ARI-R01 — P1: filter affected reservation scope before derivation

Initial source of `inventory/application/reservation-ari-service.ts:createReservationAriLocalHook` filters only tenant/property. Its mutation input has no affected product or period, so any direct reservation in that property triggers the selected Villa4/night snapshot. Mapping drift can therefore abort an unrelated room or adjacent-night reservation. This contradicts the batch's exact-reference/date isolation contract. Pass affected product and old/new periods from all three mutation sites and return before binding validation when none intersects the finite policy. Verify an unrelated product and adjacent night succeed without a derived event, even with stale policy bindings. Source trace identified; root-run reproduction/regression pending.

Follow-up: **CLOSED_SOURCE / ROOT_REGRESSION_PENDING**. The three call sites now pass affected product/periods, including both previous and next modify periods. The hook returns before all database reads when tenant/property/product/night do not match. The prepared fixture exercises each early scope exclusion with an entity manager that fails on any SQL.

### ARI-R02 — P1: pin the whole composition version

Initial `ReservationAriPolicy` contains resource IDs but no composition version ID. The service accepts any single active composition covering the night with the same leaves. A replacement version therefore passes despite the documented exact composition binding/drift contract. Pin and compare the reviewed whole composition version, retain complete-night coverage validation, and test a replacement version with unchanged leaves. Source trace identified; root-run reproduction/regression pending.

Follow-up: **CLOSED_SOURCE / ROOT_REGRESSION_PENDING**. Policy now pins `compositionVersionId`; every whole coverage row must use that ID, with exactly one active composition and complete selected-night coverage. A same-leaf replacement regression is requested.

### ARI-R03 — P2: validate departure as a real calendar date

Initial policy validation roundtrips the arrival only. JavaScript normalizes a non-leap `2027-02-29` departure to March 1, allowing it after `2027-02-28` at construction before PostgreSQL rejects the date. Apply the same strict roundtrip to departure and cover the invalid leap-date case. Root-run regression pending.

Follow-up: **CLOSED_SOURCE / ROOT_REGRESSION_PENDING**. Both endpoints now require a finite parsed value and exact ISO-date roundtrip. The invalid non-leap departure is in the prepared unit fixture.

## Strengths

- Optional hook calls are inside existing scoped mutation transactions, after inventory-version increment and before idempotency storage; current application composition supplies no hook.
- The implementation recomputes all four finite-night facts from physical allocation conflicts, readiness, overlapping restrictions and exposure protection; it does not reopen merely because an item was cancelled.
- Local snapshots omit dispatcher `cells` and are parked as outbox `CANCELLED` with `LOCAL_EVIDENCE_ONLY` in the same transaction. This status describes disabled transport, not a reservation cancellation. The ordinary lease selector excludes that status; malformed standard snapshots are also rejected before adapter push.

## Required local evidence

- The hook is absent by default, runs under the existing property lock in the mutation transaction, and commits or rolls back alongside allocations, reservation state, inventory version and idempotency.
- Confirm closes every affected eligible overlapping variant. Cancellation recomputes remaining commitments, blocks, restrictions and resource/product readiness. WHOLE and PARTS eligibility is exclusive, with no unconditional reopen.
- Modify covers both old and new occupancy periods, clipped to the exact finite policy night; unrelated tenants, properties, products and adjacent dates produce no derived event.
- Replay produces no duplicate derived snapshot; payload and event inventory versions equal the post-mutation canonical version. Mapping and geometry drift fail the opted-in transaction.
- RESERVED exposure allocations and UNKNOWN/RECONCILING protection remain unavailable. No local derivation releases protected exposure or treats provider GET as release proof.
- Payload has `canonical_ari` and no standard dispatcher `cells`. Existing generic validation must prevent adapter push, and the closed-only staging worker and runtime composition remain unchanged.

## Operational and external gates remain open

The historical plan supplies only one V04-R01 mapping, not four current verified bindings. Before operational/provider use, root must produce a safe current catalog extract binding the exact clone tenant/property/connection; Villa4 whole product and composition version; its three physical room products/resources; and all four external property/room/rate UUIDs and mapping versions. The selected night, geometry validity dates and current restrictions must be verified explicitly. Historical 2026-10-15 evidence is not a fresh authorization window or a current database read.

Any later opening additionally needs a separately reviewed finite transport, fresh zero downstream OTA counts, verified closed baseline, and exclusive sale mode. Mode transitions close every affected variant and verify closure before opening the other mode. Intersecting RESERVED/UNKNOWN/RECONCILING protected exposure prevents use unless a separately authorized complete release proof exists; none is established by this batch.

Runtime activation and reservation-driven provider close/open remain **NOT_IMPLEMENTED / NOT_TESTED** until separately evidenced. Provider booking delivery/ACK, Webhook receiver, HTTPS callback, downstream OTA evidence and production acceptance are outside this review. G-13 remains **NOT ACCEPTED / FUNCTIONAL_BLOCKED**; D-19/D-20 are unchanged.

References: [batch card](NP-channex-auto-sync-batch-01.md), [full trial contract](NP-channex-auto-sync.md), [prior staging review](NP-channex-staging-independent-review.md), [resume point](NP-trial-progress.md), [deferred webhook plan](NP-channex-webhook-plan.md).
