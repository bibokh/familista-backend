# Import checklist

Nothing copyrighted is shipped. Import the following, then run **Familista → Setup All**.

## 1. Humanoid football player model  (→ Assets/Familista/Characters/)
- [ ] One realistic humanoid footballer (FBX/GLB), Rig = **Humanoid**
      (Character Creator 4 / ActorCore, or a Unity Asset Store footballer, or a Mixamo character)

## 2. Locomotion animations — Mixamo  (→ Assets/Familista/Animations/)
- [ ] Idle            (`Soccer Idle` / `Idle`)
- [ ] Jog             (`Jog Forward`)
- [ ] Sprint          (`Fast Run`)
- [ ] Turn Left       (`Standing Turn Left 90`)
- [ ] Turn Right      (`Standing Turn Right 90`)
- [ ] Defensive Shuffle (`Strafe`)
- [ ] Accelerate      (`Run Start`)
- [ ] Decelerate      (`Run To Stop`)

## 3. Football animations — DeepMotion Animate 3D  (→ Assets/Familista/Animations/)
- [ ] Short Pass
- [ ] Long Pass
- [ ] First Touch
- [ ] Receive
- [ ] Shoot
- [ ] Press
- [ ] Recovery Run
- [ ] Goalkeeper Reaction

## 4. Run the wizard
- [ ] Select the character in the Project window
- [ ] **Familista → Setup All**  (materials, animator, prefab, pitch, WebGL settings)
- [ ] **Familista → Report Missing Assets** to confirm nothing is unbound
- [ ] Press **Play** — the sample "Transition to Attack" drill runs from StreamingAssets
- [ ] **File → Build → WebGL**, then copy the build into `public/unity/` of Familista
