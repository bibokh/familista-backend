// A child that writes far more than the parent's output cap.
'use strict';
const block = 'x'.repeat(1 << 20);
for (let i = 0; i < 64; i += 1) process.stdout.write(block);
