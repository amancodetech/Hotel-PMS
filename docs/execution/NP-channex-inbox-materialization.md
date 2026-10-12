# Channex inbox to PMS reservation — bounded source batch

11 October 2026. **SOURCE_PREPARED / ROOT_TESTS_PENDING / INDEPENDENT_REVIEW_PENDING**. The user-authorized isolated operational/staging trial permits this bounded repair; root owns all build, database, service and external operations. No migration, hotel data change or staging request was performed by this implementer. G-13 remains NOT ACCEPTED / FUNCTIONAL_BLOCKED.

The existing transport store commits `APPLIED` external booking state with no PMS `reservation_ref`. The consumer previously treated every APPLIED revision as DUPLICATE and could never materialize that normal transport path. Its replay guard now requires APPLIED plus a nonnull reservation reference. Its ordering bound includes only APPLIED revisions with reservation references, so a received future transport revision cannot block earlier revisions waiting for PMS consumption. `source_sequence` is varchar(30); numeric-only sequences are aggregated as numeric, preserving correct 9/10 ordering and ignoring nonnumeric tokens. No sequence semantics or inventory locking policy is otherwise changed.

Owned source: `packages/backend/src/modules/reservations/application/revision-service.ts`, `packages/backend/src/modules/reservations/persistence/channel-revision-repository.ts`, and `tests/property/revision-consumer.pg.test.mjs`. The appended PG test calls the actual transport store and scoped API, creates a separate connection, persists new9/modified10/cancelled11 plus an unrelated future999, checks transport APPLIED without reservations, rejects a foreign tenant, consumes each lifecycle revision, and checks exact state/versions on duplicate API replays. It checks a stale10 after materialized11, one reservation/item/segment, and zero commitments. This test is prepared, not executed by the implementer.

This preserves the existing INQUIRY design: new reservations have product_id null, no inventory commitment and no financial settlement. Successful materialization does not prove automatic confirmation, mapped allocation, operating check-in/checkout, actual worker polling, provider ACK, external transport or downstream OTA proof. Independent review and root-run tests must establish the exact demonstrated scope.

Root verification after independent source review and build:

```bash
pnpm test:property:fast --filter=revision-consumer --bail --keep
```

The standard harness creates/migrates an isolated temporary test database and starts its own API; root must first arrange service ports safely. `--keep` preserves the resulting database. Do not run the harness against hotel or the operational clone. Broaden to related P13/inbox tests only when root determines the final source and adapter batch are ready. The implementer ran Prettier only; no test counts or successful runtime result are claimed.

Next bounded runtime proposal: explicitly opt-in the existing worker to an allowlisted staging-only tenant/property/connection and exact staging origin; register the real adapter with a protected named secret resolver; schedule bounded pull/store before ACK. Reservation materialization initially remains the authorized scoped reprocess API, with explicit INQUIRY limitations. Use the existing PMS outbox to dispatch closed ARI and preserve its task/readback evidence. A one-shot runner alone cannot demonstrate worker scheduling. Production auto-discovery, channel certification and withdrawal proof remain outside this source batch.
