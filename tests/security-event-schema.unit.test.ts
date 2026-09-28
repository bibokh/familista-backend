/**
 * Cyber Defense · Step 2 — Security Event Schema v1 and the `security.*` names
 *
 * The contract every later collector will publish against, registered in the
 * existing Data Fabric registry. Declared, not produced: nothing in this build
 * emits a `security.*` event, and these tests hold that until a reviewed step
 * adds the first producer.
 */

import fs from 'fs';
import path from 'path';
import '../src/fabric';
import {
  SECURITY_EVENT_TYPES, SECURITY_CATEGORIES, securityEventPayloadV1, ipPrefix,
  type SecurityEventPayloadV1,
} from '../src/cyber-defense/security-event-schema';
import { registerSecurityProducer } from '../src/fabric/producers/security.producer';
import { fabricEvent, registeredEventTypes } from '../src/fabric/registry/event-registry';
import { fabricSchema, validateEventPayload } from '../src/fabric/registry/schema-registry';
import { sourceForEventDomain } from '../src/fabric/registry/source-registry';
import { retentionClassFor } from '../src/fabric/history/retention-classes';

const ROOT = path.join(__dirname, '..');

const valid = (category: SecurityEventPayloadV1['category'] = 'AUTHENTICATION'): SecurityEventPayloadV1 => ({
  category,
  outcome: 'FAILURE',
  severity: 'LOW',
  actor: { type: 'ANONYMOUS', role: null },
  source: { component: 'AUTH', requestId: 'fam-3f2a9c1e-0000-4000-8000-000000000000', ipPrefix: '203.0.113.0/24' },
  evidence: { attemptsInWindow: 3, windowMinutes: 15, knownAccount: false, method: 'PASSWORD' },
  privacyClass: 'PERSONAL',
});

describe('the security.* names are declared in the Fabric registry', () => {
  it('reserves exactly the reviewed set', () => {
    expect(SECURITY_EVENT_TYPES.map((d) => d.type).sort()).toEqual([
      'security.access.denied',
      'security.ai.action.decided',
      'security.audit.chain.broken',
      'security.device.replay.rejected',
      'security.device.signature.rejected',
      'security.lockout.triggered',
      'security.login.failed',
      'security.mfa.failed',
      'security.origin.rejected',
      'security.ratelimit.exceeded',
      'security.refresh.reused',
      'security.tenant.mismatch',
    ]);
    expect(registeredEventTypes().filter((t) => t.startsWith('security.')))
      .toEqual(SECURITY_EVENT_TYPES.map((d) => d.type).sort());
  });

  it.each(SECURITY_EVENT_TYPES.map((d) => [d.type, d] as const))('%s is declared, private and unproduced', (type, d) => {
    const spec = fabricEvent(type)!;
    expect(spec).toBeDefined();
    expect(spec.produced).toBe(false);
    expect(spec.exposeInLiveStream).toBe(false);
    expect(spec.classification).toBe('CONFIDENTIAL');
    expect(spec.source).toBe('system');
    expect(spec.schemaVersion).toBe(1);
    expect(spec.auditRelevant).toBe(d.auditRelevant);
    expect(fabricSchema(type, 1)).toBeDefined();
    expect(SECURITY_CATEGORIES).toContain(d.category);
  });

  it('adds no source, lane or board card — the System source already owns the fallback', () => {
    expect(sourceForEventDomain('security')).toBeUndefined();
  });

  it('registering twice is harmless', () => {
    expect(() => { registerSecurityProducer(); registerSecurityProducer(); }).not.toThrow();
  });

  it('files every security.* event under the SECURITY retention class, and leaves the others where they were', () => {
    for (const d of SECURITY_EVENT_TYPES) {
      expect(retentionClassFor({ eventType: d.type, dataClassification: 'CONFIDENTIAL' }, { auditRelevant: d.auditRelevant }))
        .toBe('SECURITY');
    }
    expect(retentionClassFor({ eventType: 'secret.rotated', dataClassification: 'INTERNAL' })).toBe('SECURITY');
    expect(retentionClassFor({ eventType: 'user.login', dataClassification: 'CONFIDENTIAL' }, { auditRelevant: true })).toBe('AUDIT');
    expect(retentionClassFor({ eventType: 'system.health.changed', dataClassification: 'INTERNAL' })).toBe('OPERATIONAL');
  });
});

