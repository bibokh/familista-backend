// One-click editor setup. After you import a licensed Humanoid character (FBX,
// configured as a Humanoid Avatar) plus the Mixamo / DeepMotion clips, run:
//   Familista > 3. Setup All (Animator + Prefab)
// It builds the shared Animator Controller (locomotion blend-tree + action states),
// auto-binds clips by name where it can, then assembles Resources/FamilistaPlayer.prefab.
#if UNITY_EDITOR
using System.IO;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;

namespace Familista.Drill3D
{
    public static class FamilistaSetup
    {
        const string ANIM_DIR = "Assets/Animation";
        const string CTRL_PATH = "Assets/Animation/PlayerAnimator.controller";
        const string PREFAB_PATH = "Assets/Resources/FamilistaPlayer.prefab";

        // action state -> candidate clip name fragments (Mixamo + DeepMotion)
        static readonly (string state, string[] names)[] Actions =
        {
            ("ShortPass", new[]{ "Short Pass", "Soccer Pass", "Pass" }),
            ("LongPass", new[]{ "Long Pass", "Kick", "Pass" }),
            ("FirstTouch", new[]{ "First Touch", "Control", "Trap" }),
            ("Receive", new[]{ "Receive", "Trap", "Control" }),
            ("Shoot", new[]{ "Shoot", "Kick", "Strike" }),
            ("Press", new[]{ "Press", "Defensive", "Jockey" }),
            ("Recovery", new[]{ "Recovery", "Fast Run", "Sprint" }),
            ("GoalkeeperReaction", new[]{ "Goalkeeper", "Dive", "Save" }),
        };

        [MenuItem("Familista/1. Build Animator Controller")]
        public static AnimatorController BuildAnimator()
        {
            if (!Directory.Exists(ANIM_DIR)) Directory.CreateDirectory(ANIM_DIR);
            var ctrl = AnimatorController.CreateAnimatorControllerAtPath(CTRL_PATH);
            ctrl.AddParameter("Speed", AnimatorControllerParameterType.Float);
            foreach (var a in Actions) ctrl.AddParameter(a.state, AnimatorControllerParameterType.Trigger);

            var sm = ctrl.layers[0].stateMachine;

            var bt = new BlendTree { name = "Locomotion", blendType = BlendTreeType.Simple1D, blendParameter = "Speed" };
            AssetDatabase.AddObjectToAsset(bt, ctrl);
            bt.AddChild(FindClip("Soccer Idle", "Idle", "Breathing Idle"), 0f);
            bt.AddChild(FindClip("Jog Forward", "Jog"), 2f);
            bt.AddChild(FindClip("Fast Run", "Sprint", "Run"), 5f);

            var loco = sm.AddState("Locomotion");
            loco.motion = bt;
            sm.defaultState = loco;

            foreach (var a in Actions)
            {
                var s = sm.AddState(a.state);
                s.motion = FindClip(a.names);
                var tr = sm.AddAnyStateTransition(s);
                tr.AddCondition(AnimatorConditionMode.If, 0, a.state);
                tr.duration = 0.12f; tr.hasExitTime = false; tr.canTransitionToSelf = false;
                var back = s.AddTransition(loco);
                back.hasExitTime = true; back.exitTime = 0.8f; back.duration = 0.15f;
            }

            EditorUtility.SetDirty(ctrl);
            AssetDatabase.SaveAssets(); AssetDatabase.Refresh();
            Debug.Log("[Familista] Animator built: " + CTRL_PATH + ". Open it and assign any clips auto-bind couldn't find.");
            return ctrl;
        }

        static AnimationClip FindClip(params string[] names)
        {
            foreach (var n in names)
            {
                foreach (var g in AssetDatabase.FindAssets("t:AnimationClip " + n))
                {
                    var c = AssetDatabase.LoadAssetAtPath<AnimationClip>(AssetDatabase.GUIDToAssetPath(g));
                    if (c != null && !c.name.StartsWith("__preview")) return c;
                }
            }
            return null;
        }

        [MenuItem("Familista/2. Build Player Prefab From Selection")]
        public static void BuildPrefab()
        {
            var model = Selection.activeGameObject;
            if (model == null)
            {
                EditorUtility.DisplayDialog("Familista",
                    "Select your imported Humanoid character (the FBX, configured as a Humanoid Avatar) in the Project or Hierarchy, then run this again.", "OK");
                return;
            }
            var ctrl = AssetDatabase.LoadAssetAtPath<AnimatorController>(CTRL_PATH);
            if (ctrl == null) ctrl = BuildAnimator();

            var root = Object.Instantiate(model);
            root.name = "FamilistaPlayer";
            var an = root.GetComponentInChildren<Animator>();
            if (an == null) an = root.AddComponent<Animator>();
            an.runtimeAnimatorController = ctrl;
            an.applyRootMotion = false;
            if (root.GetComponent<PlayerController>() == null) root.AddComponent<PlayerController>();

            if (!Directory.Exists("Assets/Resources")) Directory.CreateDirectory("Assets/Resources");
            PrefabUtility.SaveAsPrefabAsset(root, PREFAB_PATH);
            Object.DestroyImmediate(root);
            AssetDatabase.SaveAssets(); AssetDatabase.Refresh();
            Debug.Log("[Familista] Player prefab saved: " + PREFAB_PATH + " (auto-loaded at runtime).");
        }

        [MenuItem("Familista/3. Setup All (Animator + Prefab)")]
        public static void SetupAll() { BuildAnimator(); BuildPrefab(); }
    }
}
#endif
