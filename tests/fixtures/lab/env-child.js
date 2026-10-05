// A child that reports which environment variables it can see — names only.
'use strict';
process.stdout.write(JSON.stringify(Object.keys(process.env).sort()) + '\n');
