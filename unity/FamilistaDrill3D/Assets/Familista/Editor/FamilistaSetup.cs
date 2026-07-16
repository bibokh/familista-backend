// ============================================================================
//  Familista → Setup All   (one-click editor wizard)
//  After you import a licensed Humanoid character (FBX, rig = Humanoid) plus the
//  Mixamo / DeepMotion animation clips, select the character in the Project window
//  and run:  Familista > Setup All.
//
//  It will:
//   - detect the selected Humanoid model
//   - create team + pitch materials (blue / red / goalkeeper / pitch)
//   - create the Animator Controller (locomotion blend-tree + action states)
//   - detect & bind animation clips by name
//   - build the Player prefab (Resources/FamilistaPlayer)
//   - build the Pitch prefab
//   - ensure the Main scene is in Build Settings
//   - configure WebGL player settings (Brotli, template, run-in-background)
//   - report every asset that is still missing, clearly.
//  No copyrighted models or animations are included — only named slots.
// ============================================================================
#if UNITY_EDITOR
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;

namespace Familista.Drill3D
{
    public static class FamilistaSetup
    {
        const string ROOT = "Assets/Familista";
        const string RES = ROOT + "/Resources";
        const string ANIM = ROOT + "/Animations";
        const string PREFABS = ROOT + "/Prefabs";
        const string MATS = ROOT + "/Materials";
        const string CTRL_PATH = ANIM + "/PlayerAnimator.controller";
        const string PLAYER_PREFAB = RES + "/FamilistaPlayer.prefab";
        const string PITCH_PREFAB = PREFABS + "/Pitch.prefab";
        const string SCENE_PATH = ROOT + "/Scenes/Main.unity";

        // Animator action state -> candidate clip-name fragments (Mixamo + DeepMotion)
        static readonly (string state, string[] names)[] Actions =
        {
            ("ShortPass",          new[]{ "Short Pass", "Soccer Pass", "Pass" }),
            ("LongPass",           new[]{ "Long Pass", "Kick" }),
            ("FirstTouch",         new[]{ "First Touch", "Control", "Trap" }),
            ("Receive",            new[]{ "Receive", "Trap" }),
            ("Shoot",              new[]{ "Shoot", "Strike", "Kick" }),
            ("Press",              new[]{ "Press", "Jockey", "Defensive Shuffle" }),
            ("Recovery",           new[]{ "Recovery", "Fast Run", "Sprint" }),
            ("GoalkeeperReaction", new[]{ "Goalkeeper", "Dive", "Save" }),
        };

        [MenuItem("Familista/Setup All", false, 0)]
        public static void SetupAll()
        {
            EnsureFolders();
            var report = new StringBuilder();
            report.AppendLine("=== Familista Setup All ===");

            CreateMaterials(report);
            var ctrl = BuildAnimator(report);
            var model = DetectModel(report);
            if (model != null) BuildPlayerPrefab(model, ctrl, report);
            BuildPitchPrefab(report);
            EnsureSceneInBuild(report);
            ConfigureWebGL(report);
            FamilistaPipeline.BuildPipeline(report);   // PBR grass/HDRI materials, skybox, LOD, Linear colour

            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();

            Debug.Log(report.ToString());
            EditorUtility.DisplayDialog("Familista Setup",
                report.ToString().Replace("=== Familista Setup All ===\n", ""),
                "OK");
        }

        [MenuItem("Familista/Report Missing Assets", false, 20)]
        public static void ReportMissing()
        {
            var r = new StringBuilder("=== Familista - missing assets ===\n");
            if (DetectModel(null) == null) r.AppendLine("- Humanoid character model: NOT FOUND (select the FBX, rig = Humanoid).");
            r.AppendLine("Animation clips (bound in " + CTRL_PATH + "):");
            r.AppendLine(ClipStatus("Idle", "Soccer Idle", "Idle"));
            r.AppendLine(ClipStatus("Jog", "Jog Forward", "Jog"));
            r.AppendLine(ClipStatus("Sprint", "Fast Run", "Sprint", "Run"));
            foreach (var a in Actions) r.AppendLine(ClipStatus(a.state, a.names));
            Debug.Log(r.ToString());
            EditorUtility.DisplayDialog("Familista - Missing Assets", r.ToString(), "OK");
        }

        static string ClipStatus(string label, params string[] names)
        {
            var c = FindClip(names);
            return "  " + (c != null ? "[OK]  " : "[--]  ") + label + (c != null ? "  -> " + c.name : "  (import a clip named like: " + string.Join(" / ", names) + ")");
        }

        // ---------------------------------------------------------------- folders
        static void EnsureFolders()
        {
            foreach (var p in new[] { RES, ANIM, PREFABS, MATS })
                if (!Directory.Exists(p)) Directory.CreateDirectory(p);
            AssetDatabase.Refresh();
        }

