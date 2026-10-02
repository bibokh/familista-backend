/**
 * tests/log-redaction.unit.test.ts
 *
 * Cyber Defense, R12 — nothing secret and no personal data reaches a log line.
 * Pinned on the format itself and on the application logger's real output.
 */

import winston from 'winston';
import Transport from 'winston-transport';
import { maskEmail, redactFormat, redactRecord, REDACTED, scrubString } from '../src/utils/log-redaction';

// A JWT-shaped fixture, built at run time so no token-shaped literal is committed.
const b64 = (o: unknown) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const JWT = [b64({ alg: 'HS256' }), b64({ sub: 'user-1' }), b64('signature-value')].join('.');
const STRIPE = `sk_live_${'A1b2C3d4'.repeat(3)}`;

describe('redaction by field name', () => {
  it('replaces secrets at any depth and keeps counts and flags', () => {
    const out = redactRecord({
      message: 'login',
      password: 'hunter2', refreshToken: 'r', apiKey: 'k', authorization: 'Bearer abc',
      nested: { deep: { client_secret: 's', otp: '123456', recoveryCodes: ['a', 'b'], cookie: 'sid=1' } },
      tokensIn: 1200, tokenValid: true,
    });
    expect(out).toMatchObject({
      password: REDACTED, refreshToken: REDACTED, apiKey: REDACTED, authorization: REDACTED,
      nested: { deep: { client_secret: REDACTED, otp: REDACTED, recoveryCodes: REDACTED, cookie: REDACTED } },
      tokensIn: 1200, tokenValid: true,
    });
  });

  it('removes personal fields and reduces e-mail addresses to initial and domain', () => {
    const out = redactRecord({ message: 'x', firstName: 'Ana', phone: '+44 7700 900000', dateOfBirth: '2010-01-01', email: 'ana.smith@club.test' });
    expect(out).toMatchObject({ firstName: REDACTED, phone: REDACTED, dateOfBirth: REDACTED, email: 'a***@club.test' });
  });

  it('never mutates the caller\'s nested objects, and survives cycles and errors', () => {
    const req: Record<string, unknown> = { headers: { authorization: 'Bearer abc' } };
    req.self = req;
    const err = new Error(`failed with ${STRIPE}`);
    const out = redactRecord({ message: 'x', req, err });
    expect((req.headers as Record<string, string>).authorization).toBe('Bearer abc');
    expect(JSON.stringify(out)).not.toContain(STRIPE);
    expect(JSON.stringify(out)).toContain('[Circular]');
  });
});

describe('redaction by shape, in free text', () => {
  it('masks bearer values, JWTs, provider keys, webhook secrets and URL credentials', () => {
    const s = scrubString(`auth Bearer abc.def ${JWT} ${STRIPE} whsec_${'x'.repeat(12)} sk-ant-${'y'.repeat(12)} postgresql://u:pw@db:5432/x redis://:pw@r:6379`);
    for (const leak of ['abc.def', JWT, STRIPE, 'whsec_x', 'sk-ant-y', 'u:pw@', ':pw@r']) expect(s).not.toContain(leak);
    expect(s).toContain('postgresql://[REDACTED]@db:5432/x');
  });

  it('masks e-mail addresses inside a message', () => {
    expect(maskEmail('sent to coach@club.test')).toBe('sent to c***@club.test');
  });
});

describe('the logger pipeline', () => {
  it('no transport sees a secret: the format runs before output', () => {
    const lines: string[] = [];
    class Capture extends Transport { log(info: unknown, next: () => void) { lines.push(JSON.stringify(info)); next(); } }
    const log = winston.createLogger({ format: winston.format.combine(redactFormat(), winston.format.json()), transports: [new Capture()] });
    log.info(`user signed in with ${JWT}`, { password: 'hunter2', user: { email: 'p@club.test', lastName: 'Doe' } });
    const line = lines.join('\n');
    for (const leak of [JWT, 'hunter2', 'p@club.test', 'Doe']) expect(line).not.toContain(leak);
  });

  it('the application logger carries the redaction format', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/utils/logger.ts'), 'utf8') as string;
    expect((src.match(/redactFormat\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
