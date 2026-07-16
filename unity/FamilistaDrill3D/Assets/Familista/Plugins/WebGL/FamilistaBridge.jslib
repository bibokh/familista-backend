// Unity -> JavaScript event channel for the WebGL build.
// Unity's WebBridge.Emit(type, payload) calls FamilistaBridge_Emit, which forwards
// to window.FamilistaUnity.onEvent(type, payload) in the hosting Familista page.
mergeInto(LibraryManager.library, {
  FamilistaBridge_Emit: function (typePtr, payloadPtr) {
    try {
      var type = UTF8ToString(typePtr);
      var payload = UTF8ToString(payloadPtr);
      if (typeof window !== 'undefined' && window.FamilistaUnity && typeof window.FamilistaUnity.onEvent === 'function') {
        window.FamilistaUnity.onEvent(type, payload);
      }
    } catch (e) { /* no-op */ }
  }
});
