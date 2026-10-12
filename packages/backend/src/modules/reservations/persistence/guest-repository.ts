import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows } from '../../../persistence/sql.js';

export interface GuestRow {
  id: string;
  tenant_id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  country_code: string | null;
  language: string | null;
  gender: 'FEMALE' | 'MALE' | null;
  notes: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface GuestSummaryRow {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  gender: 'FEMALE' | 'MALE' | null;
  version: number;
}

export async function insertGuest(
  em: EntityManager,
  input: {
    id: string;
    tenantId: string;
    fullName: string;
    email: string | null;
    phone: string | null;
    countryCode: string | null;
    language: string | null;
    gender: 'FEMALE' | 'MALE' | null;
    notes: string | null;
  },
): Promise<GuestRow> {
  const row = await one<GuestRow>(
    em,
    `insert into "guest" (
        "id", "tenant_id", "full_name", "email", "phone",
        "country_code", "language", "gender", "notes"
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
     returning *`,
    [
      input.id,
      input.tenantId,
      input.fullName,
      input.email,
      input.phone,
      input.countryCode,
      input.language,
      input.gender,
      input.notes,
    ],
  );
  if (!row) throw new Error('guest insert returned no row');
  return row;
}

export async function findGuest(
  em: EntityManager,
  tenantId: string,
  guestId: string,
): Promise<GuestRow | null> {
  return one<GuestRow>(
    em,
    `select * from "guest" where "id" = ? and "tenant_id" = ?`,
    [guestId, tenantId],
  );
}

export async function listGuestRows(
  em: EntityManager,
  tenantId: string,
  input: { search: string | null; cursor: string | null; limit: number },
): Promise<GuestSummaryRow[]> {
  const filter = input.search
    ? `and lower("full_name") like ? escape '\\'`
    : '';
  const params: unknown[] = [tenantId];
  if (input.search) {
    const escaped = input.search
      .toLowerCase()
      .replace(/[\\%_]/g, (char) => `\\${char}`);
    params.push(`%${escaped}%`);
  }
  if (input.cursor) {
    params.push(input.cursor);
    params.push(input.cursor);
  }
  return rows<GuestSummaryRow>(
    em,
    `select "id", "full_name", "email", "phone", "gender", "version"
       from "guest"
      where "tenant_id" = ?
        ${filter}
        ${input.cursor ? `and ("full_name", "id") > (select "full_name", "id" from "guest" where "id" = ?)` : ''}
      order by "full_name", "id"
      limit ?`,
    [...params, input.limit],
  );
}
