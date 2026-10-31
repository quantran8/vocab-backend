import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { ERROR, ErrorCode } from '../constants/errors';
import { ApiError } from './api-error';

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(error: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const body = this.toBody(error);
    if (body.status >= 500) {
      const [path] = request.url.split('?');
      this.logger.error(`${request.method} ${path} ${request.id}`, error instanceof Error ? error.stack : undefined);
    }
    http.getResponse<FastifyReply>().code(body.status).send({
      code: body.code,
      message: body.message,
      retryable: body.retryable,
      requestId: request.id,
    });
  }

  private toBody(error: unknown) {
    if (error instanceof ApiError) {
      return { status: error.status, code: error.code, message: error.message, retryable: error.retryable };
    }
    if (error instanceof ZodError) {
      const message = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return { status: ERROR.VALIDATION_FAILED.status, code: 'VALIDATION_FAILED', message, retryable: false };
    }
    if (error instanceof HttpException) {
      const status = error.getStatus();
      return { status, code: STATUS_TO_CODE[status] ?? 'INTERNAL_ERROR', message: error.message, retryable: status >= 500 };
    }
    return { status: ERROR.INTERNAL_ERROR.status, code: 'INTERNAL_ERROR', message: 'Internal error', retryable: true };
  }
}
