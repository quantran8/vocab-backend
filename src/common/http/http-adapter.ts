import { randomUUID } from 'node:crypto';
import { FastifyAdapter } from '@nestjs/platform-fastify';

export const REQUEST_ID_HEADER = 'x-request-id';

const JSON_BODY_LIMIT_BYTES = 1024 * 1024;

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
  return adapter;
}
