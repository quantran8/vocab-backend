export const MS_PER_SECOND = 1_000;
export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const HOURS_PER_DAY = 24;
export const DAYS_PER_WEEK = 7;
export const HOURS_PER_WEEK = HOURS_PER_DAY * DAYS_PER_WEEK;

export const addHours = (date: Date, hours: number) => new Date(date.getTime() + hours * MS_PER_HOUR);
export const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * MS_PER_MINUTE);
