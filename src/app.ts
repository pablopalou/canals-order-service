import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import { config } from './config.ts';
import type { OrderDependencies } from './domain/orders.ts';

/** Everything the domain needs except the logger, which the app supplies. */
export type AppDependencies = Omit<OrderDependencies, 'logger'>;
import { isAppError, isTransientDatabaseError } from './errors.ts';
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
    /**
     * Node does not time out an incomplete request by default, so a client
     * that sends headers and then stops holds a socket open forever. Enough
     * of those and the service runs out of file descriptors while looking
     * perfectly healthy. Thirty seconds is far longer than any honest client
     * needs to deliver 64 KB, and it does not bound handler time — a checkout
     * waiting on a slow gateway is unaffected.
     */
    requestTimeout: 30_000,
    /** Same idea for a connection that opens and never says anything. */
    connectionTimeout: 30_000,
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

  /**
   * Liveness: is this process running. It deliberately touches nothing else,
   * so a database outage does not get the container killed and restarted —
   * restarting it would not bring the database back.
   */
  app.get('/health', async () => ({ status: 'ok' }));

  /**
   * Readiness: can this instance actually serve a request. An orchestrator
   * uses this to stop routing traffic here while the database is unreachable,
   * which is the difference between a broken instance and a busy one.
   */
  app.get('/ready', async (_request, reply) => {
    try {
      await deps.db.execute(sql`select 1`);
      return { status: 'ready' };
    } catch (error) {
      app.log.error({ err: error }, 'readiness check failed');
      return await reply.code(503).header('retry-after', '2').send({
        status: 'not_ready',
        reason: 'database unreachable',
      });
    }
  });

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

    // The database being briefly unreachable is not the caller's fault and is
    // not permanent. Reporting it as a 500 tells clients and dashboards that
    // the service is broken, when what it needs is for them to come back.
    if (isTransientDatabaseError(error)) {
      request.log.error({ err: error }, 'database unavailable');
      return reply
        .code(503)
        .header('retry-after', '2')
        .send({
          error: {
            code: 'database_unavailable',
            message: 'The service is temporarily unable to reach its database',
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
