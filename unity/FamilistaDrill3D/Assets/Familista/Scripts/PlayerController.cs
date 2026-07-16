// Drives one player each step: eased/curved movement along start->waypoints->target,
// body orientation from velocity (or bodyDir when stationary), and Animator params
// (Speed for the locomotion blend-tree; a trigger for pass/receive/shoot/press/etc.).
using System.Collections.Generic;
using UnityEngine;

namespace Familista.Drill3D
{
    public class PlayerController : MonoBehaviour
    {
        public string uuid;
        public string team;

        Animator anim;
        PlayerStep cur;
        Vector3 a, b, ctrl;
        bool hasCtrl;
        string lastAction = "";

        static readonly HashSet<string> Actions = new HashSet<string>
        { "shortPass", "longPass", "firstTouch", "receive", "shoot", "press", "recovery", "goalkeeperReaction" };

        public void Bind(Animator a) { anim = a; }

        public void ApplyStep(PlayerStep ps, float duration, bool freeze)
        {
            cur = ps;
            a = DrillImporter.ToWorld(ps.start);
            b = DrillImporter.ToWorld(ps.target);
            hasCtrl = ps.waypoints != null && ps.waypoints.Count > 0;
            if (hasCtrl) ctrl = DrillImporter.ToWorld(ps.waypoints[0]);
            lastAction = "";
            if (freeze) { transform.position = b; SetLocomotion(0f); }
        }

        static float Smooth(float u) { u = Mathf.Clamp01(u); return u * u * u * (u * (u * 6 - 15) + 10); }
        static Vector3 Bezier(Vector3 p0, Vector3 c, Vector3 p1, float t) { float k = 1 - t; return k * k * p0 + 2 * k * t * c + t * t * p1; }

        public void Tick(float local, bool freeze)
        {
            if (cur == null) return;
            float e = Smooth(freeze ? 1f : local);
            Vector3 pos = hasCtrl ? Bezier(a, ctrl, b, e) : Vector3.Lerp(a, b, e);
            transform.position = pos;

            Vector3 fwd;
            if (cur.speedMps > 0.15f && !freeze)
            {
                float e2 = Smooth(Mathf.Clamp01(local + 0.03f));
                Vector3 nx = hasCtrl ? Bezier(a, ctrl, b, e2) : Vector3.Lerp(a, b, e2);
                fwd = nx - pos;
            }
            else
            {
                float rad = cur.bodyDirDeg * Mathf.Deg2Rad;
                fwd = new Vector3(Mathf.Sin(rad), 0, Mathf.Cos(rad));
            }
            fwd.y = 0f;
            if (fwd.sqrMagnitude > 0.0001f)
                transform.rotation = Quaternion.Slerp(transform.rotation, Quaternion.LookRotation(fwd), 0.25f);

            if (anim == null) return;
            if (Actions.Contains(cur.animState))
            {
                SetLocomotion(cur.speedMps);
                if (lastAction != cur.animState) { TriggerAction(cur.animState); lastAction = cur.animState; }
            }
            else
            {
                SetLocomotion(freeze ? 0f : cur.speedMps);
            }
        }

        void SetLocomotion(float speed) { if (HasParam("Speed")) anim.SetFloat("Speed", speed); }
        void TriggerAction(string state)
        {
            string t = char.ToUpper(state[0]) + state.Substring(1); // shoot->Shoot, goalkeeperReaction->GoalkeeperReaction
            if (HasParam(t)) anim.SetTrigger(t);
        }
        bool HasParam(string n)
        {
            if (anim == null || anim.runtimeAnimatorController == null) return false;
            foreach (var p in anim.parameters) if (p.name == n) return true;
            return false;
        }
    }
}
