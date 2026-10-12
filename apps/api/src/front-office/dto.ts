import { z } from 'zod';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const boardQuery = z.object({ date: isoDate.optional() }).strict();

export const assignRoomBody = z
  .object({
    resource_id: uuid,
    start_date: isoDate.optional(),
    end_date: isoDate.optional(),
    version: z.number().int().min(1),
  })
  .strict();

export const checkInBody = z
  .object({
    resource_id: uuid.optional(),
    version: z.number().int().min(1),
  })
  .strict();

export const moveBody = z
  .object({
    to_resource_id: uuid,
    effective_date: isoDate,
    version: z.number().int().min(1),
  })
  .strict();

export const extendBody = z
  .object({
    new_departure: isoDate,
    version: z.number().int().min(1),
  })
  .strict();

export const splitBody = z
  .object({
    at_date: isoDate,
    version: z.number().int().min(1),
  })
  .strict();

export const earlyDepartureBody = z
  .object({
    effective_date: isoDate,
    version: z.number().int().min(1),
  })
  .strict();

export const partialDepartureBody = z
  .object({
    guest_ids: z.array(uuid).min(1).max(20),
    version: z.number().int().min(1),
  })
  .strict();

export const checkOutBody = z
  .object({
    version: z.number().int().min(1),
  })
  .strict();
