export const CLUB_TIME_ZONE = 'Europe/Madrid';

/**
 * Every luxon call that parses or formats club dates passes these options: the result must not depend
 * on the locale or numbering system of the machine the bot runs on (e.g. Arabic-Indic digits).
 */
export const CLUB_LUXON_OPTIONS = {
  zone: CLUB_TIME_ZONE,
  locale: 'en-US',
  numberingSystem: 'latn',
} as const;
