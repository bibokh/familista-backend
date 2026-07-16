// Parses the familista.drill.v1 JSON into the runtime Drill model, and maps pitch
// coordinates (x 0..105, z 0..68; attacking +x) into Unity world space (centre
// origin, Y up). Uses Newtonsoft (com.unity.nuget.newtonsoft-json) so nested /
// jagged arrays (waypoints: [[x,z]]) and nullable numbers parse robustly.
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace Familista.Drill3D
{
    public static class DrillImporter
    {
        static Vector2 V2(JToken t)
        {
            if (t == null || t.Type != JTokenType.Array) return Vector2.zero;
            var a = (JArray)t;
            return new Vector2((float)a[0], (float)a[1]);
        }

        public static Drill Parse(string json)
        {
            var root = JObject.Parse(json);
            var d = new Drill
            {
                schema = (string)root["schema"],
                drill = (string)root["drill"],
                name = (string)root["name"],
                totalSteps = (int?)root["totalSteps"] ?? 0
            };

            foreach (var r in (JArray)root["roster"])
                d.roster.Add(new RosterEntry
                {
                    uuid = (string)r["uuid"],
                    number = (int?)r["number"],
                    team = (string)r["team"],
                    position = (string)r["position"]
                });

            foreach (var s in (JArray)root["steps"])
            {
                var st = new DrillStep
                {
                    index = (int)s["index"],
                    key = (string)s["key"],
                    title = (string)s["title"],
                    cameraMode = (string)s["cameraMode"],
                    durationSec = (float)s["durationSec"],
                    coachingNote = (string)s["coachingNote"],
                    freeze = (bool?)s["freeze"] ?? false
                };
                var b = s["ball"];
                st.ball = new BallStep
                {
                    owner = (string)b["owner"],
                    passTarget = (string)b["passTarget"],
                    start = V2(b["start"]),
                    target = V2(b["target"]),
                    trajectory = (string)b["trajectory"]
                };
                foreach (var p in (JArray)s["players"])
                {
                    var ps = new PlayerStep
                    {
                        uuid = (string)p["uuid"],
                        number = (int?)p["number"],
                        team = (string)p["team"],
                        start = V2(p["start"]),
                        target = V2(p["target"]),
                        speedMps = (float)p["speedMps"],
                        animState = (string)p["animState"],
                        bodyDirDeg = (float)p["bodyDirDeg"]
                    };
                    var wps = p["waypoints"] as JArray;
                    if (wps != null) foreach (var w in wps) ps.waypoints.Add(V2(w));
                    st.players.Add(ps);
                }
                d.steps.Add(st);
            }
            return d;
        }

        // pitch (x 0..105, z 0..68) -> Unity world (centre origin, +X attacking)
        public static Vector3 ToWorld(Vector2 p, float y = 0f)
        {
            return new Vector3(p.x - 52.5f, y, p.y - 34f);
        }
    }
}
