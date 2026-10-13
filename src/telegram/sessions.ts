import { randomBytes } from 'node:crypto';
import type { Clock, DaySchedule, SlotChoice } from '../contracts.js';
import type { GameDate } from '../config/gameDate.js';

export const DRAFT_TTL_MS = 20 * 60_000;
export const PENDING_TTL_MS = 5 * 60_000;

export interface Expiring {
  readonly expiresAtMs: number;
}

/** In-memory per-user state; entries disappear on expiry and on restart (stale buttons are then refused). */
export interface ExpiringStore<T extends Expiring> {
  get(userId: number): T | undefined;
  set(userId: number, value: T): void;
  delete(userId: number): void;
  size(): number;
}

export const createExpiringStore = <T extends Expiring>(clock: Clock): ExpiringStore<T> => {
  const entries = new Map<number, T>();

  const prune = (): void => {
    const now = clock.nowMs();
    for (const [userId, value] of entries) {
      if (value.expiresAtMs <= now) entries.delete(userId);
    }
  };

  return {
    get: (userId) => {
      prune();
      return entries.get(userId);
    },
    set: (userId, value) => {
      entries.set(userId, value);
    },
    delete: (userId) => {
      entries.delete(userId);
    },
    size: () => {
      prune();
      return entries.size;
    },
  };
};

/** Random per conversation, so a button of a previous run never matches a new conversation. */
export const newSessionId = (): string => randomBytes(3).toString('hex');

/** Where the start times come from when the owner picks a time. */
export type PickerMode =
  | { readonly kind: 'schedule'; readonly schedule: DaySchedule }
  | { readonly kind: 'grid'; readonly source: 'open-day' | 'common'; readonly starts: readonly number[] };

export type DraftView =
  | { readonly kind: 'dates' }
  | { readonly kind: 'courts' }
  | { readonly kind: 'times'; readonly courtId: number }
  | { readonly kind: 'confirm' };

/** State of one /new conversation. */
export interface Draft extends Expiring {
  readonly sid: string;
  readonly view: DraftView;
  readonly gameDate: GameDate | null;
  readonly mode: PickerMode | null;
  /** Priority order. */
  readonly choices: readonly SlotChoice[];
  readonly submitting: boolean;
}

/** A /cancel waiting for the owner's button. */
export interface PendingCancel extends Expiring {
  readonly sid: string;
  readonly jobId: number;
}
