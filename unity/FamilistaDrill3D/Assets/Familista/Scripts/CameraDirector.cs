// Smooth, restrained camera system (broadcast / tactical / top / side / focus).
// Drives a single Camera by easing its position, look-target and FOV toward the
// active preset each frame. Kept dependency-free (plain Camera) so the project
// compiles and builds out-of-the-box; can be swapped to Cinemachine VCams later
// (com.unity.cinemachine is included in the manifest) without touching callers.
using UnityEngine;

namespace Familista.Drill3D
{
    public class CameraDirector : MonoBehaviour
    {
        public static readonly string[] Modes = { "broadcast", "tactical", "top", "side", "focus", "replay" };

        Camera cam;
        string mode = "broadcast";
        Vector3 vpos, vtgt;
        float vfov = 42f;
        Vector3 focus = Vector3.zero;

        public void Bind(Camera c)
        {
            cam = c;
            vpos = c.transform.position;
            vtgt = Vector3.zero;
            vfov = c.fieldOfView;
        }

        public void SetMode(string m) { if (!string.IsNullOrEmpty(m)) mode = m; }
        public string Mode { get { return mode; } }
        public string Cycle()
        {
            int i = System.Array.IndexOf(Modes, mode);
            mode = Modes[(i + 1) % Modes.Length];
            return mode;
        }
        public void SetFocus(Vector3 f) { focus = f; }

        void Preset(string m, out Vector3 p, out Vector3 t, out float f)
        {
            float fx = focus.x, fz = focus.z;
            switch (m)
            {
                case "tactical": p = new Vector3(0, 58, -40); t = new Vector3(0, 0, 4); f = 48; break;
                case "top": p = new Vector3(0, 82, 0.2f); t = Vector3.zero; f = 48; break;
                case "side": p = new Vector3(0, 15, -54); t = new Vector3(0, 1.2f, 0); f = 46; break;
                case "focus": p = new Vector3(fx - 3, 13, fz - 20); t = new Vector3(fx, 1.2f, fz); f = 34; break;
                case "replay": { float a = Time.time * 0.3f; p = new Vector3(fx + Mathf.Cos(a) * 26f, 10f, fz + Mathf.Sin(a) * 26f); t = new Vector3(fx, 1.1f, fz); f = 33; break; } // slow broadcast-replay orbit
                default: p = new Vector3(fx * 0.4f - 4, 24, -50); t = new Vector3(fx * 0.55f, 1.2f, fz * 0.5f); f = 42; break; // broadcast
            }
        }

        void LateUpdate()
        {
            if (cam == null) return;
            Vector3 p, t; float f;
            Preset(mode, out p, out t, out f);
            vpos = Vector3.Lerp(vpos, p, 0.06f);
            vtgt = Vector3.Lerp(vtgt, t, 0.06f);
            vfov = Mathf.Lerp(vfov, f, 0.08f);
            cam.transform.position = vpos;
            cam.transform.LookAt(vtgt);
            cam.fieldOfView = vfov;
        }
    }
}
