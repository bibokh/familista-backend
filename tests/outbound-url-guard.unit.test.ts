/**
 * tests/outbound-url-guard.unit.test.ts
 *
 * Cyber Defense, R1b — a webhook URL a user typed must not become a request
 * into the platform's own network.
 *
 * Before: any signed-in user could register a WEBHOOK notification channel
 * with any URL, and the dispatch worker POSTed to it with fetch — following
 * redirects — and wrote the first 200 characters of the response into the
 * user's own notification, where they could read it back. The private network
 * (Redis, PostgreSQL), loopback and 169.254.169.254 were all reachable, with
 * the answer delivered to the attacker's inbox. (The worker is not started in
 * production today, so this was latent — one switch away from live.)
 *
 * After: registration and the connection itself both refuse anything but a
 * public https address; no redirect is followed; time and size are bounded;
 * no response body is kept anywhere.
 */

import dns from 'dns';
import http from 'http';
import https from 'https';
import net from 'net';
import type { AddressInfo } from 'net';
import {
  assertOutboundUrl, isBlockedAddress, OutboundUrlError, parseOutboundUrl, postJsonGuarded, type Lookup,
} from '../src/security/outbound-url-guard';

const lookupTo = (...addresses: string[]): Lookup => async () => addresses.map((address) => ({ address, family: net.isIP(address) }));

describe('which addresses are the inside', () => {
  it.each([
    ['127.0.0.1', 'loopback'], ['127.255.255.254', 'loopback'], ['0.0.0.0', 'this network'],
    ['10.0.0.1', 'private'], ['172.16.0.1', 'private'], ['172.31.255.255', 'private'], ['192.168.1.1', 'private'],
    ['169.254.169.254', 'cloud metadata'], ['169.254.1.1', 'link-local'], ['100.64.0.1', 'carrier-grade NAT'],
    ['224.0.0.1', 'multicast'], ['255.255.255.255', 'broadcast'], ['198.18.0.1', 'benchmarking'],
    ['::1', 'IPv6 loopback'], ['::', 'unspecified'], ['fe80::1', 'IPv6 link-local'], ['fd12:3456::1', 'unique local'],
    ['fc00::1', 'unique local'], ['ff02::1', 'IPv6 multicast'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'], ['::ffff:7f00:1', 'IPv4-mapped loopback, hex'],
    ['::ffff:a9fe:a9fe', 'IPv4-mapped metadata, hex'], ['::ffff:10.0.0.1', 'IPv4-mapped private'],
    ['::127.0.0.1', 'IPv4-compatible loopback'], ['64:ff9b::a9fe:a9fe', 'NAT64 metadata'],
    ['2002:7f00:1::', '6to4 loopback'], ['2001:db8::1', 'documentation'], ['not-an-address', 'unparseable'],
  ])('%s (%s) is blocked', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1', '::ffff:8.8.8.8', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e'])(
    '%s is public', (address) => expect(isBlockedAddress(address)).toBe(false),
  );
});

describe('which URLs may be called at all', () => {
  const refused = (raw: string) => { try { parseOutboundUrl(raw); return 'accepted'; } catch (e) { return (e as OutboundUrlError).reason; } };

  it('refuses anything but https to a public place', () => {
    expect(refused('http://hooks.example.com/x')).toBe('https-required');
    expect(refused('ftp://hooks.example.com/x')).toBe('https-required');
    expect(refused('file:///etc/passwd')).toBe('https-required');
    expect(refused('https://user:pw@hooks.example.com/x')).toBe('credentials-in-url');
    expect(refused('https://hooks.example.com:8443/x')).toBe('port-not-allowed');
    expect(refused('https://hooks.example.com:6379/x')).toBe('port-not-allowed');
    expect(refused('not a url')).toBe('invalid-url');
  });

  it('refuses internal names, including a Render private service name', () => {
    for (const raw of ['https://localhost/x', 'https://api.localhost/x', 'https://familista-redis/x', 'https://postgres/x',
      'https://metadata.google.internal/x', 'https://printer.local/x', 'https://LOCALHOST./x']) {
      expect(`${raw}: ${refused(raw)}`).toBe(`${raw}: internal-hostname`);
    }
  });

  it('refuses internal addresses however the address is written', () => {
    for (const raw of ['https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data/', 'https://[::1]/x',
      'https://[::ffff:127.0.0.1]/x', 'https://[::ffff:7f00:1]/x', 'https://2130706433/x', 'https://0x7f.0.0.1/x',
      'https://0177.0.0.1/x', 'https://127.1/x', 'https://10.0.0.1/x', 'https://[fd00::1]/x']) {
      expect(`${raw}: ${refused(raw)}`).toBe(`${raw}: blocked-address`);
    }
  });

  it('accepts a public https URL', () => {
    expect(refused('https://hooks.example.com/familista')).toBe('accepted');
    expect(refused('https://hooks.example.com:443/familista')).toBe('accepted');
    expect(refused('https://93.184.216.34/hook')).toBe('accepted');
  });
});

