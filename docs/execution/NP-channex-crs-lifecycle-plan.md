# Selected Booking CRS staging lifecycle — discovery and execution plan

11 October 2026. **OFFICIAL_PAGES_READ / OPENSPEC_REQUIRED_FIELDS_CANCEL_PENDING / INSTALL_COST_CONFIG_PENDING / INSTALLATION_NOT_STARTED / BOOKING_LIFECYCLE_NOT_STARTED**. This is a source-only plan under the authorized isolated closed Channex staging trial. Root owns provider credentials, all account/API/DB/service/browser operations and evidence. The implementer made no provider account request or installation. Two initial web retrieval attempts failed with connection errors. Root subsequently retrieved the official Markdown pages successfully; their full contents were read from `.local/verification/NP-channex-pms-20261011/booking-crs-official.md` and `applications-official.md`. This supersedes the page-retrieval gap, while missing schema/cancellation/cost details remain unverified. No purchase, production connection, OTA certification, sale opening or G-13 acceptance is authorized by this document.

## Actual discovery from root

Root reports two successful authenticated GETs: `/api/v1/applications` and the installed-applications collection, both HTTP200. Booking CRS is present with application code `booking_crs`, ID `ff989900-41da-4dd7-b40c-e29808eed5c6`, `price:null`, `vr_price:null`, and `is_configurable:true`; no application is installed account-wide. Thus app availability is observed. Null price fields do not establish zero price, subscription terms, absence of billing or permission to purchase. `is_configurable:true` establishes that a configuration exists, not its schema, safe defaults or installation readiness. No cost/configuration conclusion is inferred from those fields.

Root's official-document verification identified [Applications API](https://docs.channex.io/api-v.1-documentation/applications-api) install endpoint `POST /api/v1/applications/install` with body `{ "application_installation": { "property_id": "SELECTED_TEST_PROPERTY_UUID", "application_code": "booking_crs" } }`. The retrieved page confirms `GET /api/v1/applications/installed`, install success HTTP200 with installation ID, property_id, application_code, settings and is_active fields, and `DELETE /api/v1/applications/:application_installation_id/uninstall` with HTTP200 success. Its example installation is a different app and does not establish Booking CRS settings/defaults. The page recommends stable application_code instead of application_id; it says some apps require additional configuration and directs configuration questions to provider support. No public Booking CRS configuration schema is supplied there. It explicitly says applications can be free or paid and directs readers to app details. Booking CRS null price fields appear in its example too, but there is no explicit free-installation or billing guarantee. This template is not an instruction to send an unresolved installation or accept a billable action. Root must resolve the actual account installation cost/configuration before installation; user staging-data authorization does not authorize purchasing.

## Fixed eligible scope

Only the selected TEST property for Villa4 and its selected V04-R01 atomic room/rate from the reviewed transport/PMS receipts may be used. Local database remains `hotel_np_operational_trial_20261009`, tenant `4e4da283-994c-41af-93ce-54b7fa89814e`, property `f5651217-3100-4da5-91ec-d3fe1775db7c`. External property/room/rate UUIDs must be copied from those exact reviewed artifacts, never guessed or rediscovered by name alone. Booking arrival2026-10-15/departure2026-10-16; two adults, zero children/infants; uniquely tagged synthetic Offline origin. Keep every overlapping room/whole-villa variant unavailable with stop_sell:true. No real guest/contact/card/guarantee/deposit/tax/service data or new webhook configuration. App installation could still have default side effects; their presence must be checked rather than assumed absent.

The current worker guard only accepts a single exact room/rate/date with Offline origin and adult2/children0/infants0, and rejects cancellation revisions with empty rooms before storage/ACK. Therefore a modification must preserve this exact guard scope, such as a documented synthetic amount change, rather than moving arrival/departure or room/rate. Root must verify an official change field and example before choosing it. If a valid provider cancellation omits rooms, it is an explicit compatibility gap requiring a separately reviewed scoped fix; do not relax the guard or manufacture room data in this plan.

## Official API facts and payload gaps

