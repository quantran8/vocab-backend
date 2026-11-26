import { uuidv7 } from 'uuidv7';

// Drizzle id columns default to this; call it directly when an id is needed before insert.
export const newId = (): string => uuidv7();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value);
