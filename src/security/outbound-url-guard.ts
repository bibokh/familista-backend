// Cyber Defense, R1b — the one door for a request to a URL a user gave us
// ─────────────────────────────────────────────────────────────────────────────
// A webhook target is typed by a user. Sent as it is, it lets that user make
// the server request anything the server can reach: the private network the
// database and Redis live on, the loopback interface, a cloud metadata
// endpoint. This module is the only way such a URL is fetched.
//
//   the URL          https only, port 443, no credentials in it, a hostname
//                    with at least one dot that is not a local or internal
//                    name, and — if the host is an address — a public one.
//   the address      every address the name resolves to must be public. The
//                    check runs twice: when the URL is registered, and again
//                    inside the connection's own DNS lookup, so the socket
//                    connects to exactly the address that was checked. A name
//                    that resolves to something else by the time it is used
//                    (DNS rebinding) is refused at that moment.
//   the response     no redirect is followed (a public URL cannot bounce the
//                    request inward), a 10-second limit, at most 64 KB read
//                    and then discarded. The caller learns the status code and
//                    a fixed reason word — never the response body, never an
//                    error message that could quote the inside.

import dns from 'dns';
import https from 'https';
import net from 'net';

export class OutboundUrlError extends Error {
  constructor(public readonly reason: OutboundRefusal) { super(`outbound request refused: ${reason}`); this.name = 'OutboundUrlError'; }
}

export type OutboundRefusal =
  | 'invalid-url' | 'https-required' | 'credentials-in-url' | 'port-not-allowed'
  | 'internal-hostname' | 'blocked-address' | 'unresolvable';

// Everything that is not the public internet.
const BLOCKED = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // carrier-grade NAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // documentation
  ['192.88.99.0', 24],   // 6to4 relay
  ['192.168.0.0', 16],   // private
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // documentation
  ['203.0.113.0', 24],   // documentation
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved, broadcast
] as const) BLOCKED.addSubnet(prefix, bits, 'ipv4');
for (const [prefix, bits] of [
  ['::', 128],           // unspecified
  ['::1', 128],          // loopback
  ['64:ff9b::', 96],     // NAT64 — reaches IPv4 through a translator
  ['64:ff9b:1::', 48],   // local-use NAT64
  ['100::', 64],         // discard
  ['2001::', 32],        // Teredo
  ['2001:db8::', 32],    // documentation
  ['2002::', 16],        // 6to4 — embeds an IPv4 address
  ['fc00::', 7],         // unique local
  ['fe80::', 10],        // link-local
  ['ff00::', 8],         // multicast
] as const) BLOCKED.addSubnet(prefix, bits, 'ipv6');

