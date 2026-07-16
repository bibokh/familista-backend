# START HERE — Familista Drill 3D (Unity 6 Web)

Do these 8 steps, in order:

1. **Install Unity 6** (6000.0.x) via Unity Hub, including the **WebGL Build Support** module.
2. **Open this folder** as a project in Unity Hub (it resolves packages on first open).
3. **Import** your licensed character + animation files:
   - character → `Assets/Familista/Characters/` (set Rig = **Humanoid**)
   - animations → `Assets/Familista/Animations/` (Rig = **Humanoid**)
   - full list: `Assets/Familista/Data/IMPORT-CHECKLIST.md`
4. **Select the character** in the Project window.
5. Run the menu **Familista → Setup All** (builds materials, Animator Controller,
   `FamilistaPlayer` prefab, pitch, and WebGL settings; then tells you what's missing).
6. Press **Play** — the "Transition to Attack" drill runs (loaded from StreamingAssets).
7. **File → Build → WebGL** (Brotli is preset by the wizard).
8. **Copy the build** output into Familista at `public/unity/` so the app can lazy-load it.

That's it. Familista sends the drill JSON (`window.FamilistaDrill.get("transition")`)
to the running build via `window.FamilistaUnity.load(...)`.
