// A child that never ends on its own: a synchronous infinite loop. Only the
// parent's SIGKILL can stop it — which is what the runner test proves.
'use strict';
for (;;) { /* never yields */ }
