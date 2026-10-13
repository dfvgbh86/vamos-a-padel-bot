export interface FixtureSlot {
  readonly start: number;
  readonly end: number;
  /** Omit to leave `duracion` out; defaults are not invented. */
  readonly duration?: number | string;
  readonly taken?: boolean;
  /** Replaces the default placeholder of a taken slot. */
  readonly reserva?: unknown;
  readonly own?: boolean | number | string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface FixtureCourt {
  readonly id: number | string;
  readonly name?: string;
  readonly slots: readonly FixtureSlot[];
  readonly extra?: Readonly<Record<string, unknown>>;
}

const slotJson = (slot: FixtureSlot): Record<string, unknown> => ({
  hora_ini: slot.start,
  hora_fin: slot.end,
  ...(slot.duration === undefined ? {} : { duracion: slot.duration }),
  reserva: slot.reserva !== undefined ? slot.reserva : slot.taken ? { id: 1, fecha_creacion: '2026-10-12 07:00:36', tipo: 'normal' } : null,
  ...(slot.own === undefined ? {} : { esta_en_reserva: slot.own }),
  reservar_pista: 1,
  ...slot.extra,
});

export const courtJson = (court: FixtureCourt): Record<string, unknown> => ({
  id_mst_recurso: court.id,
  desc_recurso: court.name ?? `Pista ${court.id}`,
  hora_ini: 540,
  hora_fin: 1380,
  horari: court.slots.map(slotJson),
  ...court.extra,
});

/** `[[[ court, ... ]]]` as the calendar endpoint nests it. */
export const calendarPayload = (courts: readonly FixtureCourt[]): unknown => [[courts.map(courtJson)]];