| Operation | Verified information available to this plan | Pending exact primary evidence |
|---|---|---|
| Install | POST `/api/v1/applications/install` with application_installation.property_id/application_code; HTTP200 installation fields; GET `/applications/installed`; uninstall endpoint above | Booking CRS configuration and actual account cost/terms; support contact is not authorized by this document |
| Create | POST `/api/v1/bookings` with top-level booking object; example includes property_id, ota_reservation_code, ota_name Offline, arrival_date/departure_date, currency, customer, rooms[].room_type_id/rate_plan_id/days and occupancy adults/children/infants/ages | OpenSpec required fields, constraints and safe omission of financial/contact fields; no minimal-schema acceptance claimed |
| Modify | PUT `/api/v1/bookings/:booking_id`; full booking object example with status modified plus the create-shaped fields; response has status modified and separate booking_id/revision_id | Whether partial updates are supported is unverified. Use a reviewed full body preserving fixed scope; provider amount change does not prove PMS financial materialization |
| Cancel | Page states CRS supports cancelling; official UI alternative previously documented in PMS certification | No cancel request example/endpoint/status payload on retrieved CRS Markdown page. Retrieve attached OpenSpec before proposing REST cancellation; no guessed DELETE/status body |
| Receiving/ACK | Existing verified property-filtered feed/GET/ACK pipeline | Actual new/modified/cancelled shapes, room-preserving cancellation, persisted store/materialization/ACK and unrelated-property non-ACK remain NOT_TESTED |


An asynchronous create/modify response is not immediate booking visibility, persisted PMS success or provider feed acknowledgment. An immediate404 may precede visibility. The official page labels this API beta/experimental. Both create and update explicitly use normal booking logic, triggering associated webhooks and availability changes according to property settings. Therefore omitting new webhook configuration does not mean there are no existing webhook effects; inspect the selected property configuration and preserve closed overlapping inventory before sending. HTTP2xx/null warnings cannot become channel/OTA proof. The existing PMS receiving consumer materializes INQUIRY/productnull without confirmed inventory or financial allocation; manual authorized reprocess must preserve that limitation.

## Bounded next root actions after primary evidence

1. The two official pages are now read. Root next retrieves their attached OpenSpec using the official file link, records required fields/cancellation semantics and establishes actual installation cost/configuration. Additional provider/account read requests outside those official pages must be concretely scoped by root before they occur. A real purchase remains outside authorization.
2. Create a concrete installation plan with exact TEST property/app code, configuration defaults/changes and expected side effects. Persist private INTENT before installation; use the installed-applications GET to reconcile an uncertain result. Never blindly repeat install or rely on null prices. No other property may gain an installation.
3. Once installation/configuration are established, prepare exact official synthetic create/modify/cancel bodies or official UI steps with hashes. Keep fixed room/rate/dates and a unique run tag, bounded request/poll budget, selected property feed baseline, and closed-ARI observation. Root validates actual clone service provenance and source hashes before the trial; avoid concurrent polling/worker restarts that can hide an outcome.
4. Persist INTENT before create; after uncertain create reconcile the selected feed/booking tag and returned IDs before any further create. Store actual booking ID and separate new revision ID. Pull/store through the real finite worker, reprocess through the existing authorized scoped PMS API, replay and compare versions/state, then ACK only the committed scoped revision. Verify disappearance from the selected feed; receiving a different property must remain unacknowledged. Empty feed alone is not lifecycle success.
5. Repeat for a verified compatible modification, then for cancellation. Preserve every failed attempt and stop on scope/occupancy/shape/unknown transport mismatch. Cancellation without room scope is blocked by current source; a blocked attempt does not prove supported cancellation. No fake reservation seed or direct SQL may replace PMS materialization.
6. Confirm all overlapping variants remain closed and synthetic baseline price is restored. Record actual worker/outbox/inbox/external-booking/reservation/item/segment/version/ACK IDs and before/after protected data hashes. Restore services to original hotel under root control and compare its tables/schema/sequences. Retain clone and evidence; do not clear unknown journals or delete an app/booking by a guessed rollback operation.

