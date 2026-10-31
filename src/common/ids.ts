import { uuidv7 } from 'uuidv7';

// Drizzle id columns default to this; call it directly when an id is needed before insert.
export const newId = (): string => uuidv7();
