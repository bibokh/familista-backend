// The one data-driven engine that renders EVERY drill from the JSON contract.
// Spawns players from the shared FamilistaPlayer prefab (the imported licensed
// character), applies team kits + shirt numbers, drives the timeline (play/pause/
// step/replay), moves the ball, and selects the camera per step. No drill is
// hardcoded — everything comes from the JSON Familista sends.
using System.Collections.Generic;
using UnityEngine;

namespace Familista.Drill3D
{
    public class DrillEngine : MonoBehaviour
    {
        public GameObject playerPrefab;   // Resources/FamilistaPlayer (assigned by Bootstrap)
        public CameraDirector cameraDirector;
        public WebBridge bridge;

        Drill drill;
        int step = 0;
        float t = 0f, total = 0f;
        bool playing = false;
        float playbackSpeed = 1f;
        float[] bounds;
        Material matBlue, matRed, matGK, matPitch;

        readonly List<GameObject> spawned = new List<GameObject>();
        readonly Dictionary<string, PlayerController> byUuid = new Dictionary<string, PlayerController>();
        BallController ball;
        GameObject pitch;

        public bool HasDrill { get { return drill != null; } }

        static readonly Color BLUE = new Color(0.22f, 0.47f, 0.88f);
        static readonly Color RED = new Color(0.84f, 0.26f, 0.26f);
        static readonly Color GK = new Color(0.96f, 0.75f, 0.31f);

        public void LoadJson(string json)
        {
            try { Load(DrillImporter.Parse(json)); }
            catch (System.Exception e)
            {
                Debug.LogError("[DrillEngine] JSON parse failed: " + e.Message);
                if (bridge) bridge.Emit("error", "{\"message\":\"parse failed\"}");
            }
        }

        public void Load(Drill d)
        {
            Clear();
            drill = d;
            // Optional wizard-created materials (Familista > Setup All). Falls back to flat colours.
            if (matBlue == null) matBlue = Resources.Load<Material>("KitBlue");
            if (matRed == null) matRed = Resources.Load<Material>("KitRed");
            if (matGK == null) matGK = Resources.Load<Material>("KitGK");
            if (matPitch == null) matPitch = Resources.Load<Material>("PitchMat");
            if (pitch == null) BuildPitch();
            if (ball == null) BuildBall();

            for (int i = 0; i < d.roster.Count; i++)
            {
                var r = d.roster[i];
                GameObject go;
                if (playerPrefab != null) go = Instantiate(playerPrefab);
                else { go = new GameObject(); Debug.LogWarning("[DrillEngine] No 'FamilistaPlayer' prefab in Resources. Import a licensed character and run Familista > Setup All. (No primitive placeholder is created.)"); }
                go.name = "Player_" + (r.number.HasValue ? r.number.Value.ToString() : r.position) + "_" + r.team;
                go.transform.position = Vector3.zero; // real per-step positions are applied by ApplyStep below

                var pc = go.GetComponent<PlayerController>();
                if (pc == null) pc = go.AddComponent<PlayerController>();
                pc.Bind(go.GetComponentInChildren<Animator>());
                pc.uuid = r.uuid; pc.team = r.team;

                ApplyKit(go, r.team);
                AddNumber(go, r.number);

                spawned.Add(go);
                byUuid[r.uuid] = pc;
            }

            bounds = new float[d.steps.Count + 1];
            float acc = 0f;
            for (int i = 0; i < d.steps.Count; i++) { bounds[i] = acc; acc += Mathf.Max(0.1f, d.steps[i].durationSec); }
            bounds[d.steps.Count] = acc; total = acc;

            step = 0; t = 0f; playing = false;
            ApplyStep(0);
            Emit();
        }

        void BuildPitch()
        {
            pitch = GameObject.CreatePrimitive(PrimitiveType.Plane);
            pitch.name = "Pitch";
            pitch.transform.localScale = new Vector3(10.5f, 1f, 6.8f); // Unity plane is 10x10 => 105 x 68
            var mr = pitch.GetComponent<Renderer>();
            if (matPitch != null) mr.sharedMaterial = matPitch;
            else mr.material.color = new Color(0.13f, 0.5f, 0.24f);
        }

        void BuildBall()
        {
            var bg = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            bg.name = "Ball";
            bg.transform.localScale = Vector3.one * 0.34f;
            var col = bg.GetComponent<Collider>(); if (col) Destroy(col);
            bg.GetComponent<Renderer>().material.color = Color.white;
            ball = bg.AddComponent<BallController>();
        }

