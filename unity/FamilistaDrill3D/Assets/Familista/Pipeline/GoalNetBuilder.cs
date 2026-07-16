// Procedural goal: two posts + crossbar + a transparent net (back / top / sides).
// Runtime + additive; a real net texture is generated in code so no asset is needed.
using UnityEngine;

namespace Familista.Drill3D
{
    public static class GoalNetBuilder
    {
        public static void Build(Transform parent, float gx, float inwardDir)
        {
            float w = 3.66f, h = 2.44f, depth = 1.7f * inwardDir;
            var postMat = new Material(Shader.Find("Standard")) { color = Color.white };
            if (postMat.HasProperty("_Glossiness")) postMat.SetFloat("_Glossiness", 0.45f);
            var netMat = NetMaterial();

            var root = new GameObject("Goal");
            root.transform.SetParent(parent);

            Post(root.transform, new Vector3(gx, h * 0.5f, -w), h, postMat);
            Post(root.transform, new Vector3(gx, h * 0.5f, w), h, postMat);
            Bar(root.transform, new Vector3(gx, h, 0), w * 2f, postMat);

            Quad(root.transform, "NetBack", new Vector3(gx + depth, h * 0.5f, 0), new Vector3(0.02f, h, w * 2f), netMat);
            Quad(root.transform, "NetTop", new Vector3(gx + depth * 0.5f, h, 0), new Vector3(Mathf.Abs(depth), 0.02f, w * 2f), netMat);
            Quad(root.transform, "NetSideL", new Vector3(gx + depth * 0.5f, h * 0.5f, -w), new Vector3(Mathf.Abs(depth), h, 0.02f), netMat);
            Quad(root.transform, "NetSideR", new Vector3(gx + depth * 0.5f, h * 0.5f, w), new Vector3(Mathf.Abs(depth), h, 0.02f), netMat);
        }

        static void Post(Transform p, Vector3 pos, float h, Material m)
        {
            var g = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            g.name = "Post"; g.transform.SetParent(p); g.transform.position = pos;
            g.transform.localScale = new Vector3(0.12f, h * 0.5f, 0.12f);
            g.GetComponent<Renderer>().sharedMaterial = m; DestroyCol(g);
        }
        static void Bar(Transform p, Vector3 pos, float len, Material m)
        {
            var g = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            g.name = "Crossbar"; g.transform.SetParent(p); g.transform.position = pos;
            g.transform.rotation = Quaternion.Euler(90, 0, 0);
            g.transform.localScale = new Vector3(0.12f, len * 0.5f, 0.12f);
            g.GetComponent<Renderer>().sharedMaterial = m; DestroyCol(g);
        }
        static void Quad(Transform p, string name, Vector3 center, Vector3 size, Material m)
        {
            var g = GameObject.CreatePrimitive(PrimitiveType.Cube);
            g.name = name; g.transform.SetParent(p); g.transform.position = center; g.transform.localScale = size;
            g.GetComponent<Renderer>().sharedMaterial = m; DestroyCol(g);
        }
        static void DestroyCol(GameObject g) { var c = g.GetComponent<Collider>(); if (c) Object.Destroy(c); }

        static Material NetMaterial()
        {
            var tex = new Texture2D(64, 64, TextureFormat.RGBA32, false);
            var px = new Color32[64 * 64];
            for (int y = 0; y < 64; y++)
                for (int x = 0; x < 64; x++)
                {
                    bool line = (x % 8 == 0) || (y % 8 == 0);
                    px[y * 64 + x] = line ? new Color32(255, 255, 255, 190) : new Color32(255, 255, 255, 0);
                }
            tex.SetPixels32(px); tex.wrapMode = TextureWrapMode.Repeat; tex.Apply();

            var m = new Material(Shader.Find("Standard"));
            m.mainTexture = tex; m.mainTextureScale = new Vector2(8, 6);
            m.SetFloat("_Mode", 3);
            m.SetInt("_SrcBlend", (int)UnityEngine.Rendering.BlendMode.SrcAlpha);
            m.SetInt("_DstBlend", (int)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);
            m.SetInt("_ZWrite", 0);
            m.DisableKeyword("_ALPHATEST_ON");
            m.EnableKeyword("_ALPHABLEND_ON");
            m.renderQueue = 3000;
            m.color = new Color(1, 1, 1, 0.75f);
            return m;
        }
    }
}