Root reports actual PMS first tick acknowledged one closed outbox restriction and sent zero booking ACKs; provider readback2 passed for availability0/stop_selltrue/IDR100000. A second tick logged generic failure and root is diagnosing it; it is not treated as a successful complete worker run. That can support its own provider-transport receipt; it does not establish CRS installation, receiving a booking or a lifecycle. Allowed eventual result is scoped **STAGING_CRS_LIFECYCLE_VERIFIED_WITH_LIMITS** only for operations actually evidenced. Until then installation/new/modify/cancel/materialization/ACK remain NOT_TESTED or explicitly BLOCKED. G-13 remains NOT ACCEPTED / FUNCTIONAL_BLOCKED; generic withdrawal proof, quota handover and downstream OTA coverage are unchanged.


## Official example-derived candidate body — review only

The following is a synthetic candidate based on the documented field shapes, not the official required-field schema or a ready-to-send payload. Its omissions of services/deposits/taxes/guarantee/payment/contact fields require OpenSpec confirmation. Replace identifiers/tag only from reviewed artifacts. The official example supports custom booking.meta but does not specify whether each field below is optional.

```json
{
  "booking": {
    "property_id": "REVIEWED_TEST_PROPERTY_UUID",
    "ota_reservation_code": "NP-CRS-UNIQUE_REVIEWED_RUN_TAG",
    "ota_name": "Offline",
    "arrival_date": "2026-10-15",
    "departure_date": "2026-10-16",
    "currency": "IDR",
    "meta": { "np_trial_run": "UNIQUE_REVIEWED_RUN_TAG" },
    "customer": { "name": "Synthetic", "surname": "NP Trial" },
    "rooms": [{
      "room_type_id": "REVIEWED_V04_R01_ROOM_UUID",
      "rate_plan_id": "REVIEWED_V04_R01_RATE_UUID",
      "days": { "2026-10-15": "100000.00" },
      "occupancy": { "adults": 2, "children": 0, "infants": 0, "ages": [] }
    }]
  }
}
```

For a reviewed full modification, reuse the complete verified body with booking.status=`modified` and change the single rooms[].days value to syntheticIDR110000.00 while retaining property/room/rate/dates/adult2 and tag. This follows the official full update example; partial omission/preservation semantics remain unknown. Confirm the provider exposes the changed amount in the selected revision and retain its new revision ID. The PMS consumer does not materialize that amount into confirmed allocation or financial settlement; its modified outcome with unchanged period proves revision consumption only. The CRS page's sample responses separately identify data.attributes.booking_id and revision_id; retain both, never use revision_id as the booking update path ID.

