// A child that allocates until its heap limit ends it.
'use strict';
const keep = [];
for (;;) keep.push(new Array(1e6).fill(1));