describe('what a name resolves to', () => {
  it('refuses a public-looking name that points inside', async () => {
    await expect(assertOutboundUrl('https://hooks.attacker.example/x', lookupTo('169.254.169.254'))).rejects.toMatchObject({ reason: 'blocked-address' });
    await expect(assertOutboundUrl('https://hooks.attacker.example/x', lookupTo('10.1.2.3'))).rejects.toMatchObject({ reason: 'blocked-address' });
    await expect(assertOutboundUrl('https://hooks.attacker.example/x', lookupTo('::ffff:7f00:1'))).rejects.toMatchObject({ reason: 'blocked-address' });
  });

  it('refuses a name with one public and one private answer', async () => {
    await expect(assertOutboundUrl('https://hooks.attacker.example/x', lookupTo('93.184.216.34', '127.0.0.1')))
      .rejects.toMatchObject({ reason: 'blocked-address' });
  });

  it('refuses a name that does not resolve, and accepts one that resolves publicly', async () => {
    const failing: Lookup = async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); };
    await expect(assertOutboundUrl('https://nothing.example/x', failing)).rejects.toMatchObject({ reason: 'unresolvable' });
    await expect(assertOutboundUrl('https://hooks.example.com/x', lookupTo('93.184.216.34'))).resolves.toBeInstanceOf(URL);
  });
});

describe('the request itself', () => {
  let server: http.Server;
  let port: number;
  const hits: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      req.resume();
      if (req.url === '/redirect') { res.writeHead(302, { location: 'https://169.254.169.254/latest/meta-data/' }); res.end(); return; }
      if (req.url === '/huge') { res.writeHead(200); res.end(Buffer.alloc(1024 * 1024, 65)); return; }
      if (req.url === '/slow') return; // never answers
      if (req.url === '/error') { res.writeHead(500); res.end('INTERNAL-STACK-TRACE'); return; }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('INTERNAL-SECRET-BODY');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => { hits.length = 0; });

  // Reaches the local test server regardless of the address, so the response
  // handling can be exercised. The address checks are tested without it.
  class ToTestServer extends https.Agent {
    createConnection(): net.Socket { return net.connect(port, '127.0.0.1'); }
  }
  const viaTestServer = { agent: new ToTestServer(), lookup: lookupTo('93.184.216.34') };

  it('DNS rebinding: a name that turns private at the connection is refused before any byte is sent', async () => {
    // Passed at registration (public), answers loopback when the socket opens.
    let calls = 0;
    const rebinding: Lookup = async () => [{ address: calls++ === 0 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
    await assertOutboundUrl(`https://rebind.attacker.example/ok`, rebinding);
    const r = await postJsonGuarded('https://rebind.attacker.example/ok', '{}', {}, { lookup: rebinding });
    expect(r).toEqual({ ok: false, status: 0, reason: 'blocked-address' });
    expect(hits).toEqual([]);
  });

  it('refuses a stored internal target at send time without connecting', async () => {
    for (const raw of ['https://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/x', 'https://familista-redis/x', `https://127.0.0.1:${port}/ok`]) {
      const r = await postJsonGuarded(raw, '{}', {});
      expect(r.ok).toBe(false);
      expect(r.status).toBe(0);
    }
    expect(hits).toEqual([]);
  });

  it('does not follow a redirect toward the inside', async () => {
    const r = await postJsonGuarded('https://hooks.example.com/redirect', '{}', {}, viaTestServer);
    expect(r).toEqual({ ok: false, status: 302, reason: 'redirect-refused' });
    expect(hits).toEqual(['/redirect']);
  });

  it('returns a status and a fixed word — never the response body', async () => {
    const ok = await postJsonGuarded('https://hooks.example.com/ok', '{"a":1}', {}, viaTestServer);
    expect(ok).toEqual({ ok: true, status: 200, reason: 'delivered' });
    const failed = await postJsonGuarded('https://hooks.example.com/error', '{}', {}, viaTestServer);
    expect(failed).toEqual({ ok: false, status: 500, reason: 'http-error' });
    expect(JSON.stringify([ok, failed])).not.toMatch(/INTERNAL/);
  });

  it('stops reading an oversized response and gives up on a silent one', async () => {
    const big = await postJsonGuarded('https://hooks.example.com/huge', '{}', {}, { ...viaTestServer, maxResponseBytes: 1024 });
    expect(big.status).toBe(200);
    const slow = await postJsonGuarded('https://hooks.example.com/slow', '{}', {}, { ...viaTestServer, timeoutMs: 200 });
    expect(slow).toEqual({ ok: false, status: 0, reason: 'timeout' });
  });

  it('uses the system resolver by default (spied, no network)', async () => {
    const spy = jest.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '10.9.8.7', family: 4 }] as never);
    try {
      await expect(assertOutboundUrl('https://hooks.example.com/x')).rejects.toMatchObject({ reason: 'blocked-address' });
      expect(spy).toHaveBeenCalledWith('hooks.example.com', { all: true });
    } finally { spy.mockRestore(); }
  });
});
