/**
 * The graph the API serves.
 *
 * In production it is the file the build wrote (scripts/neural-twin-build.js,
 * after tsc): composed once from the deployed source, so it is always the
 * architecture of the commit that is running, and nothing is scanned inside a
 * request. Outside production (the tests, a developer's server without a
 * build) it is composed on first use instead. The composer is required lazily,
 * so production never loads the TypeScript compiler.
 */
import * as fs from 'fs';
import * as path from 'path';
import { TWIN_SCHEMA_VERSION, type TwinGraph } from './model';

export const TWIN_GRAPH_FILE = path.join(__dirname, 'generated', 'neural-graph.json');

let cached: TwinGraph | null = null;

export class TwinGraphUnavailable extends Error {
  constructor(message: string) { super(message); this.name = 'TwinGraphUnavailable'; }
}

export function loadTwinGraph(): TwinGraph {
  if (cached) return cached;
  let g: TwinGraph | null = null;
  if (fs.existsSync(TWIN_GRAPH_FILE)) {
    g = JSON.parse(fs.readFileSync(TWIN_GRAPH_FILE, 'utf8')) as TwinGraph;
  } else if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { composeTwin } = require('./compose') as typeof import('./compose');
    g = composeTwin(path.resolve(__dirname, '..', '..', '..'));
  }
  if (!g) throw new TwinGraphUnavailable('The architecture graph was not built with this release.');
  if (g.schemaVersion !== TWIN_SCHEMA_VERSION) throw new TwinGraphUnavailable('The architecture graph has schema ' + g.schemaVersion + '; this server reads ' + TWIN_SCHEMA_VERSION + '.');
  cached = g;
  return g;
}

/** For the tests: forget the graph read so far. */
export function resetTwinGraphCache(): void { cached = null; }
