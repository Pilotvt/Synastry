// Stub module to silence baseline-browser-mapping warnings during build.
// Exports minimal no-op functions used by downstream tools.
function noop() { return []; }

module.exports = {
  getCompatibleVersions: noop,
  getAllVersions: noop,
  default: noop,
};