        void ApplyKit(GameObject go, string team)
        {
            Material kit = team == "def" ? matRed : team == "gk" ? matGK : matBlue;
            Color c = team == "def" ? RED : team == "gk" ? GK : BLUE;
            foreach (var rend in go.GetComponentsInChildren<Renderer>())
            {
                if (rend.GetComponent<TextMesh>() != null) continue;
                if (kit != null) { rend.sharedMaterial = kit; continue; }
                foreach (var m in rend.materials)
                {
                    if (m.HasProperty("_BaseColor")) m.SetColor("_BaseColor", c);
                    if (m.HasProperty("_Color")) m.color = c;
                }
            }
        }

        void AddNumber(GameObject go, int? num)
        {
            if (!num.HasValue) return;
            var t = new GameObject("Number");
            t.transform.SetParent(go.transform, false);
            t.transform.localPosition = new Vector3(0, 2.2f, 0);
            var tm = t.AddComponent<TextMesh>();
            tm.text = num.Value.ToString();
            tm.fontSize = 72;
            tm.characterSize = 0.06f;
            tm.anchor = TextAnchor.MiddleCenter;
            tm.alignment = TextAlignment.Center;
            tm.color = Color.white;
            var font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            if (font != null) { tm.font = font; t.GetComponent<MeshRenderer>().sharedMaterial = font.material; }
            t.AddComponent<Billboard>();
        }

        void ApplyStep(int s)
        {
            if (drill == null || s < 0 || s >= drill.steps.Count) return;
            var st = drill.steps[s];
            foreach (var ps in st.players)
                if (byUuid.TryGetValue(ps.uuid, out var pc)) pc.ApplyStep(ps, st.durationSec, st.freeze);
            if (ball != null) ball.ApplyStep(st.ball, st.durationSec, st.freeze);
            if (cameraDirector != null)
            {
                cameraDirector.SetMode(st.cameraMode);
                cameraDirector.SetFocus(DrillImporter.ToWorld(st.ball.start));
            }
        }

        void Update()
        {
            if (drill == null) return;
            if (playing)
            {
                t += Time.deltaTime * playbackSpeed;
                if (t >= total) { t = total - 0.001f; playing = false; Emit(); }
            }
            int s = StepAt();
            if (s != step) { step = s; ApplyStep(s); Emit(); }

            var st = drill.steps[step];
            float local = Frac(step);
            foreach (var ps in st.players)
                if (byUuid.TryGetValue(ps.uuid, out var pc)) pc.Tick(local, st.freeze);
            if (ball != null) ball.Tick(local, st.freeze);
            if (cameraDirector != null && ball != null) cameraDirector.SetFocus(ball.transform.position);
        }

        int StepAt()
        {
            float tt = Mathf.Clamp(t, 0, total);
            for (int i = drill.steps.Count - 1; i >= 0; i--) if (tt >= bounds[i]) return i;
            return 0;
        }
        float Frac(int s) { float d = Mathf.Max(0.1f, drill.steps[s].durationSec); return Mathf.Clamp01((t - bounds[s]) / d); }

        public void Play() { if (drill == null) return; if (t >= total - 0.01f) t = 0f; playing = true; Emit(); }
        public void Pause() { playing = false; Emit(); }
        public void NextStep() { GotoStep(step + 1); }
        public void PrevStep() { GotoStep(step - 1); }
        public void Replay() { t = 0f; playing = true; Emit(); }
        public void GotoStep(int i)
        {
            if (drill == null) return;
            i = Mathf.Clamp(i, 0, drill.steps.Count - 1);
            step = i; t = bounds[i] + 0.001f; playing = false;
            ApplyStep(i); Emit();
        }
        public void SetCamera(string mode) { if (cameraDirector != null) cameraDirector.SetMode(mode); Emit(); }
        public void SetSpeed(float s) { playbackSpeed = Mathf.Clamp(s, 0.1f, 4f); }

        public void Unload()
        {
            playing = false;
            Clear();
            if (ball) { Destroy(ball.gameObject); ball = null; }
            if (pitch) { Destroy(pitch); pitch = null; }
            drill = null;
        }

        void Clear()
        {
            foreach (var g in spawned) if (g) Destroy(g);
            spawned.Clear();
            byUuid.Clear();
        }

        void Emit()
        {
            if (bridge == null || drill == null) return;
            var st = drill.steps[Mathf.Clamp(step, 0, drill.steps.Count - 1)];
            bridge.Emit("step",
                "{\"index\":" + (step + 1) + ",\"total\":" + drill.steps.Count +
                ",\"title\":\"" + Esc(st.title) + "\",\"camera\":\"" + st.cameraMode +
                "\",\"note\":\"" + Esc(st.coachingNote) + "\",\"playing\":" + (playing ? "true" : "false") + "}");
        }
        static string Esc(string s) { return string.IsNullOrEmpty(s) ? "" : s.Replace("\\", "\\\\").Replace("\"", "\\\""); }
    }
}