The official attachment appears as `Booking CRS OpenSpec collection` with `/files/NDv0uCsaxH0DUa9507MD`; root was asked for a bounded read of [that official file link](https://docs.channex.io/files/NDv0uCsaxH0DUa9507MD) and any redirect-resolved booking_crs.yml attachment. The attachment has not yet been read by this implementer; no cancellation request is derived from its presumed contents. Installation stays pending cost/configuration confirmation, and all receiving/booking lifecycle claims stay NOT_TESTED.


## Concrete reversible installation source — not executed

Root inspected first-party staging public UI asset `.local/verification/NP-channex-pms-20261011/staging-public-index.js`, componentE7n near offset5271070: it chooses price/vrPrice according to category and displays a monthly-fee element only when the selected value is truthy. With the freshly observed two null fields, the supported conclusion is **NO_MONTHLY_FEE_DISPLAYED**, not an unconditional free-service or future-billing guarantee. Combined with the existing authorization for reversible selected staging setup, root directed preparation of this exact install action; it is not purchase/subscription/configuration consent. Official [Applications API](https://docs.channex.io/api-v.1-documentation/applications-api) still warns that application costs differ and recommends inspecting app details.

Source [channex-staging-crs-install.mjs](../../scripts/channex-staging-crs-install.mjs) offers plan/apply and bounded GET-only reconciliation for TEST Villa4 UUID `e12fa48a-1939-4400-86fa-0b9575bf04e4` and booking_crs app ID `ff989900-41da-4dd7-b40c-e29808eed5c6`. Plan freshly reads apps and installed apps, requires both prices null, representation_settings null, is_configurable true and account-wide zero installations, then reads that property with explicit numeric acc_channels_count0 and selected V04-R01 availability0/stop_selltrue/price100000 for2026-10-15. Missing/unknown state stops. The exact install body is application_installation.property_id/application_code only; no settings, payment, subscription, booking, webhook or other provider mutation is sent.

The plan binds its own source, root-reviewed transport plan/hash and first-party evidence files. Private0700/0600 files hold nonsecret metadata/body/hash, never the key; root privately injects process.env.NP_CHANNEX_STAGING_KEY. Apply requires the actual reviewed plan SHA, rechecks fresh metadata/empty installed state/closed property, then writes a durable immutable INTENT before at most one exact POST/applications/install. It GETs installed apps afterward and requires exactly one matching selected-property/code/appID/active installation ID and empty settings, with selected ARI still closed. Unexpected populated settings or missing active/cost fields are review stops, not automatic configuration.

Unknown installation is never blindly repeated. A subsequent apply with existing INTENT only reconciles GET state and preserves the original journal; no second POST occurs. Failed calls get separate receipts. The persistent run.lock stays; root confirms its PID stopped before clearing between invocations. Request budget18, streamed response bound2MB and15-second deadlines limit each run. Script preparation executed only Prettier; no plan/apply or provider request was run by the implementer. Independent review and concrete root plan approval precede the real install.

```bash
node scripts/channex-staging-crs-install.mjs plan --out ACTUAL_PRIVATE_OUTPUT --transport-plan ACTUAL_REVIEWED_TRANSPORT_PLAN --transport-plan-sha256 ACTUAL_SHA256
node scripts/channex-staging-crs-install.mjs apply --out ACTUAL_PRIVATE_OUTPUT --approve-plan-sha256 ACTUAL_REVIEWED_INSTALL_PLAN_SHA256
```

The account metadata/install proof must remain separate from CRS booking receiving: installation POST_ATTEMPTED_WITH_DURABLE_INTENT and observed by independent read-only inspection, active status UNVERIFIED, booking lifecycle/ACK/materialization NOT_TESTED. Root now reports three expected-empty scoped worker ticks passed with zero effects and original hotel services restored; that does not create a CRS booking or validate lifecycle. Official webhook documentation and current UI signing options have unresolved contract differences; no receiver/tunnel/webhook configuration or HMAC header is inferred here. A future temporary HTTPS receiver needs its own concrete reviewed setup. G-13 remains NOT ACCEPTED.


Root actual `apply-1` stopped with exit1 after seven requests and `post_attempted=true`; its immutable INTENT and failure evidence remain preserved. Independent `installed-read-1` found exactly one selected Villa4/booking_crs installation `e2de77fc-d2ea-4657-a65b-6b901baefa56`, with empty settings and no `is_active` attribute, consistent with the official installed-list example. This proves installation presence; it does not prove active status. No repost is authorized or needed.

The new `reconcile` mode accepts only reviewed plan SHA `07be1bb35fa3ec759b5fd329ed801cbb285cb2dc5685a5016b02bfbdfd368757` and its original script SHA `943a81df5f5a265d3300b875be1a88cf749ee4f609f877f5282b0789b2543000`; all other evidence bindings remain exact. It requires the original INTENT fields/body hash, fresh matching app metadata, exactly that installation ID/property/code/app ID, empty settings and absent active field, plus fresh zero channels and selected closed ARI. Its request guard rejects every non-GET method before credential resolution or HTTP. It emits `installed=true`, `active_status=UNVERIFIED` in a new timestamped receipt, preserving the original lock, journal and failures. Apply remains strict and cannot use the historical plan with changed source to repost. This source has not been executed by the implementer; independent review precedes root reconciliation.

```bash
node scripts/channex-staging-crs-install.mjs reconcile --out ACTUAL_ORIGINAL_PRIVATE_OUTPUT --approve-plan-sha256 07be1bb35fa3ec759b5fd329ed801cbb285cb2dc5685a5016b02bfbdfd368757
```


Root actual `reconcile-1` completed with exit0. The timestamped `reconciled-*.json` receipt in `.local/verification/NP-channex-crs-20261011` records `installed=true`, `active_status=UNVERIFIED`, empty settings, fresh zero-channel/closed selected ARI checks, and no POST attempted during reconciliation. The original failed apply, immutable INTENT and failure receipt remain preserved. Across the install and reconciliation sequence, only the original single POST was attempted; no repost occurred. CRS booking lifecycle/receiving/ACK remains NOT_TESTED and G-13 remains NOT ACCEPTED.
