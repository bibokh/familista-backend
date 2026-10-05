// A child that starts a grandchild in a NEW session — outside its process
// group, so beyond the parent's group kill — which inherits the child's stdout
// and stderr and so holds the parent's pipes open. The child reports the
// grandchild's pid first, then spins until the parent's deadline, or with
// LAB_TEST_EXIT=1 exits at once. The grandchild ends on its own after
// LAB_TEST_HOLD_MS, so a failed test cannot leave it behind for long; the test
// kills it sooner.
'use strict';
const { spawn } = require('child_process');
const holdMs = Number(process.env.LAB_TEST_HOLD_MS) || 20000;
const g = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${holdMs})`], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
process.stdout.write(JSON.stringify({ grandchild: g.pid }) + '\n');
if (process.env.LAB_TEST_EXIT === '1') process.exit(0);
for (;;) { /* never yields */ }
