/**
 * electron-builder normally drops every `*.d.ts` file from node_modules as a
 * development artifact. SDLC embeds the TypeScript compiler as a runtime
 * analysis engine, so its standard library declarations are executable data.
 * Dependency declarations are retained for the same reason.
 */
module.exports = function includeRuntimeDeclarations(path) {
  return path.endsWith(".d.ts") || path.endsWith(".d.mts") || path.endsWith(".d.cts");
};
