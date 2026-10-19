/**
 * Structured JSON logger shared by every service (docs/rules.md §7).
 * `console.log` is banned in production code — this is what replaces it.
 *
 * Redaction exists because of the GDPR rule in docs/plan.md "Säkerhet":
 * tokens and secrets must never end up in log storage. Add new sensitive
 * field names to REDACT_PATHS rather than trusting call sites to remember.
 */
import pino, { type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.apiKey',
  '*.cardNumber',
  '*.cvc',
];

export interface CreateLoggerOptions {
  /** Name of the service emitting logs, e.g. "booking-api". Shows up on every line. */
  readonly serviceName: string;
  /** rules.md §7: error = needs action, warn = deviation, info = business event, debug = dev only. */
  readonly level?: 'error' | 'warn' | 'info' | 'debug';
}

export function createLogger(options: CreateLoggerOptions): Logger {
  return pino({
    name: options.serviceName,
    level: options.level ?? (process.env['NODE_ENV'] === 'production' ? 'info' : 'debug'),
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

/**
 * Binds a `requestId` so every subsequent log line from this logger
 * carries it (rules.md §7: "varje request bär requestId genom alla lager").
 * Pass the child logger down through controllers/services/repositories
 * instead of the root logger once a request starts.
 */
export function withRequestId(logger: Logger, requestId: string): Logger {
  return logger.child({ requestId });
}
