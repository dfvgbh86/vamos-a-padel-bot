import { z } from 'zod';
import type { GameDate } from '../../config/gameDate.js';
import type { DayCourt, DaySchedule, DaySlot } from '../../contracts.js';
import { UnexpectedResponseError } from '../errors.js';
import { isPlainObject, isTruthyFlag, toInteger } from './values.js';

const MAX_NESTING = 8;
const MAX_COURTS = 100;
const MAX_SLOTS_PER_COURT = 1_000;
const MAX_NAME_LENGTH = 80;
const MINUTES_PER_DAY = 24 * 60;

const integerLike = z.union([z.number(), z.string()]).transform((value) => toInteger(value) ?? Number.NaN);

const minutes = integerLike.pipe(z.number().int().min(0).max(MINUTES_PER_DAY));
const courtId = integerLike.pipe(z.number().int().min(1));

/**
 * Free (`null`) or taken (any object). The object is discarded here, its contents are other people's data: the only thing
 * kept is whether it carries `esta_en_reserva`, because the live location of that flag (slot or reservation) is unverified.
 */
const reservation = z.union([
  z.null().transform(() => ({ free: true, ownFlag: false })),
  z.object({ esta_en_reserva: z.unknown().optional() }).transform((taken) => ({ free: false, ownFlag: isTruthyFlag(taken.esta_en_reserva) })),
]);

/** zod strips every key that is not listed, so nothing but these fields can survive parsing. */
const slotSchema = z.object({
  hora_ini: minutes,
  hora_fin: minutes,
  duracion: z.unknown().optional(),
  reserva: reservation,
  esta_en_reserva: z.unknown().optional(),
});

const courtSchema = z.object({
  id_mst_recurso: courtId,
  desc_recurso: z.unknown().optional(),
  horari: z.unknown(),
});

const shapeError = (where: string): UnexpectedResponseError =>
  new UnexpectedResponseError(`Calendar response has an unexpected shape (${where})`);

/** Courts are normally in nested arrays, but PHP serialises sparse lists as objects: accept both. */
const valuesOf = (node: unknown): readonly unknown[] | null => {
  if (Array.isArray(node)) return node;
  return isPlainObject(node) ? Object.values(node) : null;
};

const collectCourts = (node: unknown, depth: number, out: Record<string, unknown>[]): void => {
  if (depth > MAX_NESTING) throw shapeError('nesting too deep');
  if (isPlainObject(node) && Object.hasOwn(node, 'id_mst_recurso')) {
    out.push(node);
    if (out.length > MAX_COURTS) throw shapeError('too many courts');
    return;
  }
  const children = valuesOf(node);
  if (children === null) throw shapeError('unexpected value in the court list');
  for (const child of children) collectCourts(child, depth + 1, out);
};

/** Paths only (keys and indexes of the known schema), never values: a failure must not echo the response. */
const describeFailure = (error: z.ZodError): string =>
  error.issues
    .slice(0, 3)
    .map((issue) => issue.path.map(String).join('.') || 'value')
    .join(', ');

const courtName = (raw: unknown, id: number): string => {
  const cleaned = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return cleaned === '' ? `Court ${id}` : cleaned.slice(0, MAX_NAME_LENGTH);
};

const slotDuration = (raw: unknown, start: number, end: number): number => {
  const declared = toInteger(raw);
  return declared !== undefined && declared > 0 ? declared : end - start;
};

const toSlot = (parsed: z.output<typeof slotSchema>, where: string): DaySlot => {
  const start = parsed.hora_ini;
  const end = parsed.hora_fin;
  if (end <= start || start >= MINUTES_PER_DAY) throw shapeError(`${where} time range`);
  return {
    startMinutes: start,
    endMinutes: end,
    durationMinutes: slotDuration(parsed.duracion, start, end),
    free: parsed.reserva.free,
    ownBooking: isTruthyFlag(parsed.esta_en_reserva) || parsed.reserva.ownFlag,
  };
};

const toCourt = (raw: Record<string, unknown>, index: number): DayCourt => {
  const where = `court #${index}`;
  const parsed = courtSchema.safeParse(raw);
  if (!parsed.success) throw shapeError(`${where}: ${describeFailure(parsed.error)}`);

  const rows = valuesOf(parsed.data.horari);
  if (rows === null || rows.length > MAX_SLOTS_PER_COURT) throw shapeError(`${where}: horari`);

  const slots = rows.map((row, slotIndex) => {
    const slotWhere = `${where} slot #${slotIndex}`;
    const slot = slotSchema.safeParse(row);
    if (!slot.success) throw shapeError(`${slotWhere}: ${describeFailure(slot.error)}`);
    return toSlot(slot.data, slotWhere);
  });

  const id = parsed.data.id_mst_recurso;
  return { courtId: id, name: courtName(parsed.data.desc_recurso, id), slots };
};

/**
 * `GET /api/tipo_recurso/1/reservas_usuario` (already JSON-decoded) to a day schedule. Whitelist only: court id and name,
 * slot start/end/duration, whether it is free and whether it belongs to the logged-in account. Throws
 * `UnexpectedResponseError` (without echoing anything from the response) when the shape is not the expected one.
 */
export const parseCalendar = (payload: unknown, gameDate: GameDate): DaySchedule => {
  if (!Array.isArray(payload)) throw shapeError('top level');
  const rawCourts: Record<string, unknown>[] = [];
  collectCourts(payload, 0, rawCourts);
  return { gameDate, courts: rawCourts.map(toCourt) };
};
