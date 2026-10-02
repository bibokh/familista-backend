import { recordOutcome } from '../infra/outcome-meter';
import winston from 'winston';
import { config } from '../config';
import { redactFormat } from './log-redaction';

const { combine, timestamp, colorize, printf, json, errors } = winston.format;

// Cyber Defense R12: every line passes redaction (utils/log-redaction.ts) after
// the error's stack is extracted and before it is formatted, in both formats.
const devFormat = combine(
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  redactFormat(),
  colorize({ all: true }),
  printf(({ level, message, timestamp, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${level}] ${message}${metaStr}${stack ? `\n${stack}` : ''}`;
  })
);

const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  redactFormat(),
  json()
);

export const logger = winston.createLogger({
  level: config.log.level,
  format: config.isProd ? prodFormat : devFormat,
  transports: [
    new winston.transports.Console(),
    ...(config.isProd
      ? [
          new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
          new winston.transports.File({ filename: 'logs/combined.log' }),
        ]
      : []),
  ],
});

// The Structured Logging building reads these: every line a transport wrote,
// and every error a transport raised (a file it could not append to, say).
for (const transport of logger.transports) {
  transport.on('logged', () => recordOutcome('logging', true));
  transport.on('error', () => recordOutcome('logging', false));
}

// Morgan stream
export const morganStream = {
  write: (message: string) => {
    logger.http(message.trim());
  },
};
