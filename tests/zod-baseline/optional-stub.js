// Stands in for an optional package this tree does not install, so a module that imports it can load for the zod
// baseline (tests/zod-baseline/collect.js). Never called.
module.exports = function optionalPackageStub() { throw new Error('optional package not installed'); };
module.exports.default = module.exports;
