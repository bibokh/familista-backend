// Body-parser refusals — a body the parsers would not read, answered as the client fault it is
// ─────────────────────────────────────────────────────────────────────────────
// express.json and express.urlencoded (body-parser over raw-body) refuse a body
// with an http-errors error that carries a 4xx `status` and a `type` token:
// 'entity.too.large' past the 2 MB limit, 'entity.parse.failed' for a body that
// is not JSON, 'parameters.too.many' for a form past 1,000 fields. None of them
// is an AppError, so the error handler used to send them to its catch-all:
// HTTP 500, logged at error, and a client's oversized or malformed body read as
// a server fault in the logs and the alerts.
//
// The parser's own message is never forwarded. On Node 20+ a JSON.parse
// SyntaxError quotes the text it failed on (`Unexpected token 'h', "hunter2"
// is not valid JSON`), and body-parser also attaches the raw text as `err.body`;
// either would carry what the client sent into the response or the log. Each
// refusal answers with a fixed message instead.
//
// Only client faults are listed. 'stream.encoding.set' and 'stream.not.readable'
// are the server's own misconfiguration and stay 500.

export interface BodyParserRefusal {
  /** body-parser's token, e.g. 'entity.too.large'. */
  readonly type: string;
  readonly status: number;
  /** Fixed, and safe to send and to log: it never contains the body. */
  readonly message: string;
}

const REFUSALS: Readonly<Record<string, Omit<BodyParserRefusal, 'type'>>> = Object.freeze({
  'entity.too.large':     { status: 413, message: 'Request body too large' },
  'parameters.too.many':  { status: 413, message: 'Request body has too many parameters' },
  'entity.parse.failed':  { status: 400, message: 'Malformed request body' },
  'request.size.invalid': { status: 400, message: 'Request body does not match its declared length' },
  'request.aborted':      { status: 400, message: 'Request aborted' },
  'charset.unsupported':  { status: 415, message: 'Unsupported request body charset' },
  'encoding.unsupported': { status: 415, message: 'Unsupported request body encoding' },
});

/**
 * The refusal `err` stands for, or null when it is not one. Requires both a
 * listed `type` and a 4xx status, so an unrelated object that happens to carry
 * a `type` field is left to the handlers after this one.
 */
export function bodyParserRefusal(err: unknown): BodyParserRefusal | null {
  if (err === null || typeof err !== 'object') return null;
  const { type, status, statusCode } = err as { type?: unknown; status?: unknown; statusCode?: unknown };
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(REFUSALS, type)) return null;
  const s = typeof status === 'number' ? status : statusCode;
  if (typeof s !== 'number' || s < 400 || s > 499) return null;
  return { type, ...REFUSALS[type] };
}
