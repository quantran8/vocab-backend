import { ErrorCode } from '../../../common/constants/errors';
import { ApiError } from '../../../common/http/api-error';

export const WORD_UNIQUE_INDEX = 'words_language_lemma_key';
export const PRIVATE_MEANING_LOCKED = 'A private meaning can only be approved or recalled';
export const IN_USE = 'Still referenced by learner history, a topic or a practice item';

const FK_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';

type PgFailure = { cause?: { code?: string; constraint?: string } };

export const constraintOf = (error: unknown) => (error as PgFailure).cause?.constraint;
const codeOf = (error: unknown) => (error as PgFailure).cause?.code;

interface PgErrorMessages {
  fk?: string;
  fkCode?: ErrorCode;
  unique?: string;
  uniqueCode?: ErrorCode;
}

/** A foreign key or unique failure is the caller's error, not a retryable 500. */
export async function mapPgErrors<T>(run: PromiseLike<T>, messages: PgErrorMessages): Promise<T> {
  try {
    return await run;
  } catch (error) {
    if (messages.fk && codeOf(error) === FK_VIOLATION) throw new ApiError(messages.fkCode ?? 'CONTENT_LOCKED', messages.fk);
    if (messages.unique && codeOf(error) === UNIQUE_VIOLATION) throw new ApiError(messages.uniqueCode ?? 'DUPLICATE_CONTENT', messages.unique);
    throw error;
  }
}
