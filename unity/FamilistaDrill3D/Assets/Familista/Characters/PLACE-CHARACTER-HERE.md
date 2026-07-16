# Character slot

Import ONE licensed Humanoid football player model here (FBX/GLB), then set its
**Rig → Animation Type = Humanoid** in the model importer (Inspector → Rig → Apply).

Suggested legal sources (bring your own licence — nothing copyrighted is shipped):
- Reallusion **Character Creator 4 / ActorCore** export (Reallusion licence)
- A realistic footballer from the **Unity Asset Store** (Standard licence)
- A **Mixamo** character (free with an Adobe account) as a fallback

After importing, **select the model** in the Project window and run
**Familista → Setup All**. The wizard reads the selection, builds the
`FamilistaPlayer` prefab and binds the Animator Controller.

This folder is git-ignored so licensed binaries never enter version control.
