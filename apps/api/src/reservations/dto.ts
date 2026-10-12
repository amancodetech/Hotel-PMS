import type {
  GuestRow,
  GuestSummaryRow,
  ReservationItemRow,
  ReservationRow,
  ReservationSummary,
} from '@hotel/backend';

export function reservationSummaryDto(row: ReservationSummary) {
  return {
    id: row.id,
    source: row.source,
    state: row.state,
    version: row.version,
    created_at: row.created_at,
    item_states: row.item_states,
    item_count: row.item_count,
  };
}

export function reservationItemDto(
  item: ReservationItemRow & {
    segments: Array<{ id: string; start_date: string; end_date: string }>;
  },
) {
  return {
    id: item.id,
    product_id: item.product_id,
    period: { arrival: item.arrival, departure: item.departure },
    occupancy: { adults: item.adults, child_ages: item.child_ages },
    quantity: item.quantity,
    state: item.state,
    version: item.version,
    segments: item.segments,
  };
}

export function reservationDetailDto(result: Record<string, unknown>) {
  const reservation = result.reservation as ReservationRow;
  const items = result.items as Array<
    ReservationItemRow & {
      segments: Array<{ id: string; start_date: string; end_date: string }>;
    }
  >;
  const guests = result.guests as Array<{
    guest_id: string;
    item_id: string | null;
    role: string;
    full_name: string;
    email: string | null;
    gender: 'FEMALE' | 'MALE' | null;
  }> | null;
  return {
    reservation: {
      id: reservation.id,
      source: reservation.source,
      state: reservation.state,
      version: reservation.version,
      external_booking_key: reservation.external_booking_key,
      channel_connection_id: reservation.channel_connection_id,
      created_at: reservation.created_at,
    },
    items: items.map(reservationItemDto),
    guests,
  };
}

export function guestDto(
  guest: GuestRow | GuestSummaryRow,
): Record<string, unknown> {
  const richer = guest as GuestRow;
  return {
    id: guest.id,
    full_name: guest.full_name,
    email: guest.email,
    phone: guest.phone,
    version: guest.version,
    country_code: richer.country_code ?? null,
    language: richer.language ?? null,
    gender: richer.gender ?? null,
    notes: richer.notes ?? null,
  };
}
