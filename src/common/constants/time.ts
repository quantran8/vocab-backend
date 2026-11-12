export const MS_PER_SECOND = 1_000;
export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;
export const HOURS_PER_DAY = 24;
export const DAYS_PER_WEEK = 7;
export const HOURS_PER_WEEK = HOURS_PER_DAY * DAYS_PER_WEEK;

export const addHours = (date: Date, hours: number) => new Date(date.getTime() + hours * MS_PER_HOUR);
export const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * MS_PER_MINUTE);

/** UTC calendar day as YYYY-MM-DD; LP scoring days and ranking weeks use UTC, never the learner's zone. */
export const utcDay = (date: Date) => date.toISOString().slice(0, 10);
export const startOfUtcDay = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
/** Monday 00:00 UTC of the ISO week containing `date`. */
export const utcWeekStart = (date: Date) => {
  const day = startOfUtcDay(date);
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % DAYS_PER_WEEK) * MS_PER_DAY);
};
export const addDays = (date: Date, days: number) => new Date(date.getTime() + days * MS_PER_DAY);
