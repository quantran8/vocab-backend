import { ERROR, ErrorCode } from '../constants/errors';

export class ApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(readonly code: ErrorCode, message: string = code) {
    super(message);
    this.status = ERROR[code].status;
    this.retryable = ERROR[code].retryable;
  }
}
