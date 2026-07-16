// JavaScript <-> Unity bridge. Familista calls these methods with
//   unityInstance.SendMessage("FamilistaEngine", "<method>", "<arg>");
// Unity calls back to JS via the FamilistaBridge.jslib plugin
//   (window.FamilistaUnity.onEvent(type, payload)).
using System.Runtime.InteropServices;
using UnityEngine;

namespace Familista.Drill3D
{
    public class WebBridge : MonoBehaviour
    {
        public DrillEngine engine;

#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")] static extern void FamilistaBridge_Emit(string type, string payload);
#endif

        public void Emit(string type, string payload)
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            try { FamilistaBridge_Emit(type, payload); } catch { }
#else
            Debug.Log("[FamilistaBridge] " + type + ": " + payload);
#endif
        }

        // ===== inbound calls from Familista (SendMessage) =====
        public void LoadDrill(string json) { if (engine) engine.LoadJson(json); }
        public void Play() { if (engine) engine.Play(); }
        public void Pause() { if (engine) engine.Pause(); }
        public void NextStep() { if (engine) engine.NextStep(); }
        public void PrevStep() { if (engine) engine.PrevStep(); }
        public void GotoStep(string index) { int i; if (engine && int.TryParse(index, out i)) engine.GotoStep(i); }
        public void Replay() { if (engine) engine.Replay(); }
        public void SetCamera(string mode) { if (engine) engine.SetCamera(mode); }
        public void SetQuality(string q) { QualityManager.Set(q); }
        public void Unload() { if (engine) engine.Unload(); }
    }
}
