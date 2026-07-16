// Builds the scene at runtime (camera + director, sun + shadows, engine + bridge)
// so the Main scene stays empty and portable. Runs automatically after the scene
// loads in both the Editor and the WebGL build. In the Editor it auto-loads the
// bundled sample drill so pressing Play immediately shows the simulation.
using UnityEngine;

namespace Familista.Drill3D
{
    public static class Bootstrap
    {
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Init()
        {
            // Camera + director
            var camGo = new GameObject("Main Camera");
            camGo.tag = "MainCamera";
            var cam = camGo.AddComponent<Camera>();
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = new Color(0.05f, 0.09f, 0.13f);
            cam.fieldOfView = 42f;
            cam.nearClipPlane = 0.3f;
            cam.farClipPlane = 400f;
            var director = camGo.AddComponent<CameraDirector>();
            director.Bind(cam);

            // Sun + soft shadows
            var sunGo = new GameObject("Sun");
            var sun = sunGo.AddComponent<Light>();
            sun.type = LightType.Directional;
            sun.intensity = 1.3f;
            sun.color = new Color(1f, 0.97f, 0.9f);
            sun.shadows = LightShadows.Soft;
            sunGo.transform.rotation = Quaternion.Euler(50f, -30f, 0f);
            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Flat;
            RenderSettings.ambientLight = new Color(0.42f, 0.46f, 0.5f);

            // Engine + bridge  (GameObject name MUST be "FamilistaEngine" for SendMessage)
            var engGo = new GameObject("FamilistaEngine");
            var engine = engGo.AddComponent<DrillEngine>();
            var bridge = engGo.AddComponent<WebBridge>();
            bridge.engine = engine;
            engine.bridge = bridge;
            engine.cameraDirector = director;
            engine.playerPrefab = Resources.Load<GameObject>("FamilistaPlayer");

            QualityManager.Set("high");

#if UNITY_EDITOR
            var sample = Resources.Load<TextAsset>("sample_transition");
            if (sample != null) { engine.LoadJson(sample.text); engine.Play(); }
            else Debug.Log("[Familista] No sample_transition in Resources.");
#endif
        }
    }
}
