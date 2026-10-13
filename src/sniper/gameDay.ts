import { gameDateStart, type GameDate } from '../config/gameDate.js';

/** First instant after the game day (club time zone, DST-safe). */
export const gameDayEndsAtMs = (gameDate: GameDate): number => gameDateStart(gameDate).plus({ days: 1 }).toMillis();

export const isGameDatePassed = (gameDate: GameDate, nowMs: number): boolean => nowMs >= gameDayEndsAtMs(gameDate);
