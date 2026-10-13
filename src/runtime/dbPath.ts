import { resolve } from 'node:path';

const IN_MEMORY = ':memory:';

/**
 * A relative DB_PATH is relative to the directory the program was started in. The job store creates missing folders,
 * so the default `data/bot.sqlite` works on a fresh checkout.
 */
export const resolveDbLocation = (dbPath: string): string => (dbPath === IN_MEMORY ? dbPath : resolve(dbPath));
