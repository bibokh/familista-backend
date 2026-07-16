// Standalone test loader: fetches a drill from StreamingAssets so the scene runs
// on its own (Editor + WebGL) when Familista has not yet pushed a drill over the
// bridge. In production Familista calls WebBridge.LoadDrill(json) instead.
using System.Collections;
using UnityEngine;
using UnityEngine.Networking;

namespace Familista.Drill3D
{
    public class SampleLoader : MonoBehaviour
    {
        public DrillEngine engine;
        public string streamingPath = "Drills/transition.json";
        public float graceSeconds = 0.75f; // give the JS bridge a moment to load a drill first

        IEnumerator Start()
        {
            yield return new WaitForSeconds(graceSeconds);
            if (engine == null || engine.HasDrill) yield break; // bridge already loaded one

            string url = System.IO.Path.Combine(Application.streamingAssetsPath, streamingPath);
            // WebGL / Android need UnityWebRequest for streamingAssets
            using (var req = UnityWebRequest.Get(url))
            {
                yield return req.SendWebRequest();
#if UNITY_2020_1_OR_NEWER
                bool ok = req.result == UnityWebRequest.Result.Success;
#else
                bool ok = !req.isNetworkError && !req.isHttpError;
#endif
                if (ok && engine != null && !engine.HasDrill)
                {
                    engine.LoadJson(req.downloadHandler.text);
                    engine.Play();
                }
                else if (!ok)
                {
                    Debug.Log("[Familista] No StreamingAssets sample loaded (" + url + "). Familista will push the drill via the bridge.");
                }
            }
        }
    }
}
