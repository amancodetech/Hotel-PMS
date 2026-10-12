export const reservationItemStates = [
  'INQUIRY',
  'TENTATIVE',
  'WAITLIST',
  'CONFIRMED',
  'IN_HOUSE',
  'CHECKED_OUT',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
] as const;

export type ReservationItemState = (typeof reservationItemStates)[number];

export const reservationStates = [
  'INQUIRY',
  'TENTATIVE',
  'WAITLIST',
  'CONFIRMED',
  'PARTIALLY_CONFIRMED',
  'IN_HOUSE',
  'PARTIALLY_IN_HOUSE',
  'CHECKED_OUT',
  'PARTIALLY_CHECKED_OUT',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
] as const;

export type ReservationState = (typeof reservationStates)[number];

export const guestRoles = ['LEAD', 'ACCOMPANYING'] as const;
export type GuestRole = (typeof guestRoles)[number];

export function deriveReservationState(
  states: readonly ReservationItemState[],
): ReservationState {
  if (states.length === 0) return 'INQUIRY';
  const active = states.filter((state) => state !== 'CANCELLED');
  if (active.length === 0) return 'CANCELLED';
  const complete = active.length === states.length;
  if (active.every((state) => state === 'IN_HOUSE'))
    return complete ? 'IN_HOUSE' : 'PARTIALLY_IN_HOUSE';
  if (active.some((state) => state === 'IN_HOUSE')) return 'PARTIALLY_IN_HOUSE';
  if (
    active.every((state) => state === 'CHECKED_OUT' || state === 'COMPLETED')
  ) {
    if (!complete) return 'PARTIALLY_CHECKED_OUT';
    return active.every((state) => state === 'COMPLETED')
      ? 'COMPLETED'
      : 'CHECKED_OUT';
  }
  if (active.every((state) => state === 'NO_SHOW'))
    return complete ? 'NO_SHOW' : 'PARTIALLY_CHECKED_OUT';
  if (active.every((state) => state === 'CONFIRMED')) return 'CONFIRMED';
  if (active.some((state) => state === 'CONFIRMED'))
    return 'PARTIALLY_CONFIRMED';
  if (active.every((state) => state === 'TENTATIVE')) return 'TENTATIVE';
  if (active.some((state) => state === 'TENTATIVE')) return 'TENTATIVE';
  if (active.some((state) => state === 'WAITLIST')) return 'WAITLIST';
  return 'INQUIRY';
}

export function isReservationItemState(
  value: unknown,
): value is ReservationItemState {
  return (
    typeof value === 'string' &&
    (reservationItemStates as readonly string[]).includes(value)
  );
}
