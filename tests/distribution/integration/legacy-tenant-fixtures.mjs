export const legacyTenantFixture = {
  tenantA: 'dddd1111-2222-4333-8444-666666666601',
  tenantB: 'dddd1111-2222-4333-8444-666666666602',
  propertyA: 'dddd1111-2222-4333-8444-777777777701',
  propertyB: 'dddd1111-2222-4333-8444-777777777702',
  connectionA: 'dddd1111-2222-4333-8444-555555555501',
  connectionB: 'dddd1111-2222-4333-8444-555555555502',
  orphanConnection: 'dddd1111-2222-4333-8444-555555555503',
  orphanTenant: 'dddd1111-2222-4333-8444-666666666699',
  mixedOutbox: 'dddd1111-2222-4333-8444-444444444401',
  mixedInbox: 'dddd1111-2222-4333-8444-444444444402',
  mixedException: 'dddd1111-2222-4333-8444-333333333301',
  orphanOutbox: 'dddd1111-2222-4333-8444-444444444403',
  orphanInbox: 'dddd1111-2222-4333-8444-444444444404',
  orphanException: 'dddd1111-2222-4333-8444-333333333302',
  orphanDeadLetter: 'dddd1111-2222-4333-8444-222222222201',
  orphanDedup: 'dddd1111-2222-4333-8444-111111111101',
  orphanAttempt: 'dddd1111-2222-4333-8444-000000000001',
  orphanCheckpoint: 'dddd1111-2222-4333-8444-999999999901',
  orphanBooking: 'dddd1111-2222-4333-8444-888888888801',
  orphanCapability: 'dddd1111-2222-4333-8444-777777777703',
  orphanMapping: 'dddd1111-2222-4333-8444-666666666603',
};

