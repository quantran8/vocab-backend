import { PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { ErrorCode } from '../constants/errors';
import { ApiError } from './api-error';

export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>, private readonly errorCode?: ErrorCode) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    if (this.errorCode) throw new ApiError(this.errorCode, result.error.issues[0].message);
    throw result.error;
  }
}
