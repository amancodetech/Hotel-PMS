import { PropertyError } from '../../property/domain/errors.js';

export type SharingScope = 'MIXED' | 'FEMALE' | 'MALE';
export type GuestGender = 'FEMALE' | 'MALE';

export interface SharingGuest {
  guest_id: string;
  item_id?: string | null;
  gender: string | null;
  departed_at?: string | null;
}

export function isRestrictedSharingScope(
  scope: string | null | undefined,
): scope is 'FEMALE' | 'MALE' {
  return scope === 'FEMALE' || scope === 'MALE';
}

/**
 * Fail-closed enforcement of a restricted sharing scope for one reservation
 * item: every candidate guest attached to the item (or reservation-level,
 * `item_id` null) must declare a gender that matches the scope. A guest with
 * no declared gender is rejected with GUEST_GENDER_REQUIRED instead of being
 * guessed; a declared mismatch is SHARING_POLICY_VIOLATION. Departed guests
 * are ignored so a reused reservation keeps working after early departures.
 */
export function assertSharingScopeGuests(input: {
  scope: string | null | undefined;
  itemId?: string | null;
  productId?: string | null;
  guests: readonly SharingGuest[];
}): void {
  if (!isRestrictedSharingScope(input.scope)) return;
  const candidates = input.guests.filter(
    (guest) =>
      !guest.departed_at &&
      (input.itemId === undefined ||
        input.itemId === null ||
        guest.item_id === null ||
        guest.item_id === undefined ||
        guest.item_id === input.itemId),
  );
  if (candidates.length === 0)
    throw new PropertyError('GUEST_GENDER_REQUIRED', {
      scope: input.scope,
      product_id: input.productId ?? null,
      item_id: input.itemId ?? null,
      reason: 'no_guest_declared',
    });
  for (const guest of candidates) {
    if (guest.gender !== 'FEMALE' && guest.gender !== 'MALE')
      throw new PropertyError('GUEST_GENDER_REQUIRED', {
        scope: input.scope,
        product_id: input.productId ?? null,
        item_id: input.itemId ?? null,
        guest_id: guest.guest_id,
        reason: 'gender_unknown',
      });
    if (guest.gender !== input.scope)
      throw new PropertyError('SHARING_POLICY_VIOLATION', {
        scope: input.scope,
        product_id: input.productId ?? null,
        item_id: input.itemId ?? null,
        guest_id: guest.guest_id,
        gender: guest.gender,
      });
  }
}
