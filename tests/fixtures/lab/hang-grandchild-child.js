// A child that starts a grandchild in its own process group, records the
// grandchild's pid, then loops forever. Killing the group must take both.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(process.env.LAB_TEST_PIDFILE, String(g.pid));
for (;;) { /* never yields */ }
