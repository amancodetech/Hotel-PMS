export const legacyAckFixture = {
  connectionId: 'aaaa1111-2222-4333-8444-555555555501',
  tenantId: 'aaaa1111-2222-4333-8444-666666666601',
  propertyId: 'aaaa1111-2222-4333-8444-777777777701',
  existingExceptionId: 'cccc1111-2222-4333-8444-555555555501',
  unlinkedAckExceptionId: 'cccc1111-2222-4333-8444-555555555502',
  mappingExceptionId: 'cccc1111-2222-4333-8444-555555555503',
  revisions: {
    exhausted: {
      id: 'bbbb1111-2222-4333-8444-555555555501',
      providerRevisionId: 'LEGACY-ACK-EXHAUSTED',
      ackState: 'PENDING',
      attempts: 4,
    },
    exhaustedWithException: {
      id: 'bbbb1111-2222-4333-8444-555555555502',
      providerRevisionId: 'LEGACY-ACK-EXHAUSTED-WITH-EXCEPTION',
      ackState: 'UNKNOWN',
      attempts: 5,
      exceptionId: 'cccc1111-2222-4333-8444-555555555501',
    },
    sent: {
      id: 'bbbb1111-2222-4333-8444-555555555503',
      providerRevisionId: 'LEGACY-ACK-SENT',
      ackState: 'SENT',
      attempts: 1,
    },
    failed: {
      id: 'bbbb1111-2222-4333-8444-555555555504',
      providerRevisionId: 'LEGACY-ACK-FAILED',
      ackState: 'FAILED',
      attempts: 1,
    },
    retryable: {
      id: 'bbbb1111-2222-4333-8444-555555555505',
      providerRevisionId: 'LEGACY-ACK-RETRY',
      ackState: 'PENDING',
      attempts: 1,
    },
    exhaustedWithUnlinkedException: {
      id: 'bbbb1111-2222-4333-8444-555555555506',
      providerRevisionId: 'LEGACY-ACK-EXHAUSTED-UNLINKED',
      ackState: 'UNKNOWN',
      attempts: 5,
    },
    exhaustedWithMappingException: {
      id: 'bbbb1111-2222-4333-8444-555555555507',
      providerRevisionId: 'LEGACY-ACK-EXHAUSTED-MAPPING',
      ackState: 'PENDING',
      attempts: 4,
      processingState: 'EXCEPTION',
      exceptionId: 'cccc1111-2222-4333-8444-555555555503',
    },
  },
};

function revisionValues(connectionId, revision) {
  return `('${revision.id}', '${connectionId}', 'test-sixth-channel',
     'test-alternate', 'test', '${revision.providerRevisionId}',
     'LEGACY-BOOKING', 'new', repeat('a', 64),
     '{}'::jsonb, now(), '${revision.processingState ?? 'APPLIED'}',
     '${revision.ackState}', ${revision.attempts}, null, now(), now())`;
}

export function legacyAckSeedStatements() {
  const fixture = legacyAckFixture;
  return [
    `insert into "distribution_connection"
       ("id","tenant_id","property_id","provider_key","environment","channel_key","external_property_id","secret_ref")
     values ('${fixture.connectionId}','${fixture.tenantId}','${fixture.propertyId}',
       'test-alternate','test','test-sixth-channel','LEGACY-EXT','secret:synthetic-legacy')`,
    `insert into "distribution_inbox_revision"
       ("id","connection_id","channel_key","provider_key","environment",
        "provider_revision_id","external_booking_id","revision_type","payload_hash",
        "payload_safe","received_at","processing_state","ack_state",
        "ack_attempt_count","exception_id","created_at","updated_at")
     values ${Object.values(fixture.revisions)
       .map((revision) => revisionValues(fixture.connectionId, revision))
       .join(', ')}`,
    `insert into "distribution_exception_case"
       ("id","tenant_id","property_id","connection_id","inbox_revision_id","type","state","details_safe")
     values ('${fixture.existingExceptionId}','${fixture.tenantId}','${fixture.propertyId}',
       '${fixture.connectionId}','${fixture.revisions.exhaustedWithException.id}',
       'ACK_EXHAUSTED','OPEN','{}'::jsonb)`,
    `insert into "distribution_exception_case"
       ("id","tenant_id","property_id","connection_id","inbox_revision_id","type","state","details_safe")
     values ('${fixture.unlinkedAckExceptionId}','${fixture.tenantId}','${fixture.propertyId}',
       '${fixture.connectionId}','${fixture.revisions.exhaustedWithUnlinkedException.id}',
       'ACK_EXHAUSTED','OPEN','{}'::jsonb)`,
    `insert into "distribution_exception_case"
       ("id","tenant_id","property_id","connection_id","inbox_revision_id","type","state","details_safe")
     values ('${fixture.mappingExceptionId}','${fixture.tenantId}','${fixture.propertyId}',
       '${fixture.connectionId}','${fixture.revisions.exhaustedWithMappingException.id}',
       'MAPPING_MISSING','OPEN','{}'::jsonb)`,
    `update "distribution_inbox_revision"
     set "exception_id" = '${fixture.existingExceptionId}'
     where "id" = '${fixture.revisions.exhaustedWithException.id}'`,
    `update "distribution_inbox_revision"
     set "exception_id" = '${fixture.mappingExceptionId}'
     where "id" = '${fixture.revisions.exhaustedWithMappingException.id}'`,
  ];
}
