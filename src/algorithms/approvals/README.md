# Approval dossiers

One JSON file per promoted algorithm version: the evidence a CHANGE approval in
`src/algorithms/registry.ts` is bound to (Algorithms Step 5). Its schema is
`src/algorithms/approval-dossier.ts`; its digest is `src/algorithms/dossier-core.js`.

- **Written by the release tool, never by hand.** `npm run algorithms:release`
  (`lab/algorithms/release/`) writes a dossier only in a pull request that
  carries an approval, and only when the platform owner asks for one.
- **Immutable.** The registry records each dossier's SHA-256. Change one value
  and CI fails with `DIGEST_MISMATCH`. A later change to the algorithm is a new
  version with a new dossier; this one stays as history.
- **Pinned.** A dossier records the lab spec version and a fingerprint of every
  evaluation-engine module its evidence came from, and the commit they were at.
  While the engine is unchanged, CI re-runs it and the result must agree with
  the dossier (every figure within 1e-9, relatively). After the engine moves on,
  the evidence stays as it was, and is reproduced by checking out the pinned
  commit.
- **Synthetic.** A dossier shows how a change behaves on invented shots and
  which properties it keeps. It never shows real-world accuracy, and it holds no
  club data, health data or personal data.

No algorithm has been promoted yet, so this directory holds no dossier.