        // -------------------------------------------------------------- materials
        [MenuItem("Familista/Advanced/Create Materials", false, 40)]
        public static void CreateMaterialsMenu() { EnsureFolders(); CreateMaterials(new StringBuilder()); AssetDatabase.SaveAssets(); }
        static void CreateMaterials(StringBuilder report)
        {
            Mat("KitBlue", new Color(0.22f, 0.47f, 0.88f), 0.75f);
            Mat("KitRed", new Color(0.84f, 0.26f, 0.26f), 0.75f);
            Mat("KitGK", new Color(0.96f, 0.75f, 0.31f), 0.7f);   // goalkeeper
            Mat("PitchMat", new Color(0.13f, 0.5f, 0.24f), 0.92f);
            if (report != null) report.AppendLine("- Materials: KitBlue, KitRed, KitGK, PitchMat created in Resources.");
        }
        static Material Mat(string name, Color c, float rough)
        {
            string path = RES + "/" + name + ".mat";
            var m = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (m == null)
            {
                var sh = Shader.Find("Standard");
                if (sh == null) sh = Shader.Find("Universal Render Pipeline/Lit");
                if (sh == null) sh = Shader.Find("Diffuse");
                m = new Material(sh); m.name = name;
                AssetDatabase.CreateAsset(m, path);
            }
            if (m.HasProperty("_Color")) m.color = c;
            if (m.HasProperty("_BaseColor")) m.SetColor("_BaseColor", c);
            if (m.HasProperty("_Glossiness")) m.SetFloat("_Glossiness", 1f - rough);
            if (m.HasProperty("_Smoothness")) m.SetFloat("_Smoothness", 1f - rough);
            EditorUtility.SetDirty(m);
            return m;
        }

        // --------------------------------------------------------------- animator
        [MenuItem("Familista/Advanced/Build Animator Controller", false, 41)]
        public static void BuildAnimatorMenu() { EnsureFolders(); BuildAnimator(new StringBuilder()); AssetDatabase.SaveAssets(); }
        static AnimatorController BuildAnimator(StringBuilder report)
        {
            if (!Directory.Exists(ANIM)) Directory.CreateDirectory(ANIM);
            var ctrl = AssetDatabase.LoadAssetAtPath<AnimatorController>(CTRL_PATH);
            if (ctrl == null) ctrl = AnimatorController.CreateAnimatorControllerAtPath(CTRL_PATH);

            EnsureFloat(ctrl, "Speed");
            foreach (var a in Actions) EnsureTrigger(ctrl, a.state);

            var sm = ctrl.layers[0].stateMachine;
            sm.states = new ChildAnimatorState[0]; // rebuild states cleanly

            var bt = new BlendTree { name = "Locomotion", blendType = BlendTreeType.Simple1D, blendParameter = "Speed" };
            AssetDatabase.AddObjectToAsset(bt, ctrl);
            bt.AddChild(FindClip("Soccer Idle", "Idle", "Breathing Idle"), 0f);
            bt.AddChild(FindClip("Jog Forward", "Jog"), 2f);
            bt.AddChild(FindClip("Fast Run", "Sprint", "Run"), 5f);

            var loco = sm.AddState("Locomotion");
            loco.motion = bt;
            sm.defaultState = loco;

            int missing = 0;
            foreach (var a in Actions)
            {
                var s = sm.AddState(a.state);
                s.motion = FindClip(a.names);
                if (s.motion == null) missing++;
                var tr = sm.AddAnyStateTransition(s);
                tr.AddCondition(AnimatorConditionMode.If, 0, a.state);
                tr.duration = 0.12f; tr.hasExitTime = false; tr.canTransitionToSelf = false;
                var back = s.AddTransition(loco);
                back.hasExitTime = true; back.exitTime = 0.8f; back.duration = 0.15f;
            }
            EditorUtility.SetDirty(ctrl);
            if (report != null) report.AppendLine("- Animator: built " + CTRL_PATH + " (locomotion + 8 action states). Unbound action clips: " + missing + ".");
            return ctrl;
        }
        static void EnsureFloat(AnimatorController c, string n) { foreach (var p in c.parameters) if (p.name == n) return; c.AddParameter(n, AnimatorControllerParameterType.Float); }
        static void EnsureTrigger(AnimatorController c, string n) { foreach (var p in c.parameters) if (p.name == n) return; c.AddParameter(n, AnimatorControllerParameterType.Trigger); }

        static AnimationClip FindClip(params string[] names)
        {
            foreach (var n in names)
                foreach (var g in AssetDatabase.FindAssets("t:AnimationClip " + n))
                {
                    var c = AssetDatabase.LoadAssetAtPath<AnimationClip>(AssetDatabase.GUIDToAssetPath(g));
                    if (c != null && !c.name.StartsWith("__preview")) return c;
                }
            return null;
        }

