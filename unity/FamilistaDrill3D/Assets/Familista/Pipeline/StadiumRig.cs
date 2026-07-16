// Visual-only stadium rig. Additive: it does NOT touch the drill engine, JSON or
// bridge — it upgrades the scene's lighting/environment and applies the PBR
// materials + goal nets after the (unchanged) engine has built the pitch/ball.
using UnityEngine;
using UnityEngine.Rendering;

namespace Familista.Drill3D
{
    public class StadiumRig : MonoBehaviour
    {
        bool pitchDone, ballDone;
        Material pitchMat, ballMat, sky;

        void Start()
        {
            pitchMat = Resources.Load<Material>("PitchMat");
            ballMat = Resources.Load<Material>("BallMat");
            sky = Resources.Load<Material>("StadiumSky");

            SetupEnvironment();
            BuildFloodlights();
            BuildReflectionProbe();
            BuildGoalNets();
            TuneQuality();
        }

        void SetupEnvironment()
        {
            if (sky != null)
            {
                RenderSettings.skybox = sky;
                RenderSettings.ambientMode = AmbientMode.Skybox;
                RenderSettings.ambientIntensity = 1f;
            }
            else
            {
                RenderSettings.ambientMode = AmbientMode.Trilight;
                RenderSettings.ambientSkyColor = new Color(0.55f, 0.62f, 0.72f);
                RenderSettings.ambientEquatorColor = new Color(0.40f, 0.45f, 0.40f);
                RenderSettings.ambientGroundColor = new Color(0.12f, 0.14f, 0.10f);
            }
            RenderSettings.fog = true;
            RenderSettings.fogMode = FogMode.Linear;
            RenderSettings.fogColor = new Color(0.62f, 0.70f, 0.80f);
            RenderSettings.fogStartDistance = 130f;
            RenderSettings.fogEndDistance = 360f;
            DynamicGI.UpdateEnvironment();

            var sun = GameObject.Find("Sun");
            if (sun != null)
            {
                var l = sun.GetComponent<Light>();
                if (l != null)
                {
                    l.intensity = 1.5f;
                    l.color = new Color(1f, 0.96f, 0.88f);
                    l.shadows = LightShadows.Soft;
                    l.shadowStrength = 0.8f;
                    l.shadowBias = 0.03f;
                    l.shadowNormalBias = 0.4f;
                }
                sun.transform.rotation = Quaternion.Euler(52f, -28f, 0f);
            }
        }

        void BuildFloodlights()
        {
            Vector3[] pos = {
                new Vector3(-60, 46, -42), new Vector3(60, 46, -42),
                new Vector3(-60, 46,  42), new Vector3(60, 46,  42)
            };
            foreach (var p in pos)
            {
                var g = new GameObject("Floodlight");
                g.transform.SetParent(transform);
                g.transform.position = p;
                var l = g.AddComponent<Light>();
                l.type = LightType.Spot;
                l.range = 220f;
                l.spotAngle = 72f;
                l.intensity = 1.0f;
                l.color = new Color(0.95f, 0.97f, 1f);
                l.shadows = LightShadows.None;
                g.transform.LookAt(new Vector3(0, 0, 0));
            }
        }

        void BuildReflectionProbe()
        {
            var g = new GameObject("ReflectionProbe");
            g.transform.SetParent(transform);
            g.transform.position = new Vector3(0, 12, 0);
            var rp = g.AddComponent<ReflectionProbe>();
            rp.mode = ReflectionProbeMode.Realtime;
            rp.refreshMode = ReflectionProbeRefreshMode.ViaScripting;
            rp.resolution = 128;
            rp.size = new Vector3(150, 60, 100);
            rp.RenderProbe();
        }

        void BuildGoalNets()
        {
            GoalNetBuilder.Build(transform, 52.5f, -1f);
            GoalNetBuilder.Build(transform, -52.5f, 1f);
        }

        void TuneQuality()
        {
            QualitySettings.shadowDistance = 150f;
            QualitySettings.shadowResolution = ShadowResolution.High;
            QualitySettings.lodBias = 1.6f;
            QualitySettings.pixelLightCount = 4;
            QualitySettings.anisotropicFiltering = AnisotropicFiltering.Enable;
        }

        void Update()
        {
            if (!pitchDone)
            {
                var p = GameObject.Find("Pitch");
                if (p != null) { var r = p.GetComponent<Renderer>(); if (r != null && pitchMat != null) r.sharedMaterial = pitchMat; pitchDone = true; }
            }
            if (!ballDone)
            {
                var b = GameObject.Find("Ball");
                if (b != null) { var r = b.GetComponent<Renderer>(); if (r != null && ballMat != null) r.sharedMaterial = ballMat; ballDone = true; }
            }
        }
    }
}
