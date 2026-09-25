# Vision session store

Session artefacts the Familista Vision Engine produced, read by the platform
through `src/vision-platform/engine-contract.ts`.

## What these are

**Original evidence.** Each directory is one completed run of the validated
engine, copied here by `scripts/vision-import-session.js` with two changes and
no others: the engine's several output files become one directory, and the
absolute path it recorded for its input is reduced to the file's name. Every
observation, every null coordinate, every UNKNOWN, every PROPAGATED ball frame
and every calibration verdict is byte-for-byte what the engine decided. The
importer verifies that by re-reading what it wrote and refusing if the
observation count moved.

## Why they are read-only

When a better model produces different derived results from the same video, both
answers must be readable and attributable. That is only possible if the original
is still exactly as the engine wrote it, so nothing in the platform writes here.

## Why they are in the repository

Two of the three are regression fixtures that `tests/familista-vision.unit.test.ts`
asserts against — the platform must report the engine's numbers unchanged, and a
test that cannot see the evidence cannot check that. A production deployment
points `FAMILISTA_VISION_SESSIONS` at wherever its engine actually writes.

## The sessions

| Directory | Source | Frames | Observations | Calibration coverage |
|---|---|---|---|---|
| `original-clip` | `test_match.mp4`, 1024×576 | 301 | 4484 | 71.8% |
| `morocco-spain-clip1` | `broadcast_test_20s.mp4`, 1920×1080 | 556 | 10043 | 3.8% |
| `morocco-spain-clip2` | `morocco_spain_clip2.mp4`, 1920×1080 | 460 | 6546 | 10.4% |

The two Morocco v Spain clips are the cross-source generalisation tests. Their
low calibration coverage is the honest measured result on that footage, not a
defect in the import.
