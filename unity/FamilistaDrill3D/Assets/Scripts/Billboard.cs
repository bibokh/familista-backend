// Keeps a world-space label (shirt number) facing the active camera.
using UnityEngine;

namespace Familista.Drill3D
{
    public class Billboard : MonoBehaviour
    {
        void LateUpdate()
        {
            var c = Camera.main;
            if (c != null) transform.rotation = c.transform.rotation;
        }
    }
}
