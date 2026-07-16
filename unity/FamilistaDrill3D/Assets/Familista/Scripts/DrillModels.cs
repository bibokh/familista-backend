// Familista Drill 3D — runtime data model (populated by DrillImporter from the
// familista.drill.v1 JSON contract that Familista sends over the JS<->Unity bridge).
using System.Collections.Generic;
using UnityEngine;

namespace Familista.Drill3D
{
    public class Drill
    {
        public string schema;
        public string drill;
        public string name;
        public int totalSteps;
        public List<RosterEntry> roster = new List<RosterEntry>();
        public List<DrillStep> steps = new List<DrillStep>();
    }

    public class RosterEntry
    {
        public string uuid;
        public int? number;
        public string team;      // "att" | "def" | "gk"
        public string position;  // "ATT" | "DEF" | "GK"
    }

    public class DrillStep
    {
        public int index;
        public string key;
        public string title;
        public string cameraMode;   // broadcast | tactical | top | side | focus
        public float durationSec;
        public string coachingNote;
        public bool freeze;
        public BallStep ball;
        public List<PlayerStep> players = new List<PlayerStep>();
    }

    public class BallStep
    {
        public string owner;        // player uuid or null
        public string passTarget;   // player uuid or null
        public Vector2 start;       // pitch metres (x 0..105, z 0..68)
        public Vector2 target;
        public string trajectory;   // ground | lofted | dribble | stationary | reset
    }

    public class PlayerStep
    {
        public string uuid;
        public int? number;
        public string team;
        public Vector2 start;
        public Vector2 target;
        public List<Vector2> waypoints = new List<Vector2>();
        public float speedMps;
        public string animState;    // idle|jog|sprint|shortPass|longPass|firstTouch|receive|shoot|press|recovery|goalkeeperReaction
        public float bodyDirDeg;
    }
}
