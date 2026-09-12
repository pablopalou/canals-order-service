import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { config } from './config.ts';
import type { OrderDependencies } from './domain/orders.ts';

/** Everything the domain needs except the logger, which the app supplies. */
export type AppDependencies = Omit<OrderDependencies, 'logger'>;
import { isAppError } from './errors.ts';
import { registerOrderRoutes } from './routes/orders.ts';

/** Methods worth reporting in an Allow header when a path exists. */
const KNOWN_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
] as const;

/** Our own names for the refusals Fastify makes before a handler runs. */
const FRAMEWORK_ERROR_CODES: Record<number, string> = {
  413: 'payload_too_large',
  415: 'unsupported_media_type',
};

export async function buildApp(
  deps: AppDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({
    // A valid order is a few kilobytes. Fastify defaults to a megabyte;
    // stating the limit keeps a hostile body from being parsed at all.
    bodyLimit: 64 * 1024,
    logger: {
      level: config.LOG_LEVEL,
      // Card numbers must never reach a log sink, an error tracker, or a
      // support engineer's terminal, whatever future code decides to log.
      redact: {
        paths: [
          'req.body.payment.cardNumber',
          'body.payment.cardNumber',
          'payment.cardNumber',
          'cardNumber',
        ],
        censor: '[redacted]',
      },
      transport:
        config.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } }
          : undefined,
    },
    // Ties every log line and error response of one request together.
    genReqId: () => crypto.randomUUID(),
  });

  /**
   * Responses are JSON and nothing else, so browsers should never be left to
   * guess a type. Cheap, and it closes off a whole class of content sniffing.
   */
  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
  });

  app.get('/health', async () => ({ status: 'ok' }));

  await registerOrderRoutes(app, { ...deps, logger: app.log });

  /**
   * A path that exists under a different method is a 405, not a 404, and RFC
   * 9110 requires the Allow header to say which methods it does take.
   * Answering 404 tells a client the resource is gone when it is only the verb
   * that is wrong.
   */
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    const allowed = KNOWN_METHODS.filter(
      (method) =>
        method !== request.method && app.findRoute({ method, url: path }),
    );

    if (allowed.length > 0) {
      return reply
        .code(405)
        .header('allow', allowed.join(', '))
        .send({
          error: {
            code: 'method_not_allowed',
            message: `${request.method} is not allowed on ${path}`,
          },
          requestId: request.id,
        });
    }

    return reply.code(404).send({
      error: {
        code: 'route_not_found',
        message: `${request.method} ${path} is not a route on this service`,
      },
      requestId: request.id,
    });
  });

  app.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      request.log.info(
        { code: error.code, status: error.status },
        'request rejected',
      );
      if (error.status === 503) {
        // The condition is transient by definition, so say when to come back
        // rather than leaving the client to invent an interval.
        reply.header('retry-after', '1');
      }
      return reply.code(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
        requestId: request.id,
      });
    }

    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'validation_failed',
          message: 'The request body is invalid',
          details: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
        requestId: request.id,
      });
    }

    // Fastify raises its own errors before a handler ever runs: an unparseable
    // body, an unsupported content type, a payload over the limit. They are
    // the client's fault and carry a status, so they are reported in the same
    // shape as everything else rather than as a 500.
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      request.log.info({ err: error, status }, 'malformed request');
      return reply.code(status).send({
        error: {
          // Framework error identifiers are an implementation detail; clients
          // branch on our own stable codes.
          code: FRAMEWORK_ERROR_CODES[status] ?? 'malformed_request',
          message:
            error instanceof Error ? error.message : 'Malformed request',
        },
        requestId: request.id,
      });
    }

    // Anything unrecognised is a bug. It is logged in full and reported as an
    // opaque 500: internal messages and stack traces are not the client's.
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({
      error: {
        code: 'internal_error',
        message: 'An unexpected error occurred',
      },
      requestId: request.id,
    });
  });

  return await app;
}
