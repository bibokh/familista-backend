// Files that must exist beside the compiled output but are not TypeScript.
//
// tsc emits .ts and leaves everything else where it is. The password worker is
// plain JavaScript on purpose — a worker is spawned by path, so it has to be a
// real file at runtime — which means the build has to put it in dist itself.
// Without this the pool finds no worker, falls back to hashing inline, and the
// event loop blocks again on every sign-in, silently.
const fs = require('fs');
const path = require('path');

const ASSETS = [['src/utils/password.worker.js', 'dist/utils/password.worker.js']];

let copied = 0;
for (const [from, to] of ASSETS) {
  const src = path.join(process.cwd(), from);
  const dst = path.join(process.cwd(), to);
  if (!fs.existsSync(src)) {
    console.error('[assets] missing source: ' + from);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  copied++;
}
console.log('[assets] copied ' + copied + ' runtime file(s) into dist');