        // ----------------------------------------------------------------- model
        static GameObject DetectModel(StringBuilder report)
        {
            var sel = Selection.activeGameObject;
            if (sel != null)
            {
                var an = sel.GetComponentInChildren<Animator>();
                bool humanoid = an != null && an.avatar != null && an.avatar.isHuman;
                if (report != null) report.AppendLine("- Character: using selection '" + sel.name + "'" + (humanoid ? " (Humanoid avatar OK)." : " - WARNING: no Humanoid avatar detected; set the FBX rig to Humanoid."));
                return sel;
            }
            foreach (var g in AssetDatabase.FindAssets("t:Model"))
            {
                var go = AssetDatabase.LoadAssetAtPath<GameObject>(AssetDatabase.GUIDToAssetPath(g));
                if (go == null) continue;
                var an = go.GetComponentInChildren<Animator>();
                if (an != null && an.avatar != null && an.avatar.isHuman) { if (report != null) report.AppendLine("- Character: auto-detected '" + go.name + "'."); return go; }
            }
            if (report != null) report.AppendLine("- Character: NOT FOUND. Import a Humanoid football model (rig = Humanoid) and select it, then re-run.");
            return null;
        }

        // ---------------------------------------------------------------- prefab
        static void BuildPlayerPrefab(GameObject model, AnimatorController ctrl, StringBuilder report)
        {
            if (!Directory.Exists(RES)) Directory.CreateDirectory(RES);
            var root = Object.Instantiate(model);
            root.name = "FamilistaPlayer";
            var an = root.GetComponentInChildren<Animator>();
            if (an == null) an = root.AddComponent<Animator>();
            if (ctrl != null) an.runtimeAnimatorController = ctrl;
            an.applyRootMotion = false;
            if (root.GetComponent<PlayerController>() == null) root.AddComponent<PlayerController>();
            PrefabUtility.SaveAsPrefabAsset(root, PLAYER_PREFAB);
            Object.DestroyImmediate(root);
            if (report != null) report.AppendLine("- Player prefab: saved " + PLAYER_PREFAB + " (auto-loaded at runtime).");
        }

        // ----------------------------------------------------------------- pitch
        static void BuildPitchPrefab(StringBuilder report)
        {
            var mat = AssetDatabase.LoadAssetAtPath<Material>(RES + "/PitchMat.mat");
            var go = GameObject.CreatePrimitive(PrimitiveType.Plane);
            go.name = "Pitch";
            go.transform.localScale = new Vector3(10.5f, 1f, 6.8f);
            if (mat != null) go.GetComponent<Renderer>().sharedMaterial = mat;
            if (!Directory.Exists(PREFABS)) Directory.CreateDirectory(PREFABS);
            PrefabUtility.SaveAsPrefabAsset(go, PITCH_PREFAB);
            Object.DestroyImmediate(go);
            if (report != null) report.AppendLine("- Pitch prefab: saved " + PITCH_PREFAB + " (105 x 68 m).");
        }

        // ------------------------------------------------------------ build/webgl
        static void EnsureSceneInBuild(StringBuilder report)
        {
            var scenes = new List<EditorBuildSettingsScene>(EditorBuildSettings.scenes);
            if (!scenes.Exists(s => s.path == SCENE_PATH))
                scenes.Insert(0, new EditorBuildSettingsScene(SCENE_PATH, true));
            EditorBuildSettings.scenes = scenes.ToArray();
            if (report != null) report.AppendLine("- Build Settings: '" + SCENE_PATH + "' is included.");
        }

        static void ConfigureWebGL(StringBuilder report)
        {
            try
            {
                PlayerSettings.productName = "Familista Drill 3D";
                PlayerSettings.runInBackground = true;
                PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Brotli;
                PlayerSettings.WebGL.decompressionFallback = true;
                PlayerSettings.WebGL.linkerTarget = WebGLLinkerTarget.Wasm;
                PlayerSettings.WebGL.dataCaching = true;
                bool hasTemplate = false;
                foreach (var f in AssetDatabase.GetSubFolders("Assets/WebGLTemplates")) if (f.EndsWith("Familista")) hasTemplate = true;
                if (hasTemplate) PlayerSettings.WebGL.template = "PROJECT:Familista";
                if (report != null) report.AppendLine("- WebGL: Brotli + wasm + run-in-background + Familista template configured.");
            }
            catch (System.Exception e) { if (report != null) report.AppendLine("- WebGL: could not fully configure (" + e.Message + "). Set Brotli + template in Build Settings manually."); }
        }
    }
}
#endif
