import type { JobEvent, JobEventSink } from '../contracts.js';
import { describeError, type SniperLogger } from './types.js';

/**
 * Events are delivered in order, one at a time, but NEVER on the booking path: `emit` returns at once, so a slow
 * Telegram call cannot delay an add_event request, and a failing sink cannot break a booking.
 */
export interface EventQueue {
  emit(event: JobEvent): void;
  /** Resolves when every event emitted so far has been handed to the sink (or its failure logged). */
  flush(): Promise<void>;
}

export const createEventQueue = (sink: JobEventSink, logger: SniperLogger): EventQueue => {
  let tail: Promise<void> = Promise.resolve();

  const deliver = async (event: JobEvent): Promise<void> => {
    try {
      await sink.emit(event);
    } catch (error) {
      logger.error({ event: event.kind, jobId: event.job.id, ...describeError(error) }, 'event sink failed');
    }
  };

  return {
    emit: (event) => {
      tail = tail.then(() => deliver(event));
    },
    flush: async () => {
      let seen: Promise<void>;
      do {
        seen = tail;
        await seen;
      } while (seen !== tail);
    },
  };
};

/** Waits for the queue to drain, but never longer than `timeoutMs` (a hung sink must not block shutdown). */
export const flushWithin = async (queue: EventQueue, timeoutMs: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([queue.flush().then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
};