/** True when an address is anything but a public unicast address. Unparseable counts as blocked. */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return true;
  if (family === 6) {
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) addresses,
    // in any spelling (::ffff:7f00:1 is 127.0.0.1): judge the IPv4 inside.
    // Decoded here rather than as BlockList subnets, because a ::/96 subnet
    // in a BlockList also matches every plain IPv4 address.
    const words = expandIPv6(address);
    if (words.slice(0, 5).every((w) => w === 0) && (words[5] === 0xffff || words[5] === 0)) {
      const v4 = `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
      if (words[5] === 0xffff || (v4 !== '0.0.0.0' && v4 !== '0.0.0.1')) return isBlockedAddress(v4);
    }
    return BLOCKED.check(address, 'ipv6');
  }
  return BLOCKED.check(address, 'ipv4');
}

/** The eight 16-bit words of an IPv6 address (already validated by net.isIP). */
function expandIPv6(address: string): number[] {
  let a = address.toLowerCase().split('%')[0];
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (dotted) {
    const [, p, q, r, t] = dotted.map(Number);
    a = a.slice(0, dotted.index) + `${((p << 8) | q).toString(16)}:${((r << 8) | t).toString(16)}`;
  }
  const [head, tail] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = tail !== undefined ? Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map((w) => parseInt(w, 16));
}

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home', '.corp', '.private'];

/** Checks a URL without touching the network. Returns it parsed, or throws OutboundUrlError. */
export function parseOutboundUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(String(raw).trim()); } catch { throw new OutboundUrlError('invalid-url'); }
  if (url.protocol !== 'https:') throw new OutboundUrlError('https-required');
  if (url.username || url.password) throw new OutboundUrlError('credentials-in-url');
  if (url.port !== '' && url.port !== '443') throw new OutboundUrlError('port-not-allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) throw new OutboundUrlError('invalid-url');
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new OutboundUrlError('blocked-address');
    return url;
  }
  // A name with no dot is a local name (a Render private service is one).
  if (!host.includes('.') || host === 'localhost' || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new OutboundUrlError('internal-hostname');
  }
  return url;
}

export type Lookup = (hostname: string, options: dns.LookupAllOptions) => Promise<dns.LookupAddress[]>;
const systemLookup: Lookup = (hostname, options) => dns.promises.lookup(hostname, options);

async function vettedAddresses(hostname: string, lookup: Lookup): Promise<dns.LookupAddress[]> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new OutboundUrlError('blocked-address');
    return [{ address: host, family: net.isIP(host) }];
  }
  let found: dns.LookupAddress[];
  try { found = await lookup(host, { all: true }); } catch { throw new OutboundUrlError('unresolvable'); }
  if (found.length === 0) throw new OutboundUrlError('unresolvable');
  // One private answer is enough to refuse: a name must not be half inside.
  if (found.some((a) => isBlockedAddress(a.address))) throw new OutboundUrlError('blocked-address');
  return found;
}

/** Full check of a URL a user wants us to call: the URL itself, then every address it resolves to. */
export async function assertOutboundUrl(raw: string, lookup: Lookup = systemLookup): Promise<URL> {
  const url = parseOutboundUrl(raw);
  await vettedAddresses(url.hostname, lookup);
  return url;
}

/**
 * A DNS lookup for the connection itself: resolves, refuses a blocked answer,
 * and hands the socket only the address it checked.
 */
export function guardedLookup(lookup: Lookup = systemLookup): net.LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void) => {
    vettedAddresses(hostname, lookup).then((found) => {
      const wanted = options?.family ? found.filter((a) => a.family === options.family) : found;
      if (wanted.length === 0) throw new OutboundUrlError('unresolvable');
      if (options?.all) callback(null, wanted);
      else callback(null, wanted[0].address, wanted[0].family);
    }).catch((err) => callback(err as NodeJS.ErrnoException, '', 0));
  }) as unknown as net.LookupFunction;
}

export interface GuardedPostResult {
  ok: boolean;
  /** HTTP status, or 0 when no response was received. */
  status: number;
  /** A fixed word, never text from the response or from an error. */
  reason: 'delivered' | 'http-error' | 'redirect-refused' | 'timeout' | 'network-error' | OutboundRefusal;
}

export interface GuardedPostOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  lookup?: Lookup;
  /** Tests only: the TLS agent to use (e.g. one that trusts a test certificate). */
  agent?: https.Agent;
}

/** POSTs a JSON body to a user-supplied URL through every check above. Never throws. */
export async function postJsonGuarded(
  rawUrl: string, body: string, headers: Record<string, string>, opts: GuardedPostOptions = {},
): Promise<GuardedPostResult> {
  let url: URL;
  try { url = parseOutboundUrl(rawUrl); } catch (err) {
    return { ok: false, status: 0, reason: (err as OutboundUrlError).reason ?? 'invalid-url' };
  }
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxResponseBytes ?? 64 * 1024;
  return new Promise<GuardedPostResult>((resolve) => {
    let settled = false;
    const done = (r: GuardedPostResult) => { if (!settled) { settled = true; resolve(r); } };
    const req = https.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...headers },
      lookup: guardedLookup(opts.lookup),
      agent: opts.agent,
      timeout: timeoutMs,
    }, (res) => {
      const status = res.statusCode ?? 0;
      let read = 0;
      res.on('data', (chunk: Buffer) => { read += chunk.length; if (read > maxBytes) res.destroy(); });
      res.on('error', () => undefined);
      res.on('close', () => {
        if (status >= 300 && status < 400) done({ ok: false, status, reason: 'redirect-refused' });
        else if (status >= 200 && status < 300) done({ ok: true, status, reason: 'delivered' });
        else done({ ok: false, status, reason: 'http-error' });
      });
      res.resume();
    });
    req.on('timeout', () => { req.destroy(); done({ ok: false, status: 0, reason: 'timeout' }); });
    req.on('error', (err) => {
      done({ ok: false, status: 0, reason: err instanceof OutboundUrlError ? err.reason : 'network-error' });
    });
    req.end(body);
  });
}
