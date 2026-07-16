/* ---------------------------------------------------------------------------
 * familista-unity-bridge.js  (reference)
 * Ships inside the WebGL build. The Familista page talks to the running Unity
 * build through window.FamilistaUnity (created by this template's index.html):
 *
 *   FU = iframe.contentWindow.FamilistaUnity;   // if embedded via <iframe>
 *   FU.on((type, data) => { ... });             // Unity -> JS ("step" | "error")
 *   FU.load(FamilistaDrill.get("transition"));  // push the drill JSON
 *   FU.play(); FU.pause(); FU.next(); FU.prev(); FU.goto(3); FU.replay();
 *   FU.camera("broadcast"); FU.speed(1.5); FU.quality("high"); FU.unload();
 *
 * The drill JSON comes from Familista's window.FamilistaDrill.get(id)
 * (schema "familista.drill.v1"). No squad is hardcoded in Unity.
 * ------------------------------------------------------------------------- */
(function () {
  if (typeof window === "undefined") return;
  var FU = window.FamilistaUnity = window.FamilistaUnity || {};
  FU._listeners = FU._listeners || [];
  if (!FU.on) FU.on = function (fn) { FU._listeners.push(fn); };
  if (!FU.onEvent) FU.onEvent = function (type, payload) {
    var data = payload; try { data = JSON.parse(payload); } catch (e) {}
    FU._listeners.forEach(function (fn) { try { fn(type, data); } catch (e) {} });
  };
})();
