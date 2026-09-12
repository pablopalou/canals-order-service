import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { config } from './config.ts';
import type { OrderDependencies } from './domain/orders.ts';

/** Everything the domain needs except the logger, which the app supplies. */
export type AppDependencies = Omit<OrderDependencies, 'logger'>;
import { isAppError } from './errors.ts';
import { registerOrderRoutes } from './routes/orders.ts';

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

  app.get('/health', async () => ({ status: 'ok' }));

  await registerOrderRoutes(app, { ...deps, logger: app.log });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: {
        code: 'route_not_found',
        message: `${request.method} ${request.url} is not a route on this service`,
      },
      requestId: request.id,
    }),
  );

  app.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      request.log.info(
        { code: error.code, status: error.status },
        'request rejected',
      );
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
          code: 'malformed_request',
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

  return app;
}
