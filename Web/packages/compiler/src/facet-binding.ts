//
//  facet-binding.ts: a module scheme may be dotted (`firebase.remoteconfig`,
//  `telemetry.sentry`). The demo bootloader emits each scheme as a JS binding
//  while the module filename stays the scheme. A raw `import firebase.remoteconfig`
//  is a SyntaxError; the binding is the scheme with non-ident characters folded
//  to `_`.
//

/** Legal JS identifier for a scheme. Filename stays the scheme. */
export function facetBindingIdent(scheme: string): string {
  const cleaned = scheme.replace(/[^a-zA-Z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

/** The bootloader `import` line: binding is sanitized, specifier keeps the scheme. */
export function facetBootImport(scheme: string): string {
  const id = facetBindingIdent(scheme);
  return `import ${id}, * as ${id}NS from "./modules/${scheme}.js";`;
}

/** The bootloader `ModuleRegistry.register` line. */
export function facetBootRegister(scheme: string, aliases: readonly string[] = []): string {
  const id = facetBindingIdent(scheme);
  const extra = aliases.length ? `, { aliases: ${JSON.stringify(aliases)} }` : "";
  return `ModuleRegistry.register(${id}${extra});`;
}
