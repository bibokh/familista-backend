# Familista — Professional 3D Asset Pipeline (Phase 1)

Goal: make every drill look like a professional football simulation, **without**
changing the JSON drill engine, the JSON structure, the coaching logic, the UI, or
the Unity↔Familista bridge. Only the visual layer is upgraded.

## What is built here (all additive, in `Assets/Familista/Pipeline` + `Editor`)
| Requirement | How it is delivered |
|---|---|
| High-quality humanoid players | You import a licensed Humanoid model; the wizard builds the prefab + **LODGroup** |
| Modern PBR materials | `FamilistaPipeline` builds Standard/PBR materials (albedo + normal + AO) in **Linear** colour space |
| Stadium lighting | `StadiumRig`: HDRI skybox + ambient, key sun (soft shadows), 4 floodlights, reflection probe, fog |
| Realistic grass | Vendored **CC0 Poly Haven** grass PBR set → tiling `PitchMat` (albedo/normal/AO) |
| Professional football | PBR `BallMat` (the ball motion/spin stays in the unchanged engine) |
| Goal nets | `GoalNetBuilder`: procedural posts + crossbar + transparent net at both goals |
| Shadows | Soft shadows, tuned shadow distance/resolution |
| Broadcast / Tactical / Replay cameras | `CameraDirector` modes broadcast/tactical/top/side/focus **+ replay orbit** |
| Smooth animations | Animator blend-tree + crossfaded action states (from the wizard) |
| High-quality ball physics | Engine ball arc/spin (unchanged) + PBR ball material |
| LOD support | `LODGroup` configured on the player prefab by the wizard |
| WebGL optimization | Brotli, wasm, Linear colour, texture compression, code stripping (wizard) |

## Vendored CC0 assets (already in the project — no account needed)
- `Assets/Familista/Textures/Grass/leafy_grass_{diff,nor_gl,rough,ao}_1k.jpg` — Poly Haven, **CC0**
- `Assets/Familista/Textures/HDRI/autumn_field_puresky_1k.hdr` — Poly Haven, **CC0**

## Asset sources — research & recommendation
Nothing copyrighted is shipped. Recommended legal sources, by category:

**Players (humanoid, licensed — pick ONE):**
- **Reallusion Character Creator 4 + ActorCore** — best quality/control; realistic
  footballers, Humanoid-ready, huge motion library. Paid (Reallusion licence). *Recommended primary.*
- **Ready Player Me** — free/commercial full-body avatars (glTF), fast, decent realism,
  good for quick many-player variety. Developer licence.
- **Unity Asset Store** — search "soccer player / football player" (Standard licence). Fast drop-in.
- **Mixamo character** — free with an Adobe account; realistic humans, native to Mixamo clips (fallback).

**General locomotion animation:** **Mixamo** (free, Adobe account) — Idle, Jog, Sprint,
Turns, Strafe, Run Start/Stop. Retarget via Humanoid.

**Football-specific motion capture:** **DeepMotion Animate 3D** (paid SaaS, video→FBX) —
Short/Long pass, First touch, Receive, Shoot, Press, Recovery, GK reaction.
*Newer alternatives worth evaluating:* **Move.ai** and **Rokoko Video** (markerless mocap,
often cleaner output than DeepMotion for sports actions).

**Environment / lighting / grass / textures:** **Poly Haven** (CC0 — HDRIs, PBR ground
textures; used here) and **ambientCG** (CC0, huge PBR texture library). *Recommended free.*

**Props / low-poly fallback:** **Kenney** (CC0) — cones, flags, simple props when a
stylised look is wanted. Not used for players.

**Optional pro upgrades:** switch the render pipeline to **URP** for better mobile/WebGL
lighting + the vendored roughness map; add **Unity Terrain grass / GPU instanced grass**
only if the FPS budget allows (heavy for WebGL — a tiling PBR pitch is the safe default).

## Run order (in Unity)
1. Import the licensed character + Mixamo/DeepMotion clips (see `Data/IMPORT-CHECKLIST.md`).
2. Select the character → **Familista → Setup All** (now also runs the asset pipeline:
   PBR materials from the vendored grass/HDRI, LOD, Linear colour, WebGL settings).
3. Press **Play** — `StadiumRig` adds the HDRI sky, floodlights, reflection probe and goal nets.
4. **Build → WebGL**, copy into Familista `public/unity/`.

The drill engine, JSON contract, coaching logic and bridge are untouched.
