/**
 * Familista Design Studio — the document core, on the server.
 *
 * The server validates a design with the very file the editor runs:
 * public/product-design/pd-core.js (pure, deterministic, no DOM, no clock), and
 * against the very template the editor draws: public/product-design/templates/.
 * One validator, so a document the server accepts is one the editor opens, and
 * nothing the editor refuses can be stored. Both are read once, from the
 * repository's public directory (the same one app.ts serves), and the template
 * passes the core's own template validation before any document is checked
 * against it.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/** A refusal from the core: a machine code and the path in the document it is about. */
export interface CoreProblem { code: string; path: string }

/** The canonical document, as validateDocument returns it. Its parts stay opaque to the server. */
export interface DesignDocument {
  format: string;
  version: number;
  name: string;
  template: { key: string; version: number };
  palette: unknown[];
  parts: Record<string, unknown>;
  surfaces: unknown[];
}

interface ProductTemplate { key: string; templateVersion: number }

interface PdCore {
  FORMAT: string;
  VERSION: number;
  LIMITS: { bytes: number; name: number };
  validateTemplate(input: unknown): ProductTemplate;
  validateDocument(input: unknown, template: ProductTemplate): DesignDocument;
  serializeDocument(doc: DesignDocument): string;
  byteLength(text: string): number;
}

const PUBLIC_DIR = path.join(__dirname, '..', '..', '..', 'public', 'product-design');
const TEMPLATE_FILES = ['football-jersey.json'];

let loaded: { core: PdCore; templates: Map<string, ProductTemplate> } | null = null;

function load(): { core: PdCore; templates: Map<string, ProductTemplate> } {
  if (loaded) return loaded;
  // The editor's own core, required as the CommonJS module its UMD wrapper exports.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const core = require(path.join(PUBLIC_DIR, 'pd-core.js')) as PdCore;
  const templates = new Map<string, ProductTemplate>();
  for (const file of TEMPLATE_FILES) {
    const t = core.validateTemplate(JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'templates', file), 'utf8')));
    templates.set(`${t.key}@${t.templateVersion}`, t);
  }
  loaded = { core, templates };
  return loaded;
}

/** The core's limits (bytes, name length), for the routes' own envelope checks. */
export function coreLimits(): { bytes: number; name: number } {
  return load().core.LIMITS;
}

/** The document format version this server writes. */
export function formatVersion(): number {
  return load().core.VERSION;
}

/** A document the core refused. `problems` are the core's own codes and paths, at most 20. */
export class DesignDocumentError extends Error {
  readonly problems: CoreProblem[];
  constructor(problems: CoreProblem[]) {
    super(problems.length ? `${problems[0].code} at ${problems[0].path || 'document'}` : 'invalid design document');
    this.name = 'DesignDocumentError';
    this.problems = problems.slice(0, 20);
  }
}

export interface ValidatedDocument {
  document: DesignDocument;
  /** The canonical text: one document, one text. */
  text: string;
  sha256: string;
  bytes: number;
}

/**
 * Validate a document against the template it names, and return its canonical
 * form with the hash and size of its canonical text. Throws DesignDocumentError.
 */
export function validateDesignDocument(input: unknown): ValidatedDocument {
  const { core, templates } = load();
  const named = input && typeof input === 'object' ? (input as { template?: { key?: unknown; version?: unknown } }).template : undefined;
  const template = named ? templates.get(`${String(named.key)}@${String(named.version)}`) : undefined;
  let document: DesignDocument;
  try {
    // An unknown template is the core's 'unknown-template', reported like every other problem.
    document = core.validateDocument(input, template ?? templates.values().next().value as ProductTemplate);
  } catch (err) {
    const e = err as { code?: unknown; path?: unknown; errors?: Array<{ code?: unknown; path?: unknown }> };
    if (typeof e.code !== 'string') throw err;
    const list = Array.isArray(e.errors) && e.errors.length ? e.errors : [e];
    throw new DesignDocumentError(list.map((p) => ({ code: String(p.code), path: String(p.path || '') })));
  }
  const text = core.serializeDocument(document);
  const bytes = core.byteLength(text);
  if (bytes > core.LIMITS.bytes) throw new DesignDocumentError([{ code: 'too-large', path: 'document' }]);
  return { document, text, bytes, sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex') };
}

/** The hash of a stored document's canonical text, for verifying what was read back. */
export function canonicalSha256(document: DesignDocument): string {
  const { core } = load();
  return crypto.createHash('sha256').update(core.serializeDocument(document), 'utf8').digest('hex');
}
