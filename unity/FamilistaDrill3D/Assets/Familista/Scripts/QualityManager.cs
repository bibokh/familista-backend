// Quality presets Low / Medium / High, driven from the web bridge.
using UnityEngine;

namespace Familista.Drill3D
{
    public static class QualityManager
    {
        public static void Set(string q)
        {
            switch ((q ?? "high").ToLower())
            {
                case "low":
                    QualitySettings.shadows = ShadowQuality.Disable;
                    QualitySettings.pixelLightCount = 1;
                    QualitySettings.antiAliasing = 0;
                    QualitySettings.shadowDistance = 0;
                    break;
                case "medium":
                    QualitySettings.shadows = ShadowQuality.HardOnly;
                    QualitySettings.pixelLightCount = 2;
                    QualitySettings.antiAliasing = 2;
                    QualitySettings.shadowDistance = 60;
                    break;
                default: // high
                    QualitySettings.shadows = ShadowQuality.All;
                    QualitySettings.pixelLightCount = 3;
                    QualitySettings.antiAliasing = 4;
                    QualitySettings.shadowDistance = 120;
                    break;
            }
        }
    }
}
