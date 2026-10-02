// Nothing secret and no personal data reaches a log line (Cyber Defense, R12)
// ─────────────────────────────────────────────────────────────────────────────
// One format, first in the logger's pipeline (utils/logger.ts), so every line —
// console and files, dev and prod — passes through it. It works on the line's
// metadata at any depth and on the message itself:
//
//   by field name   a password, token, secret, cookie, authorization header,
//                   API or private key, signature, one-time code or recovery
//                   code is replaced with "[REDACTED]"; so are a person's name,
//                   phone, date of birth and address. An e-mail address is
//                   reduced to its first letter and domain.
//   by shape        in any string, including the message: a "Bearer …" value,
//                   a JWT, a live Stripe-style key, a webhook secret and an
//                   e-mail address are masked.
//
// Counts are not secrets: a number or boolean under a name like `tokensIn` is
// kept. The original object is never mutated — a caller's object may be the
// request itself.

import winston from 'winston';

const SECRET_NAME = /(^pass$|password|passwd|passphrase|secret|token|authori[sz]ation|cookie|api[_-]?key|private[_-]?key|signature|^sig$|^t?otp$|^t?otp[_-]?code$|recovery[_-]?codes?|backup[_-]?codes?|credential|bearer|^jwt$|^key$|session[_-]?id|refresh)/i;
const PERSONAL_NAME = /^(first[_-]?name|last[_-]?name|full[_-]?name|phone(number)?|mobile|date[_-]?of[_-]?birth|dob|birth[_-]?date|address|street|post(al)?[_-]?code|zip)$/i;
const EMAIL_NAME = /^(e[_-]?mail|email[_-]?address|recipient|to)$/i;

const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const SHAPES: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED_JWT]'],
  [/\b(sk|rk)_(live|test)_[A-Za-z0-9]{8,}\b/g, '[REDACTED_KEY]'],
  [/\bwhsec_[A-Za-z0-9]{8,}\b/g, '[REDACTED_KEY]'],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]'],
  [/\b(postgres(ql)?|redis|rediss|mysql|mongodb(\+srv)?):\/\/[^\s"'@]+@/gi, '$1://[REDACTED]@'],
];

export const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;

export function maskEmail(s: string): string {
  return s.replace(EMAIL, (_m, first: string, domain: string) => `${first}***@${domain}`);
}

/** Mask secret- and personal-looking substrings in free text. */
export function scrubString(s: string): string {
  let out = s;
  for (const [re, rep] of SHAPES) out = out.replace(re, rep);
  return maskEmail(out);
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1, seen));
  if (value instanceof Date) return value;
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const keys = value instanceof Error ? ['name', 'message', 'stack', ...Object.keys(src)] : Object.keys(src);
  for (const k of keys) out[k] = redactField(k, src[k], depth, seen);
  return out;
}

function redactField(key: string, v: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (v === undefined || v === null) return v;
  if (SECRET_NAME.test(key) && typeof v !== 'number' && typeof v !== 'boolean') return REDACTED;
  if (PERSONAL_NAME.test(key) && typeof v !== 'boolean') return REDACTED;
  if (EMAIL_NAME.test(key) && typeof v === 'string') return maskEmail(v);
  return redactValue(v, depth + 1, seen);
}

/** A redacted copy of a log record's own fields (Symbol keys untouched). */
export function redactRecord<T extends Record<string, unknown>>(info: T): T {
  const seen = new WeakSet<object>();
  for (const k of Object.keys(info)) {
    if (k === 'level' || k === 'timestamp') continue;
    (info as Record<string, unknown>)[k] = k === 'message' || k === 'stack'
      ? (typeof info[k] === 'string' ? scrubString(info[k] as string) : redactValue(info[k], 0, seen))
      : redactField(k, info[k], 0, seen);
  }
  return info;
}

/** The winston format: in the logger's own format, so no transport can be added that skips it. */
export const redactFormat = winston.format((info) => redactRecord(info as Record<string, unknown>) as typeof info);
