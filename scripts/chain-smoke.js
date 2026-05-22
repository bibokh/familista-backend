// Tamper-resistance smoke test for the SecurityAuditEvent hash chain.
// Pure-function — no DB. Verifies the algorithm against the spec:
//   currentHash = SHA-256(previousHash + actorId + clubId + action +
//                          entityType + entityId + payloadHash + timestamp)
//
// Builds a 5-event chain, then mutates one row's `action` and confirms
// the recomputed hash no longer matches → chain is broken.

const { _internal, computeRowHash } = require('../dist/security/audit-chain.service');

const club  = 'club-test';
const actor = 'user-test';
const events = [
  { action: 'MATCH_CREATED',  entityType: 'Match',  entityId: 'm1', payload: { competition: 'CUP' } },
  { action: 'LINEUP_SET',     entityType: 'Lineup', entityId: 'l1', payload: { side: 'HOME', formation: '4-3-3' } },
  { action: 'TIMELINE_ADDED', entityType: 'Event',  entityId: 'e1', payload: { kind: 'GOAL', min: 23 } },
  { action: 'AI_APPROVAL_REQUESTED', entityType: 'AIApprovalRequest', entityId: 'a1', payload: { kind: 'CHANGE_TACTICS_LIVE' } },
  { action: 'MATCH_FINALIZED', entityType: 'Match',  entityId: 'm1', payload: { home: 2, away: 1 } },
];

let prev = 'GENESIS';
const chain = [];
const baseTime = new Date('2026-01-01T00:00:00.000Z').getTime();
events.forEach((e, i) => {
  const ts = new Date(baseTime + i * 60_000).toISOString();
  const payloadHash = _internal.payloadHash(e.payload);
  const currentHash = computeRowHash({
    previousHash: prev,
    actorId:      actor,
    clubId:       club,
    action:       e.action,
    entityType:   e.entityType,
    entityId:     e.entityId,
    payloadHash,
    timestampIso: ts,
  });
  chain.push({ ...e, payloadHash, previousHash: prev, currentHash, timestampIso: ts });
  prev = currentHash;
});

// 1. Verify clean chain.
function verify(rows) {
  let p = 'GENESIS';
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const expect = computeRowHash({
      previousHash: p,
      actorId:      actor,
      clubId:       club,
      action:       r.action,
      entityType:   r.entityType,
      entityId:     r.entityId,
      payloadHash:  r.payloadHash,
      timestampIso: r.timestampIso,
    });
    if (expect !== r.currentHash || r.previousHash !== p) return { ok: false, brokenAt: i };
    p = r.currentHash;
  }
  return { ok: true };
}

const clean = verify(chain);
if (!clean.ok) { console.error('FAIL: clean chain did not verify', clean); process.exit(1); }

// 2. Tamper with row 2 (index 1) — change action.
const tampered = chain.map((r, i) => i === 1 ? { ...r, action: 'LINEUP_SET_TAMPERED' } : r);
const broken = verify(tampered);
if (broken.ok) { console.error('FAIL: tampered chain still verified — algorithm is broken'); process.exit(1); }
if (broken.brokenAt !== 1) { console.error('FAIL: tamper detected at wrong position', broken); process.exit(1); }

console.log('OK · chain ok · tampered chain rejected at position', broken.brokenAt);
console.log('     head hash:', chain[chain.length - 1].currentHash);
process.exit(0);