export function legacyTenantSeedStatements() {
  const f = legacyTenantFixture;
  return [
    `insert into "tenant" ("id", "name", "slug") values
       ('${f.tenantA}', 'Legacy Tenant A', 'legacy-tenant-a'),
       ('${f.tenantB}', 'Legacy Tenant B', 'legacy-tenant-b')`,
    `insert into "distribution_connection"
       ("id", "tenant_id", "property_id", "provider_key", "environment",
        "channel_key", "external_property_id", "secret_ref")
     values
       ('${f.connectionA}', '${f.tenantA}', '${f.propertyA}', 'simulator', 'simulator',
        'tiket-com', 'LEGACY-A', 'secret:synthetic'),
       ('${f.connectionB}', '${f.tenantB}', '${f.propertyB}', 'simulator', 'simulator',
        'tiket-com', 'LEGACY-B', 'secret:synthetic'),
       ('${f.orphanConnection}', '${f.orphanTenant}', '${f.propertyB}', 'simulator',
        'simulator', 'tiket-com', 'LEGACY-ORPHAN', 'secret:synthetic')`,
    `insert into "distribution_outbox_event"
       ("id", "tenant_id", "property_id", "connection_id", "channel_key",
        "aggregate_type", "aggregate_id", "event_type", "event_version",
        "inventory_version", "payload_safe")
     values ('${f.mixedOutbox}', '${f.tenantA}', '${f.propertyA}', '${f.connectionB}',
             'tiket-com', 'inventory', '${f.mixedOutbox}', 'AvailabilitySnapshot',
             1, 1, '{}'::jsonb)`,
    `insert into "distribution_exception_case"
       ("id", "tenant_id", "property_id", "connection_id", "type", "state",
        "details_safe")
     values ('${f.mixedException}', '${f.tenantB}', '${f.propertyB}', '${f.connectionB}',
             'MAPPING_MISSING', 'OPEN', '{}'::jsonb)`,
    `insert into "distribution_inbox_revision"
       ("id", "connection_id", "channel_key", "provider_key", "environment",
        "provider_revision_id", "external_booking_id", "revision_type",
        "payload_hash", "payload_safe", "received_at", "exception_id",
        "ack_state", "ack_attempt_count")
     values ('${f.mixedInbox}', '${f.connectionA}', 'tiket-com', 'simulator',
             'simulator', 'LEGACY-MIXED-INBOX', 'LEGACY-MIXED', 'new',
             repeat('f', 64), '{}'::jsonb, now(), '${f.mixedException}',
             'SENT', 1)`,
    `insert into "distribution_outbox_event"
       ("id", "tenant_id", "property_id", "connection_id", "channel_key",
        "aggregate_type", "aggregate_id", "event_type", "event_version",
        "inventory_version", "payload_safe", "next_attempt_at")
     values ('${f.orphanOutbox}', '${f.orphanTenant}', '${f.propertyB}',
             '${f.orphanConnection}', 'tiket-com', 'inventory',
             '${f.orphanOutbox}', 'AvailabilitySnapshot', 1, 1, '{}'::jsonb,
             now() - interval '1 minute')`,
    `insert into "distribution_inbox_revision"
       ("id", "connection_id", "channel_key", "provider_key", "environment",
        "provider_revision_id", "external_booking_id", "revision_type",
        "payload_hash", "payload_safe", "received_at",
        "ack_state", "ack_attempt_count")
     values ('${f.orphanInbox}', '${f.orphanConnection}', 'tiket-com',
             'simulator', 'simulator', 'LEGACY-ORPHAN-INBOX',
             'LEGACY-ORPHAN', 'new', repeat('e', 64), '{}'::jsonb, now(),
             'PENDING', 0)`,
    `insert into "distribution_exception_case"
       ("id", "tenant_id", "property_id", "connection_id", "inbox_revision_id",
        "outbox_id", "type", "state", "details_safe")
     values ('${f.orphanException}', '${f.orphanTenant}', '${f.propertyB}',
             '${f.orphanConnection}', '${f.orphanInbox}', '${f.orphanOutbox}',
             'MAPPING_MISSING', 'OPEN', '{}'::jsonb)`,
    `insert into "distribution_dead_letter"
       ("id", "tenant_id", "property_id", "connection_id", "outbox_id",
        "event_type", "payload_safe", "safe_error_code", "attempts", "reason")
     values ('${f.orphanDeadLetter}', '${f.orphanTenant}', '${f.propertyB}',
             '${f.orphanConnection}', '${f.orphanOutbox}',
             'AvailabilitySnapshot', '{}'::jsonb, 'SYNTHETIC', 3,
             'synthetic legacy dead letter')`,
    `insert into "distribution_dedup_key"
       ("id", "scope", "dedup_key", "payload_hash", "inbox_revision_id")
     values ('${f.orphanDedup}', 'legacy-orphan', 'LEGACY-ORPHAN-DEDUP',
             repeat('d', 64), '${f.orphanInbox}')`,
    `insert into "distribution_sync_attempt"
       ("id", "outbox_id", "attempt_no", "status", "certainty",
        "safe_error_code", "started_at")
     values ('${f.orphanAttempt}', '${f.orphanOutbox}', 1, 'STARTED',
             'UNKNOWN', 'SYNTHETIC', now() - interval '1 minute')`,
    `insert into "distribution_sync_checkpoint"
       ("id", "connection_id", "stream", "cursor", "last_pull_at")
     values ('${f.orphanCheckpoint}', '${f.orphanConnection}',
             'reservations', 'synthetic-cursor', now() - interval '1 minute')`,
    `insert into "distribution_external_booking"
       ("id", "connection_id", "channel_key", "external_booking_id", "state")
     values ('${f.orphanBooking}', '${f.orphanConnection}', 'tiket-com',
             'LEGACY-ORPHAN-BOOKING', 'ACTIVE')`,
    `insert into "distribution_channel_capability"
       ("id", "connection_id", "channel_key", "capability_code", "status",
        "authorization_status", "adapter_version", "limitations")
     values ('${f.orphanCapability}', '${f.orphanConnection}', 'tiket-com',
             'inventory.push', 'UNKNOWN', 'UNKNOWN', 'simulator-v1', '[]')`,
    `insert into "distribution_mapping_version"
       ("id", "connection_id", "channel_key", "external_room_ref",
        "external_rate_ref", "occupancy", "effective_at", "status",
        "mapping_version")
     values ('${f.orphanMapping}', '${f.orphanConnection}', 'tiket-com',
             'LEGACY-ORPHAN-ROOM', 'LEGACY-ORPHAN-RATE', 2,
             now() - interval '1 minute', 'ACTIVE', 1)`,
  ];
}
