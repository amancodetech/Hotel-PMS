import type { EntityManager } from '@mikro-orm/postgresql';
import { rows } from './sql.js';

export interface CapabilityRow {
  id: string;
  connection_id: string;
  channel_key: string;
  capability_code: string;
  status: string;
  authorization_status: string;
  adapter_version: string;
  evidence_ref: string | null;
  checked_at: string | null;
  test_run_id: string | null;
  limitations: unknown;
  owner: string | null;
  recheck_trigger: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export async function listCapabilitiesForConnection(
  em: EntityManager,
  connectionId: string,
): Promise<CapabilityRow[]> {
  return rows<CapabilityRow>(
    em,
    `select * from "distribution_channel_capability"
      where "connection_id" = ?
      order by "channel_key", "capability_code"`,
    [connectionId],
  );
}
