import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { config } from './config.ts';
import type { OrderDependencies } from './domain/orders.ts';
import { isAppError } from './errors.ts';
import { registerOrderRoutes } from './routes/orders.ts';

export async function buildApp(
  deps: OrderDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({
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

  await registerOrderRoutes(app, deps);

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
