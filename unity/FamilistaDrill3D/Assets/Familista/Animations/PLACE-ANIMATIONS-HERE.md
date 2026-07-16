# Animation slots

Import the animation clips here as FBX with **Rig → Animation Type = Humanoid** so
they retarget onto the shared avatar. Name them so the wizard can auto-bind them
(the setup searches by these name fragments). The generated Animator Controller is
`PlayerAnimator.controller` in this folder.

## Locomotion (Mixamo — free with an Adobe account)
| Slot          | Import a clip named like        |
|---------------|---------------------------------|
| Idle          | `Soccer Idle` / `Idle`          |
| Jog           | `Jog Forward`                   |
| Sprint        | `Fast Run` / `Sprint`           |
| Turn Left     | `Standing Turn Left 90`         |
| Turn Right    | `Standing Turn Right 90`        |
| Defensive Shuffle | `Strafe` / `Defensive Shuffle` |
| Accelerate    | `Run Start`                     |
| Decelerate    | `Run To Stop`                   |

## Football-specific (DeepMotion Animate 3D — paid SaaS, from reference video)
| Slot                | Import a clip named like       |
|---------------------|--------------------------------|
| Short Pass          | `Short Pass`                   |
| Long Pass           | `Long Pass`                    |
| First Touch         | `First Touch`                  |
| Receive             | `Receive`                      |
| Shoot               | `Shoot`                        |
| Press               | `Press`                        |
| Recovery Run        | `Recovery Run` / `Recovery`    |
| Goalkeeper Reaction | `Goalkeeper Reaction` / `Dive` |

After importing, run **Familista → Setup All** (or **Familista → Report Missing
Assets** to see exactly which clips are still unbound). Any clip the auto-bind
misses can be dragged onto its state in `PlayerAnimator.controller`.
