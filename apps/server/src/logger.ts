import type { FastifyBaseLogger } from 'fastify';

/** The pino logger Fastify creates; passed into services so they log with the same redaction. */
export type Logger = FastifyBaseLogger;
