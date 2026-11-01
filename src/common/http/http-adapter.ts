import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';

export const REQUEST_ID_HEADER = 'x-request-id';

const JSON_BODY_LIMIT_BYTES = 1024 * 1024;

const logger = new Logger('HTTP');

const LOG_BODY_MAX_CHARS = 2000;
const REDACTED_KEY = /password|token|secret|authorization|apikey|audio/i;

// Secrets and audio payloads must not reach logs; long bodies are cut.
function bodyForLog(body: unknown) {
  if (body === undefined || body === null || body === '') return '-';
  const text = typeof body === 'string' ? body : JSON.stringify(body, (k, v) => (REDACTED_KEY.test(k) ? '[redacted]' : v));
  return text.length > LOG_BODY_MAX_CHARS ? `${text.slice(0, LOG_BODY_MAX_CHARS)}...(${text.length} chars)` : text;
}

function redactJsonText(payload: unknown) {
  if (typeof payload !== 'string') return bodyForLog(undefined);
  try {
    return bodyForLog(JSON.parse(payload));
  } catch {
    return bodyForLog(payload);
  }
}

export function createHttpAdapter() {
  const adapter = new FastifyAdapter({
    bodyLimit: JSON_BODY_LIMIT_BYTES,
    genReqId: () => randomUUID(),
    routerOptions: { ignoreTrailingSlash: true },
  });
  adapter.getInstance().addHook('onRequest', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
    // Fastify rejects an empty body declared as JSON; clients send that header on bodyless POSTs.
    if (request.headers['content-length'] === '0') delete request.headers['content-type'];
  });
  adapter.getInstance().addHook('preHandler', async (request) => {
    logger.log(`--> ${request.method} ${request.url} ${request.id} body=${bodyForLog(request.body)}`);
  });
  adapter.getInstance().addHook('onSend', async (request, _reply, payload) => {
    (request as { logBody?: string }).logBody = redactJsonText(payload);
    return payload;
  });
  // onResponse also covers guard rejections and unmatched routes, which interceptors miss.
  adapter.getInstance().addHook('onResponse', async (request, reply) => {
    const [path] = request.url.split('?');
    const userId = (request as { user?: { id: string } }).user?.id ?? '-';
    logger.log(`<-- ${request.method} ${path} ${reply.statusCode} ${Math.round(reply.elapsedTime)}ms user=${userId} ${request.id} body=${(request as { logBody?: string }).logBody ?? '-'}`);
  });
  return adapter;
}
