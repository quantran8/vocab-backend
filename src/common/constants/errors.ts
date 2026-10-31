export const ERROR = {
  UNAUTHORIZED: { status: 401, retryable: false },
  FORBIDDEN: { status: 403, retryable: false },
  SESSION_NOT_OWNED: { status: 403, retryable: false },
  NOT_FOUND: { status: 404, retryable: false },
  SESSION_PAYLOAD_CONFLICT: { status: 409, retryable: false },
  SESSION_STALE: { status: 409, retryable: false },
  SESSION_EXPIRED: { status: 410, retryable: false },
  INVALID_SUBMISSION: { status: 422, retryable: false },
  TASK_DATA_INVALID: { status: 422, retryable: false },
  VALIDATION_FAILED: { status: 400, retryable: false },
  PUBLICATION_INVALID: { status: 422, retryable: false },
  CONTENT_UNAVAILABLE: { status: 422, retryable: false },
  PAYLOAD_TOO_LARGE: { status: 413, retryable: false },
  SPEECH_PROVIDER_UNAVAILABLE: { status: 503, retryable: true },
  INTERNAL_ERROR: { status: 500, retryable: true },
} as const;
export type ErrorCode = keyof typeof ERROR;
