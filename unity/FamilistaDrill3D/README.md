# Familista Drill 3D — Unity 6 Web project

A complete, data-driven Unity project that renders Familista drills in genuine 3D.
Every C# script, the scene, the JSON importer, the drill engine, the camera system,
the quality manager and the JS↔Unity bridge are generated here. The only steps that
**must** be done in the Unity Editor (because the assets are licensed and account-gated)
are: import the character + animation clips, run one setup menu, then **Build**.

## What is already generated
```
FamilistaDrill3D/
├─ Packages/manifest.json          Newtonsoft JSON, Cinemachine, Addressables, uGUI/TMP
├─ ProjectSettings/                Unity version pin + build scene list
├─ Assets/
│  ├─ Scenes/Main.unity            empty scene; Bootstrap builds everything at runtime
│  ├─ Scripts/
│  │  ├─ DrillModels.cs            runtime model of the familista.drill.v1 contract
│  │  ├─ DrillImporter.cs          JSON -> model + pitch→world mapping
│  │  ├─ DrillEngine.cs            the single data-driven engine (spawns, timeline, ball, camera)
│  │  ├─ PlayerController.cs       per-player movement + Animator params/triggers
│  │  ├─ BallController.cs         independent 3D ball (ground/lofted/dribble)
│  │  ├─ CameraDirector.cs         broadcast/tactical/top/side/focus, smooth blends
│  │  ├─ QualityManager.cs         Low/Medium/High
│  │  ├─ WebBridge.cs              SendMessage entry points + Unity→JS events
│  │  ├─ Billboard.cs, Bootstrap.cs
│  ├─ Editor/FamilistaSetup.cs     one-click Animator + Player-prefab builder
│  ├─ Plugins/WebGL/FamilistaBridge.jslib   Unity→JS event channel
│  └─ Resources/sample_transition.json      real "Transition to Attack" drill for in-editor testing
```

## Remaining manual steps (assets are licensed — cannot be shipped in a repo)
1. **Install Unity 6** (6000.0.x) via Unity Hub, with the **WebGL** build module.
2. **Open this folder** as a project. Unity resolves the packages on first open.
3. **Import a licensed Humanoid character** (Character Creator 4 / ActorCore export,
   or a Unity Asset Store footballer). Set its rig to **Humanoid** in the model importer.
4. **Import animations** into the project (as FBX, rig = Humanoid so they retarget):
   - **Mixamo:** Soccer Idle, Jog Forward, Fast Run, Standing Turn Left 90,
     Standing Turn Right 90, Strafe (defensive shuffle), Run Start, Run To Stop.
   - **DeepMotion Animate 3D:** Short Pass, Long Pass, First Touch, Receive, Shoot,
     Press, Recovery Run, Goalkeeper Reaction.
5. Select the character in the Project window and run menu **Familista → 3. Setup All
   (Animator + Prefab)**. This builds `Assets/Animation/PlayerAnimator.controller`
   (locomotion blend-tree by `Speed` + trigger states for each action, auto-binding
   clips by name) and `Assets/Resources/FamilistaPlayer.prefab` (auto-loaded at runtime).
   Open the controller and assign any clip the name auto-bind missed.
6. **Press Play** in the Editor — Bootstrap auto-loads `sample_transition.json` and runs
   the full 9-step Transition to Attack drill (camera modes, ball, animations).
7. **File → Build Settings → WebGL → Build.** Recommended: Brotli compression,
   IL2CPP + code stripping, ASTC/DXT textures. Put the output in the repo at
   `public/unity/` so Familista can lazy-load `public/unity/Build/*.loader.js`.

## JS ↔ Unity bridge (already wired on both sides)
Familista → Unity (call after the build loads):
```js
unityInstance.SendMessage("FamilistaEngine", "LoadDrill", JSON.stringify(FamilistaDrill.get("transition")));
unityInstance.SendMessage("FamilistaEngine", "Play");        // Pause / NextStep / PrevStep / Replay
unityInstance.SendMessage("FamilistaEngine", "GotoStep", "3");
unityInstance.SendMessage("FamilistaEngine", "SetCamera", "broadcast"); // tactical|top|side|focus
unityInstance.SendMessage("FamilistaEngine", "SetQuality", "high");     // low|medium
unityInstance.SendMessage("FamilistaEngine", "Unload");     // on window close (no leak)
```
Unity → Familista (implement in the page):
```js
window.FamilistaUnity = { onEvent: (type, payload) => { /* type "step" -> {index,total,title,camera,note,playing}; "error" */ } };
```
The drill JSON comes from `window.FamilistaDrill.get(id)` (already live in Familista).
**No squad is hardcoded in Unity** — UUIDs/positions arrive in the JSON.

## Camera / Cinemachine note
`CameraDirector` drives a plain `Camera` with smooth blends so the project compiles
and builds with zero manual fixes. `com.unity.cinemachine` is in the manifest; to use
Cinemachine VCams instead, replace the presets in `CameraDirector` with VCam priorities —
callers (`DrillEngine.SetCamera`) are unchanged.

## Render pipeline note
Ships on the **built-in** pipeline (real directional light + soft shadows + PBR-capable
Standard shaders) so it opens and builds immediately. To switch to URP: install URP,
create a URP asset in `Assets/Settings`, assign it in Project Settings → Graphics, and
upgrade materials (Edit → Rendering → Materials → Convert). `_BaseColor`/`_Color` kit
assignment already supports both.
