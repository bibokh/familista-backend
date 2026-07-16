// ============================================================================
//  Familista Asset Pipeline (editor)
//  Builds the PBR visual layer from the vendored CC0 textures/HDRI:
//   - configures texture import settings (normal map, linear masks, HDRI)
//   - PitchMat (grass: albedo + normal + AO, tiled), StadiumSky (HDRI skybox),
//     BallMat, and PBR kit materials
//   - sets Linear colour space
//   - adds a LODGroup to the player prefab
//  Runs from  Familista > Build Asset Pipeline  and is also called by Setup All.
//  Additive only — does not touch the drill engine, JSON or bridge.
// ============================================================================
#if UNITY_EDITOR
using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace Familista.Drill3D
{
    public static class FamilistaPipeline
    {
        const string ROOT = "Assets/Familista";
        const string RES = ROOT + "/Resources";
        const string TEX = ROOT + "/Textures";
        const string GRASS = TEX + "/Grass/leafy_grass_";
        const string HDRI = TEX + "/HDRI/autumn_field_puresky_1k.hdr";
        const string PLAYER_PREFAB = RES + "/FamilistaPlayer.prefab";

        [MenuItem("Familista/Build Asset Pipeline", false, 1)]
        public static void BuildMenu() { var sb = new StringBuilder(); BuildPipeline(sb); AssetDatabase.SaveAssets(); AssetDatabase.Refresh(); Debug.Log(sb.ToString()); EditorUtility.DisplayDialog("Familista Asset Pipeline", sb.ToString(), "OK"); }

        public static void BuildPipeline(StringBuilder report)
        {
            if (!Directory.Exists(RES)) Directory.CreateDirectory(RES);
            PlayerSettings.colorSpace = ColorSpace.Linear;
            ConfigureTextures(report);
            BuildPitchMaterial(report);
            BuildSkybox(report);
            BuildBallMaterial(report);
            EnhanceKits(report);
            AddPlayerLOD(report);
            if (report != null) report.AppendLine("- Colour space: Linear (better PBR).");
        }

        static void ConfigureTextures(StringBuilder report)
        {
            SetTex(GRASS + "diff_1k.jpg", false, TextureImporterType.Default);
            SetTex(GRASS + "nor_gl_1k.jpg", true, TextureImporterType.NormalMap);
            SetTex(GRASS + "rough_1k.jpg", true, TextureImporterType.Default);
            SetTex(GRASS + "ao_1k.jpg", true, TextureImporterType.Default);
            var hi = AssetImporter.GetAtPath(HDRI) as TextureImporter;
            if (hi != null) { hi.textureShape = TextureImporterShape.Texture2D; hi.sRGBTexture = false; hi.mipmapEnabled = false; hi.SaveAndReimport(); }
            if (report != null) report.AppendLine("- Textures: grass (albedo/normal/AO) + HDRI import settings applied.");
        }
        static void SetTex(string path, bool linear, TextureImporterType type)
        {
            var ti = AssetImporter.GetAtPath(path) as TextureImporter;
            if (ti == null) return;
            ti.textureType = type;
            ti.sRGBTexture = !linear || type == TextureImporterType.Default && !linear;
            if (type == TextureImporterType.NormalMap) ti.sRGBTexture = false;
            if (linear && type == TextureImporterType.Default) ti.sRGBTexture = false;
            ti.SaveAndReimport();
        }

        static void BuildPitchMaterial(StringBuilder report)
        {
            var m = LoadOrCreate(RES + "/PitchMat.mat");
            var diff = AssetDatabase.LoadAssetAtPath<Texture>(GRASS + "diff_1k.jpg");
            var nor = AssetDatabase.LoadAssetAtPath<Texture>(GRASS + "nor_gl_1k.jpg");
            var ao = AssetDatabase.LoadAssetAtPath<Texture>(GRASS + "ao_1k.jpg");
            var tiling = new Vector2(12, 8); // ~9m grass tile across a 105x68 pitch
            if (diff != null) { m.SetTexture("_MainTex", diff); m.SetTextureScale("_MainTex", tiling); }
            if (nor != null && m.HasProperty("_BumpMap")) { m.EnableKeyword("_NORMALMAP"); m.SetTexture("_BumpMap", nor); m.SetTextureScale("_BumpMap", tiling); if (m.HasProperty("_BumpScale")) m.SetFloat("_BumpScale", 0.8f); }
            if (ao != null && m.HasProperty("_OcclusionMap")) { m.SetTexture("_OcclusionMap", ao); m.SetTextureScale("_OcclusionMap", tiling); }
            if (m.HasProperty("_Glossiness")) m.SetFloat("_Glossiness", 0.18f);
            m.color = new Color(0.55f, 0.75f, 0.5f);
            EditorUtility.SetDirty(m);
            if (report != null) report.AppendLine("- PitchMat: PBR grass (albedo + normal + AO, tiled) built.");
        }

        static void BuildSkybox(StringBuilder report)
        {
            var hdr = AssetDatabase.LoadAssetAtPath<Texture>(HDRI);
            var sh = Shader.Find("Skybox/Panoramic");
            if (hdr == null || sh == null) { if (report != null) report.AppendLine("- StadiumSky: skipped (HDRI or Skybox/Panoramic missing)."); return; }
            string path = RES + "/StadiumSky.mat";
            var m = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (m == null) { m = new Material(sh) { name = "StadiumSky" }; AssetDatabase.CreateAsset(m, path); }
            else if (m.shader != sh) m.shader = sh;
            m.SetTexture("_MainTex", hdr);
            if (m.HasProperty("_Mapping")) m.SetFloat("_Mapping", 1);      // Latitude-Longitude
            if (m.HasProperty("_ImageType")) m.SetFloat("_ImageType", 0);  // 360
            if (m.HasProperty("_Exposure")) m.SetFloat("_Exposure", 1.05f);
            EditorUtility.SetDirty(m);
            if (report != null) report.AppendLine("- StadiumSky: HDRI skybox material built (used for sky + ambient + reflections).");
        }

        static void BuildBallMaterial(StringBuilder report)
        {
            var m = LoadOrCreate(RES + "/BallMat.mat");
            m.color = Color.white;
            if (m.HasProperty("_Glossiness")) m.SetFloat("_Glossiness", 0.55f);
            if (m.HasProperty("_Metallic")) m.SetFloat("_Metallic", 0f);
            EditorUtility.SetDirty(m);
            if (report != null) report.AppendLine("- BallMat: PBR football material built.");
        }

        static void EnhanceKits(StringBuilder report)
        {
            foreach (var name in new[] { "KitBlue", "KitRed", "KitGK" })
            {
                var m = AssetDatabase.LoadAssetAtPath<Material>(RES + "/" + name + ".mat");
                if (m == null) continue;
                if (m.HasProperty("_Glossiness")) m.SetFloat("_Glossiness", 0.25f);
                if (m.HasProperty("_Metallic")) m.SetFloat("_Metallic", 0f);
                EditorUtility.SetDirty(m);
            }
            if (report != null) report.AppendLine("- Kits: PBR smoothness tuned (run Setup All first if kits are missing).");
        }

        static void AddPlayerLOD(StringBuilder report)
        {
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(PLAYER_PREFAB);
            if (prefab == null) { if (report != null) report.AppendLine("- LOD: player prefab not found yet (run Setup All after importing the character)."); return; }
            var root = PrefabUtility.LoadPrefabContents(PLAYER_PREFAB);
            var group = root.GetComponent<LODGroup>();
            if (group == null) group = root.AddComponent<LODGroup>();
            var rends = root.GetComponentsInChildren<Renderer>();
            var lods = new LOD[] {
                new LOD(0.20f, rends),   // LOD0: full detail
                new LOD(0.02f, rends),   // LOD1: same meshes (replace with decimated LODs if your model ships them)
            };
            group.SetLODs(lods);
            group.RecalculateBounds();
            PrefabUtility.SaveAsPrefabAsset(root, PLAYER_PREFAB);
            PrefabUtility.UnloadPrefabContents(root);
            if (report != null) report.AppendLine("- LOD: LODGroup added to the player prefab (assign decimated LOD meshes if available).");
        }

        static Material LoadOrCreate(string path)
        {
            var m = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (m == null)
            {
                var sh = Shader.Find("Standard");
                if (sh == null) sh = Shader.Find("Universal Render Pipeline/Lit");
                m = new Material(sh);
                AssetDatabase.CreateAsset(m, path);
            }
            return m;
        }
    }
}
#endif