describe('nothing in this build publishes a security.* event yet', () => {
  it('the producer module registers and exports no publish helper', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/fabric/producers/security.producer.ts'), 'utf8');
    expect(src).not.toMatch(/publishFabricEvent/);
    expect(src).not.toMatch(/export function publish/);
  });

  it('no source file uses a security.* event type outside the declaration', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'generated') walk(p); continue; }
        if (!e.name.endsWith('.ts')) continue;
        const rel = path.relative(ROOT, p);
        if (rel === path.join('src', 'cyber-defense', 'security-event-schema.ts')) continue;
        // An event type in use: `eventType: 'security.…'` or `type: 'security.…'`.
        // Other `security.` identifiers (metric names, capability keys) are not events.
        if (/\b(?:eventType|type)\s*:\s*['"`]security\.[a-z]/.test(fs.readFileSync(p, 'utf8'))) hits.push(rel);
      }
    };
    walk(path.join(ROOT, 'src'));
    expect(hits).toEqual([]);
  });
});

describe('Security Event Schema v1 accepts a well-formed event', () => {
  it('through the Fabric validator', () => {
    expect(validateEventPayload('security.login.failed', 1, valid())).toEqual({ ok: true, validated: true });
    expect(validateEventPayload('security.origin.rejected', 1, {
      ...valid('NETWORK'), actor: { type: 'ANONYMOUS', role: null },
      source: { component: 'CORS', requestId: null, ipPrefix: '2001:db8:85a3::/48' },
      evidence: { originHost: 'evil.example' },
    })).toEqual({ ok: true, validated: true });
  });
});

describe('Security Event Schema v1 refuses what must never travel', () => {
  const reject = (type: string, payload: unknown) => {
    const r = validateEventPayload(type, 1, payload);
    expect(r.ok).toBe(false);
  };

  it('a category that does not match the event type', () => {
    reject('security.login.failed', valid('DEVICE'));
  });

  it('an unknown field — a password, a token, an e-mail', () => {
    reject('security.login.failed', { ...valid(), password: 'x' });
    reject('security.login.failed', { ...valid(), actor: { type: 'USER', role: null, email: 'a@b.c' } });
    reject('security.login.failed', { ...valid(), source: { ...valid().source, userAgent: 'Mozilla' } });
  });

  it('a full IP address', () => {
    reject('security.login.failed', { ...valid(), source: { ...valid().source, ipPrefix: '203.0.113.7' } });
    reject('security.login.failed', { ...valid(), source: { ...valid().source, ipPrefix: '2001:db8:85a3:0:0:8a2e:370:7334' } });
  });

  it('a sentence in evidence', () => {
    reject('security.login.failed', { ...valid(), evidence: { note: 'wrong password for the owner' } });
    reject('security.login.failed', { ...valid(), evidence: { 'free text': 1 } });
  });

  it('unbounded evidence', () => {
    const evidence = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, i]));
    reject('security.login.failed', { ...valid(), evidence });
  });

  it('an out-of-vocabulary outcome, severity or component', () => {
    reject('security.login.failed', { ...valid(), outcome: 'MAYBE' });
    reject('security.login.failed', { ...valid(), severity: 'SEVERE' });
    reject('security.login.failed', { ...valid(), source: { ...valid().source, component: 'KERNEL' } });
  });

  it('the base schema itself is strict', () => {
    expect(securityEventPayloadV1.safeParse({ ...valid(), extra: true }).success).toBe(false);
  });
});

describe('ipPrefix keeps the network and drops the host', () => {
  it.each([
    ['203.0.113.7', '203.0.113.0/24'],
    ['::ffff:198.51.100.23', '198.51.100.0/24'],
    ['2001:db8:85a3:0:0:8a2e:370:7334', '2001:db8:85a3::/48'],
    ['2001:0db8:0001::1', '2001:db8:1::/48'],
    ['2001:db8::1', '2001:db8:0::/48'],
    ['::1', '0:0:0::/48'],
    ['fe80::1%eth0', 'fe80:0:0::/48'],
  ])('%s → %s', (input, expected) => {
    expect(ipPrefix(input)).toBe(expected);
    expect(securityEventPayloadV1.shape.source.shape.ipPrefix.safeParse(expected).success).toBe(true);
  });

  it.each([['not-an-ip'], [''], [null], [undefined], ['203.0.113.7:443'], ['%eth0']])('%s → null', (input) => {
    expect(ipPrefix(input as string | null | undefined)).toBeNull();
  });
});
