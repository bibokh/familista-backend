// Moves the ball independently of the players: ground pass (ease-out arrival),
// dribble (follows an eased path), lofted (parabolic arc), stationary / reset (hold).
using UnityEngine;

namespace Familista.Drill3D
{
    public class BallController : MonoBehaviour
    {
        Vector3 a, b;
        string traj = "ground";

        public void ApplyStep(BallStep bs, float duration, bool freeze)
        {
            a = DrillImporter.ToWorld(bs.start, 0.11f);
            b = DrillImporter.ToWorld(bs.target, 0.11f);
            traj = bs.trajectory;
            if (freeze) transform.position = a;
        }

        public void Tick(float local, bool freeze)
        {
            float u = freeze ? 0f : local;
            if (traj == "stationary" || traj == "reset") { transform.position = a; return; }
            float e = traj == "dribble" ? Smooth(u) : Out(u);
            Vector3 p = Vector3.Lerp(a, b, e);
            if (traj == "lofted") p.y += 4.5f * Mathf.Sin(Mathf.PI * e);
            transform.position = p;
            transform.Rotate(Vector3.right, 540f * Time.deltaTime, Space.World);
        }

        static float Smooth(float u) { u = Mathf.Clamp01(u); return u * u * (3 - 2 * u); }
        static float Out(float u) { u = Mathf.Clamp01(u); return 1 - (1 - u) * (1 - u); }
    }
}
